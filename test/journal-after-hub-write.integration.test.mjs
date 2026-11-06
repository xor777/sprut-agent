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
// must not say otherwise, what the hub confirmed must not be lost, and undo
// must still work. The lock is held at the moment the record is due, by a
// real other process, as a stuck dialog holds it.
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

async function setup(t) {
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
        SPRUTHUB_TIMEOUT_MS: "30000",
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
    whenArrives,
    savedRecord,
  };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function kill(holder) {
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
}

// The record reaches the journal by itself once the journal is free.
async function waitForRecord(savedRecord, changeRef, holds) {
  const deadline = Date.now() + 15_000;
  while (!holds(await savedRecord(changeRef))) {
    assert.ok(Date.now() < deadline, "the record never reached the journal");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  assert.doesNotMatch(error.message, /no write .* was sent/i);
  assert.match(error.message, /already went to the hub/i);
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

    t.test("a new group: undo removes the device it created", async (t) => {
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
      const restored = await call(client, "restore_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(restored.status, "restored", JSON.stringify(restored));
      assert.equal(inRoster(hub, "Свет гостиной"), false);
    }),

    t.test(
      "a new group: the id reaches the journal, and another dialog undoes it",
      async (t) => {
        const { hub, client, startDialog, holdJournalWhen, savedRecord } =
          await setup(t);
        const prepared = await prepareGroup(client);
        const { held } = await holdJournalWhen("accessory.create");

        const stopped = await client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        });
        assert.equal(stopped.isError, true, JSON.stringify(stopped));

        await kill(await held);
        await waitForRecord(
          savedRecord,
          prepared.change_ref,
          ({ created_accessory_id: id }) => id !== undefined,
        );
        const other = await startDialog();
        const restored = await call(other, "restore_native_change", {
          change_ref: prepared.change_ref,
        });
        assert.equal(restored.status, "restored", JSON.stringify(restored));
        assert.equal(inRoster(hub, "Свет гостиной"), false);
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

    t.test("a virtual device: its id is not lost either", async (t) => {
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
      const restored = await call(client, "restore_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(restored.status, "restored", JSON.stringify(restored));
      assert.equal(inRoster(hub, "Режим гостей"), false);
    }),
  ]);
});

// The same when the file system refuses the journal itself: the answer owns
// up, and the journal gets what the hub confirmed once it can be written.
test("a journal that cannot be written after a hub step keeps the id too", async (t) => {
  const { hub, client, journalFile, whenArrives, savedRecord } = await setup(t);
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
  await waitForRecord(
    savedRecord,
    prepared.change_ref,
    ({ created_accessory_id: id }) => id !== undefined,
  );
  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(inRoster(hub, "Свет гостиной"), false);
});
