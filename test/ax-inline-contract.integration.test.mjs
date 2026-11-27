import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const LIVING_ROOM = 3;
const BUILT_IN_SCENARIO = "21";
const ZIGBEE_WINDOW = "Controller/zigbee/";
const NETWORK_KEY = "4f1b7c2e9a0d6b3f8c5e1a7d2b9f0c6e";

function roomRef(id) {
  return `${homeRef}/room/${id}`;
}

function scenarioRef(index) {
  return `${homeRef}/scenario/${index}`;
}

function windowRef(windowKey) {
  return `${homeRef}/window/${encodeURIComponent(windowKey)}`;
}

function windowOption(key, name, type, inputType, value, extra = {}) {
  return {
    key,
    name,
    type,
    inputType,
    parent: "",
    read: true,
    write: true,
    disabled: false,
    value,
    ...extra,
  };
}

function zigbeeWindow() {
  return {
    windowKey: ZIGBEE_WINDOW,
    label: { text: "ZigBee" },
    options: [
      windowOption(
        "Channel",
        "Канал",
        "GenericInteger",
        "LIST",
        { intValue: 15 },
        {
          validValues: [11, 15, 20, 25].map((channel) => ({
            name: String(channel),
            value: { intValue: channel },
          })),
        },
      ),
      windowOption(
        "ReadOnlyFlag",
        "Только чтение",
        "GenericBoolean",
        "CHECKBOX",
        { boolValue: false },
        { write: false },
      ),
      windowOption(
        "DisabledFlag",
        "Отключённый параметр",
        "GenericBoolean",
        "CHECKBOX",
        { boolValue: false },
        { disabled: true },
      ),
      windowOption(
        "UnreadableFlag",
        "Нечитаемый параметр",
        "GenericBoolean",
        "CHECKBOX",
        { boolValue: false },
        { read: false },
      ),
      windowOption("NetworkKey", "Ключ сети", "GenericString", "TEXT", {
        stringValue: NETWORK_KEY,
      }),
    ],
  };
}

async function setup(t) {
  const fixture = await loadHomeFixture("apartment");
  fixture.scenarios.push({
    index: BUILT_IN_SCENARIO,
    name: "Плавное включение",
    type: "LOGIC",
    predefined: true,
    active: true,
    onStart: true,
    data: "info = { name: 'Плавное включение' }; function trigger() {}",
  });
  const hub = await startSimulatedHub(fixture);
  hub.state.windows[ZIGBEE_WINDOW] = zigbeeWindow();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-ax-inline-contract-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "ax-inline-contract-test",
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

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return result.structuredContent;
}

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} failed: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

