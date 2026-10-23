import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The owner asks the agent to delete a scenario, then perhaps to put it
// back, through the public MCP tools. The simulator deletes as the owner's
// 3.0.0 hub did on 2026-10-23 (research/protocol/2026-10-23-scenario-
// delete.md): the other scenarios keep their numbers, a deleted number is
// not given out again, scenario targets of other BLOCKs keep pointing at
// it, and a LOGIC's device assignments go with it.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const NIGHT = "5"; // «Ночной режим», run by RUNNER
const STUDY_OFF = "8"; // «Выключить свет в кабинете», nothing depends on it
const LEAK = "9"; // LOGIC «Защита от протечки», assigned to the leak sensor
const COLORS = "20"; // GLOBAL that sets global.colorScene
const MOVIE = "21"; // BLOCK whose code calls global.colorScene
const GLOW = "22"; // LOGIC whose code calls global.colorScene
const RUNNER = "23"; // BLOCK that runs NIGHT
const ALARM = "SecuritySystem"; // built-in LOGIC

function scenarioRef(index) {
  return `${homeRef}/scenario/${index}`;
}

async function setup(t) {
  const fixture = await loadHomeFixture("apartment");
  fixture.scenarios.push(
    {
      index: COLORS,
      name: "Color scenes",
      desc: "Цветовые сцены для кнопок",
      type: "GLOBAL",
      active: true,
      onStart: true,
      data: [
        "global.colorScene = function (room, scene) {",
        '  log.info("scene " + room + " " + scene);',
        "};",
        'global["dimAll"] = function () {};',
      ].join("\n"),
    },
    {
      index: MOVIE,
      name: "Сцена: кино",
      type: "BLOCK",
      active: true,
      data: {
        targets: [
          { type: "code", code: 'global.colorScene("Гостиная", "кино");' },
        ],
      },
    },
    {
      index: GLOW,
      name: "Подсветка по сцене",
      type: "LOGIC",
      active: true,
      data: [
        "info = {",
        '  name: "Подсветка по сцене",',
        '  description: "Включает сцену по датчику",',
        "  onStart: false,",
        "  sourceServices: [HS.Lightbulb],",
        "  sourceCharacteristics: [HC.On],",
        "};",
        "function trigger(source, value) {",
        '  if (value) global.colorScene("Спальня", "ночь");',
        "}",
      ].join("\n"),
    },
    {
      index: RUNNER,
      name: "Кнопка: ночь",
      type: "BLOCK",
      active: true,
      data: {
        targets: [{ type: "scenario", index: NIGHT, mode: "FIRE" }],
      },
    },
    {
      index: ALARM,
      name: "Сигнализация",
      type: "LOGIC",
      predefined: true,
      active: true,
      data: [
        "info = {",
        '  name: "Сигнализация",',
        '  description: "Встроенная логика хаба",',
        "  onStart: false,",
        "  sourceServices: [HS.SecuritySystem],",
        "  sourceCharacteristics: [HC.SecuritySystemTargetState],",
        "};",
        "function trigger() {}",
      ].join("\n"),
    },
  );
  const hooks = {};
  const hub = await startSimulatedHub(fixture, {
    onRequest: (request) => hooks.onRequest?.(request),
  });
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-scenario-delete-"),
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
  const client = new Client({ name: "scenario-delete-test", version: "1.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, hooks };
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

function prepareDelete(client, index) {
  return call(client, "prepare_native_change", {
    operation: "scenario_delete",
    target_ref: scenarioRef(index),
    reason: "Владелец попросил удалить сценарий",
  });
}

function scenarioOf(hub, index) {
  return hub.state.scenarios.find((scenario) => scenario.index === index);
}

function writes(hub, from = 0) {
  return hub.requests.slice(from).filter(({ write }) => write);
}

// What the owner set on a scenario: everything a recreate has to bring back.
function configuration(scenario) {
  const { type, name, desc, active, onStart, sync, data } = scenario;
  return { type, name, desc, active, onStart, sync, data };
}

// The keys of the home snapshot that changed, apart from one scenario.
function changedBesides(before, after, index) {
  return diffHomeSnapshots(before, after)
    .map(({ key }) => key)
    .filter((key) => !key.startsWith(`scenario/${index}/`));
}

test("deletes a scenario nothing depends on and puts it back under a new number", async (t) => {
  const { hub, client } = await setup(t);
  const before = hub.snapshot();
  const original = configuration(scenarioOf(hub, STUDY_OFF));

  const prepared = await prepareDelete(client, STUDY_OFF);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.equal(prepared.scenario.name, "Выключить свет в кабинете");
  assert.equal(prepared.tell_owner, undefined, prepared.tell_owner);
  assert.equal(prepared.next?.tool, "apply_native_change");
  // The delete can be undone: an agent told otherwise asks the owner again
  // (eval delete-fumigator-scenario, Sonnet 5, 2026-10-23).
  assert.equal(prepared.restore_supported, true);
  assert.deepEqual(writes(hub), []);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, STUDY_OFF), undefined);
  // Only that scenario went; the others keep their numbers and settings.
  assert.deepEqual(changedBesides(before, hub.snapshot(), STUDY_OFF), []);
  assert.deepEqual(
    writes(hub).map(({ method }) => method),
    ["scenario.delete"],
  );

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  const recreatedIndex = decodeURIComponent(
    restored.recreated.scenario_ref.split("/").at(-1),
  );
  assert.notEqual(recreatedIndex, STUDY_OFF);
  assert.equal(scenarioOf(hub, STUDY_OFF), undefined);
  assert.deepEqual(
    configuration(scenarioOf(hub, recreatedIndex)),
    original,
    "same name, description, data, on/off, start and sync",
  );
  assert.equal(restored.recreated.name, original.name);
  assert.match(restored.limitations.join(" "), /new number/);
});

test("names the scenarios whose code uses what a GLOBAL sets and writes nothing", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareDelete(client, COLORS);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.equal(typeof prepared.tell_owner, "string");
  assert.equal(prepared.next, undefined, "no apply before the owner hears");
  const users = prepared.dependencies.code_users
    .map(({ name, uses }) => `${name}: ${uses.join(",")}`)
    .sort();
  assert.deepEqual(users, [
    "Подсветка по сцене: colorScene",
    "Сцена: кино: colorScene",
  ]);
  assert.equal(prepared.dependencies.scenario_targets, undefined);
  assert.deepEqual(writes(hub), []);
  assert.ok(scenarioOf(hub, COLORS));
});

