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

// The agent's own changes of one scenario form one chain: a later one in
// effect makes an earlier one name it (later_owned_change) instead of
// counting as a change by hand, and undoing them newest first puts the
// scenario back. A LOGIC's Name, Desc and OnStart all write its code.

async function codeUpdate(client, source, reason) {
  const prepared = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source,
    reason,
  });
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  return prepared;
}

function writesSince(hub, from) {
  return hub.requests.slice(from).filter(({ write }) => write);
}

function assertNamesLater(result, later) {
  assert.equal(result.status, "conflict", JSON.stringify(result));
  assert.equal(result.conflict_reason, "later_owned_change");
  assert.equal(result.restore_first_change_ref, later.change_ref);
  assert.equal(result.manual_change_observed, undefined);
}

test("a LOGIC renamed and then described names the description change while it stands, and «верни как было» puts both back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const source = scenarioOf(hub, LOGIC).data;
  const renamed = await change(client, LOGIC, "Name", "Протечка под мойкой");
  const described = await change(client, LOGIC, "Desc", "Новое описание");
  assert.equal(scenarioOf(hub, LOGIC).name, "Протечка под мойкой");
  assert.equal(scenarioOf(hub, LOGIC).desc, "Новое описание");

  // The agent's own description change wrote the code after the rename:
  // that is no change by hand.
  const read = await call(client, "get_native_change", {
    change_ref: renamed.change_ref,
  });
  assertNamesLater(read, described);

  const sentBefore = hub.requests.length;
  const undone = await call(client, "restore_native_change", {
    change_refs: [renamed.change_ref, described.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone.results));
  assert.deepEqual(
    undone.results.map(({ change_ref: ref, status }) => [ref, status]),
    [
      [described.change_ref, "restored"],
      [renamed.change_ref, "restored"],
    ],
  );
  assert.notDeepEqual(writesSince(hub, sentBefore), []);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
});

test("restoring a LOGIC's rename before the later description change names that change, writes nothing, and works once it is undone", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const source = scenarioOf(hub, LOGIC).data;
  const renamed = await change(client, LOGIC, "Name", "Протечка под мойкой");
  const described = await change(client, LOGIC, "Desc", "Новое описание");

  const sentBefore = hub.requests.length;
  const early = await call(client, "restore_native_change", {
    change_ref: renamed.change_ref,
  });
  assertNamesLater(early, described);
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.equal(scenarioOf(hub, LOGIC).name, "Протечка под мойкой");

  await restore(client, described);
  assert.equal(scenarioOf(hub, LOGIC).desc, LOGIC_DESC);
  assert.equal(scenarioOf(hub, LOGIC).name, "Протечка под мойкой");
  await restore(client, renamed);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
});

test("a LOGIC's rename and the agent's later code edit name each other's order in both directions and come back newest first", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const source = scenarioOf(hub, LOGIC).data;

  // Rename, then a code edit of the code as it now is.
  const renamed = await change(client, LOGIC, "Name", "Протечка под мойкой");
  const edited = await codeUpdate(
    client,
    scenarioOf(hub, LOGIC).data.replace(
      'log("Протечка: розетка чайника отключена")',
      'log("Протечка: розетка отключена")',
    ),
    "Короче запись в журнале",
  );
  let sentBefore = hub.requests.length;
  assertNamesLater(
    await call(client, "restore_native_change", {
      change_ref: renamed.change_ref,
    }),
    edited,
  );
  assert.deepEqual(writesSince(hub, sentBefore), []);
  await restore(client, edited);
  await restore(client, renamed);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, source);

  // A code edit, then a rename that writes the code again.
  const recoded = await codeUpdate(
    client,
    source.replace(
      'log("Протечка: розетка чайника отключена")',
      'log("Протечка: чайник отключён")',
    ),
    "Понятнее запись в журнале",
  );
  const renamedAfter = await change(client, LOGIC, "Name", "Мойка");
  sentBefore = hub.requests.length;
  const early = await call(client, "restore_native_change", {
    change_ref: recoded.change_ref,
  });
  assert.equal(early.status, "conflict", JSON.stringify(early));
  assert.equal(early.conflict_reason, "later_owned_change");
  assert.equal(early.restore_first_change_ref, renamedAfter.change_ref);
  assert.deepEqual(writesSince(hub, sentBefore), []);
  const undone = await call(client, "restore_native_change", {
    change_refs: [recoded.change_ref, renamedAfter.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone.results));
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
});

