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

// The owner renames a scenario, changes its description, has it run when
// the hub starts or run its actions one after another, for a BLOCK, a LOGIC
// and a GLOBAL, through the public MCP tools. The simulator changes these
// as the owner's 3.0.0 hub did on 2026-10-13 (research/protocol/
// 2026-10-13-wave4-contracts.md): only the scenario's options window
// changes them, and a LOGIC's code sets its name, description and onStart
// again on every code write.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const BLOCK = "5";
const LOGIC = "9";
const GLOBAL = "20";
const BUILT_IN = "21";
const LOGIC_NAME = "Защита от протечки";
const LOGIC_DESC = "Отключает розетку чайника при протечке под мойкой";

function scenarioRef(index) {
  return `${homeRef}/scenario/${index}`;
}

async function setup(t) {
  const fixture = await loadHomeFixture("apartment");
  fixture.scenarios.push(
    {
      index: GLOBAL,
      name: "Переменные дома",
      desc: "Общие флаги",
      type: "GLOBAL",
      active: true,
      data: "let away = false;",
    },
    {
      index: BUILT_IN,
      name: "Плавное включение",
      type: "LOGIC",
      predefined: true,
      active: true,
      onStart: true,
      data: [
        "info = {",
        '  name: "Плавное включение",',
        '  description: "Встроенная логика хаба",',
        "  onStart: true,",
        "  sourceServices: [HS.Lightbulb],",
        "  sourceCharacteristics: [HC.On],",
        "};",
        "function trigger() {}",
      ].join("\n"),
    },
  );
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-scenario-settings-"),
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
  const client = new Client({
    name: "scenario-settings-test",
    version: "1.0.0",
  });
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

async function change(client, index, optionKey, value) {
  const prepared = await call(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: scenarioRef(index),
    option_key: optionKey,
    value,
    reason: "Владелец попросил",
  });
  assert.equal(prepared.status, "prepared");
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  return prepared;
}

async function restore(client, prepared) {
  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
}

function scenarioOf(hub, index) {
  return hub.state.scenarios.find((scenario) => scenario.index === index);
}

// What the scenario's options window itself holds for a LOGIC (the window
// of a LOGIC keeps its own Name, Desc and OnStart).
function storedWindowValue(hub, index, key) {
  const window = hub.state.windows[scenarioOf(hub, index).optionsWindow];
  const value = window.options.find((option) => option.key === key).value;
  return Object.values(value)[0];
}

function windowRef(hub, index) {
  return `${homeRef}/window/${encodeURIComponent(scenarioOf(hub, index).optionsWindow)}`;
}

// The owner changes an option in the SprutHub app: its options window.
function ownerWritesWindow(hub, index, key, value) {
  const reply = hub.request({
    window: {
      update: {
        windowKey: scenarioOf(hub, index).optionsWindow,
        options: [{ key, value }],
      },
    },
  });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
}

// Requests since `from` that carry a scenario's name, description or
// flags in scenario.update, which SprutHub acknowledges and ignores.
function ignoredMetadataUpdates(hub, from) {
  return hub.requests
    .slice(from)
    .filter(
      ({ method, params }) =>
        method === "scenario.update" &&
        ["name", "desc", "onStart", "sync", "active"].some((field) =>
          Object.hasOwn(params.scenario.update, field),
        ),
    );
}

function changedKeys(before, after) {
  return diffHomeSnapshots(before, after).map(({ key }) => key);
}

