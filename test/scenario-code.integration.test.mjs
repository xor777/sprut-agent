import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  COLOR_SCENES,
  COLOR_SCENES_SOURCE,
  SCENE_LAMPS_LINE,
  withColorScenes,
} from "./fixtures/homes/color-scenes.mjs";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The owner's colour scenes are code (research/protocol/
// 2026-10-23-scenario-code.md 1.1, 1.2): a GLOBAL keeps the scene lamps
// and paints them, BLOCKs call it. «Добавь ночник в цветные сцены» is an
// edit of that GLOBAL's code. On the hub its code runs as soon as it is
// written, and what it assigned to global stays until the hub restarts,
// whatever is written or deleted later (3.2-3.10); error tells that the
// stored code did not compile or run (2.9-2.11, 3.7-3.9).
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const globalRef = `${homeRef}/scenario/${COLOR_SCENES}`;
const WITH_NIGHT_LIGHT = "global.COLOR_SCENE_LIGHTS = [15, 16, 17, 63, 26];";

async function setup(t, patch = (fixture) => fixture) {
  const fixture = patch(withColorScenes(await loadHomeFixture("apartment")));
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-scenario-code-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "scenario-code-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function refusal(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent;
}

function scenarioOf(hub, index) {
  return hub.state.scenarios.find((scenario) => scenario.index === index);
}

function writesSince(hub, from) {
  return hub.requests.slice(from).filter(({ write }) => write);
}

function prepareGlobal(client, source) {
  return client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: globalRef,
      source,
      reason: "Добавить ночник в цветные сцены",
    },
  });
}

test("«добавь ночник в цветные сцены» changes one line of the GLOBAL: prepare shows that line and that the code runs at apply, apply writes only it, and restore puts the old code back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const entity = await call(client, "get_entity", {
    entity_ref: globalRef,
    include: ["configuration"],
  });
  assert.equal(entity.entity.configuration.value, COLOR_SCENES_SOURCE);
  const source = COLOR_SCENES_SOURCE.replace(
    SCENE_LAMPS_LINE,
    WITH_NIGHT_LIGHT,
  );

  const sentBefore = hub.requests.length;
  const prepared = (await prepareGlobal(client, source)).structuredContent;
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.deepEqual(writesSince(hub, sentBefore), []);
  // The changed line, not the whole code.
  assert.deepEqual(prepared.code_diff, [
    { line: 2, removed: [SCENE_LAMPS_LINE], added: [WITH_NIGHT_LIGHT] },
  ]);
  assert.equal(prepared.executes_on_apply, true);
  assert.equal(prepared.hub_memory_kept, true);
  // A GLOBAL's code does not set its name or description.
  assert.equal(prepared.code_sets, undefined);
  assert.equal(prepared.diff.editable_flags.to.name, "Цветные сцены");
  assert.equal(prepared.next?.tool, "apply_native_change");

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(applied.hub_code_error, false);
  assert.equal(applied.tell_owner, undefined);
  assert.equal(scenarioOf(hub, COLOR_SCENES).data, source);
  assert.deepEqual(
    diffHomeSnapshots(initial, hub.snapshot()).map(({ key }) => key),
    [`scenario/${COLOR_SCENES}/data`],
  );

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.hub_memory_kept, true);
  assert.equal(scenarioOf(hub, COLOR_SCENES).data, COLOR_SCENES_SOURCE);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

test("a GLOBAL edited in the app between prepare and apply is a conflict, and the owner's code stays", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = (
    await prepareGlobal(
      client,
      COLOR_SCENES_SOURCE.replace(SCENE_LAMPS_LINE, WITH_NIGHT_LIGHT),
    )
  ).structuredContent;
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const byHand = COLOR_SCENES_SOURCE.replace(
    SCENE_LAMPS_LINE,
    "global.COLOR_SCENE_LIGHTS = [15, 16];",
  );
  const reply = hub.request({
    scenario: { update: { index: COLOR_SCENES, data: byHand } },
  });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));

  const sentBefore = hub.requests.length;
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "conflict", JSON.stringify(applied));
  assert.equal(applied.conflict_reason, "baseline_changed");
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.equal(scenarioOf(hub, COLOR_SCENES).data, byHand);
});

