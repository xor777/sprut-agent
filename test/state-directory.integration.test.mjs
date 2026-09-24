import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

async function startClient(t, hub, { cwd, home, stateDirectory }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
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
  const point = await call(firstClient, "save_configuration_point", {
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
  const points = await call(secondClient, "list_configuration_points", {
    home_ref: homeRef,
  });
  assert.deepEqual(
    points.points.map(({ point_ref }) => point_ref),
    [point.point_ref],
  );
  assert.deepEqual(await readdir(secondCwd), []);
}