test("window_option renames a BLOCK, a LOGIC and a GLOBAL, and restore puts each back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const logicSource = scenarioOf(hub, LOGIC).data;
  const renames = [
    [BLOCK, "Ночь"],
    [LOGIC, "Протечка под мойкой"],
    [GLOBAL, "Флаги дома"],
  ];
  const prepared = [];
  for (const [index, name] of renames) {
    const sentBefore = hub.requests.length;
    const renamed = await change(client, index, "Name", name);
    assert.deepEqual(renamed.diff.value, {
      from: initial[`scenario/${index}/name`],
      to: name,
      kind: "stringValue",
    });
    assert.equal(scenarioOf(hub, index).name, name);
    assert.deepEqual(ignoredMetadataUpdates(hub, sentBefore), []);
    prepared.push(renamed);
  }

  // The LOGIC's code changes only in info.name, shown before apply, so its
  // next code write keeps the new name; its window shows the name too.
  const logicRename = prepared[1];
  assert.deepEqual(logicRename.logic_source.edits, [
    {
      field: "info.name",
      line: 2,
      from: LOGIC_NAME,
      to: "Протечка под мойкой",
    },
  ]);
  const renamedSource = logicSource.replace(
    `name: "${LOGIC_NAME}"`,
    'name: "Протечка под мойкой"',
  );
  assert.notEqual(renamedSource, logicSource);
  assert.equal(scenarioOf(hub, LOGIC).data, renamedSource);
  assert.equal(storedWindowValue(hub, LOGIC, "Name"), "Протечка под мойкой");
  assert.equal(prepared[0].logic_source, undefined);
  assert.equal(prepared[2].logic_source, undefined);
  assert.deepEqual(
    changedKeys(initial, hub.snapshot()),
    [
      `scenario/${BLOCK}/name`,
      `scenario/${LOGIC}/data`,
      `scenario/${LOGIC}/name`,
      `scenario/${GLOBAL}/name`,
    ].sort(),
  );

  for (const renamed of prepared.reverse()) await restore(client, renamed);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, logicSource);
  assert.equal(storedWindowValue(hub, LOGIC, "Name"), LOGIC_NAME);
});

test("a LOGIC renamed with window_option keeps its name through a later code edit that its restore does not drop, and a code edit that sets a name back says so", async (t) => {
  const { hub, client } = await setup(t);
  const renamed = await change(client, LOGIC, "Name", "Протечка под мойкой");

  // A later edit of the code as the hub now holds it keeps the name.
  const entity = await call(client, "get_entity", {
    entity_ref: scenarioRef(LOGIC),
    include: ["configuration"],
  });
  const edited = entity.entity.configuration.value.replace(
    'log("Протечка: розетка чайника отключена")',
    'log("Протечка под мойкой: розетка отключена")',
  );
  assert.notEqual(edited, entity.entity.configuration.value);
  const update = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: edited,
    reason: "Поменять запись в журнале",
  });
  assert.equal(update.code_sets_back, undefined);
  assert.equal(update.diff.editable_flags.to.name, "Протечка под мойкой");
  const applied = await call(client, "apply_native_change", {
    change_ref: update.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.equal(scenarioOf(hub, LOGIC).data, edited);
  assert.equal(scenarioOf(hub, LOGIC).name, "Протечка под мойкой");

  // The rename's restore would put back the code from before it and drop
  // the later edit, so it refuses while that edit stands.
  const writesBefore = hub.writes().length;
  const refused = await call(client, "restore_native_change", {
    change_ref: renamed.change_ref,
  });
  assert.equal(refused.status, "conflict");
  assert.equal(hub.writes().length, writesBefore);
  assert.equal(scenarioOf(hub, LOGIC).data, edited);

  // The owner renames it in the app: only the window, the code keeps its
  // info.name. A code edit that keeps that info.name would set the name
  // back, and its preview says so before anything is sent.
  ownerWritesWindow(hub, LOGIC, "Name", { stringValue: "Имя из приложения" });
  assert.equal(scenarioOf(hub, LOGIC).name, "Имя из приложения");
  const sentBefore = hub.requests.length;
  const reverting = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: edited.replace("setValue(false);", "setValue(false); // чайник"),
    reason: "Пояснить код",
  });
  assert.equal(reverting.status, "prepared");
  assert.deepEqual(reverting.code_sets_back, [
    {
      field: "name",
      from: "Имя из приложения",
      to: "Протечка под мойкой",
    },
  ]);
  assert.equal(reverting.warnings.length, 1);
  assert.deepEqual(
    hub.requests.slice(sentBefore).filter(({ write }) => write),
    [],
  );
});

