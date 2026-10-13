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
// 2026-10-13-wave4-contracts.md): the scenario's options window changes
// them, and a LOGIC's code sets its name, description and onStart again
// on every code write, so for a LOGIC those three are changed in its code.
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

test("window_option renames a BLOCK and a GLOBAL, and restore puts each back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const renames = [
    [BLOCK, "Ночь"],
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
  assert.deepEqual(
    changedKeys(initial, hub.snapshot()),
    [`scenario/${BLOCK}/name`, `scenario/${GLOBAL}/name`].sort(),
  );

  for (const renamed of prepared.reverse()) await restore(client, renamed);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// SprutHub sets a LOGIC's name, description and start on boot from info in
// its code on every code write (research/protocol/2026-10-13-wave4-
// contracts.md 1.5), so they are changed there; its options window would
// hold them only until the next code write.
test("a LOGIC's Name, Desc and OnStart in its options window are refused before anything is sent and point to its code, while its Sync changes", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const readCode = {
    tool: "get_entity",
    arguments: { entity_ref: scenarioRef(LOGIC), include: ["configuration"] },
  };
  for (const [optionKey, value] of [
    ["Name", "Протечка под мойкой"],
    ["Desc", "Новое описание"],
    ["OnStart", true],
  ]) {
    const refused = await refusal(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: scenarioRef(LOGIC),
      option_key: optionKey,
      value,
      reason: "Владелец попросил",
    });
    assert.equal(refused.error.code, "logic_info_in_code", optionKey);
    assert.deepEqual(refused.next, readCode, optionKey);
    const contract = await refusal(client, "get_native_change_contract", {
      operation: "window_option",
      target_ref: scenarioRef(LOGIC),
      option_key: optionKey,
    });
    assert.equal(contract.error.code, "logic_info_in_code", optionKey);
    // Its options window written by the window ref is refused the same way.
    const direct = await refusal(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: windowRef(hub, LOGIC),
      option_key: optionKey,
      value,
      reason: "Владелец попросил",
    });
    assert.equal(direct.error.code, "logic_info_in_code", optionKey);
    assert.deepEqual(direct.next, readCode, optionKey);
  }
  assert.deepEqual(hub.writes(), []);

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
    assert.equal(offers[key].reason, "logic_info_in_code", key);
    assert.deepEqual(offers[key].next, readCode, key);
  }
  assert.equal(offers.Sync.supported, true);

  const sync = await change(client, LOGIC, "Sync", true);
  assert.equal(scenarioOf(hub, LOGIC).sync, true);
  assert.deepEqual(
    hub.writes().map(({ method }) => method),
    ["window.update"],
  );
  await restore(client, sync);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

test("«переименуй сценарий» of a LOGIC follows the refusal to its code: info.name changes, the prepare says the name it sets, and restore puts the old name back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const source = scenarioOf(hub, LOGIC).data;
  const newName = "Протечка под мойкой";
  const refused = await refusal(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: scenarioRef(LOGIC),
    option_key: "Name",
    value: newName,
    reason: "Переименовать",
  });
  const entity = await call(client, refused.next.tool, refused.next.arguments);
  const renamedSource = entity.entity.configuration.value.replace(
    `name: "${LOGIC_NAME}"`,
    `name: "${newName}"`,
  );
  assert.notEqual(renamedSource, source);

  const prepared = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: renamedSource,
    reason: "Переименовать",
  });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.code_sets, [
    { field: "name", from: LOGIC_NAME, to: newName },
  ]);
  assert.equal(prepared.restore_code_sets, undefined);
  assert.equal(prepared.warnings, undefined);
  assert.equal(prepared.diff.editable_flags.to.name, newName);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, LOGIC).name, newName);
  assert.deepEqual(
    changedKeys(initial, hub.snapshot()),
    [`scenario/${LOGIC}/data`, `scenario/${LOGIC}/name`].sort(),
  );

  await restore(client, prepared);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// The owner renamed the LOGIC in the app: only its options window, its code