test("a restore of a LOGIC's description that stops after its code write is retried and brings back the name given in the app", async (t) => {
  const { hub, client } = await setup(t);
  const source = scenarioOf(hub, LOGIC).data;
  ownerWritesWindow(hub, LOGIC, "Name", { stringValue: "Имя из приложения" });
  const before = hub.snapshot();
  const described = await change(client, LOGIC, "Desc", "Новое описание");

  // The hub refuses the first window write after the code went back: the
  // code set the name from its info, the app's name is not back yet.
  hub.refuseNext("window.update", { code: -32000, message: "Busy" });
  const stopped = await call(client, "restore_native_change", {
    change_ref: described.change_ref,
  });
  assert.notEqual(stopped.status, "restored");
  assert.equal(stopped.manual_change_observed, undefined);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
  assert.equal(scenarioOf(hub, LOGIC).name, LOGIC_NAME);

  await restore(client, described);
  assert.deepEqual(diffHomeSnapshots(before, hub.snapshot()), []);
  assert.equal(scenarioOf(hub, LOGIC).name, "Имя из приложения");
  assert.equal(scenarioOf(hub, LOGIC).data, source);
});

test("a BLOCK's data change and its OnStart, Sync and Name changes are prepared on one baseline and undone in any order", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const data = JSON.parse(scenarioOf(hub, BLOCK).data);
  data.targets[0].then[1].characteristics[1].value = "20";
  const dataChange = await call(client, "prepare_native_change", {
    operation: "block_data_update",
    target_ref: scenarioRef(BLOCK),
    data,
    reason: "Ночник ярче",
  });
  const onStart = await change(client, BLOCK, "OnStart", true);
  const sync = await change(client, BLOCK, "Sync", true);
  const renamed = await change(client, BLOCK, "Name", "Ночь");

  // Prepared before the flags and name changed, the data change still
  // applies: it writes only data.
  const applied = await call(client, "apply_native_change", {
    change_ref: dataChange.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));

  // Undone oldest first: each puts back only its own field.
  for (const prepared of [onStart, sync, renamed]) {
    await restore(client, prepared);
  }
  await restore(client, dataChange);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);

  // Applied in the other order and undone flags first.
  const later = await call(client, "prepare_native_change", {
    operation: "block_data_update",
    target_ref: scenarioRef(BLOCK),
    data,
    reason: "Ночник ярче",
  });
  const onStartAgain = await change(client, BLOCK, "OnStart", true);
  assert.equal(
    (
      await call(client, "apply_native_change", {
        change_ref: later.change_ref,
      })
    ).status,
    "applied",
  );
  await restore(client, onStartAgain);
  await restore(client, later);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