test("simple write field/value errors return an inline compact contract so the caller retries without get_native_change_contract", async (t) => {
  const { hub, client } = await setup(t);

  // 1. room_name missing value (caller sent name instead of value)
  const roomError = await callError(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: roomRef(LIVING_ROOM),
    name: "Зал",
    reason: "Переименовать гостиную в Зал",
  });
  assert.equal(roomError.error.code, "name_required");
  assert.equal(roomError.error.action, "prepare_native_change");
  assert.ok(roomError.contract, "room_name error must include inline contract");
  assert.equal(roomError.contract.kind, "stringValue");
  assert.equal(roomError.contract.max_length, 32);
  assert.ok(
    Buffer.byteLength(JSON.stringify(roomError.contract), "utf8") <= 4_096,
  );
  const roomPrepared = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: roomRef(LIVING_ROOM),
    value: "Зал",
    reason: "Переименовать гостиную в Зал",
  });
  assert.equal(roomPrepared.status, "prepared");

  // 2. window_option wrong value type -> inline contract with valid_values
  const zigbeeRef = windowRef(ZIGBEE_WINDOW);
  const optionError = await callError(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: zigbeeRef,
    option_key: "Channel",
    value: "20",
    reason: "Сменить канал ZigBee на 20",
  });
  assert.equal(optionError.error.code, "invalid_native_value");
  assert.ok(
    optionError.contract,
    "window_option wrong value error must include inline contract",
  );
  assert.equal(optionError.contract.kind, "intValue");
  assert.equal(optionError.contract.input_type, "LIST");
  assert.ok(
    Buffer.byteLength(JSON.stringify(optionError.contract), "utf8") <= 4_096,
  );
  const chosen = optionError.contract.valid_values.find(
    ({ value }) => value === 20,
  );
  assert.ok(chosen, "inline contract must expose valid_values for retry");
  const optionPrepared = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: zigbeeRef,
    option_key: "Channel",
    value: chosen.value,
    reason: "Сменить канал ZigBee на 20",
  });
  assert.equal(optionPrepared.status, "prepared");

  // 3. window_option missing option_key -> contract lookup requires option_key,
  // so original option_key_required error is preserved cleanly without crash.
  const missingKeyError = await callError(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: zigbeeRef,
    value: 20,
    reason: "Сменить канал ZigBee на 20",
  });
  assert.equal(missingKeyError.error.code, "option_key_required");
  assert.equal(missingKeyError.error.action, "get_entity");
  assert.equal(missingKeyError.contract, undefined);

  // 4. virtual_device invalid service type -> inline contract preserves
  // supported_types and provides fields so caller retries directly.
  const virtualError = await callError(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: roomRef(LIVING_ROOM),
    name: "Режим гостей",
    value: "FilterMaintenance",
    reason: "Создать виртуальный выключатель",
  });
  assert.equal(virtualError.error.code, "unsupported_virtual_device_type");
  assert.equal(virtualError.error.action, "get_native_change_contract");
  assert.ok(Array.isArray(virtualError.supported_types));
  assert.ok(
    virtualError.contract,
    "virtual_device invalid type error must include inline contract",
  );
  assert.ok(virtualError.contract.fields.value.service_type.includes("Switch"));
  assert.ok(
    Buffer.byteLength(JSON.stringify(virtualError.contract), "utf8") <= 4_096,
  );
  const virtualPrepared = await callOk(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: roomRef(LIVING_ROOM),
    name: "Режим гостей",
    value: "Switch",
    reason: "Создать виртуальный выключатель",
  });
  assert.equal(virtualPrepared.status, "prepared");

  // 5. characteristic_value wrong value type -> inline contract lets caller
  // retry with the right native type without calling get_native_change_contract.
  const brightnessRef = `${homeRef}/accessory/16/service/13/characteristic/15`;
  const charError = await callError(client, "prepare_native_change", {
    operation: "characteristic_value",
    target_ref: brightnessRef,
    value: "half",
    reason: "Уменьшить яркость торшера",
  });
  assert.equal(charError.error.code, "invalid_native_value");
  assert.ok(
    charError.contract,
    "characteristic_value wrong value error must include inline contract",
  );
  assert.equal(charError.contract.type, "Brightness");
  assert.equal(charError.contract.kind, "intValue");
  assert.ok(
    Buffer.byteLength(JSON.stringify(charError.contract), "utf8") <= 4_096,
  );
  const charPrepared = await callOk(client, "prepare_native_change", {
    operation: "characteristic_value",
    target_ref: brightnessRef,
    value: 50,
    reason: "Уменьшить яркость торшера",
  });
  assert.equal(charPrepared.status, "prepared");

  // No writes were sent to the hub by any prepare_native_change call.
  assert.deepEqual(hub.writes(), []);
});

test("complex BLOCK errors point to get_native_change_contract via next instead of inlining a >4 KB contract", async (t) => {
  const { hub, client } = await setup(t);

  const createError = await callError(client, "prepare_native_change", {
    operation: "block_create",
    target_ref: homeRef,
    name: "Тестовый сценарий",
    description: "Проверка",
    active: true,
    on_start: false,
    sync: false,
    data: { targets: [{ type: "not_a_real_block_node" }] },
    reason: "Создать сценарий",
  });
  assert.equal(createError.error.code, "invalid_block_data");
  assert.ok(Array.isArray(createError.problems));
  assert.equal(
    createError.contract,
    undefined,
    "BLOCK contract exceeds 4096 bytes and must not be inlined",
  );
  assert.deepEqual(createError.next, {
    tool: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });

  // Following next succeeds and returns the full >4 KB BLOCK contract.
  const fullContract = await callOk(
    client,
    createError.next.tool,
    createError.next.arguments,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(fullContract.contract), "utf8") > 4_096,
  );

  // block_data_update invalid data also points via next without inlining.
  const updateDataError = await callError(client, "prepare_native_change", {
    operation: "block_data_update",
    target_ref: scenarioRef("5"),
    data: { targets: [{ type: "not_a_real_block_node" }] },
    reason: "Поправить сценарий",
  });
  assert.equal(updateDataError.error.code, "invalid_block_data");
  assert.equal(updateDataError.contract, undefined);
  assert.deepEqual(updateDataError.next, {
    tool: "get_native_change_contract",
    arguments: { operation: "block_data_update" },
  });

  // Existing next on an error (e.g. block_data_update missing data redirecting
  // to window_option) must not be overwritten.
  const missingDataError = await callError(client, "prepare_native_change", {
    operation: "block_data_update",
    target_ref: scenarioRef("5"),
    reason: "Поправить сценарий",
  });
  assert.equal(missingDataError.error.code, "invalid_native_change");
  assert.equal(missingDataError.contract, undefined);
  assert.equal(missingDataError.next?.arguments?.operation, "window_option");

  assert.deepEqual(hub.writes(), []);
});

