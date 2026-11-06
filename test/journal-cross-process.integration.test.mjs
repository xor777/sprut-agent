import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const journalProcess = path.join(
  projectRoot,
  "test",
  "support",
  "journal-process.mjs",
);
const run = promisify(execFile);
const homeRef = "spruthub://hub/sim-house-01";
const LIVING_ROOM = 3;
const LEVEL = { sId: 13, cId: 15 };
// Eight dimmable lamps per dialog, each dialog with its own.
const lamps = (first) =>
  Array.from({ length: 8 }, (_, index) => ({
    aId: first + index,
    level: 20 + index,
  }));
const FIRST_DIALOG_LAMPS = lamps(901);
const SECOND_DIALOG_LAMPS = lamps(921);

function levelRef({ aId }) {
  return `${homeRef}/accessory/${aId}/service/${LEVEL.sId}/characteristic/${LEVEL.cId}`;
}

async function houseWithLamps() {
  const fixture = await loadHomeFixture("house");
  return {
    ...fixture,
    accessories: [
      ...fixture.accessories,
      ...[...FIRST_DIALOG_LAMPS, ...SECOND_DIALOG_LAMPS].map(
        ({ aId, level }) => ({
          id: aId,
          roomId: LIVING_ROOM,
          name: `Лампа ${aId}`,
          extensionKey: "Controller:zigbee",
          deviceId: `00158d0009${aId.toString(16).padStart(6, "0")}`,
          services: [
            {
              sId: LEVEL.sId,
              type: "Lightbulb",
              name: "Свет",
              characteristics: [
                { cId: 14, type: "On", value: true },
                { cId: LEVEL.cId, type: "Brightness", value: level },
              ],
            },
          ],
        }),
      ),
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
async function startDialog(t, hub, stateDirectory, { timeoutMs = 5_000 } = {}) {
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

function setLevel(client, lamp, value) {
  return client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [{ target_ref: levelRef(lamp), value }],
      reason: `Яркость лампы ${lamp.aId}`,
    },
  });
}

// As the hub holds it, independent of the product.
function hubLevel(hub, { aId }) {
  const control = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find(({ sId }) => sId === LEVEL.sId)
    .characteristics.find(({ cId }) => cId === LEVEL.cId).control;
  return Object.values(control.value)[0];
}

function levelWritesOf(hub, from, lamp) {
  return hub.requests
    .slice(from)
    .filter(
      ({ method, params }) =>
        method === "characteristic.update" &&
        params.characteristic.update.control &&
        params.characteristic.update.aId === lamp.aId,
    );
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
    const result = await setLevel(dialog.client, lamp, lamp.level + 40);
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
    assert.equal(hubLevel(hub, lamp), lamp.level + 40);
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
    assert.equal(hubLevel(hub, lamp), lamp.level, `lamp ${lamp.aId} is back`);
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

  const sent = await setLevel(first.client, lamp, 90);
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

  assert.equal(hubLevel(hub, lamp), lamp.level);
  for (const { client } of [first, second]) {
    const seen = await call(client, "get_native_change", { change_ref: ref });
    assert.equal(seen.status, "restored");
  }
  // Undoing again sends nothing: the journal still knows it is undone.
  const writes = hub.requests.length;
  await call(first.client, "restore_native_change", { change_ref: ref });
  assert.deepEqual(levelWritesOf(hub, writes, lamp), []);
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
  const underWay = setLevel(first.client, firstLamp, 90).catch(() => null);
  await waitFor(
    () =>
      hub.requests.slice(from).some(({ method }) => method === "accessory.get"),
    "the first dialog's command reached the hub",
  );
  hub.delayReplies("accessory.get", 0);

  const startedAt = Date.now();
  const refused = await setLevel(second.client, secondLamp, 90);
  const waited = Date.now() - startedAt;
  assert.equal(refused.isError, true, refused.content[0]?.text);
  const { error } = refused.structuredContent;
  assert.equal(error.code, "state_storage_busy");
  assert.equal(error.action, "retry_in_a_few_seconds");
  assert.equal(error.retryable, true);
  assert.match(error.message, /another open dialog/i);
  assert.match(error.message, /not sent/i);
  assert.ok(waited < 20_000, `waited ${waited} ms`);
  assert.deepEqual(levelWritesOf(hub, from, secondLamp), []);
  assert.equal(hubLevel(hub, secondLamp), secondLamp.level);

  // The first dialog's process dies with its command unfinished: the same
  // call now goes through, without waiting for the bound again.
  process.kill(first.pid, "SIGKILL");
  await underWay;
  const retriedAt = Date.now();
  const retried = await setLevel(second.client, secondLamp, 90);
  assert.equal(retried.isError, undefined, retried.content[0]?.text);
  assert.equal(retried.structuredContent.status, "ok");
  assert.ok(Date.now() - retriedAt < 5_000, "no second wait");
  assert.equal(hubLevel(hub, secondLamp), 90);

  await call(second.client, "restore_native_change", {
    change_ref: retried.structuredContent.results[0].change_ref,
  });
  assert.equal(hubLevel(hub, secondLamp), secondLamp.level);
});
