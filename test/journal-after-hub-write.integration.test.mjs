import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GROUP_CHARACTERISTICS } from "./fixtures/homes/kitchen-chandelier.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// A change of several steps saves its record after each step the hub took.
// When that save cannot happen, the step is already in the home: the answer
// must not say otherwise, and undo must still work. The journal stays the only
// record: what it did not take is an outcome the next call settles from the
// hub, as after a lost answer. The lock is held at the moment the record is
// due, by a real other process, as a stuck dialog holds it.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const holdStateLock = path.join(
  projectRoot,
  "test",
  "support",
  "hold-state-lock.mjs",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const lampRef = (aId) => `${homeRef}/accessory/${aId}/service/13`;
const groupServiceRef = lampRef(44);
const NEW_LAMP_GROUP = [41, 42, 45];
// Long enough for the holder to be running when the hub's answer comes.
const REPLY_DELAY_MS = 3_000;
// Long enough for anything a stopped dialog still wrote by itself to show.
const SETTLE_MS = 6_000;

async function setup(t, { timeoutMs = 30_000 } = {}) {
  let arrived = () => {};
  const holders = [];
  const clients = [];
  const hub = await startSimulatedHub(
    await loadHomeFixture("kitchen-chandelier"),
    { onRequest: (request) => arrived(request) },
  );
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-after-write-"),
  );
  const startDialog = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "after-write-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    client.pid = transport.pid;
    return client;
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    for (const holder of holders) holder.kill("SIGKILL");
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const journalFile = async () =>
    path.join(
      stateDirectory,
      (await readdir(stateDirectory)).find((entry) =>
        /^automation-changes-[0-9a-f]+\.json$/.test(entry),
      ),
    );
  // Another live process takes the journal's lock as the first `method`
  // reaches the hub, and the hub's answer to it comes after that. `held`
  // resolves to the holder.
  const holdJournalWhen = async (method) => {
    const lockFile = `${await journalFile()}.lock`;
    hub.delayReplies(method, REPLY_DELAY_MS);
    const held = new Promise((resolve, reject) => {
      arrived = (request) => {
        if (request.method !== method) return;
        arrived = () => {};
        const holder = spawn(process.execPath, [holdStateLock, lockFile], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        holders.push(holder);
        once(holder.stdout, "data").then(([line]) => {
          assert.equal(String(line), "held\n");
          // Later steps of the same kind answer at once.
          hub.delayReplies(method, 0);
          resolve(holder);
        }, reject);
      };
    });
    return { held };
  };
  const holdLock = async (lockFile) => {
    const holder = spawn(process.execPath, [holdStateLock, lockFile], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    holders.push(holder);
    const [line] = await once(holder.stdout, "data");
    assert.equal(String(line), "held\n");
    return holder;
  };
  const whenArrives = (method, action) => {
    arrived = (request) => {
      if (request.method !== method) return;
      arrived = () => {};
      action();
    };
  };
  const savedRecord = async (changeRef) => {
    const { changes } = JSON.parse(await readFile(await journalFile(), "utf8"));
    return changes[changeRef.split("/").at(-1)];
  };
  return {
    hub,
    journalFile,
    client: await startDialog(),
    startDialog,
    holdJournalWhen,
    holdLock,
    whenArrives,
    savedRecord,
  };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function kill(holder) {
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
}

function assertStoppedPartWay(answer, changeRef, tool, code) {
  const text = JSON.stringify(answer);
  assert.equal(answer.isError, true, text);
  const {
    error,
    hub_effect: effect,
    change_ref: ref,
    next,
  } = answer.structuredContent;
  assert.equal(error.code, code, text);
  assert.equal(effect, "partial", text);
  assert.equal(ref, changeRef, text);
  assert.deepEqual(next, { tool, arguments: { change_ref: changeRef } }, text);
  // It says what happened, not the answer of a call that sent nothing.
  assert.doesNotMatch(text, /no write .* was sent/i);
  assert.doesNotMatch(text, /nothing was (written|sent)/i);
  assert.match(error.message, /already went to the hub/i);
  // A repeat settles from the hub first: it may not go on from there.
  assert.match(error.message, /checks the hub first/i);
}

function prepareGroup(client) {
  return call(client, "prepare_native_change", {
    operation: "virtual_light_group",
    target_ref: homeRef,
    room_ref: `${homeRef}/room/3`,
    name: "Свет гостиной",
    member_service_refs: [lampRef(15), lampRef(16)],
    characteristic_types: ["On", "Brightness"],
    reason: "Собрать свет гостиной",
  });
}

function prepareMembers(client) {
  return call(client, "prepare_native_change", {
    operation: "virtual_light_group",
    target_ref: groupServiceRef,
    member_service_refs: NEW_LAMP_GROUP.map(lampRef),
    reason: "Перевязать люстру",
  });
}

function prepareDevice(client) {
  return call(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: `${homeRef}/room/3`,
    name: "Режим гостей",
    value: "Switch",
    reason: "Сделать выключатель",
  });
}

const inRoster = (hub, name) =>
  hub.state.accessories.some((accessory) => accessory.name === name);

const creations = (hub) =>
  hub.requests.filter(({ method }) => method === "accessory.create").length;

const candidateNames = (candidates) => candidates.map(({ name }) => name);

function groupLinkCount(hub) {
  return Object.values(GROUP_CHARACTERISTICS)
    .flatMap((cId) => hub.state.links.get(`44.13.${cId}`) ?? [])
    .flatMap(({ characteristics }) => characteristics).length;
}

test("the journal held after a hub step: the answer owns up and undo still works", {
  concurrency: 6,
}, async (t) => {
  await Promise.all([
    t.test("a new set of lamps: the retry finishes it", async (t) => {
      const { hub, client, holdJournalWhen } = await setup(t);
      const prepared = await prepareMembers(client);
      const { held } = await holdJournalWhen("link.addVirtual");

      const stopped = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.change_ref },
      });

      assertStoppedPartWay(
        stopped,
        prepared.change_ref,
        "apply_native_change",
        "state_storage_busy",
      );
      assert.equal(stopped.structuredContent.error.retryable, true);
      assert.ok(
        hub.requests.some(({ method }) => method === "link.addVirtual"),
      );

      await kill(await held);
      const finished = await call(client, "apply_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(finished.status, "applied", JSON.stringify(finished));
      const restored = await call(client, "restore_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(restored.status, "restored", JSON.stringify(restored));
    }),

    t.test(
      "a new group whose id was not saved: no second device, and undo names it",
      async (t) => {
        const { hub, client, holdJournalWhen } = await setup(t);
        const prepared = await prepareGroup(client);
        const { held } = await holdJournalWhen("accessory.create");

        const stopped = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        });

        assertStoppedPartWay(
          stopped,
          prepared.change_ref,
          "apply_native_change",
          "state_storage_busy",
        );
        assert.equal(inRoster(hub, "Свет гостиной"), true);

        await kill(await held);
        const undo = await call(client, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(undo.status, "not_owned", JSON.stringify(undo));
        assert.deepEqual(candidateNames(undo.candidate_accessories), [
          "Свет гостиной",
        ]);
        assert.equal(inRoster(hub, "Свет гостиной"), true);

        const repeat = await call(client, "apply_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(repeat.status, "uncertain", JSON.stringify(repeat));
        assert.equal(
          repeat.conflict_reason,
          "virtual_accessory_creation_outcome_unknown",
        );
        assert.deepEqual(candidateNames(repeat.candidate_accessories), [
          "Свет гостиной",
        ]);
        assert.equal(creations(hub), 1);
      },
    ),

    t.test(
      "a new group whose id was not saved: another dialog knows as much",
      async (t) => {
        const { hub, client, startDialog, holdJournalWhen } = await setup(t);
        const prepared = await prepareGroup(client);
        const { held } = await holdJournalWhen("accessory.create");

        const stopped = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        });
        assert.equal(stopped.isError, true, JSON.stringify(stopped));

        await kill(await held);
        const other = await startDialog();
        const seen = await call(other, "get_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(seen.status, "uncertain", JSON.stringify(seen));
        assert.deepEqual(candidateNames(seen.candidate_accessories), [
          "Свет гостиной",
        ]);
        const undo = await call(other, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(undo.status, "not_owned", JSON.stringify(undo));
        assert.equal(inRoster(hub, "Свет гостиной"), true);
        assert.equal(creations(hub), 1);
      },
    ),

    t.test(
      "a group another dialog finished keeps its record, and undo works",
      async (t) => {
        const { hub, client, startDialog, holdJournalWhen, savedRecord } =
          await setup(t);
        const other = await startDialog();
        const prepared = await prepareGroup(client);
        const { held } = await holdJournalWhen("link.addVirtual");

        const stopped = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        });
        assert.equal(stopped.isError, true, JSON.stringify(stopped));

        await kill(await held);
        const finished = await call(other, "apply_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(finished.status, "applied", JSON.stringify(finished));

        await sleep(SETTLE_MS);
        assert.equal(
          (await savedRecord(prepared.change_ref)).status,
          "applied",
        );
        const retried = await call(client, "apply_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(retried.status, "applied", JSON.stringify(retried));
        const restored = await call(other, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(restored.status, "restored", JSON.stringify(restored));
        assert.equal(inRoster(hub, "Свет гостиной"), false);
      },
    ),

    t.test(
      "lamps another dialog relinked keep their record, and undo works",
      async (t) => {
        const { hub, client, startDialog, holdJournalWhen, savedRecord } =
          await setup(t);
        const links = groupLinkCount(hub);
        const other = await startDialog();
        const prepared = await prepareMembers(client);
        const { held } = await holdJournalWhen("link.addVirtual");

        const stopped = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        });
        assert.equal(stopped.isError, true, JSON.stringify(stopped));

        await kill(await held);
        const finished = await call(other, "apply_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(finished.status, "applied", JSON.stringify(finished));

        await sleep(SETTLE_MS);
        assert.equal(
          (await savedRecord(prepared.change_ref)).status,
          "applied",
        );
        const restored = await call(other, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(restored.status, "restored", JSON.stringify(restored));
        assert.equal(groupLinkCount(hub), links);
      },
    ),

    t.test(
      "undo of a group: the item says its steps went, and undo goes on",
      async (t) => {
        const { hub, client, holdJournalWhen } = await setup(t);
        const prepared = await prepareGroup(client);
        const applied = await call(client, "apply_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(applied.status, "applied", JSON.stringify(applied));
        const { held } = await holdJournalWhen("link.remove");

        const stopped = await call(client, "restore_native_change", {
          change_refs: [prepared.change_ref],
        });

        const [item] = stopped.results;
        assert.equal(item.status, "failed", JSON.stringify(item));
        assert.equal(item.sent, true, JSON.stringify(item));
        assert.equal(item.hub_effect, "partial");
        assert.equal(item.error.code, "state_storage_busy");
        assert.deepEqual(item.next, {
          tool: "restore_native_change",
          arguments: { change_ref: prepared.change_ref },
        });
        assert.doesNotMatch(item.error.message, /no write .* was sent/i);

        await kill(await held);
        const finished = await call(client, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(finished.status, "restored", JSON.stringify(finished));
        assert.equal(inRoster(hub, "Свет гостиной"), false);
      },
    ),

    t.test("undo of a new set of lamps: the answer owns up too", async (t) => {
      const { hub, client, holdJournalWhen } = await setup(t);
      const links = groupLinkCount(hub);
      const prepared = await prepareMembers(client);
      await call(client, "apply_native_change", {
        change_ref: prepared.change_ref,
      });
      const { held } = await holdJournalWhen("link.remove");

      const stopped = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.change_ref },
      });

      assertStoppedPartWay(
        stopped,
        prepared.change_ref,
        "restore_native_change",
        "state_storage_busy",
      );

      await kill(await held);
      const finished = await call(client, "restore_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(finished.status, "restored", JSON.stringify(finished));
      assert.equal(groupLinkCount(hub), links);
    }),

    t.test(
      "a virtual device whose id was not saved: no second one, and undo names it",
      async (t) => {
        const { hub, client, holdJournalWhen } = await setup(t);
        const prepared = await prepareDevice(client);
        const { held } = await holdJournalWhen("accessory.create");

        const stopped = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        });

        assertStoppedPartWay(
          stopped,
          prepared.change_ref,
          "apply_native_change",
          "state_storage_busy",
        );
        assert.equal(inRoster(hub, "Режим гостей"), true);

        await kill(await held);
        const undo = await call(client, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(undo.status, "not_owned", JSON.stringify(undo));
        assert.deepEqual(candidateNames(undo.candidate_devices), [
          "Режим гостей",
        ]);
        assert.equal(inRoster(hub, "Режим гостей"), true);

        const repeat = await call(client, "apply_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(repeat.status, "uncertain", JSON.stringify(repeat));
        assert.equal(
          repeat.conflict_reason,
          "virtual_device_creation_outcome_unknown",
        );
        assert.deepEqual(candidateNames(repeat.candidate_devices), [
          "Режим гостей",
        ]);
        assert.equal(creations(hub), 1);
      },
    ),
  ]);
});

// The same when the file system refuses the journal itself: the answer owns
// up, and once the journal can be written the next call settles it from the hub.
test("a journal that cannot be written after a hub step: the next call settles it", async (t) => {
  const { hub, client, journalFile, whenArrives } = await setup(t);
  const prepared = await prepareGroup(client);
  // The journal's temporary file: a directory in its place fails the write.
  const temporaryFile = `${await journalFile()}.${client.pid}.tmp`;
  hub.delayReplies("accessory.create", 200);
  whenArrives("accessory.create", () => mkdirSync(temporaryFile));

  const stopped = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });

  assertStoppedPartWay(
    stopped,
    prepared.change_ref,
    "apply_native_change",
    "state_storage_unavailable",
  );
  assert.equal(stopped.structuredContent.error.retryable, false);

  rmdirSync(temporaryFile);
  const repeat = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(repeat.status, "uncertain", JSON.stringify(repeat));
  assert.deepEqual(candidateNames(repeat.candidate_accessories), [
    "Свет гостиной",
  ]);
  assert.equal(creations(hub), 1);
  const undo = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(undo.status, "not_owned", JSON.stringify(undo));
  assert.equal(inRoster(hub, "Свет гостиной"), true);
});