// keeps the old info.name. Any code write, the agent's or its undo, takes
// the name from info again; prepare says so before anything is sent.
test("a code edit of a LOGIC renamed in the app says it sets the old name back and that its restore does not bring the app's name back", async (t) => {
  const { hub, client } = await setup(t);
  const source = scenarioOf(hub, LOGIC).data;
  ownerWritesWindow(hub, LOGIC, "Name", { stringValue: "Имя из приложения" });
  assert.equal(scenarioOf(hub, LOGIC).name, "Имя из приложения");

  const sentBefore = hub.requests.length;
  const edit = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: source.replace(
      'log("Протечка: розетка чайника отключена")',
      'log("Протечка: розетка отключена")',
    ),
    reason: "Короче запись в журнале",
  });
  assert.equal(edit.status, "prepared");
  assert.deepEqual(edit.code_sets, [
    { field: "name", from: "Имя из приложения", to: LOGIC_NAME },
  ]);
  assert.deepEqual(edit.restore_code_sets, [
    { field: "name", before_change: "Имя из приложения", to: LOGIC_NAME },
  ]);
  assert.equal(edit.warnings.length, 2);
  assert.deepEqual(writesSince(hub, sentBefore), []);

  // Renamed in the code as well: the new name is what the code sets; its
  // restore still sets the code's old info.name, not the app's name.
  const renamed = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: source.replace(`name: "${LOGIC_NAME}"`, 'name: "Мойка"'),
    reason: "Переименовать",
  });
  assert.deepEqual(renamed.code_sets, [
    { field: "name", from: "Имя из приложения", to: "Мойка" },
  ]);
  assert.deepEqual(renamed.restore_code_sets, [
    { field: "name", before_change: "Имя из приложения", to: LOGIC_NAME },
  ]);
  const applied = await call(client, "apply_native_change", {
    change_ref: renamed.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, LOGIC).name, "Мойка");
  const read = await call(client, "get_native_change", {
    change_ref: renamed.change_ref,
  });
  assert.deepEqual(read.restore_code_sets, renamed.restore_code_sets);

  const restored = await call(client, "restore_native_change", {
    change_ref: renamed.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.deepEqual(restored.restore_code_sets, renamed.restore_code_sets);
  assert.equal(scenarioOf(hub, LOGIC).data, source);
  assert.equal(scenarioOf(hub, LOGIC).name, LOGIC_NAME);
});

// The final review of the earlier candidate crashed here: the current code
// passes info on, so what it sets cannot be read without running it.
test("a code edit of a LOGIC whose current code passes info on is prepared, applied and restored to that exact code, and says the values after restore are unknown", async (t) => {
  const { hub, client } = await setup(t);
  const clean = scenarioOf(hub, LOGIC).data;
  const passing = `${clean}\nfunction helper(meta){meta.onStart=false} helper(info);`;
  hub.request({ scenario: { update: { index: LOGIC, data: passing } } });
  const before = hub.snapshot();

  const prepared = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: clean,
    reason: "Убрать лишнюю функцию",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.code_sets, undefined);
  assert.deepEqual(prepared.restore_code_sets, [
    { field: "name", before_change: LOGIC_NAME, unknown: true },
    { field: "description", before_change: LOGIC_DESC, unknown: true },
    { field: "on_start", before_change: false, unknown: true },
  ]);
  assert.equal(prepared.warnings.length, 1);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, LOGIC).data, clean);

  await restore(client, prepared);
  assert.equal(scenarioOf(hub, LOGIC).data, passing);
  assert.deepEqual(diffHomeSnapshots(before, hub.snapshot()), []);
});

test("a new code whose info is not plain values says the name, description and start on boot after its write are unknown", async (t) => {
  const { hub, client } = await setup(t);
  const source = scenarioOf(hub, LOGIC).data;
  const prepared = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: source.replace(
      `name: "${LOGIC_NAME}"`,
      'name: "Защита " + "от протечки"',
    ),
    reason: "Собрать имя из частей",
  });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.code_sets, [
    { field: "name", from: LOGIC_NAME, unknown: true },
  ]);
  assert.equal(prepared.diff.editable_flags.to.name, null);
  assert.equal(prepared.warnings.length, 1);
  assert.deepEqual(hub.writes(), []);
});

test("OnStart and Sync of a BLOCK and a GLOBAL, and Sync of a LOGIC, change through window_option and restore", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const logicSource = scenarioOf(hub, LOGIC).data;
  const settings = [
    [BLOCK, "OnStart", "onStart"],
    [BLOCK, "Sync", "sync"],
    [GLOBAL, "OnStart", "onStart"],
    [GLOBAL, "Sync", "sync"],
    [LOGIC, "Sync", "sync"],
  ];
  const prepared = [];
  for (const [index, key, field] of settings) {
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
  // A LOGIC's code does not set its sync: a code write keeps it.
  hub.request({ scenario: { update: { index: LOGIC, data: logicSource } } });
  assert.equal(scenarioOf(hub, LOGIC).sync, true);
  assert.deepEqual(
    changedKeys(initial, hub.snapshot()),
    settings.map(([index, , field]) => `scenario/${index}/${field}`).sort(),
  );

  for (const switched of prepared.reverse()) await restore(client, switched);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
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
});

test("built-in scenarios are refused before anything is sent", async (t) => {
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
  assert.deepEqual(hub.writes(), []);
});