test("OnStart and Sync of a BLOCK, a LOGIC and a GLOBAL change through window_option and restore", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const logicSource = scenarioOf(hub, LOGIC).data;
  const prepared = [];
  for (const index of [BLOCK, LOGIC, GLOBAL]) {
    for (const [key, field] of [
      ["OnStart", "onStart"],
      ["Sync", "sync"],
    ]) {
      const from = initial[`scenario/${index}/${field}`];
      assert.equal(typeof from, "boolean");
      const sentBefore = hub.requests.length;
      const switched = await change(client, index, key, !from);
      assert.deepEqual(switched.diff.value, {
        from,
        to: !from,
        kind: "boolValue",
      });
      assert.equal(scenarioOf(hub, index)[field], !from, `${index} ${key}`);
      assert.deepEqual(ignoredMetadataUpdates(hub, sentBefore), []);
      prepared.push(switched);
    }
  }

  // The LOGIC's onStart is also its info.onStart, so a code write keeps
  // it; sync is not in its code.
  const [logicOnStart, logicSync] = prepared.slice(2, 4);
  assert.deepEqual(logicOnStart.logic_source.edits, [
    { field: "info.onStart", line: 6, from: false, to: true },
  ]);
  assert.equal(logicSync.logic_source, undefined);
  const onStartSource = logicSource.replace("onStart: false", "onStart: true");
  assert.notEqual(onStartSource, logicSource);
  assert.equal(scenarioOf(hub, LOGIC).data, onStartSource);
  hub.request({ scenario: { update: { index: LOGIC, data: onStartSource } } });
  assert.equal(scenarioOf(hub, LOGIC).onStart, true);
  assert.deepEqual(
    changedKeys(initial, hub.snapshot()),
    [BLOCK, LOGIC, GLOBAL]
      .flatMap((index) => [
        `scenario/${index}/onStart`,
        `scenario/${index}/sync`,
      ])
      .concat(`scenario/${LOGIC}/data`)
      .sort(),
  );

  for (const switched of prepared.reverse()) await restore(client, switched);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, logicSource);
});

test("a description change of a LOGIC renamed in the app keeps that name, and restore puts back code, name and description", async (t) => {
  const { hub, client } = await setup(t);
  const source = scenarioOf(hub, LOGIC).data;
  // Renamed in the app: the code still says the old info.name, so any
  // code write would bring the old name back.
  ownerWritesWindow(hub, LOGIC, "Name", { stringValue: "Имя из приложения" });
  const before = hub.snapshot();

  const described = await change(client, LOGIC, "Desc", "Новое описание");
  assert.deepEqual(described.diff.value, {
    from: LOGIC_DESC,
    to: "Новое описание",
    kind: "stringValue",
  });
  assert.deepEqual(described.logic_source.edits, [
    {
      field: "info.name",
      line: 2,
      from: LOGIC_NAME,
      to: "Имя из приложения",
    },
    {
      field: "info.description",
      line: 3,
      from: LOGIC_DESC,
      to: "Новое описание",
    },
  ]);
  assert.equal(described.warnings.length, 1);
  assert.equal(scenarioOf(hub, LOGIC).name, "Имя из приложения");
  assert.equal(scenarioOf(hub, LOGIC).desc, "Новое описание");
  assert.equal(
    scenarioOf(hub, LOGIC).data,
    source
      .replace(`name: "${LOGIC_NAME}"`, 'name: "Имя из приложения"')
      .replace(`description: "${LOGIC_DESC}"`, 'description: "Новое описание"'),
  );

  await restore(client, described);
  assert.deepEqual(diffHomeSnapshots(before, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
  assert.equal(scenarioOf(hub, LOGIC).name, "Имя из приложения");
});

test("current name and flags come from the scenario, not from a LOGIC's window that kept older ones", async (t) => {
  const { hub, client } = await setup(t);
  // The app renamed it through the window, then its code was written
  // again with the old info.name: the scenario has that name back, the
  // window still shows the app's.
  ownerWritesWindow(hub, LOGIC, "Name", { stringValue: "Имя из приложения" });
  hub.request({
    scenario: {
      update: { index: LOGIC, data: scenarioOf(hub, LOGIC).data },
    },
  });
  assert.equal(scenarioOf(hub, LOGIC).name, LOGIC_NAME);
  assert.equal(storedWindowValue(hub, LOGIC, "Name"), "Имя из приложения");

  const entity = await call(client, "get_entity", {
    entity_ref: scenarioRef(LOGIC),
  });
  const shown = Object.fromEntries(
    entity.entity.metadata_options.map((option) => [
      option.key,
      option.configured_value,
    ]),
  );
  assert.deepEqual(shown, {
    Name: LOGIC_NAME,
    Desc: LOGIC_DESC,
    OnStart: false,
    Sync: false,
  });
  const nameOption = entity.entity.metadata_options.find(
    ({ key }) => key === "Name",
  );
  assert.deepEqual(nameOption.native_change.next, {
    tool: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: scenarioRef(LOGIC),
      option_key: "Name",
    },
  });

  const renamed = await call(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: scenarioRef(LOGIC),
    option_key: "Name",
    value: "Протечка",
    reason: "Короче",
  });
  assert.equal(renamed.diff.value.from, LOGIC_NAME);
});