const REFUSED = { code: -32000, message: "busy" };
const APPLY = "apply_native_change";
const RESTORE = "restore_native_change";

// Whatever stops a change after a step of it went, the answer owns up to that
// step and the same call finishes the change.
const STOPPED_AFTER_A_STEP = [
  {
    name: "apply of a group, after a link",
    prepare: prepareGroup,
    tool: APPLY,
  },
  {
    name: "apply of a group, after a setting",
    prepare: prepareGroup,
    tool: APPLY,
    write: "characteristic.update",
    read: "accessory.get",
  },
  {
    name: "apply of lamps, after a link",
    prepare: prepareMembers,
    tool: APPLY,
  },
  {
    name: "undo of a group, after a link",
    prepare: prepareGroup,
    tool: RESTORE,
    write: "link.remove",
  },
  {
    name: "undo of a group, after a setting",
    prepare: prepareGroup,
    tool: RESTORE,
    write: "characteristic.update",
    read: "accessory.get",
  },
  {
    name: "undo of a group, after its deletion",
    prepare: prepareGroup,
    tool: RESTORE,
    write: "accessory.delete",
    read: "accessory.get",
  },
  {
    name: "undo of lamps, after a link",
    prepare: prepareMembers,
    tool: RESTORE,
  },
];

const finalStatus = { [APPLY]: "applied", [RESTORE]: "restored" };