test("names the BLOCK that runs a deleted scenario, and its undo names it as not restored", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareDelete(client, NIGHT);
  assert.equal(typeof prepared.tell_owner, "string");
  assert.equal(prepared.next, undefined);
  assert.deepEqual(
    prepared.dependencies.scenario_targets.map(({ name, mode }) => [
      name,
      mode,
    ]),
    [["Кнопка: ночь", "FIRE"]],
  );
  const runnerData = scenarioOf(hub, RUNNER).data;

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, NIGHT), undefined);
  assert.equal(scenarioOf(hub, RUNNER).data, runnerData, "left as it was");

  // «Верни как было» for the request: its changes in change_refs.
  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored));
  const [item] = restored.results;
  assert.equal(item.status, "restored", JSON.stringify(item));
  assert.equal(item.recreated.name, "Ночной режим");
  assert.ok(scenarioOf(hub, item.recreated.scenario_ref.split("/").at(-1)));
  assert.deepEqual(
    item.not_restored.scenario_targets.map(({ name }) => name),
    ["Кнопка: ночь"],
  );
});

test("a LOGIC's device assignments go with it and do not come back", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareDelete(client, LEAK);
  assert.equal(typeof prepared.tell_owner, "string");
  assert.equal(prepared.dependencies.logic_assignments.length, 1);
  assert.equal(
    prepared.dependencies.logic_assignments[0].service_ref,
    `${homeRef}/accessory/23/service/13`,
  );

  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.deepEqual(
    hub.state.logics.filter(({ type }) => type === LEAK),
    [],
  );
  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.not_restored.logic_assignments.length, 1);
  const recreated = hub.state.scenarios.find(
    ({ name }) => name === "Защита от протечки",
  );
  assert.ok(recreated && recreated.index !== LEAK);
  assert.deepEqual(
    hub.state.logics.filter(({ type }) => type === recreated.index),
    [],
  );
});

test("finds a LOGIC's assignments when a device disappears during the scan", async (t) => {
  const { hub, client, hooks } = await setup(t);
  // The first logic.list removes another device, as an owner or another
  // client deletes it meanwhile: its own logic.list then finds nothing.
  hooks.onRequest = (request) => {
    if (request.method !== "logic.list") return;
    hooks.onRequest = undefined;
    const gone = hub.state.accessories.findLast(({ id }) => id !== 23);
    hub.state.accessories = hub.state.accessories.filter(
      (accessory) => accessory !== gone,
    );
  };
  const prepared = await prepareDelete(client, LEAK);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  assert.equal(prepared.dependencies.logic_assignments.length, 1);
});

test("refuses a built-in scenario without writing", async (t) => {
  const { hub, client } = await setup(t);
  const refused = await refusal(client, "prepare_native_change", {
    operation: "scenario_delete",
    target_ref: scenarioRef(ALARM),
    reason: "Владелец попросил удалить сигнализацию",
  });
  assert.equal(
    refused.error.code,
    "built_in_scenario",
    JSON.stringify(refused),
  );
  assert.deepEqual(writes(hub), []);
  assert.ok(scenarioOf(hub, ALARM));
});

test("an edit by hand between prepare and apply is a conflict, not a delete", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareDelete(client, STUDY_OFF);
  const scenario = scenarioOf(hub, STUDY_OFF);
  scenario.data = scenario.data.replace('"false"', '"true"');
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "conflict", JSON.stringify(applied));
  assert.ok(scenarioOf(hub, STUDY_OFF));
  assert.deepEqual(writes(hub), []);
});

test("a lost delete reply is settled by reading the home", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareDelete(client, STUDY_OFF);
  hub.state.faults.droppedReply.push({
    method: "scenario.delete",
    remaining: 1,
  });
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, STUDY_OFF), undefined);
});

test("a lost create reply on undo is found by the scenario's fields", async (t) => {
  const { hub, client } = await setup(t);
  const original = configuration(scenarioOf(hub, STUDY_OFF));
  const prepared = await prepareDelete(client, STUDY_OFF);
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  hub.state.faults.droppedReply.push({
    method: "scenario.create",
    remaining: 1,
  });
  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  const copies = hub.state.scenarios.filter(
    ({ name }) => name === original.name,
  );
  assert.equal(copies.length, 1, "created once");
  assert.equal(restored.recreated.scenario_ref, scenarioRef(copies[0].index));
  // Undoing again does not create another copy.
  const again = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(again.status, "restored");
  assert.equal(
    hub.state.scenarios.filter(({ name }) => name === original.name).length,
    1,
  );
});