test("built-in scenarios and a LOGIC whose info cannot be edited are refused before anything is sent", async (t) => {
  const { hub, client } = await setup(t);
  for (const [optionKey, value] of [
    ["Name", "Своё имя"],
    ["Desc", "Своё описание"],
    ["OnStart", false],
    ["Sync", true],
  ]) {
    const refused = await refusal(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: scenarioRef(BUILT_IN),
      option_key: optionKey,
      value,
      reason: "Владелец попросил",
    });
    assert.equal(refused.error.code, "predefined_scenario_read_only");
  }
  const contract = await refusal(client, "get_native_change_contract", {
    operation: "window_option",
    target_ref: scenarioRef(BUILT_IN),
    option_key: "Name",
  });
  assert.equal(contract.error.code, "predefined_scenario_read_only");

  // info.name built from parts cannot be rewritten as a plain value.
  hub.request({
    scenario: {
      update: {
        index: LOGIC,
        data: scenarioOf(hub, LOGIC).data.replace(
          `name: "${LOGIC_NAME}"`,
          'name: "Защита " + "от протечки"',
        ),
      },
    },
  });
  const sentBefore = hub.requests.length;
  const unparsed = await refusal(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: scenarioRef(LOGIC),
    option_key: "Name",
    value: "Протечка",
    reason: "Короче",
  });
  assert.equal(unparsed.error.code, "logic_info_not_editable");
  assert.deepEqual(
    hub.requests.slice(sentBefore).filter(({ write }) => write),
    [],
  );
  // Sync is not in the code, so it still changes, by the window alone.
  await change(client, LOGIC, "Sync", true);
  assert.equal(scenarioOf(hub, LOGIC).sync, true);
  assert.deepEqual(
    hub.requests
      .slice(sentBefore)
      .filter(({ write }) => write)
      .map(({ method }) => method),
    ["window.update"],
  );
});

test("a scenario's options window written by its window ref points to the scenario ref", async (t) => {
  const { hub, client } = await setup(t);
  for (const index of [BLOCK, LOGIC, GLOBAL]) {
    for (const [optionKey, value] of [
      ["Name", "Другое имя"],
      ["OnStart", true],
    ]) {
      const refused = await refusal(client, "prepare_native_change", {
        operation: "window_option",
        target_ref: windowRef(hub, index),
        option_key: optionKey,
        value,
        reason: "Владелец попросил",
      });
      assert.equal(refused.error.code, "scenario_owner_required");
      assert.deepEqual(refused.next.arguments, {
        operation: "window_option",
        target_ref: scenarioRef(index),
        option_key: optionKey,
      });
    }
  }
  assert.deepEqual(hub.writes(), []);
});
