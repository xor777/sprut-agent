import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hubStateFingerprint } from "../src/automation-store.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The owner keeps several dialogs open, each with its own MCP server process
// on one state directory: «верни как было» has to work for all their changes.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const offsetClock = path.join(
  projectRoot,
  "test",
  "support",
  "offset-clock.mjs",
);
const journalProcess = path.join(
  projectRoot,
  "test",
  "support",
  "journal-process.mjs",
);
const holdStateLock = path.join(
  projectRoot,
  "test",
  "support",
  "hold-state-lock.mjs",
);
const run = promisify(execFile);
const homeRef = "spruthub://hub/sim-house-01";
const LIVING_ROOM = 3;
const LIGHT = { sId: 13, cId: 14 };
// Eight lamps, all on, per dialog; each dialog changes its own.
const lamps = (first) =>
  Array.from({ length: 8 }, (_, index) => ({ aId: first + index }));
const FIRST_DIALOG_LAMPS = lamps(901);
const SECOND_DIALOG_LAMPS = lamps(921);

function onRef({ aId }) {
  return `${homeRef}/accessory/${aId}/service/${LIGHT.sId}/characteristic/${LIGHT.cId}`;
}

async function houseWithLamps() {
  const fixture = await loadHomeFixture("house");
  return {
    ...fixture,
    accessories: [
      ...fixture.accessories,
      ...[...FIRST_DIALOG_LAMPS, ...SECOND_DIALOG_LAMPS].map(({ aId }) => ({
        id: aId,
        roomId: LIVING_ROOM,
        name: `Лампа ${aId}`,
        extensionKey: "Controller:zigbee",
        deviceId: `00158d0009${aId.toString(16).padStart(6, "0")}`,
        services: [
          {
            sId: LIGHT.sId,
            type: "Lightbulb",
            name: "Свет",
            characteristics: [{ cId: LIGHT.cId, type: "On", value: true }],
          },
        ],
      })),
    ],
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startHub(t) {
  const hub = await startSimulatedHub(await houseWithLamps());
  t.after(() => hub.close());
  return hub;
}

// One dialog: its own MCP server process on the shared state directory.
async function startDialog(
  t,
  hub,
  stateDirectory,
  { timeoutMs = 5_000, clockOffsetMs } = {},
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(clockOffsetMs ? ["--import", offsetClock] : []),
      "src/server.mjs",
    ],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      ...(clockOffsetMs
        ? { SPRUT_TEST_CLOCK_OFFSET_MS: String(clockOffsetMs) }
        : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "journal-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, pid: transport.pid };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function turnOff(client, lamp) {
  return client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [{ target_ref: onRef(lamp), value: false }],
      reason: `Выключить лампу ${lamp.aId}`,
    },
  });
}

// As the hub holds it, independent of the product.
function hubOn(hub, { aId }) {
  const control = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find(({ sId }) => sId === LIGHT.sId)
    .characteristics.find(({ cId }) => cId === LIGHT.cId).control;
  return Object.values(control.value)[0];
}

function lightWritesOf(hub, from, lamp) {
  return hub.requests
    .slice(from)
    .filter(
      ({ method, params }) =>
        method === "characteristic.update" &&
        params.characteristic.update.control &&
        params.characteristic.update.aId === lamp.aId,
    );
}

function prepareTurnOff(client, lamp) {
  return client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: onRef(lamp),
      value: false,
      reason: `Выключить лампу ${lamp.aId}`,
    },
  });
}

async function journalOf(stateDirectory) {
  const name = (await readdir(stateDirectory)).find((entry) =>
    /^automation-changes-[0-9a-f]+\.json$/.test(entry),
  );
  const file = path.join(stateDirectory, name);
  return { file, changes: JSON.parse(await readFile(file, "utf8")).changes };
}

// Another live process holding a lock of the state directory.
async function holdLock(t, lockFile) {
  const holder = spawn(process.execPath, [holdStateLock, lockFile], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => holder.kill("SIGKILL"));
  const [line] = await once(holder.stdout, "data");
  assert.equal(String(line), "held\n");
  return holder;
}

async function kill(holder) {
  const exited = once(holder, "exit");
  holder.kill("SIGKILL");
  await exited;
}

function assertBusy(error) {
  assert.equal(error?.code, "state_storage_busy", JSON.stringify(error));
  assert.equal(error.action, "retry_in_a_few_seconds");
  assert.match(error.message, /no write .* was sent to the hub/i);
}