test("a scenario's options window written by its window ref points to the scenario ref", async (t) => {
  const { hub, client } = await setup(t);
  for (const [index, optionKey, value] of [
    [BLOCK, "Name", "Другое имя"],
    [BLOCK, "OnStart", true],
    [GLOBAL, "Name", "Другое имя"],
    [GLOBAL, "OnStart", true],
    [LOGIC, "Sync", true],
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
  assert.deepEqual(hub.writes(), []);
});

// The agent's own changes of one scenario form one chain: a later one in
// effect makes an earlier one name it (later_owned_change) instead of
// counting as a change by hand, and undoing them newest first puts the
// scenario back.

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

test("a LOGIC renamed in its code and then described in its code: the rename names the later edit, and «верни как было» puts both back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const source = scenarioOf(hub, LOGIC).data;
  const renamed = await codeUpdate(
    client,
    source.replace(`name: "${LOGIC_NAME}"`, 'name: "Протечка под мойкой"'),
    "Переименовать",
  );
  const described = await codeUpdate(
    client,
    scenarioOf(hub, LOGIC).data.replace(
      `description: "${LOGIC_DESC}"`,
      'description: "Новое описание"',
    ),
    "Новое описание",
  );
  assert.equal(scenarioOf(hub, LOGIC).name, "Протечка под мойкой");
  assert.equal(scenarioOf(hub, LOGIC).desc, "Новое описание");

  let sentBefore = hub.requests.length;
  assertNamesLater(
    await call(client, "restore_native_change", {
      change_ref: renamed.change_ref,
    }),
    described,
  );
  assert.deepEqual(writesSince(hub, sentBefore), []);

  sentBefore = hub.requests.length;
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
  const indexes = [];
  for (const created of [createdBlock, createdLogic]) {
    const applied = await call(client, "apply_native_change", {
      change_ref: created.change_ref,
    });
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    indexes.push(applied.scenario_ref.split("/").at(-1));
  }
  // The BLOCK is renamed in its options window, the LOGIC in its code.
  const renames = [await change(client, indexes[0], "Name", "Новое имя")];
  const logicRename = await call(client, "prepare_native_change", {
    operation: "logic_source_update",
    target_ref: scenarioRef(indexes[1]),
    source: scenarioOf(hub, indexes[1]).data.replace(
      'name: "Журнал"',
      'name: "Новое имя"',
    ),
    reason: "Переименовать",
  });
  const applied = await call(client, "apply_native_change", {
    change_ref: logicRename.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(scenarioOf(hub, indexes[1]).name, "Новое имя");
  renames.push(logicRename);

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
  const source = scenarioOf(hub, LOGIC).data;
  const renamed = await codeUpdate(
    client,
    source.replace(`name: "${LOGIC_NAME}"`, 'name: "Протечка под мойкой"'),
    "Переименовать",
  );
  const described = await codeUpdate(
    client,
    scenarioOf(hub, LOGIC).data.replace(
      `description: "${LOGIC_DESC}"`,
      'description: "Новое описание"',
    ),
    "Новое описание",
  );
  ownerWritesWindow(hub, LOGIC, "Desc", { stringValue: "Описание владельца" });

  const sentBefore = hub.requests.length;
  for (const prepared of [renamed, described]) {
    const refused = await call(client, "restore_native_change", {
      change_ref: prepared.change_ref,
    });
    assert.equal(refused.status, "conflict", JSON.stringify(refused));
    assert.equal(refused.conflict_reason, "manual_change");
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

// A setting write whose request was lost leaves its scenario as it was; it
// does not stop the agent's other changes of the scenario from being
// undone, and the undo does not send the lost write.
test("after a BLOCK's Sync write is lost, «верни как было» puts back its rename and does not write Sync", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const renamed = await change(client, BLOCK, "Name", "Ночь");
  const sync = await call(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: scenarioRef(BLOCK),
    option_key: "Sync",
    value: true,
    reason: "Владелец попросил",
  });
  hub.loseNext("window.update");
  const lost = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: sync.change_ref },
  });
  assert.notEqual(lost.structuredContent.status, "applied");
  assert.equal(scenarioOf(hub, BLOCK).sync, false);
  const read = await call(client, "get_native_change", {
    change_ref: sync.change_ref,
  });
  assert.notEqual(read.status, "applied");

  const sentBefore = hub.requests.length;
  const undone = await call(client, "restore_native_change", {
    change_refs: [renamed.change_ref, sync.change_ref],
  });
  const results = Object.fromEntries(
    undone.results.map((item) => [item.change_ref, item]),
  );
  assert.equal(
    results[renamed.change_ref].status,
    "restored",
    JSON.stringify(undone.results),
  );
  assert.deepEqual(
    writesSince(hub, sentBefore).map(({ params }) => params.window.update),
    [
      {
        windowKey: scenarioOf(hub, BLOCK).optionsWindow,
        options: [
          {
            key: "Name",
            value: { stringValue: initial[`scenario/${BLOCK}/name`] },
          },
        ],
      },
    ],
  );
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});