test("refusals (built-in scenario, redacted/sensitive values, missing entities, read-only/disabled options) never attach an inline contract or leak secrets", async (t) => {
  const { hub, client } = await setup(t);
  const zigbeeRef = windowRef(ZIGBEE_WINDOW);

  const cases = [
    [
      "built_in_scenario delete",
      {
        operation: "scenario_delete",
        target_ref: scenarioRef(BUILT_IN_SCENARIO),
        reason: "Удалить встроенный сценарий",
      },
      "built_in_scenario",
    ],
    [
      "built_in_scenario active",
      {
        operation: "scenario_active",
        target_ref: scenarioRef(BUILT_IN_SCENARIO),
        value: false,
        reason: "Выключить встроенный сценарий",
      },
      "predefined_scenario_read_only",
    ],
    [
      "redacted room_name value",
      {
        operation: "room_name",
        target_ref: roomRef(LIVING_ROOM),
        value: "Комната [REDACTED]",
        reason: "Переименовать комнату",
      },
      "invalid_native_value",
    ],
    [
      "redacted room_create name",
      {
        operation: "room_create",
        target_ref: homeRef,
        name: "Комната [REDACTED]",
        reason: "Создать комнату",
      },
      "invalid_native_value",
    ],
    [
      "redacted BLOCK notify text",
      {
        operation: "block_create",
        target_ref: homeRef,
        name: "Уведомление",
        description: "Тест",
        active: true,
        on_start: false,
        sync: false,
        data: {
          targets: [{ type: "notify", mode: "PUSH", text: "Key [REDACTED]" }],
        },
        reason: "Создать уведомление",
      },
      "invalid_block_data",
    ],
    [
      "sensitive window option",
      {
        operation: "window_option",
        target_ref: zigbeeRef,
        option_key: "NetworkKey",
        value: "not-a-key",
        reason: "Поменять ключ сети",
      },
      "sensitive_native_data",
    ],
    [
      "missing scenario",
      {
        operation: "scenario_active",
        target_ref: scenarioRef("99999"),
        value: false,
        reason: "Выключить несуществующий сценарий",
      },
      "scenario_not_found",
    ],
    [
      "missing service",
      {
        operation: "service_name",
        target_ref: `${homeRef}/accessory/99999/service/1`,
        value: "Лампа",
        reason: "Переименовать несуществующий сервис",
      },
      "service_not_found",
    ],
    [
      "missing characteristic",
      {
        operation: "characteristic_notify",
        target_ref: `${homeRef}/accessory/99999/service/1/characteristic/1`,
        value: true,
        reason: "Включить уведомления",
      },
      "characteristic_not_found",
    ],
    [
      "missing window option",
      {
        operation: "window_option",
        target_ref: zigbeeRef,
        option_key: "DoesNotExist",
        value: true,
        reason: "Изменить несуществующую опцию",
      },
      "window_option_not_found",
    ],
    [
      "missing room",
      {
        operation: "room_name",
        target_ref: roomRef(99999),
        value: "Кабинет",
        reason: "Переименовать несуществующую комнату",
      },
      "room_not_found",
    ],
    [
      "read-only window option",
      {
        operation: "window_option",
        target_ref: zigbeeRef,
        option_key: "ReadOnlyFlag",
        value: "wrong-type",
        reason: "Изменить опцию только для чтения",
      },
      "insufficient_rights",
    ],
    [
      "disabled window option",
      {
        operation: "window_option",
        target_ref: zigbeeRef,
        option_key: "DisabledFlag",
        value: "wrong-type",
        reason: "Изменить отключённую опцию",
      },
      "insufficient_rights",
    ],
    [
      "unreadable window option",
      {
        operation: "window_option",
        target_ref: zigbeeRef,
        option_key: "UnreadableFlag",
        value: "wrong-type",
        reason: "Изменить нечитаемую опцию",
      },
      "insufficient_rights",
    ],
    [
      "unsupported home settings window",
      {
        operation: "window_option",
        target_ref: windowRef(""),
        option_key: "TimeZone",
        value: "UTC",
        reason: "Сменить часовой пояс",
      },
      "unsupported_window_option",
    ],
  ];

  for (const [label, args, expectedCode] of cases) {
    const refused = await callError(client, "prepare_native_change", args);
    assert.equal(refused.error.code, expectedCode, label);
    assert.equal(
      refused.contract,
      undefined,
      `${label} must not attach an inline contract`,
    );
    assert.equal(
      refused.next?.tool === "get_native_change_contract",
      false,
      `${label} must not attach get_native_change_contract next`,
    );
    assert.equal(
      JSON.stringify(refused).includes(NETWORK_KEY),
      false,
      `${label} must never leak secrets`,
    );
  }

  assert.deepEqual(hub.writes(), []);
});

test("MCP tool descriptions stay within 1000 chars and server instructions within 2048 chars", async (t) => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  const oversized = tools
    .filter(({ description }) => description.length > 1_000)
    .map(({ name, description }) => `${name}: ${description.length}`);
  assert.deepEqual(oversized, []);

  const instructions = client.getInstructions();
  assert.ok(
    instructions.length <= 2_048,
    `instructions: ${instructions.length} characters`,
  );
});