test("a LOGIC's Sync, which its code does not set, and a code edit are prepared on one baseline and undone in any order", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const code = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: scenarioOf(hub, LOGIC).data.replace(
      'log("Протечка: розетка чайника отключена")',
      'log("Протечка: розетка отключена")',
    ),
    reason: "Короче запись в журнале",
  });
  const sync = await change(client, LOGIC, "Sync", true);
  const applied = await call(client, "apply_native_change", {
    change_ref: code.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  await restore(client, sync);
  await restore(client, code);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// A BLOCK the agent creates in the tests below: the bathroom light on
// motion.
function bathroomLightRule() {
  return {
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              aId: 38,
              sId: 13,
              cId: 14,
              hs: "MotionSensor",
              hc: "MotionDetected",
              cond: "=",
              value: "true",
              trigger: true,
              time: 0,
              timeCond: "",
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [
          {
            type: "service",
            aId: 35,
            sId: 13,
            hs: "Lightbulb",
            characteristics: [
              { type: "set", cId: 14, hc: "On", value: "true" },
            ],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

function createBathroomRule(client) {
  return call(client, "prepare_native_change", {
    operation: "block_create",
    target_ref: homeRef,
    name: "Свет в ванной по движению",
    description: "Включает свет в ванной при движении",
    active: false,
    on_start: false,
    sync: false,
    data: bathroomLightRule(),
    reason: "Включать свет в ванной при движении",
  });
}

test("undo of a created BLOCK or LOGIC names the agent's later rename, and both together are undone", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const createdBlock = await createBathroomRule(client);
  const createdLogic = await call(client, "prepare_native_change", {
    operation: "logic_source_create",
    target_ref: `${homeRef}/accessory/34/service/13`,
    name: "Журнал",
    description: "Пишет в журнал",
    active: false,
    on_start: false,
    sync: false,
    source: [
      "info = {",
      '  name: "Журнал",',
      '  description: "Пишет в журнал",',
      "  onStart: false,",
      "  sourceServices: [HS.Lightbulb],",
      "  sourceCharacteristics: [HC.On],",
      "};",
      'function trigger() { log("свет"); }',
    ].join("\n"),
    reason: "Журнал света",
  });
  const renames = [];
  for (const created of [createdBlock, createdLogic]) {
    const applied = await call(client, "apply_native_change", {
      change_ref: created.change_ref,
    });
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    const index = applied.scenario_ref.split("/").at(-1);
    renames.push(await change(client, index, "Name", "Новое имя"));
  }

  for (const [created, renamed] of [
    [createdBlock, renames[0]],
    [createdLogic, renames[1]],
  ]) {
    const sentBefore = hub.requests.length;
    const alone = await call(client, "restore_native_change", {
      change_ref: created.change_ref,
    });
    assert.equal(alone.status, "conflict", JSON.stringify(alone));
    assert.equal(alone.conflict_reason, "later_owned_change");
    assert.equal(alone.restore_first_change_ref, renamed.change_ref);
    assert.deepEqual(writesSince(hub, sentBefore), []);
  }

  const undone = await call(client, "restore_native_change", {
    change_refs: [
      createdBlock.change_ref,
      createdLogic.change_ref,
      ...renames.map(({ change_ref: ref }) => ref),
    ],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone.results));
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// The chain does not hide a change by hand: once the owner changed the
// scenario after the agent's later change, both are left as they are.
test("an owner's edit after the agent's later change of a LOGIC stays a change by hand for both changes", async (t) => {
  const { hub, client } = await setup(t);
  const renamed = await change(client, LOGIC, "Name", "Протечка под мойкой");
  const described = await change(client, LOGIC, "Desc", "Новое описание");
  ownerWritesWindow(hub, LOGIC, "Desc", { stringValue: "Описание владельца" });

  const sentBefore = hub.requests.length;
  for (const prepared of [renamed, described]) {
    const refused = await call(client, "restore_native_change", {
      change_ref: prepared.change_ref,
    });
    assert.equal(refused.status, "conflict", JSON.stringify(refused));
    assert.notEqual(refused.conflict_reason, "later_owned_change");
    assert.equal(refused.manual_change_observed, true);
  }
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.equal(scenarioOf(hub, LOGIC).desc, "Описание владельца");
  assert.equal(scenarioOf(hub, LOGIC).name, "Протечка под мойкой");
});

test("a created BLOCK whose data the owner edited after the agent's rename is named as changed by hand", async (t) => {
  const { hub, client } = await setup(t);
  const created = await createBathroomRule(client);
  const applied = await call(client, "apply_native_change", {
    change_ref: created.change_ref,
  });
  const index = applied.scenario_ref.split("/").at(-1);
  const renamed = await change(client, index, "Name", "Новое имя");
  const data = JSON.parse(scenarioOf(hub, index).data);
  data.targets[0].then_delay = 5_000;
  hub.request({
    scenario: { update: { index, data: JSON.stringify(data) } },
  });

  const sentBefore = hub.requests.length;
  const refused = await call(client, "restore_native_change", {
    change_ref: created.change_ref,
  });
  assert.equal(refused.status, "conflict", JSON.stringify(refused));
  assert.equal(refused.conflict_reason, "manual_change");
  assert.deepEqual(writesSince(hub, sentBefore), []);

  // Together: the rename goes back, the edited BLOCK stays.
  const undone = await call(client, "restore_native_change", {
    change_refs: [created.change_ref, renamed.change_ref],
  });
  assert.deepEqual(
    undone.results.map(({ change_ref: ref, status, reason }) => [
      ref,
      status,
      reason,
    ]),
    [
      [renamed.change_ref, "restored", undefined],
      [created.change_ref, "skipped", "changed_since"],
    ],
  );
  assert.equal(scenarioOf(hub, index).name, "Свет в ванной по движению");
});

test("the owner's rename back to the agent's earlier name is a change by hand of the later rename", async (t) => {
  const { hub, client } = await setup(t);
  const first = await change(client, BLOCK, "Name", "Ночь");
  ownerWritesWindow(hub, BLOCK, "Name", { stringValue: "Ночной свет" });
  const second = await change(client, BLOCK, "Name", "Ночь, свет");
  ownerWritesWindow(hub, BLOCK, "Name", { stringValue: "Ночь" });

  const sentBefore = hub.requests.length;
  const refused = await call(client, "restore_native_change", {
    change_ref: second.change_ref,
  });
  assert.equal(refused.status, "conflict", JSON.stringify(refused));
  assert.notEqual(refused.restore_first_change_ref, first.change_ref);
  assert.equal(refused.manual_change_observed, true);
  assert.deepEqual(writesSince(hub, sentBefore), []);
});

test("get_entity offers a LOGIC's Name, Desc and OnStart only while its info can be rewritten, and points to its code otherwise", async (t) => {
  const { hub, client } = await setup(t);
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
  const entity = await call(client, "get_entity", {
    entity_ref: scenarioRef(LOGIC),
  });
  const offers = Object.fromEntries(
    entity.entity.metadata_options.map(({ key, native_change: offer }) => [
      key,
      offer,
    ]),
  );
  for (const key of ["Name", "Desc", "OnStart"]) {
    assert.equal(offers[key].supported, false, key);
    assert.equal(offers[key].reason, "logic_info_not_editable", key);
    assert.deepEqual(offers[key].next, {
      tool: "get_native_change_contract",
      arguments: {
        operation: "logic_source_update",
        target_ref: scenarioRef(LOGIC),
      },
    });
  }
  assert.equal(offers.Sync.supported, true);
});

test("a LOGIC whose code changes or passes on info after assigning it is refused before anything is sent", async (t) => {
  const { hub, client } = await setup(t);
  const source = scenarioOf(hub, LOGIC).data;
  for (const line of [
    'Object.assign(info, { name: "Другое" });',
    '({ name: info.name } = { name: "Другое" });',
    '[info.description] = ["Другое"];',
    "const meta = info;",
    "for (info.name in { Другое: 1 }) {}",
    'Object.defineProperty(info, "name", { value: "Другое" });',
    "delete info.description;",
  ]) {
    hub.request({
      scenario: { update: { index: LOGIC, data: `${source}\n${line}` } },
    });
    const sentBefore = hub.requests.length;
    const refused = await refusal(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: scenarioRef(LOGIC),
      option_key: "Name",
      value: "Протечка",
      reason: "Короче",
    });
    assert.equal(refused.error.code, "logic_info_not_editable", line);
    assert.deepEqual(writesSince(hub, sentBefore), [], line);
  }
});