test("a read refused after a step went: the answer owns up, and the same call finishes", {
  concurrency: 8,
}, async (t) => {
  await Promise.all(
    STOPPED_AFTER_A_STEP.map(
      ({
        name,
        prepare,
        tool,
        write = "link.addVirtual",
        read = "link.list",
      }) =>
        t.test(name, async (t) => {
          const { hub, client, whenArrives } = await setup(t);
          const prepared = await prepare(client);
          if (tool === RESTORE) {
            await call(client, APPLY, { change_ref: prepared.change_ref });
          }
          const before = hub.writes().length;
          whenArrives(write, () => hub.refuseNext(read, REFUSED));

          const stopped = await client.callTool({
            name: tool,
            arguments: { change_ref: prepared.change_ref },
          });

          assertStoppedPartWay(
            stopped,
            prepared.change_ref,
            tool,
            "request_rejected",
          );
          assert.equal(hub.writes().at(-1).method, write);
          assert.ok(hub.writes().length > before);

          const finished = await call(client, tool, {
            change_ref: prepared.change_ref,
          });
          assert.equal(
            finished.status,
            finalStatus[tool],
            JSON.stringify(finished),
          );
        }),
    ),
  );
});

test("a read lost after a step went owns up too", {
  concurrency: 2,
}, async (t) => {
  await Promise.all(
    [
      { name: "apply of a group", prepare: prepareGroup, tool: APPLY },
      { name: "undo of lamps", prepare: prepareMembers, tool: RESTORE },
    ].map(({ name, prepare, tool }) =>
      t.test(name, async (t) => {
        const { hub, client, whenArrives } = await setup(t, {
          timeoutMs: 2_000,
        });
        const prepared = await prepare(client);
        if (tool === RESTORE) {
          await call(client, APPLY, { change_ref: prepared.change_ref });
        }
        whenArrives("link.addVirtual", () => hub.loseNext("link.list"));

        const stopped = await client.callTool({
          name: tool,
          arguments: { change_ref: prepared.change_ref },
        });

        assertStoppedPartWay(stopped, prepared.change_ref, tool, "timeout");
        const finished = await call(client, tool, {
          change_ref: prepared.change_ref,
        });
        assert.equal(
          finished.status,
          finalStatus[tool],
          JSON.stringify(finished),
        );
      }),
    ),
  );
});

