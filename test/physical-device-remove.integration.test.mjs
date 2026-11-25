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
const HOME_REF = "spruthub://hub/sim-apartment-01";
const BEDROOM = 5;
const ZIGBEE_EXT_KEY = "Controller:zigbee_1";
const XIAOMI_EXT_KEY = "Controller:xiaomi_1";
const TELEGRAM_EXT_KEY = "Notification:telegram_1";
const HOMEKIT_EXT_KEY = "Bridge:homekit_1";
const IR_EXT_KEY = "Controller:ir_1";

const ZIGBEE_BUSY_ID = "00158d0001a2b3c4";
const ZIGBEE_CLEAN_ID = "00158d0001a2b3c5";
const ZIGBEE_COORD_ID = "00124b0012345678";
const ZIGBEE_ORPHAN_ID = "00158d0000orphan";
const XIAOMI_DISC_ID = "mi_disc_01";

const ZIGBEE_BUSY_ACC = 42;
const ZIGBEE_CLEAN_ACC = 43;

const ZIGBEE_BUSY_WINDOW = `Controller/zigbee_1/Child/${ZIGBEE_BUSY_ID}/`;
const ZIGBEE_CLEAN_WINDOW = `Controller/zigbee_1/Child/${ZIGBEE_CLEAN_ID}/`;
const ZIGBEE_COORD_WINDOW = `Controller/zigbee_1/Child/${ZIGBEE_COORD_ID}/`;
const ZIGBEE_ORPHAN_WINDOW = `Controller/zigbee_1/Child/${ZIGBEE_ORPHAN_ID}/`;
const XIAOMI_DISC_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_DISC_ID}/`;

function windowRef(windowKey) {
  return `${HOME_REF}/window/${encodeURIComponent(windowKey)}`;
}

function extensionRef(extensionKey) {
  return `${HOME_REF}/extension/${encodeURIComponent(extensionKey)}`;
}

function accessoryRef(id) {
  return `${HOME_REF}/accessory/${id}`;
}

function roomRef(id) {
  return `${HOME_REF}/room/${id}`;
}

function optionEntry(key, name, type, inputType, value, extra = {}) {
  return {
    key,
    name,
    type,
    inputType,
    parent: "",
    read: true,
    write: true,
    disabled: false,
    visible: true,
    value,
    ...extra,
  };
}

function removeOption({
  visible = true,
  disabled = false,
  validValues = [
    {
      value: { boolValue: true },
      confirm: "Действительно хотите удалить?",
    },
  ],
} = {}) {
  return optionEntry(
    "Remove",
    "Удалить",
    "GenericBoolean",
    "BUTTON_DANGER",
    { boolValue: true },
    {
      visible,
      disabled,
      ...(validValues !== undefined ? { validValues } : {}),
    },
  );
}

function accessoriesListOption(accessories) {
  return optionEntry(
    "AccessoriesList",
    "Аксессуары",
    "GenericInteger",
    "ACCESSORY_LIST",
    { intValue: 0 },
    {
      read: true,
      write: false,
      ...(accessories !== undefined
        ? {
            validValues: accessories.map(({ id, name }) => ({
              name,
              value: { intValue: id },
            })),
          }
        : {}),
    },
  );
}

function infoOption(html) {
  return optionEntry(
    "Info",
    "Информация",
    "GenericString",
    "HTML",
    { stringValue: html },
    { read: true, write: false },
  );
}

function childWindow(
  windowKey,
  labelText,
  { infoHtml, accessories, remove } = {},
) {
  const options = [];
  if (infoHtml !== undefined) options.push(infoOption(infoHtml));
  if (accessories !== "omit_option") {
    options.push(accessoriesListOption(accessories));
  }
  options.push(removeOption(remove));
  return {
    windowKey,
    label: { text: labelText },
    options,
  };
}

async function setup(t, { patch, faults, onRequest, timeoutMs } = {}) {
  const fixture = await loadHomeFixture("apartment");
  fixture.extensions.push(
    {
      extensionKey: ZIGBEE_EXT_KEY,
      type: "zigbee",
      index: "zigbee_1",
      bundleType: "CONTROLLER",
      name: "ZigBee",
      state: "LOADED",
      enabled: true,
      optionsWindow: "Controller/zigbee_1/",
      spaces: [],
      children: [
        {
          id: ZIGBEE_COORD_ID,
          name: "Координатор ZigBee",
          spaceKey: "main",
          online: true,
          optionsWindow: ZIGBEE_COORD_WINDOW,
        },
        {
          id: ZIGBEE_ORPHAN_ID,
          name: "Старый датчик",
          spaceKey: "main",
          online: false,
          optionsWindow: ZIGBEE_ORPHAN_WINDOW,
        },
      ],
    },
    {
      extensionKey: XIAOMI_EXT_KEY,
      type: "xiaomi",
      index: "xiaomi_1",
      bundleType: "CONTROLLER",
      name: "Xiaomi",
      state: "LOADED",
      enabled: true,
      optionsWindow: "Controller/xiaomi_1/",
      spaces: [],
      children: [
        {
          id: XIAOMI_DISC_ID,
          name: "Увлажнитель Xiaomi",
          spaceKey: "discovery",
          online: false,
          optionsWindow: XIAOMI_DISC_WINDOW,
        },
      ],
    },
    {
      extensionKey: TELEGRAM_EXT_KEY,
      type: "telegram",
      index: "telegram_1",
      bundleType: "NOTIFICATION",
      name: "Telegram",
      state: "LOADED",
      enabled: true,
      optionsWindow: "Notification/telegram_1/",
      spaces: [],
    },
    {
      extensionKey: HOMEKIT_EXT_KEY,
      type: "homekit",
      index: "homekit_1",
      bundleType: "BRIDGE",
      name: "HomeKit 1",
      state: "LOADED",
      enabled: true,
      optionsWindow: "Bridge/homekit_1/",
      exported: {},
      spaces: [],
    },
    {
      extensionKey: IR_EXT_KEY,
      type: "ir",
      index: "ir_1",
      bundleType: "CONTROLLER",
      name: "IR 1",
      state: "LOADED",
      enabled: true,
      optionsWindow: "Controller/ir_1/",
      spaces: [],
      children: [
        {
          id: "ir_dev_1",
          name: "ИК пульт",
          spaceKey: "main",
          online: true,
          optionsWindow: "Controller/ir_1/Child/ir_dev_1/",
        },
      ],
    },
  );

  fixture.accessories.push(
    {
      id: ZIGBEE_BUSY_ACC,
      roomId: BEDROOM,
      name: "Лампа у кровати",
      online: true,
      virtual: false,
      extensionKey: ZIGBEE_EXT_KEY,
      deviceId: ZIGBEE_BUSY_ID,
      services: [
        {
          sId: 13,
          type: "Lightbulb",
          name: "Лампа у кровати",
          characteristics: [
            { cId: 14, type: "Name", value: "Лампа у кровати" },
            { cId: 15, type: "On", value: false },
          ],
        },
      ],
    },
    {
      id: ZIGBEE_CLEAN_ACC,
      roomId: BEDROOM,
      name: "Розетка у стола",
      online: true,
      virtual: false,
      extensionKey: ZIGBEE_EXT_KEY,
      deviceId: ZIGBEE_CLEAN_ID,
      services: [
        {
          sId: 13,
          type: "Outlet",
          name: "Розетка у стола",
          characteristics: [
            { cId: 14, type: "Name", value: "Розетка у стола" },
            { cId: 15, type: "On", value: false },
          ],
        },
      ],
    },
  );

  // Dependencies on ZIGBEE_BUSY_ACC (42): BLOCK, GLOBAL accessory_id_list,
  // unparseable GLOBAL, link, bridge export, and assigned LOGIC.
  fixture.scenarios.push(
    {
      index: "50",
      name: "Ночной свет у кровати",
      desc: "",
      type: "BLOCK",
      active: true,
      data: {
        targets: [
          {
            type: "service",
            aId: ZIGBEE_BUSY_ACC,
            sId: 13,
            hs: "Lightbulb",
            characteristics: [
              { type: "set", cId: 15, hc: "On", value: "true" },
            ],
          },
        ],
      },
    },
    {
      index: "51",
      name: "Цветные сцены",
      desc: "",
      type: "GLOBAL",
      active: true,
      data: [
        `global.SCENE_LIGHTS = [16, ${ZIGBEE_BUSY_ACC}];`,
        "global.applyScene = function () {",
        "  global.SCENE_LIGHTS.forEach(function (id) {",
        "    Hub.getAccessory(id);",
        "  });",
        "};",
      ].join("\n"),
    },
    {
      index: "52",
      name: "Старый скрипт for each",
      desc: "",
      type: "GLOBAL",
      active: true,
      data: `var list = [${ZIGBEE_BUSY_ACC}];\nfor each (var id in list) { Hub.getAccessory(id); }`,
    },
  );

  fixture.links = [
    ...(fixture.links ?? []),
    {
      aId: 16,
      sId: 13,
      cId: 14,
      tAId: ZIGBEE_BUSY_ACC,
      tSId: 13,
      tCId: 15,
    },
  ];

  fixture.logics = [
    ...(fixture.logics ?? []),
    {
      aId: ZIGBEE_BUSY_ACC,
      sId: 13,
      type: "LightbulbControl",
      name: "Управление лампой",
      active: true,
    },
  ];

  const alice = fixture.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:yandex",
  );
  alice.exported[String(ZIGBEE_BUSY_ACC)] = [13];

  if (patch) patch(fixture);

  const hub = await startSimulatedHub(fixture, { faults, onRequest });
  // Attach deviceWindow refs on the two physical accessories.
  hub.state.accessories.find(({ id }) => id === ZIGBEE_BUSY_ACC).deviceWindow =
    ZIGBEE_BUSY_WINDOW;
  hub.state.accessories.find(({ id }) => id === ZIGBEE_CLEAN_ACC).deviceWindow =
    ZIGBEE_CLEAN_WINDOW;

  // Populate controller child & extension windows.
  hub.state.windows[ZIGBEE_BUSY_WINDOW] = childWindow(
    ZIGBEE_BUSY_WINDOW,
    "Лампа у кровати",
    {
      infoHtml: `Address: ${ZIGBEE_BUSY_ID}/73AE<br>Clusters: 0000_Basic, 0006_OnOff`,
      accessories: [{ id: ZIGBEE_BUSY_ACC, name: "Лампа у кровати" }],
    },
  );
  hub.state.windows[ZIGBEE_CLEAN_WINDOW] = childWindow(
    ZIGBEE_CLEAN_WINDOW,
    "Розетка у стола",
    {
      infoHtml: `Address: ${ZIGBEE_CLEAN_ID}/73AF<br>Clusters: 0000_Basic, 0003_Identify`,
      accessories: [{ id: ZIGBEE_CLEAN_ACC, name: "Розетка у стола" }],
      remove: { validValues: [] },
    },
  );
  hub.state.windows[ZIGBEE_COORD_WINDOW] = childWindow(
    ZIGBEE_COORD_WINDOW,
    "Координатор ZigBee",
    {
      infoHtml: `Address: ${ZIGBEE_COORD_ID}/0000<br>Type: Coordinator<br>Clusters: 0000_Basic`,
      accessories: undefined,
    },
  );
  hub.state.windows[ZIGBEE_ORPHAN_WINDOW] = childWindow(
    ZIGBEE_ORPHAN_WINDOW,
    "Старый датчик",
    {
      infoHtml: `Address: ${ZIGBEE_ORPHAN_ID}/4C10<br>Clusters: 0000_Basic`,
      accessories: undefined,
    },
  );
  hub.state.windows[XIAOMI_DISC_WINDOW] = childWindow(
    XIAOMI_DISC_WINDOW,
    "Увлажнитель Xiaomi",
    {
      accessories: undefined,
    },
  );
  hub.state.windows["Controller/zigbee_1/"] = {
    windowKey: "Controller/zigbee_1/",
    label: { text: "ZigBee" },
    options: [
      optionEntry(
        "DeleteAllAccessories",
        "Удалить все аксессуары",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
      ),
      removeOption(),
    ],
  };
  hub.state.windows["Controller/xiaomi_1/"] = {
    windowKey: "Controller/xiaomi_1/",
    label: { text: "Xiaomi" },
    options: [
      optionEntry(
        "DeleteAllAccessories",
        "Удалить все аксессуары",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
      ),
      removeOption(),
    ],
  };
  hub.state.windows["Notification/telegram_1/"] = {
    windowKey: "Notification/telegram_1/",
    label: { text: "Telegram" },
    options: [removeOption()],
  };
  hub.state.windows["Bridge/homekit_1/"] = {
    windowKey: "Bridge/homekit_1/",
    label: { text: "HomeKit 1" },
    options: [removeOption()],
  };
  hub.state.windows["Bridge/homekit_1/Child/16/"] = {
    windowKey: "Bridge/homekit_1/Child/16/",
    label: { text: "Торшер" },
    options: [removeOption()],
  };
  hub.state.windows["Controller/ir_1/Child/ir_dev_1/"] = childWindow(
    "Controller/ir_1/Child/ir_dev_1/",
    "ИК пульт",
    { accessories: undefined },
  );
  hub.state.windows[""].options.push(
    optionEntry("RebootHub", "Перезагрузить", "GenericBoolean", "BUTTON", {
      boolValue: true,
    }),
    optionEntry("UpdateHub", "Обновить", "GenericBoolean", "BUTTON", {
      boolValue: true,
    }),
    optionEntry("DiskAction", "Диск", "GenericInteger", "BUTTON", {
      intValue: 1,
    }),
    optionEntry("Restore", "Восстановить", "GenericBoolean", "BUTTON", {
      boolValue: true,
    }),
  );

  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-physical-device-remove-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs ?? ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "physical-device-remove-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, stateDirectory };
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

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    true,
    `${name} unexpectedly succeeded: ${JSON.stringify(result.structuredContent)}`,
  );
  return result.structuredContent;
}

test("ZigBee child Remove audits BLOCK, code id lists, code_unread, links, bridges, and logics, requires owner confirmation, removes device with honest readback, indexes history, and refuses restore", async (t) => {
  const { hub, client } = await setup(t);
  const busyWinRef = windowRef(ZIGBEE_BUSY_WINDOW);

  // get_entity decorates allowed controller-child Remove with window_button & requires_confirmation.
  const winEntity = await callOk(client, "get_entity", {
    entity_ref: busyWinRef,
  });
  const removeCmd = winEntity.entity.commands.find(
    ({ key }) => key === "Remove",
  );
  assert.equal(removeCmd.requires_confirmation, true);
  assert.deepEqual(removeCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
    requires_confirmation: true,
  });

  // prepare_native_change audits every dependency class and ALWAYS returns tell_owner without next.
  const prep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: busyWinRef,
    option_key: "Remove",
    reason: "Удалить лампу у кровати из сети ZigBee",
  });
  assert.equal(prep.status, "prepared");
  assert.equal(prep.operation, "window_button");
  assert.equal(prep.button.kind, "physical_device_remove");
  assert.equal(prep.button.requires_confirmation, true);
  assert.equal(prep.native_write_sent, false);
  assert.equal(prep.restore_supported, false);
  assert.equal(
    prep.next,
    undefined,
    "prepare must omit next when owner confirmation is required",
  );
  assert.equal(typeof prep.tell_owner, "string");
  assert.match(prep.tell_owner, /restore_native_change|re-pair/i);
  assert.match(prep.tell_owner, /confirm/i);

  const dr = prep.device_remove;
  assert.equal(dr.controller_ref, extensionRef(ZIGBEE_EXT_KEY));
  assert.equal(dr.extension_key, ZIGBEE_EXT_KEY);
  assert.equal(dr.child_id, ZIGBEE_BUSY_ID);
  assert.equal(dr.space_key, "main");
  assert.equal(dr.linked_accessories_unconfirmed, false);
  assert.equal(dr.child_unread, false);
  assert.deepEqual(dr.linked_accessories, [
    {
      ref: accessoryRef(ZIGBEE_BUSY_ACC),
      name: "Лампа у кровати",
      room_ref: roomRef(BEDROOM),
      room_name: "Спальня",
      services: [{ type: "Lightbulb", name: "Лампа у кровати" }],
    },
  ]);

  assert.deepEqual(
    dr.dependencies.scenarios.map(({ name }) => name),
    ["Ночной свет у кровати"],
  );
  assert.deepEqual(
    dr.dependencies.code.map(({ name, found_by }) => [name, found_by]),
    [["Цветные сцены", ["accessory_id_list"]]],
  );
  assert.deepEqual(dr.dependencies.code_unread, [
    { ref: `${HOME_REF}/scenario/52`, reason: "not_parsed" },
  ]);
  assert.equal(dr.dependencies.links.length, 1);
  assert.equal(dr.dependencies.links[0].characteristic, "On");
  assert.deepEqual(
    dr.dependencies.links[0].with.map(({ ref }) => ref),
    [accessoryRef(16)],
  );
  assert.deepEqual(
    dr.dependencies.bridges.map(({ ref }) => ref),
    [extensionRef("Bridge:yandex")],
  );
  assert.deepEqual(dr.dependencies.logics, [
    { name: "Связь включения и уровня" },
  ]);
  assert.deepEqual(hub.writes(), []);

  // After owner confirms once, apply sends window.update Remove and observes full removal.
  const applied = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.native_write_sent, true);
  assert.equal(applied.native_acknowledged, true);
  assert.equal(applied.restore_supported, false);
  assert.equal(applied.readback_error, undefined);
  assert.deepEqual(applied.observed_effect, {
    window_absent: true,
    child_absent: true,
    accessories_absent: [accessoryRef(ZIGBEE_BUSY_ACC)],
    accessories_remaining: [],
  });
  assert.ok(
    applied.limitations.some((line) => /not yet been observed/i.test(line)),
    "limitations must honestly note live ZigBee/Xiaomi child Remove was not observed on a live hub",
  );
  assert.ok(
    applied.limitations.some((line) =>
      /mentioning removed accessory/i.test(line),
    ),
    "limitations must note scenarios/code referencing removed accessory IDs remain",
  );

  // Exactly 1 window.update with Remove={boolValue:true}; repeated apply never resends.
  const updates = hub
    .writes()
    .filter(({ method }) => method === "window.update");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.window.update, {
    windowKey: ZIGBEE_BUSY_WINDOW,
    options: [{ key: "Remove", value: { boolValue: true } }],
  });
  const repeat = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(repeat.status, "applied");
  assert.equal(
    hub.writes().filter(({ method }) => method === "window.update").length,
    1,
  );

  // Other physical accessories and scenarios remain intact.
  assert.equal(
    hub.state.accessories.some(({ id }) => id === ZIGBEE_BUSY_ACC),
    false,
  );
  assert.equal(
    hub.state.accessories.some(({ id }) => id === ZIGBEE_CLEAN_ACC),
    true,
  );
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "50"),
    true,
  );

  // History indexed under window ref, linked accessory ref, AND controller extension ref.
  for (const entityRef of [
    busyWinRef,
    accessoryRef(ZIGBEE_BUSY_ACC),
    extensionRef(ZIGBEE_EXT_KEY),
  ]) {
    const history = await callOk(client, "get_native_change", {
      home_ref: HOME_REF,
      entity_ref: entityRef,
    });
    assert.ok(
      history.changes.some(({ change_ref }) => change_ref === prep.change_ref),
      `history for ${entityRef} must include ${prep.change_ref}`,
    );
  }

  // Single restore_native_change refuses cleanly explaining physical re-pairing.
  const singleRestoreErr = await callError(client, "restore_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(singleRestoreErr.error.code, "restore_unsupported");
  assert.match(singleRestoreErr.error.message, /re-pair/i);

  // Batch restore skips device removal as not_restorable while restoring a restorable change.
  const roomPrep = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: roomRef(BEDROOM),
    value: "Большая спальня",
    reason: "Переименовать спальню",
  });
  await callOk(client, "apply_native_change", {
    change_ref: roomPrep.change_ref,
  });
  const batchRestore = await callOk(client, "restore_native_change", {
    change_refs: [prep.change_ref, roomPrep.change_ref],
  });
  const removeItem = batchRestore.results.find(
    ({ change_ref }) => change_ref === prep.change_ref,
  );
  const roomItem = batchRestore.results.find(
    ({ change_ref }) => change_ref === roomPrep.change_ref,
  );
  assert.equal(removeItem.status, "skipped");
  assert.equal(removeItem.reason, "not_restorable");
  assert.match(removeItem.message, /re-pair/i);
  assert.equal(roomItem.status, "restored");
});

test("ZigBee child with 0 dependencies and 0000_Basic cluster in Info is allowed and STILL requires mandatory tell_owner confirmation", async (t) => {
  const { hub, client } = await setup(t, {
    patch: (fixture) => {
      fixture.scenarios = fixture.scenarios.filter(
        ({ index }) => index !== "52",
      );
    },
  });
  const cleanWinRef = windowRef(ZIGBEE_CLEAN_WINDOW);

  // Normal device with 0000_Basic cluster and non-zero short address /73AF is NOT mistaken for coordinator.
  // Empty validValues: [] on Remove still exposes top-level requires_confirmation: true.
  const winEntity = await callOk(client, "get_entity", {
    entity_ref: cleanWinRef,
  });
  const removeCmd = winEntity.entity.commands.find(
    ({ key }) => key === "Remove",
  );
  assert.equal(removeCmd.requires_confirmation, true);
  assert.deepEqual(removeCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
    requires_confirmation: true,
  });

  // Remove with 0 dependencies MUST still return tell_owner and omit next!
  const prep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: cleanWinRef,
    option_key: "Remove",
    reason: "Удалить розетку у стола",
  });
  assert.equal(prep.status, "prepared");
  assert.equal(prep.next, undefined);
  assert.equal(typeof prep.tell_owner, "string");
  assert.match(prep.tell_owner, /no referencing|none/i);
  assert.match(prep.tell_owner, /restore_native_change|re-pair/i);
  assert.equal(prep.device_remove.linked_accessories_unconfirmed, false);
  assert.deepEqual(prep.device_remove.dependencies.scenarios, []);
  assert.deepEqual(prep.device_remove.dependencies.code, []);
  assert.deepEqual(prep.device_remove.dependencies.links, []);
  assert.deepEqual(prep.device_remove.dependencies.bridges, []);
  assert.deepEqual(prep.device_remove.dependencies.logics, []);
  assert.deepEqual(hub.writes(), []);

  const applied = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.observed_effect, {
    window_absent: true,
    child_absent: true,
    accessories_absent: [accessoryRef(ZIGBEE_CLEAN_ACC)],
    accessories_remaining: [],
  });
});

test("pre-write drift guard catches new dependencies, linked-accessory drift, and coordinator change before any write", async (t) => {
  const { hub, client } = await setup(t);
  const cleanWinRef = windowRef(ZIGBEE_CLEAN_WINDOW);

  // 1. New BLOCK dependency added between prepare and apply -> conflict dependencies_changed, zero writes.
  const prep1 = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: cleanWinRef,
    option_key: "Remove",
    reason: "Удалить розетку у стола",
  });
  hub.state.scenarios.push({
    index: "60",
    name: "Новое правило розетки",
    desc: "",
    type: "BLOCK",
    active: true,
    data: JSON.stringify({
      targets: [
        {
          type: "service",
          aId: ZIGBEE_CLEAN_ACC,
          sId: 13,
          hs: "Outlet",
          characteristics: [{ type: "set", cId: 15, hc: "On", value: "true" }],
        },
      ],
    }),
  });
  const drift1 = await callOk(client, "apply_native_change", {
    change_ref: prep1.change_ref,
  });
  assert.equal(drift1.status, "conflict");
  assert.equal(drift1.conflict_reason, "dependencies_changed");
  assert.equal(drift1.native_write_sent, false);
  assert.deepEqual(
    drift1.device_remove.dependencies.scenarios.map(({ name }) => name),
    ["Новое правило розетки"],
  );

  // Remove that scenario so we can test linked_accessories_unconfirmed flip false -> true.
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== "60",
  );
  const prep2 = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: cleanWinRef,
    option_key: "Remove",
    reason: "Удалить розетку у стола",
  });
  const accListOpt = hub.state.windows[ZIGBEE_CLEAN_WINDOW].options.find(
    ({ key }) => key === "AccessoriesList",
  );
  delete accListOpt.validValues;
  const drift2 = await callOk(client, "apply_native_change", {
    change_ref: prep2.change_ref,
  });
  assert.equal(drift2.status, "conflict");
  assert.equal(drift2.conflict_reason, "dependencies_changed");
  assert.equal(drift2.native_write_sent, false);
  assert.equal(drift2.device_remove.linked_accessories_unconfirmed, true);

  // Restore AccessoriesList and test coordinator protection on apply drift.
  accListOpt.validValues = [
    { name: "Розетка у стола", value: { intValue: ZIGBEE_CLEAN_ACC } },
  ];
  const prep3 = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: cleanWinRef,
    option_key: "Remove",
    reason: "Удалить розетку у стола",
  });
  hub.state.windows[ZIGBEE_CLEAN_WINDOW].options.find(
    ({ key }) => key === "Info",
  ).value.stringValue = `Address: ${ZIGBEE_CLEAN_ID}/0000<br>Type: Coordinator`;
  const coordErr = await callError(client, "apply_native_change", {
    change_ref: prep3.change_ref,
  });
  assert.equal(coordErr.error.code, "zigbee_coordinator_protected");
  assert.equal(coordErr.error.retryable, false);
  assert.deepEqual(hub.writes(), []);
});

test("ZigBee coordinator (short address 0000) is protected on get_entity, get_native_change_contract, and prepare_native_change", async (t) => {
  const { hub, client } = await setup(t);
  const coordRef = windowRef(ZIGBEE_COORD_WINDOW);

  // get_entity MUST NOT decorate coordinator's Remove with native_change.
  const coordEntity = await callOk(client, "get_entity", {
    entity_ref: coordRef,
  });
  const removeCmd = coordEntity.entity.commands.find(
    ({ key }) => key === "Remove",
  );
  assert.ok(removeCmd, "Remove command stays visible as read-only info");
  assert.equal(
    Object.hasOwn(removeCmd, "native_change"),
    false,
    "ZigBee coordinator Remove MUST NOT carry native_change",
  );

  // get_native_change_contract refuses with zigbee_coordinator_protected.
  const contractErr = await callError(client, "get_native_change_contract", {
    operation: "window_button",
    target_ref: coordRef,
    option_key: "Remove",
  });
  assert.equal(contractErr.error.code, "zigbee_coordinator_protected");
  assert.equal(contractErr.error.retryable, false);
  assert.match(contractErr.error.message, /coordinator/i);

  // prepare_native_change refuses with zigbee_coordinator_protected and NO inline contract.
  const prepErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: coordRef,
    option_key: "Remove",
    reason: "Попробовать удалить координатор",
  });
  assert.equal(prepErr.error.code, "zigbee_coordinator_protected");
  assert.equal(prepErr.error.retryable, false);
  assert.equal(prepErr.contract, undefined);

  // Case-insensitive end-of-string ADDRESS: <ieee>/0000 is also protected.
  hub.state.windows[ZIGBEE_COORD_WINDOW].options.find(
    ({ key }) => key === "Info",
  ).value.stringValue = `ADDRESS: ${ZIGBEE_COORD_ID.toUpperCase()}/0000`;
  const upperErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: coordRef,
    option_key: "Remove",
    reason: "Попробовать удалить координатор (верхний регистр)",
  });
  assert.equal(upperErr.error.code, "zigbee_coordinator_protected");
  assert.equal(upperErr.error.retryable, false);
  assert.deepEqual(hub.writes(), []);
});

test("strict refusals block extension-level Remove, Bridge child Remove, scenario Remove, destructive/debug buttons, and hidden/disabled Remove", async (t) => {
  const { hub, client } = await setup(t);

  // Add hidden and disabled Remove controller child windows.
  const hiddenWin = "Controller/zigbee_1/Child/00158d0000hidden/";
  const disabledWin = "Controller/zigbee_1/Child/00158d0000disabl/";
  hub.state.windows[hiddenWin] = childWindow(hiddenWin, "Скрытая кнопка", {
    infoHtml: "Address: 00158d0000hidden/1234",
    remove: { visible: false },
  });
  hub.state.windows[disabledWin] = childWindow(
    disabledWin,
    "Отключённая кнопка",
    {
      infoHtml: "Address: 00158d0000disabl/1235",
      remove: { disabled: true },
    },
  );

  const cases = [
    [
      "ZigBee extension Remove",
      windowRef("Controller/zigbee_1/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Xiaomi extension Remove",
      windowRef("Controller/xiaomi_1/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Telegram extension Remove",
      windowRef("Notification/telegram_1/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Bridge extension Remove",
      windowRef("Bridge/homekit_1/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Bridge child Remove",
      windowRef("Bridge/homekit_1/Child/16/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Scenario Remove (numeric windowKey)",
      windowRef("5"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Scenario Remove (Scenario/5/)",
      windowRef("Scenario/5/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "IR controller child Remove (not ZigBee/Xiaomi)",
      windowRef("Controller/ir_1/Child/ir_dev_1/"),
      "Remove",
      "unsupported_window_button",
    ],
    [
      "ZigBee DeleteAllAccessories",
      windowRef("Controller/zigbee_1/"),
      "DeleteAllAccessories",
      "unsupported_window_button",
    ],
    [
      "Xiaomi DeleteAllAccessories",
      windowRef("Controller/xiaomi_1/"),
      "DeleteAllAccessories",
      "unsupported_window_button",
    ],
    ["Hub RebootHub", windowRef(""), "RebootHub", "unsupported_window_button"],
    ["Hub UpdateHub", windowRef(""), "UpdateHub", "unsupported_window_button"],
    [
      "Hub DiskAction",
      windowRef(""),
      "DiskAction",
      "unsupported_window_button",
    ],
    ["Hub Restore", windowRef(""), "Restore", "unsupported_window_button"],
    [
      "Hidden controller child Remove",
      windowRef(hiddenWin),
      "Remove",
      "window_button_hidden",
    ],
    [
      "Disabled controller child Remove",
      windowRef(disabledWin),
      "Remove",
      "window_button_disabled",
    ],
  ];

  for (const [label, targetRef, optionKey, expectedCode] of cases) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_button",
      target_ref: targetRef,
      option_key: optionKey,
      reason: `Проверить отказ: ${label}`,
    });
    assert.equal(err.error.code, expectedCode, label);
    assert.equal(err.contract, undefined, `${label} must not attach contract`);
  }
  assert.deepEqual(hub.writes(), []);
});

test("unpaired Xiaomi discovery child vs main-space child with omitted AccessoriesList validValues, child_unread, and missing listed accessory", async (t) => {
  const { hub, client } = await setup(t);

  // 1. Unpaired Xiaomi discovery child: linked_accessories=[], linked_accessories_unconfirmed=false.
  const discPrep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(XIAOMI_DISC_WINDOW),
    option_key: "Remove",
    reason: "Удалить неподключённый увлажнитель Xiaomi",
  });
  assert.equal(discPrep.status, "prepared");
  assert.equal(discPrep.next, undefined);
  assert.equal(typeof discPrep.tell_owner, "string");
  assert.equal(discPrep.device_remove.space_key, "discovery");
  assert.deepEqual(discPrep.device_remove.linked_accessories, []);
  assert.equal(discPrep.device_remove.linked_accessories_unconfirmed, false);
  assert.equal(discPrep.device_remove.child_unread, false);

  const discApplied = await callOk(client, "apply_native_change", {
    change_ref: discPrep.change_ref,
  });
  assert.equal(discApplied.status, "applied");
  assert.deepEqual(discApplied.observed_effect, {
    window_absent: true,
    child_absent: true,
    accessories_absent: [],
    accessories_remaining: [],
  });

  // 2. Orphaned offline ZigBee child in main space whose AccessoriesList omits validValues:
  //    linked_accessories_unconfirmed MUST be true and explicitly warned in tell_owner.
  const orphanPrep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(ZIGBEE_ORPHAN_WINDOW),
    option_key: "Remove",
    reason: "Удалить старый офлайн-датчик ZigBee",
  });
  assert.equal(orphanPrep.status, "prepared");
  assert.equal(orphanPrep.next, undefined);
  assert.equal(orphanPrep.device_remove.space_key, "main");
  assert.deepEqual(orphanPrep.device_remove.linked_accessories, []);
  assert.equal(orphanPrep.device_remove.linked_accessories_unconfirmed, true);
  assert.equal(orphanPrep.device_remove.child_unread, false);
  assert.match(
    orphanPrep.tell_owner,
    /linked_accessories_unconfirmed|could not be.*verified|did not list/i,
  );

  // After owner confirms once, apply proceeds cleanly (unconfirmed was already disclosed).
  const orphanApplied = await callOk(client, "apply_native_change", {
    change_ref: orphanPrep.change_ref,
  });
  assert.equal(orphanApplied.status, "applied");
  assert.deepEqual(orphanApplied.observed_effect, {
    window_absent: true,
    child_absent: true,
    accessories_absent: [],
    accessories_remaining: [],
  });

  // 3. extensionChild.list failure sets child_unread: true and linked_accessories_unconfirmed: true.
  const unreadWin = "Controller/xiaomi_1/Child/mi_unread_02/";
  hub.state.windows[unreadWin] = childWindow(unreadWin, "Датчик Xiaomi", {
    accessories: undefined,
  });
  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Temporary child list failure",
  });
  const childUnreadPrep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(unreadWin),
    option_key: "Remove",
    reason: "Удалить датчик при ошибке extensionChild.list",
  });
  assert.equal(childUnreadPrep.device_remove.child_unread, true);
  assert.equal(
    childUnreadPrep.device_remove.linked_accessories_unconfirmed,
    true,
  );
  assert.equal(childUnreadPrep.device_remove.space_key, null);

  // 4. AccessoriesList pointing to a missing accessory ID sets linked_accessories_unconfirmed: true.
  const missingAccWin = "Controller/zigbee_1/Child/00158d0000missing/";
  hub.state.windows[missingAccWin] = childWindow(
    missingAccWin,
    "Призрак ZigBee",
    {
      infoHtml: "Address: 00158d0000missing/8811",
      accessories: [{ id: 999, name: "Пропавший аксессуар" }],
    },
  );
  const missingAccPrep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(missingAccWin),
    option_key: "Remove",
    reason: "Удалить устройство с пропавшим аксессуаром",
  });
  assert.equal(
    missingAccPrep.device_remove.linked_accessories_unconfirmed,
    true,
  );
  assert.equal(
    missingAccPrep.device_remove.linked_accessories[0].ref,
    accessoryRef(999),
  );
  assert.equal(
    missingAccPrep.device_remove.linked_accessories[0].unread_reason,
    "accessory_missing",
  );
});

test("post-ACK readback failure keeps status=applied, lost reply marks uncertain without resending, hub rejection marks not_applied, and MCP budgets hold", async (t) => {
  // Part A: Post-ACK readback failure (transport timeout on window.get + hub error on extensionChild.list)
  // preserves status=applied with readback_error; later get_native_change refreshes cleanly.
  let failReadback = false;
  const { hub, client } = await setup(t, {
    timeoutMs: 350,
    onRequest: ({ method }) => {
      if (failReadback && method === "window.update") {
        failReadback = false;
        hub.refuseNext("extensionChild.list", {
          code: -32603,
          message: "Temporary child list failure after ACK",
        });
        hub.state.faults.droppedReply.push({
          method: "window.get",
          remaining: 1,
          applied: false,
        });
      }
    },
  });

  const prepA = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(ZIGBEE_CLEAN_WINDOW),
    option_key: "Remove",
    reason: "Удалить розетку со сбоем readback",
  });
  failReadback = true;
  const appliedA = await callOk(client, "apply_native_change", {
    change_ref: prepA.change_ref,
  });
  assert.equal(appliedA.status, "applied");
  assert.equal(appliedA.native_write_sent, true);
  assert.equal(appliedA.native_acknowledged, true);
  assert.ok(appliedA.readback_error?.window);
  assert.ok(appliedA.readback_error?.extension_children);
  assert.equal(appliedA.observed_effect.window_absent, null);
  assert.equal(appliedA.observed_effect.child_absent, null);
  assert.deepEqual(appliedA.observed_effect.accessories_absent, [
    accessoryRef(ZIGBEE_CLEAN_ACC),
  ]);
  assert.ok(
    appliedA.limitations.some((line) =>
      /acknowledged the button press/i.test(line),
    ),
  );

  // Later get_native_change refreshes observed_effect cleanly without sending any write.
  const writesBeforeGet = hub.writes().length;
  const refreshedA = await callOk(client, "get_native_change", {
    change_ref: prepA.change_ref,
  });
  assert.equal(refreshedA.status, "applied");
  assert.equal(refreshedA.readback_error, undefined);
  assert.deepEqual(refreshedA.observed_effect, {
    window_absent: true,
    child_absent: true,
    accessories_absent: [accessoryRef(ZIGBEE_CLEAN_ACC)],
    accessories_remaining: [],
  });
  assert.equal(hub.writes().length, writesBeforeGet);

  // Part B: Explicit hub rejection marks not_applied and never resends.
  const prepB = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(ZIGBEE_BUSY_WINDOW),
    option_key: "Remove",
    reason: "Удалить лампу при отказе хаба",
  });
  hub.refuseNext("window.update", {
    code: -32603,
    message: "Device removal refused by hub",
  });
  const rejectedB = await callError(client, "apply_native_change", {
    change_ref: prepB.change_ref,
  });
  assert.equal(rejectedB.hub_effect, "not_applied");
  assert.ok(rejectedB.rejection);
  const writesAfterReject = hub.writes().length;
  const repeatB = await callOk(client, "apply_native_change", {
    change_ref: prepB.change_ref,
  });
  assert.equal(repeatB.status, "not_applied");
  assert.equal(hub.writes().length, writesAfterReject);

  // Part C: Lost reply marks uncertain (hub_effect: unknown) and never resends.
  const prepC = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(XIAOMI_DISC_WINDOW),
    option_key: "Remove",
    reason: "Удалить Xiaomi при потере ответа",
  });
  hub.state.faults.droppedReply.push({
    method: "window.update",
    remaining: 1,
    applied: true,
  });
  const writesBeforeC = hub.writes().length;
  const uncertainC = await callOk(client, "apply_native_change", {
    change_ref: prepC.change_ref,
  });
  assert.equal(uncertainC.status, "uncertain");
  assert.equal(uncertainC.hub_effect, "unknown");
  assert.equal(uncertainC.native_write_sent, true);
  assert.equal(uncertainC.native_acknowledged, false);
  assert.equal(hub.writes().length, writesBeforeC + 1);
  const retryC = await callOk(client, "apply_native_change", {
    change_ref: prepC.change_ref,
  });
  assert.equal(retryC.status, "uncertain");
  assert.equal(retryC.hub_effect, "unknown");
  assert.equal(hub.writes().length, writesBeforeC + 1);

  // Part D: MCP surface budgets (13 tools, instructions <= 2048, tool desc <= 1000, inline contract <= 4096 B).
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13, "must keep exactly 13 MCP tools");
  const oversized = tools
    .filter(({ description }) => description.length > 1_000)
    .map(({ name, description }) => `${name}: ${description.length}`);
  assert.deepEqual(oversized, []);
  const instructions = client.getInstructions();
  assert.ok(
    instructions.length <= 2_048,
    `instructions exceeded 2048 chars: ${instructions.length}`,
  );
  const contractRes = await callOk(client, "get_native_change_contract", {
    operation: "window_button",
    target_ref: windowRef(ZIGBEE_BUSY_WINDOW),
    option_key: "Remove",
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(contractRes.contract), "utf8") <= 4_096,
    "window_button contract must stay <= 4096 bytes",
  );
  const inlineValErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(ZIGBEE_BUSY_WINDOW),
    option_key: "Remove",
    value: true,
    reason: "Проверить inline contract при лишнем value",
  });
  assert.equal(inlineValErr.error.code, "invalid_native_change");
  assert.ok(inlineValErr.contract);
  assert.ok(
    Buffer.byteLength(JSON.stringify(inlineValErr.contract), "utf8") <= 4_096,
  );
});

test("multi-accessory controller child aggregates and tags dependencies across accessories, detects drift on any accessory, and indexes history for all", async (t) => {
  const dualId = "00158d0000dual01";
  const dualWin = `Controller/zigbee_1/Child/${dualId}/`;
  const dualA = 44;
  const dualB = 45;
  const { hub, client } = await setup(t, {
    patch: (fixture) => {
      fixture.accessories.push(
        {
          id: dualA,
          roomId: BEDROOM,
          name: "Двойное реле канал 1",
          online: true,
          virtual: false,
          extensionKey: ZIGBEE_EXT_KEY,
          deviceId: dualId,
          services: [
            {
              sId: 13,
              type: "Switch",
              name: "Канал 1",
              characteristics: [
                { cId: 14, type: "Name", value: "Канал 1" },
                { cId: 15, type: "On", value: false },
              ],
            },
          ],
        },
        {
          id: dualB,
          roomId: BEDROOM,
          name: "Двойное реле канал 2",
          online: true,
          virtual: false,
          extensionKey: ZIGBEE_EXT_KEY,
          deviceId: dualId,
          services: [
            {
              sId: 13,
              type: "Switch",
              name: "Канал 2",
              characteristics: [
                { cId: 14, type: "Name", value: "Канал 2" },
                { cId: 15, type: "On", value: false },
              ],
            },
          ],
        },
      );
      const alice = fixture.extensions.find(
        ({ extensionKey }) => extensionKey === "Bridge:yandex",
      );
      alice.exported[String(dualA)] = [13];
    },
  });
  hub.state.accessories.find(({ id }) => id === dualA).deviceWindow = dualWin;
  hub.state.accessories.find(({ id }) => id === dualB).deviceWindow = dualWin;
  hub.state.windows[dualWin] = childWindow(dualWin, "Двойное реле", {
    infoHtml: `Address: ${dualId}/73B0<br>Clusters: 0000_Basic`,
    accessories: [
      { id: dualA, name: "Двойное реле канал 1" },
      { id: dualB, name: "Двойное реле канал 2" },
    ],
  });

  // Prepare: only dualA is exported to Alice.
  const prep1 = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(dualWin),
    option_key: "Remove",
    reason: "Удалить двойное реле",
  });
  assert.equal(prep1.device_remove.linked_accessories.length, 2);
  assert.equal(prep1.device_remove.linked_accessories_unconfirmed, false);
  assert.deepEqual(prep1.device_remove.dependencies.bridges, [
    {
      ref: extensionRef("Bridge:yandex"),
      name: "Яндекс Алиса",
      accessory_ref: accessoryRef(dualA),
      accessory_name: "Двойное реле канал 1",
    },
  ]);

  // Exporting dualB to the SAME bridge (Alice) before apply MUST trigger dependencies_changed!
  const alice = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:yandex",
  );
  alice.exported[String(dualB)] = [13];
  const drift = await callOk(client, "apply_native_change", {
    change_ref: prep1.change_ref,
  });
  assert.equal(drift.status, "conflict");
  assert.equal(drift.conflict_reason, "dependencies_changed");
  assert.equal(drift.device_remove.dependencies.bridges.length, 2);
  assert.deepEqual(hub.writes(), []);

  // Re-prepare with both bridges acknowledged, apply, verify both accessories absent & indexed.
  const prep2 = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(dualWin),
    option_key: "Remove",
    reason: "Удалить двойное реле после проверки обоих каналов",
  });
  assert.equal(prep2.device_remove.dependencies.bridges.length, 2);
  const applied = await callOk(client, "apply_native_change", {
    change_ref: prep2.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.observed_effect, {
    window_absent: true,
    child_absent: true,
    accessories_absent: [accessoryRef(dualA), accessoryRef(dualB)],
    accessories_remaining: [],
  });
  for (const ref of [accessoryRef(dualA), accessoryRef(dualB)]) {
    const history = await callOk(client, "get_native_change", {
      home_ref: HOME_REF,
      entity_ref: ref,
    });
    assert.ok(
      history.changes.some(({ change_ref }) => change_ref === prep2.change_ref),
      `history for ${ref} must include ${prep2.change_ref}`,
    );
  }
});