async function waitFor(condition, message) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("two processes saving at once keep every change, beside the 94 already there", async (t) => {
  const directory = await temporaryDirectory(t, "sprut-agent-journal-");
  const identity = { hubUrl: "wss://hub.test/spruthub", hubSerial: "sim-1" };
  const fingerprint = hubStateFingerprint(identity.hubUrl, identity.hubSerial);
  // A journal as today's owner has it, in the file's format.
  const existing = Object.fromEntries(
    Array.from({ length: 94 }, (_, index) => [
      `existing-${index}`,
      { id: `existing-${index}`, status: "applied", reason: `Запись ${index}` },
    ]),
  );
  const journal = path.join(
    directory,
    `automation-changes-${fingerprint.slice(0, 24)}.json`,
  );
  await writeFile(
    journal,
    `${JSON.stringify(
      { version: 1, hub_fingerprint: fingerprint, changes: existing },
      null,
      2,
    )}\n`,
  );

  const count = 150;
  await Promise.all(
    ["first", "second"].map((tag) =>
      run(process.execPath, [
        journalProcess,
        JSON.stringify({ directory, ...identity, tag, count }),
      ]),
    ),
  );

  const stored = JSON.parse(await readFile(journal, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.hub_fingerprint, fingerprint);
  const expected = { ...existing };
  for (const tag of ["first", "second"]) {
    for (let index = 0; index < count; index += 1) {
      expected[`${tag}-${index}`] = {
        id: `${tag}-${index}`,
        tag,
        index,
        status: "prepared",
      };
    }
  }
  assert.equal(
    Object.keys(stored.changes).length,
    Object.keys(expected).length,
    "every saved change is in the journal",
  );
  assert.deepEqual(stored.changes, expected);
  // Nothing of the writers stays beside the journal.
  assert.deepEqual(await readdir(directory), [path.basename(journal)]);
});

test("changes made in two dialogs at once are each undone from the other dialog", async (t) => {
  const hub = await startHub(t);
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-dialogs-");
  const first = await startDialog(t, hub, stateDirectory);
  const second = await startDialog(t, hub, stateDirectory);

  const change = async (dialog, lamp) => {
    const result = await turnOff(dialog.client, lamp);
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(
      result.structuredContent.status,
      "ok",
      result.content[0]?.text,
    );
    return result.structuredContent.results[0].change_ref;
  };
  const sequentially = async (dialog, dialogLamps) => {
    const refs = [];
    for (const lamp of dialogLamps) refs.push(await change(dialog, lamp));
    return refs;
  };
  const [firstRefs, secondRefs] = await Promise.all([
    sequentially(first, FIRST_DIALOG_LAMPS),
    sequentially(second, SECOND_DIALOG_LAMPS),
  ]);
  for (const lamp of [...FIRST_DIALOG_LAMPS, ...SECOND_DIALOG_LAMPS]) {
    assert.equal(hubOn(hub, lamp), false);
  }

  // Both dialogs see every change of the other.
  for (const { client } of [first, second]) {
    for (const ref of [...firstRefs, ...secondRefs]) {
      const seen = await call(client, "get_native_change", { change_ref: ref });
      assert.equal(seen.status, "applied", ref);
    }
  }

  // Each dialog undoes what the other one did, at the same time.
  const undo = async (dialog, refs) => {
    for (const ref of refs) {
      const restored = await call(dialog.client, "restore_native_change", {
        change_ref: ref,
      });
      assert.equal(restored.status, "restored", ref);
    }
  };
  await Promise.all([undo(first, secondRefs), undo(second, firstRefs)]);

  for (const lamp of [...FIRST_DIALOG_LAMPS, ...SECOND_DIALOG_LAMPS]) {
    assert.equal(hubOn(hub, lamp), true, `lamp ${lamp.aId} is back`);
  }
  // The dialog that made a change sees it undone by the other one, and so
  // does the other one.
  for (const { client } of [first, second]) {
    for (const ref of [...firstRefs, ...secondRefs]) {
      const seen = await call(client, "get_native_change", { change_ref: ref });
      assert.equal(seen.status, "restored", ref);
    }
  }
});

test("a status check in one dialog does not bring back a change the other dialog just undid", async (t) => {
  const hub = await startHub(t);
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-stale-");
  const first = await startDialog(t, hub, stateDirectory, {
    timeoutMs: 10_000,
  });
  const second = await startDialog(t, hub, stateDirectory);
  const lamp = FIRST_DIALOG_LAMPS[0];

  const sent = await turnOff(first.client, lamp);
  assert.equal(sent.structuredContent.status, "ok", sent.content[0]?.text);
  const ref = sent.structuredContent.results[0].change_ref;

  // The first dialog checks the change and its read of the lamp is slow.
  const from = hub.requests.length;
  hub.delayReplies("characteristic.get", 700);
  const check = call(first.client, "get_native_change", { change_ref: ref });
  await waitFor(
    () =>
      hub.requests
        .slice(from)
        .some(({ method }) => method === "characteristic.get"),
    "the check reads the lamp",
  );
  hub.delayReplies("characteristic.get", 0);

  // Meanwhile the second dialog undoes it.
  const restored = await call(second.client, "restore_native_change", {
    change_ref: ref,
  });
  assert.equal(restored.status, "restored");
  await check;

  assert.equal(hubOn(hub, lamp), true);
  for (const { client } of [first, second]) {
    const seen = await call(client, "get_native_change", { change_ref: ref });
    assert.equal(seen.status, "restored");
  }
  // Undoing again sends nothing: the journal still knows it is undone.
  const writes = hub.requests.length;
  await call(first.client, "restore_native_change", { change_ref: ref });
  assert.deepEqual(lightWritesOf(hub, writes, lamp), []);
});

test("a write waits a bounded time for another dialog's write and says what to do, then a dead dialog frees it", async (t) => {
  const hub = await startHub(t);
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-busy-");
  const first = await startDialog(t, hub, stateDirectory, {
    timeoutMs: 30_000,
  });
  const second = await startDialog(t, hub, stateDirectory);
  const firstLamp = FIRST_DIALOG_LAMPS[0];
  const secondLamp = SECOND_DIALOG_LAMPS[0];

  // The first dialog's command is under way: the hub takes long to answer.
  const from = hub.requests.length;
  hub.delayReplies("accessory.get", 20_000);
  const underWay = turnOff(first.client, firstLamp).catch(() => null);
  await waitFor(
    () =>
      hub.requests.slice(from).some(({ method }) => method === "accessory.get"),
    "the first dialog's command reached the hub",
  );
  hub.delayReplies("accessory.get", 0);

  const startedAt = Date.now();
  const refused = await turnOff(second.client, secondLamp);
  const waited = Date.now() - startedAt;
  assert.equal(refused.isError, true, refused.content[0]?.text);
  const { error } = refused.structuredContent;
  assert.equal(error.code, "state_storage_busy");
  assert.equal(error.action, "retry_in_a_few_seconds");
  assert.equal(error.retryable, true);
  assert.match(error.message, /another open dialog/i);
  assert.match(error.message, /no write .* was sent to the hub/i);
  assert.ok(waited < 20_000, `waited ${waited} ms`);
  assert.deepEqual(lightWritesOf(hub, from, secondLamp), []);
  assert.equal(hubOn(hub, secondLamp), true);

  // The first dialog's process dies with its command unfinished: the same
  // call now goes through, without waiting for the bound again.
  process.kill(first.pid, "SIGKILL");
  await underWay;
  const retriedAt = Date.now();
  const retried = await turnOff(second.client, secondLamp);
  assert.equal(retried.isError, undefined, retried.content[0]?.text);
  assert.equal(retried.structuredContent.status, "ok");
  assert.ok(Date.now() - retriedAt < 5_000, "no second wait");
  assert.equal(hubOn(hub, secondLamp), false);

  await call(second.client, "restore_native_change", {
    change_ref: retried.structuredContent.results[0].change_ref,
  });
  assert.equal(hubOn(hub, secondLamp), true);
});

test("while another process holds the journal nothing reaches the hub, and the same call works once it dies", {
  concurrency: 2,
}, async (t) => {
  await Promise.all([
    t.test("apply and prepare", async (t) => {
      const hub = await startHub(t);
      const stateDirectory = await temporaryDirectory(t, "sprut-agent-held-");
      const { client } = await startDialog(t, hub, stateDirectory);
      const [lamp, otherLamp] = FIRST_DIALOG_LAMPS;
      const prepared = (await prepareTurnOff(client, lamp)).structuredContent;
      const { file } = await journalOf(stateDirectory);
      const holder = await holdLock(t, `${file}.lock`);

      const from = hub.requests.length;
      const [applied, another] = await Promise.all([
        client.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.change_ref },
        }),
        prepareTurnOff(client, otherLamp),
      ]);
      assert.equal(applied.isError, true, applied.content[0]?.text);
      assertBusy(applied.structuredContent.error);
      assert.equal(applied.structuredContent.error.retryable, true);
      assert.equal(another.isError, true, another.content[0]?.text);
      assertBusy(another.structuredContent.error);
      assert.deepEqual(lightWritesOf(hub, from, lamp), []);
      assert.equal(hubOn(hub, lamp), true);
      // Nothing counts as sent: the record is as it was before the call.
      const { changes } = await journalOf(stateDirectory);
      assert.deepEqual(
        Object.values(changes).map(({ status }) => status),
        ["prepared"],
      );

      await kill(holder);
      const retried = await call(client, "apply_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(retried.status, "applied");
      assert.equal(hubOn(hub, lamp), false);
      await call(client, "restore_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(hubOn(hub, lamp), true);
    }),
    t.test("device commands", async (t) => {
      const hub = await startHub(t);
      const stateDirectory = await temporaryDirectory(t, "sprut-agent-held-");
      const { client } = await startDialog(t, hub, stateDirectory);
      const [lamp, otherLamp] = FIRST_DIALOG_LAMPS;
      await prepareTurnOff(client, otherLamp);
      const { file } = await journalOf(stateDirectory);
      const holder = await holdLock(t, `${file}.lock`);

      const from = hub.requests.length;
      const refused = await turnOff(client, lamp);
      const [item] = refused.structuredContent.results;
      assert.equal(item.status, "not_sent", refused.content[0]?.text);
      assert.equal(item.sent, false);
      assertBusy(item.error);
      assert.deepEqual(lightWritesOf(hub, from, lamp), []);
      assert.equal(hubOn(hub, lamp), true);

      await kill(holder);
      const retried = await turnOff(client, lamp);
      assert.equal(retried.structuredContent.status, "ok");
      assert.equal(hubOn(hub, lamp), false);
    }),
  ]);
});