test("an item of a restore owns up to a refused read too", async (t) => {
  const { hub, client, whenArrives } = await setup(t);
  const prepared = await prepareMembers(client);
  await call(client, APPLY, { change_ref: prepared.change_ref });
  whenArrives("link.addVirtual", () => hub.refuseNext("link.list", REFUSED));

  const { results } = await call(client, RESTORE, {
    change_refs: [prepared.change_ref],
  });

  const [item] = results;
  assert.equal(item.status, "failed", JSON.stringify(item));
  assert.equal(item.sent, true, JSON.stringify(item));
  assert.equal(item.hub_effect, "partial");
  assert.deepEqual(item.next, {
    tool: RESTORE,
    arguments: { change_ref: prepared.change_ref },
  });
  assert.doesNotMatch(JSON.stringify(item), /nothing was written/i);
});

test("a virtual device's undo whose delete went owns up to a refused read", async (t) => {
  const { hub, client } = await setup(t, { timeoutMs: 2_000 });
  const prepared = await prepareDevice(client);
  await call(client, APPLY, { change_ref: prepared.change_ref });

  hub.loseNext("accessory.delete");
  const unknown = await call(client, RESTORE, {
    change_ref: prepared.change_ref,
  });
  assert.equal(unknown.status, "uncertain", JSON.stringify(unknown));

  hub.refuseNext("accessory.get", REFUSED);
  const stopped = await client.callTool({
    name: RESTORE,
    arguments: { change_ref: prepared.change_ref },
  });
  assertStoppedPartWay(
    stopped,
    prepared.change_ref,
    RESTORE,
    "request_rejected",
  );

  const finished = await call(client, RESTORE, {
    change_ref: prepared.change_ref,
  });
  assert.equal(finished.status, "restored", JSON.stringify(finished));
  assert.equal(inRoster(hub, "Режим гостей"), false);
});

