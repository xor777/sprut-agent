import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// MCP clients often pass an unfilled SPRUT_AGENT_STATE_DIR as an empty
// string. The change journal and configuration points must then stay in the
// default per-user state directory, so restore and command history survive a
// restart from another working directory.
const serverPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "server.mjs",
);
const homeRef = "spruthub://hub/sim-apartment-01";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startClient(t, hub, { cwd, home, stateDirectory, preload }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(preload ? ["--import", preload] : []), serverPath],
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_STATE_HOME: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "state-directory-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

test("a blank state directory keeps history in the user state directory across working directories", async (t) => {
  for (const stateDirectory of ["", " "]) {
    await t.test(JSON.stringify(stateDirectory), (t) =>
      historySurvivesAnotherWorkingDirectory(t, stateDirectory),
    );
  }
});

async function historySurvivesAnotherWorkingDirectory(t, stateDirectory) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const home = await temporaryDirectory(t, "sprut-agent-state-home-");
  const firstCwd = await temporaryDirectory(t, "sprut-agent-state-cwd-a-");
  const secondCwd = await temporaryDirectory(t, "sprut-agent-state-cwd-b-");

  const firstClient = await startClient(t, hub, {
    cwd: firstCwd,
    home,
    stateDirectory,
  });
  const prepared = await call(firstClient, "prepare_native_change", {
    operation: "characteristic_value",
    target_ref: `${homeRef}/accessory/16/service/13/characteristic/15`,
    value: 30,
    reason: "Приглушить торшер",
  });
  const point = await call(firstClient, "configuration_point", {
    home_ref: homeRef,
    entity_refs: [`${homeRef}/scenario/3`],
  });
  await firstClient.close();

  assert.deepEqual(await readdir(firstCwd), []);
  const secondClient = await startClient(t, hub, {
    cwd: secondCwd,
    home,
    stateDirectory,
  });
  const change = await call(secondClient, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(change.status, "prepared");
  const points = await call(secondClient, "configuration_point", {
    home_ref: homeRef,
  });
  assert.deepEqual(
    points.points.map(({ point_ref }) => point_ref),
    [point.point_ref],
  );
  assert.deepEqual(await readdir(secondCwd), []);
}

// A network share or an exFAT disk has no hard links, and the journal's lock
// needs them. The owner hears that and what to do; reads go on.
test("a state directory without hard links names the reason for every write", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-no-links-");
  const client = await startClient(t, hub, {
    cwd: stateDirectory,
    home: stateDirectory,
    stateDirectory,
    preload: pathToFileURL(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "support",
        "no-hard-links.mjs",
      ),
    ).href,
  });

  const assertNamesTheReason = (error) => {
    assert.equal(
      error.code,
      "state_storage_unavailable",
      JSON.stringify(error),
    );
    assert.equal(error.action, "restore_state_storage_then_retry");
    assert.match(error.message, /hard links/i);
    assert.ok(error.message.includes(stateDirectory), error.message);
    assert.match(error.message, /SPRUT_AGENT_STATE_DIR/);
  };

  const overview = await call(client, "home_overview", {});
  assert.equal(overview.home.ref, homeRef);

  const room = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Кладовка",
      reason: "Завести кладовку",
    },
  });
  assert.equal(room.isError, true, room.content[0]?.text);
  assertNamesTheReason(room.structuredContent.error);

  const before = hub.requests.length;
  const command = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${homeRef}/accessory/12/service/13/characteristic/14`,
        value: true,
      },
    ],
    reason: "Включить свет",
  });
  const [item] = command.results;
  assert.equal(item.status, "not_sent", JSON.stringify(item));
  assertNamesTheReason(item.error);
  assert.deepEqual(
    hub.requests
      .slice(before)
      .filter(({ method }) => method === "characteristic.update"),
    [],
  );
});