test("GLOBAL code the hub's JavaScript does not know is refused before anything is sent, with its line and what to write instead", async (t) => {
  const { hub, client } = await setup(t);
  const sentBefore = hub.requests.length;
  for (const [line, construct] of [
    ["var first = global.COLOR_SCENE_LIGHTS?.[0];", "?."],
    ["var lamps = [...global.COLOR_SCENE_LIGHTS];", "..."],
    ["var { ocean } = PALETTES;", "destructuring"],
    ["class Scene {}", "class"],
    ["var level = 2 ** 3;", "**"],
    ["var known = global.COLOR_SCENE_LIGHTS.includes(26);", ".includes"],
  ]) {
    const refused = await prepareGlobal(
      client,
      `${COLOR_SCENES_SOURCE}${line}\n`,
    );
    assert.equal(refused.isError, true, line);
    const { error, problems } = refused.structuredContent;
    assert.equal(error.code, "unsupported_javascript", line);
    assert.deepEqual(
      problems.map((problem) => [problem.line, problem.construct]),
      [[COLOR_SCENES_SOURCE.split("\n").length, construct]],
      line,
    );
  }
  const broken = await prepareGlobal(
    client,
    COLOR_SCENES_SOURCE.replace("var PALETTES = {", "var PALETTES = {{"),
  );
  assert.equal(broken.isError, true);
  assert.equal(broken.structuredContent.error.code, "invalid_javascript");
  assert.equal(broken.structuredContent.problems[0].line, 4);
  assert.deepEqual(writesSince(hub, sentBefore), []);
});

test("code the hub stores with error after the write is named in the apply result with an offer to put the old code back, not a silent success", async (t) => {
  const { hub, client } = await setup(t);
  // Parses, but throws when the hub runs it: SprutHub keeps it and sets
  // error (2026-10-23-scenario-code 3.8).
  const source = COLOR_SCENES_SOURCE.replace(
    SCENE_LAMPS_LINE,
    "global.COLOR_SCENE_LIGHTS = SCENE_LAMPS.concat([26]);",
  );
  const prepared = (await prepareGlobal(client, source)).structuredContent;
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, COLOR_SCENES).error, true);
  assert.equal(applied.hub_code_error, true);
  assert.equal(typeof applied.tell_owner, "string");
  assert.deepEqual(applied.offer, {
    tool: "restore_native_change",
    arguments: { change_ref: prepared.change_ref },
  });
  // Offered, not a next call the agent follows on its own.
  assert.equal(applied.next, undefined);
  const read = await call(client, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(read.hub_code_error, true);

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(scenarioOf(hub, COLOR_SCENES).data, COLOR_SCENES_SOURCE);
  assert.equal(scenarioOf(hub, COLOR_SCENES).error, false);
});

test("a GLOBAL edit names the devices its changed lines act on", async (t) => {
  const { client } = await setup(t);
  const prepared = (
    await prepareGlobal(
      client,
      `${COLOR_SCENES_SOURCE}global.deskLampOn = function () {\n  Hub.setCharacteristicValue(32, 14, true);\n};\n`,
    )
  ).structuredContent;
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.deepEqual(
    prepared.code_mentions.map(({ accessory_ref, name }) => [
      accessory_ref,
      name,
    ]),
    [[`${homeRef}/accessory/32`, "Настольная лампа"]],
  );
  // Lines the edit leaves alone are not searched: 15, 16 and 17 stay
  // unnamed although the list holds them.
  const unchanged = (
    await prepareGlobal(
      client,
      COLOR_SCENES_SOURCE.replace(SCENE_LAMPS_LINE, WITH_NIGHT_LIGHT),
    )
  ).structuredContent;
  assert.equal(unchanged.code_mentions, undefined);
});

test("a GLOBAL whose code reads as [REDACTED] is not rewritten: the agent cannot see what it would replace", async (t) => {
  const keyed = [
    'global.CAMERA = "http://camera.local/snapshot?token=f81d4fae7dec";',
    "global.COLOR_SCENE_LIGHTS = [15];",
  ].join("\n");
  const { hub, client } = await setup(t, (fixture) => {
    fixture.scenarios.find(({ index }) => index === COLOR_SCENES).data = keyed;
    return fixture;
  });
  const entity = await call(client, "get_entity", {
    entity_ref: globalRef,
    include: ["configuration"],
  });
  assert.equal(entity.entity.configuration.value, "[REDACTED]");
  const sentBefore = hub.requests.length;
  const refused = await refusal(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: globalRef,
    source: "global.COLOR_SCENE_LIGHTS = [15, 26];\n",
    reason: "Добавить ночник",
  });
  assert.equal(refused.error.code, "hidden_code");
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.equal(scenarioOf(hub, COLOR_SCENES).data, keyed);
});