// The undo of a deletion creates the device again: the same lost id.
test("the undo of a deletion whose new id was not saved: no third device", async (t) => {
  const { hub, client, journalFile, whenArrives } = await setup(t);
  const made = await prepareDevice(client);
  const { device } = await call(client, APPLY, { change_ref: made.change_ref });
  const removal = await call(client, "prepare_native_change", {
    operation: "virtual_device_delete",
    target_ref: device.ref,
    reason: "Убрать выключатель",
  });
  await call(client, APPLY, { change_ref: removal.change_ref });
  assert.equal(inRoster(hub, "Режим гостей"), false);

  const temporaryFile = `${await journalFile()}.${client.pid}.tmp`;
  hub.delayReplies("accessory.create", 200);
  whenArrives("accessory.create", () => mkdirSync(temporaryFile));
  const stopped = await client.callTool({
    name: RESTORE,
    arguments: { change_ref: removal.change_ref },
  });
  rmdirSync(temporaryFile);

  assertStoppedPartWay(
    stopped,
    removal.change_ref,
    RESTORE,
    "state_storage_unavailable",
  );
  assert.equal(inRoster(hub, "Режим гостей"), true);
  const repeat = await call(client, RESTORE, {
    change_ref: removal.change_ref,
  });
  assert.equal(repeat.status, "uncertain", JSON.stringify(repeat));
  assert.deepEqual(candidateNames(repeat.candidate_devices), ["Режим гостей"]);
  assert.equal(creations(hub), 2);
});