test("a stopped process's lock gives way by its age", async (t) => {
  const hub = await startHub(t);
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-aged-");
  const { client } = await startDialog(t, hub, stateDirectory);
  const [lamp, otherLamp] = FIRST_DIALOG_LAMPS;
  await prepareTurnOff(client, lamp);
  const { file } = await journalOf(stateDirectory);
  const lockFile = `${file}.lock`;
  // Its pid stays alive, as a dead holder's pid taken by another program does.
  const holder = await holdLock(t, lockFile);
  holder.kill("SIGSTOP");
  const longAgo = new Date(Date.now() - 60 * 60_000);
  await utimes(lockFile, longAgo, longAgo);

  const startedAt = Date.now();
  const prepared = await prepareTurnOff(client, otherLamp);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.ok(Date.now() - startedAt < 5_000, "no wait for the bound");
  const { changes } = await journalOf(stateDirectory);
  assert.equal(Object.keys(changes).length, 2);
});

// A holder that runs keeps its lock fresh, so its age never gives it away,
// even to a process whose clock is ahead by most of the lock's limit. Without
// that this dialog would take the lock of a live process about 25 s after it
// was taken, and two processes would write the journal at once.
test("a process with its clock ahead does not take a live process's lock", async (t) => {
  const hub = await startHub(t);
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-live-");
  const first = await startDialog(t, hub, stateDirectory);
  const [lamp, otherLamp] = FIRST_DIALOG_LAMPS;
  await prepareTurnOff(first.client, lamp);
  const { file, changes: before } = await journalOf(stateDirectory);
  const lockFile = `${file}.lock`;
  const holder = await holdLock(t, lockFile);
  const heldText = await readFile(lockFile, "utf8");
  const ahead = await startDialog(t, hub, stateDirectory, {
    clockOffsetMs: 95_000,
  });

  // The next try waits 15 s, so it spans the moment the lock would go stale.
  await new Promise((resolve) => setTimeout(resolve, 17_000));
  const refused = await prepareTurnOff(ahead.client, otherLamp);

  assert.equal(refused.isError, true, refused.content[0]?.text);
  assertBusy(refused.structuredContent.error);
  assert.equal(await readFile(lockFile, "utf8"), heldText);
  const { changes } = await journalOf(stateDirectory);
  assert.deepEqual(Object.keys(changes), Object.keys(before));

  await kill(holder);
  const prepared = await prepareTurnOff(ahead.client, otherLamp);
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
});

test("processes that find a dead process's lock together all keep their changes", async (t) => {
  const directory = await temporaryDirectory(t, "sprut-agent-dead-");
  const identity = { hubUrl: "wss://hub.test/spruthub", hubSerial: "sim-1" };
  const fingerprint = hubStateFingerprint(identity.hubUrl, identity.hubSerial);
  const journal = path.join(
    directory,
    `automation-changes-${fingerprint.slice(0, 24)}.json`,
  );
  await kill(await holdLock(t, `${journal}.lock`));

  const tags = ["a", "b", "c", "d"];
  const count = 40;
  await Promise.all(
    tags.map((tag) =>
      run(process.execPath, [
        journalProcess,
        JSON.stringify({ directory, ...identity, tag, count }),
      ]),
    ),
  );

  const { changes } = JSON.parse(await readFile(journal, "utf8"));
  assert.equal(Object.keys(changes).length, tags.length * count);
  assert.deepEqual(await readdir(directory), [path.basename(journal)]);
});