// Another dialog's long write holds the operation lock when a repeat comes.
test("a repeat that cannot start owns up to the steps an earlier call sent", {
  concurrency: 2,
}, async (t) => {
  await Promise.all(
    [
      { name: "apply of a group", tool: APPLY },
      { name: "undo of a group", tool: RESTORE, write: "link.remove" },
    ].map(({ name, tool, write = "link.addVirtual" }) =>
      t.test(name, async (t) => {
        const { hub, client, journalFile, whenArrives, holdLock } =
          await setup(t);
        const prepared = await prepareGroup(client);
        if (tool === RESTORE) {
          await call(client, APPLY, { change_ref: prepared.change_ref });
        }
        whenArrives(write, () => hub.refuseNext("link.list", REFUSED));
        await client.callTool({
          name: tool,
          arguments: { change_ref: prepared.change_ref },
        });

        const holder = await holdLock(`${await journalFile()}.operation.lock`);
        const stopped = await client.callTool({
          name: tool,
          arguments: { change_ref: prepared.change_ref },
        });
        assertStoppedPartWay(
          stopped,
          prepared.change_ref,
          tool,
          "state_storage_busy",
        );

        await kill(holder);
        const finished = await call(client, tool, {
          change_ref: prepared.change_ref,
        });
        assert.equal(
          finished.status,
          finalStatus[tool],
          JSON.stringify(finished),
        );
      }),
    ),
  );
});

// The id reached the journal and the read after it did not: the record holds
// only the id, and it is shown as it is.
test("a new group whose first read failed still answers and finishes", async (t) => {
  const { hub, client, whenArrives } = await setup(t);
  const prepared = await prepareGroup(client);
  whenArrives("accessory.create", () =>
    hub.refuseNext("accessory.get", REFUSED),
  );

  const stopped = await client.callTool({
    name: APPLY,
    arguments: { change_ref: prepared.change_ref },
  });
  assert.equal(stopped.isError, undefined, JSON.stringify(stopped));
  assert.equal(stopped.structuredContent.status, "uncertain");
  assert.equal(
    stopped.structuredContent.conflict_reason,
    "created_accessory_readback_failed",
  );

  const finished = await call(client, APPLY, {
    change_ref: prepared.change_ref,
  });
  assert.equal(finished.status, "applied", JSON.stringify(finished));
  assert.equal(creations(hub), 1);
});

function assertSentNothing(answer) {
  const text = JSON.stringify(answer);
  assert.equal(answer.isError, true, text);
  assert.equal(answer.structuredContent.hub_effect, undefined, text);
  assert.equal(answer.structuredContent.next, undefined, text);
  assert.doesNotMatch(text, /already went to the hub/i);
}

const PREPARE_EACH = [
  { name: "a group", prepare: prepareGroup },
  { name: "lamps", prepare: prepareMembers },
  { name: "a virtual device", prepare: prepareDevice },
];

// A step is marked in the journal before it goes. When that save fails, the
// step did not go: nothing is claimed, and the next call starts clean.
test("a journal that refuses the first mark: nothing is claimed, and the next call works", {
  concurrency: 6,
}, async (t) => {
  await Promise.all(
    PREPARE_EACH.flatMap(({ name, prepare }) =>
      [APPLY, RESTORE].map((tool) =>
        t.test(`${tool} of ${name}`, async (t) => {
          const { hub, client, journalFile } = await setup(t);
          const prepared = await prepare(client);
          if (tool === RESTORE) {
            await call(client, APPLY, { change_ref: prepared.change_ref });
          }
          const writes = hub.writes().length;
          const temporaryFile = `${await journalFile()}.${client.pid}.tmp`;
          mkdirSync(temporaryFile);

          const refused = await client.callTool({
            name: tool,
            arguments: { change_ref: prepared.change_ref },
          });

          rmdirSync(temporaryFile);
          assertSentNothing(refused);
          assert.equal(
            refused.structuredContent.error.code,
            "state_storage_unavailable",
          );
          assert.equal(hub.writes().length, writes);
          const finished = await call(client, tool, {
            change_ref: prepared.change_ref,
          });
          assert.equal(
            finished.status,
            finalStatus[tool],
            JSON.stringify(finished),
          );
        }),
      ),
    ),
  );
});

test("a read refused before any step of this direction: the answer stays as it was", {
  concurrency: 4,
}, async (t) => {
  await Promise.all([
    t.test("apply of a group", async (t) => {
      const { hub, client } = await setup(t);
      const prepared = await prepareGroup(client);
      hub.refuseNext("accessory.list", REFUSED);
      const answer = await client.callTool({
        name: APPLY,
        arguments: { change_ref: prepared.change_ref },
      });
      assertSentNothing(answer);
      assert.deepEqual(hub.writes(), []);
    }),

    t.test("undo of lamps says nothing was written", async (t) => {
      const { hub, client } = await setup(t);
      const prepared = await prepareMembers(client);
      await call(client, APPLY, { change_ref: prepared.change_ref });
      const writes = hub.writes().length;
      hub.refuseNext("accessory.get", REFUSED);
      const answer = await call(client, RESTORE, {
        change_ref: prepared.change_ref,
      });
      assert.equal(answer.hub_effect, undefined);
      assert.match(answer.restore_outcome.message, /nothing was written/i);
      assert.equal(hub.writes().length, writes);
    }),

    t.test("undo of a group", async (t) => {
      const { hub, client } = await setup(t);
      const prepared = await prepareGroup(client);
      await call(client, APPLY, { change_ref: prepared.change_ref });
      const writes = hub.writes().length;
      hub.refuseNext("accessory.get", REFUSED);
      const answer = await client.callTool({
        name: RESTORE,
        arguments: { change_ref: prepared.change_ref },
      });
      assertSentNothing(answer);
      assert.equal(hub.writes().length, writes);
    }),

    t.test("undo of a virtual device", async (t) => {
      const { hub, client } = await setup(t);
      const prepared = await prepareDevice(client);
      await call(client, APPLY, { change_ref: prepared.change_ref });
      const writes = hub.writes().length;
      hub.refuseNext("accessory.get", REFUSED);
      const answer = await client.callTool({
        name: RESTORE,
        arguments: { change_ref: prepared.change_ref },
      });
      assertSentNothing(answer);
      assert.equal(hub.writes().length, writes);
    }),
  ]);
});

// A finished change holds no part of anything: its repeat that cannot read
// says only that.
test("a repeat of a finished apply whose read is refused does not call it partial", {
  concurrency: 2,
}, async (t) => {
  await Promise.all(
    [
      { name: "a group", prepare: prepareGroup },
      { name: "lamps", prepare: prepareMembers },
    ].map(({ name, prepare }) =>
      t.test(name, async (t) => {
        const { hub, client } = await setup(t);
        const prepared = await prepare(client);
        await call(client, APPLY, { change_ref: prepared.change_ref });
        hub.refuseNext("accessory.get", REFUSED);
        const answer = await client.callTool({
          name: APPLY,
          arguments: { change_ref: prepared.change_ref },
        });
        assertSentNothing(answer);
      }),
    ),
  );
});

// A write the hub refused did not go: a repeat that cannot read claims nothing.
test("a refused creation followed by a refused read claims nothing", {
  concurrency: 2,
}, async (t) => {
  await Promise.all(
    [
      {
        name: "a group",
        prepare: prepareGroup,
        read: "accessory.list",
      },
      {
        name: "a virtual device",
        prepare: prepareDevice,
        read: "room.get",
      },
    ].map(({ name, prepare, read }) =>
      t.test(name, async (t) => {
        const { hub, client } = await setup(t);
        const prepared = await prepare(client);
        hub.refuseNext("accessory.create", REFUSED);
        const refused = await client.callTool({
          name: APPLY,
          arguments: { change_ref: prepared.change_ref },
        });
        assert.equal(
          refused.structuredContent.hub_effect,
          "not_applied",
          JSON.stringify(refused),
        );

        hub.refuseNext(read, REFUSED);
        const answer = await client.callTool({
          name: APPLY,
          arguments: { change_ref: prepared.change_ref },
        });
        assertSentNothing(answer);
      }),
    ),
  );
});

// An answer that already carries the hub's refusal keeps it.
test("a step the hub refused after earlier steps keeps its own answer", async (t) => {
  const { hub, client, whenArrives } = await setup(t);
  const prepared = await prepareMembers(client);
  // The first link goes; the second is refused as it arrives.
  whenArrives("link.addVirtual", () =>
    whenArrives("link.addVirtual", () =>
      hub.refuseNext("link.addVirtual", REFUSED),
    ),
  );
  const answer = await client.callTool({
    name: APPLY,
    arguments: { change_ref: prepared.change_ref },
  });
  const { hub_effect: effect, rejection, next } = answer.structuredContent;
  assert.equal(effect, "partial", JSON.stringify(answer));
  assert.ok(rejection, JSON.stringify(answer));
  assert.equal(next.tool, RESTORE);
});
