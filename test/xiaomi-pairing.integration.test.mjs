import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
const LIVING_ROOM = 3;
const KITCHEN = 4;
const BEDROOM = 5;

const XIAOMI_EXT_KEY = "Controller:xiaomi_1";
const ZIGBEE_EXT_KEY = "Controller:zigbee_1";
const TELEGRAM_EXT_KEY = "Notification:telegram_1";
const HOMEKIT_EXT_KEY = "Bridge:homekit_1";
const IR_EXT_KEY = "Controller:ir_1";

const XIAOMI_ONLINE_ID = "mi_hum_01";
const XIAOMI_ROOM_ERR_ID = "mi_pur_02";
const XIAOMI_OFFLINE_ID = "mi_off_03";
const XIAOMI_JOINED_ID = "mi_main_04";
const XIAOMI_JOINED_STALE_ID = "mi_main_stale_05";
const XIAOMI_LINKED_DISC_ID = "mi_linked_disc_06";
const XIAOMI_JOINED_ACC = 77;
const XIAOMI_LINKED_DISC_ACC = 78;

const XIAOMI_CTRL_WINDOW = "Controller/xiaomi_1/";
const XIAOMI_ONLINE_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_ONLINE_ID}/`;
const XIAOMI_ROOM_ERR_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_ROOM_ERR_ID}/`;
const XIAOMI_OFFLINE_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_OFFLINE_ID}/`;
const XIAOMI_JOINED_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_JOINED_ID}/`;
const XIAOMI_JOINED_STALE_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_JOINED_STALE_ID}/`;
const XIAOMI_LINKED_DISC_WINDOW = `Controller/xiaomi_1/Child/${XIAOMI_LINKED_DISC_ID}/`;
const ZIGBEE_CHILD_WINDOW = "Controller/zigbee_1/Child/00158d0001a2b3c4/";
const TELEGRAM_WINDOW = "Notification/telegram_1/";
const HOMEKIT_CHILD_WINDOW = "Bridge/homekit_1/Child/16/";
const IR_CHILD_WINDOW = "Controller/ir_1/Child/ir_01/";

const SECRET_CHILD_TOKEN = "XiaomiChildBearerSecret991";
const SECRET_ROOM_PASS = "XiaomiRoomPassword772";
const SECRET_ERR_TOKEN = "XiaomiErrorSecretToken553";

function windowRef(windowKey) {
  return `${HOME_REF}/window/${encodeURIComponent(windowKey)}`;
}

function extensionRef(extensionKey) {
  return `${HOME_REF}/extension/${encodeURIComponent(extensionKey)}`;
}

function extensionChildRef(extensionKey, childId) {
  return `${extensionRef(extensionKey)}/child/${encodeURIComponent(childId)}`;
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

function joinRoomOption(selectedValue = String(LIVING_ROOM), validValues) {
  return optionEntry(
    "joinRoom",
    "Комната",
    "GenericString",
    "TEXT",
    { stringValue: selectedValue },
    {
      validValues: validValues ?? [
        { name: "Гостиная", value: { stringValue: String(LIVING_ROOM) } },
        { name: "Кухня", value: { stringValue: String(KITCHEN) } },
        { name: "Спальня", value: { stringValue: String(BEDROOM) } },
      ],
    },
  );
}

function joinButtonOption(extra = {}) {
  return optionEntry(
    "joinButton",
    "Подключить",
    "GenericBoolean",
    "BUTTON",
    { boolValue: true },
    extra,
  );
}

function removeOption() {
  return optionEntry(
    "Remove",
    "Удалить",
    "GenericBoolean",
    "BUTTON_DANGER",
    { boolValue: true },
    {
      validValues: [
        {
          value: { boolValue: true },
          confirm: "Действительно хотите удалить?",
        },
      ],
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

function xiaomiDiscoveryWindow(
  windowKey,
  labelText,
  {
    selectedRoom = String(LIVING_ROOM),
    roomValidValues,
    includeJoinRoom = true,
    includeJoinButton = true,
    joinButtonExtra = {},
    accessories,
    error,
  } = {},
) {
  const options = [accessoriesListOption(accessories)];
  if (includeJoinRoom) {
    options.push(joinRoomOption(selectedRoom, roomValidValues));
  }
  if (includeJoinButton) {
    options.push(joinButtonOption(joinButtonExtra));
  }
  options.push(
    optionEntry("ip", "IP-адрес", "GenericString", "TEXT", {
      stringValue: "192.168.1.44",
    }),
    removeOption(),
  );
  return {
    windowKey,
    label: {
      text: labelText,
      ...(error !== undefined ? { error } : {}),
    },
    options,
  };
}

async function setup(t, { patch, faults, onRequest, timeoutMs } = {}) {
  const fixture = await loadHomeFixture("apartment");
  fixture.extensions.push(
    {
      extensionKey: XIAOMI_EXT_KEY,
      type: "xiaomi",
      index: "xiaomi_1",
      bundleType: "CONTROLLER",
      name: "Xiaomi",
      state: "LOADED",
      enabled: true,
      optionsWindow: XIAOMI_CTRL_WINDOW,
      spaces: [
        { key: "main", label: { button: "Мои устройства" } },
        { key: "discovery", label: { button: "Новые устройства" } },
      ],
      children: [
        {
          id: XIAOMI_ONLINE_ID,
          name: "Увлажнитель Xiaomi",
          spaceKey: "discovery",
          online: true,
          optionsWindow: XIAOMI_ONLINE_WINDOW,
        },
        {
          id: XIAOMI_ROOM_ERR_ID,
          name: "Очиститель Xiaomi",
          spaceKey: "discovery",
          online: true,
          optionsWindow: XIAOMI_ROOM_ERR_WINDOW,
        },
        {
          id: XIAOMI_OFFLINE_ID,
          name: "Увлажнитель не в сети",
          spaceKey: "discovery",
          online: false,
          joinDeferred: true,
          optionsWindow: XIAOMI_OFFLINE_WINDOW,
        },
        {
          id: XIAOMI_JOINED_ID,
          name: "Пылесос Xiaomi",
          spaceKey: "main",
          online: true,
          optionsWindow: XIAOMI_JOINED_WINDOW,
        },
        {
          id: XIAOMI_JOINED_STALE_ID,
          name: "Вентилятор Xiaomi",
          spaceKey: "main",
          online: true,
          optionsWindow: XIAOMI_JOINED_STALE_WINDOW,
        },
        {
          id: XIAOMI_LINKED_DISC_ID,
          name: "Чайник Xiaomi",
          spaceKey: "discovery",
          online: true,
          optionsWindow: XIAOMI_LINKED_DISC_WINDOW,
        },
      ],
    },
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
          id: "00158d0001a2b3c4",
          name: "Датчик ZigBee",
          spaceKey: "main",
          online: true,
          optionsWindow: ZIGBEE_CHILD_WINDOW,
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
      optionsWindow: TELEGRAM_WINDOW,
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
          id: "ir_01",
          name: "ИК пульт",
          spaceKey: "main",
          online: true,
          optionsWindow: IR_CHILD_WINDOW,
        },
      ],
    },
  );

  fixture.accessories.push(
    {
      id: XIAOMI_JOINED_ACC,
      roomId: LIVING_ROOM,
      name: "Пылесос Xiaomi",
      online: true,
      virtual: false,
      extensionKey: XIAOMI_EXT_KEY,
      deviceId: XIAOMI_JOINED_ID,
      services: [
        {
          sId: 13,
          type: "Switch",
          name: "Пылесос Xiaomi",
          characteristics: [
            { cId: 14, type: "Name", value: "Пылесос Xiaomi" },
            { cId: 15, type: "On", value: false },
          ],
        },
      ],
    },
    {
      id: XIAOMI_LINKED_DISC_ACC,
      roomId: KITCHEN,
      name: "Чайник Xiaomi",
      online: true,
      virtual: false,
      extensionKey: XIAOMI_EXT_KEY,
      deviceId: XIAOMI_LINKED_DISC_ID,
      services: [
        {
          sId: 13,
          type: "Switch",
          name: "Чайник Xiaomi",
          characteristics: [
            { cId: 14, type: "Name", value: "Чайник Xiaomi" },
            { cId: 15, type: "On", value: false },
          ],
        },
      ],
    },
  );

  if (patch) patch(fixture);

  const hub = await startSimulatedHub(fixture, { faults, onRequest });
  hub.state.windows[XIAOMI_ONLINE_WINDOW] = xiaomiDiscoveryWindow(
    XIAOMI_ONLINE_WINDOW,
    "Увлажнитель Xiaomi",
  );
  hub.state.windows[XIAOMI_ROOM_ERR_WINDOW] = xiaomiDiscoveryWindow(
    XIAOMI_ROOM_ERR_WINDOW,
    "Очиститель Xiaomi",
    { selectedRoom: String(KITCHEN) },
  );
  hub.state.windows[XIAOMI_OFFLINE_WINDOW] = xiaomiDiscoveryWindow(
    XIAOMI_OFFLINE_WINDOW,
    "Увлажнитель не в сети",
    { selectedRoom: String(LIVING_ROOM) },
  );
  hub.state.windows[XIAOMI_JOINED_WINDOW] = xiaomiDiscoveryWindow(
    XIAOMI_JOINED_WINDOW,
    "Пылесос Xiaomi",
    {
      includeJoinRoom: false,
      includeJoinButton: false,
      accessories: [{ id: XIAOMI_JOINED_ACC, name: "Пылесос Xiaomi" }],
    },
  );
  hub.state.windows[XIAOMI_JOINED_STALE_WINDOW] = xiaomiDiscoveryWindow(
    XIAOMI_JOINED_STALE_WINDOW,
    "Вентилятор Xiaomi",
    { accessories: undefined },
  );
  hub.state.windows[XIAOMI_LINKED_DISC_WINDOW] = xiaomiDiscoveryWindow(
    XIAOMI_LINKED_DISC_WINDOW,
    "Чайник Xiaomi",
    {
      accessories: [{ id: XIAOMI_LINKED_DISC_ACC, name: "Чайник Xiaomi" }],
    },
  );
  hub.state.windows[XIAOMI_CTRL_WINDOW] = {
    windowKey: XIAOMI_CTRL_WINDOW,
    label: { text: "Xiaomi" },
    options: [
      optionEntry("Login", "Войти", "GenericBoolean", "BUTTON", {
        boolValue: true,
      }),
      optionEntry("Logout", "Выйти из аккаунта", "GenericBoolean", "BUTTON", {
        boolValue: true,
      }),
      joinButtonOption(),
    ],
  };
  hub.state.windows[ZIGBEE_CHILD_WINDOW] = {
    windowKey: ZIGBEE_CHILD_WINDOW,
    label: { text: "Датчик ZigBee" },
    options: [joinButtonOption(), removeOption()],
  };
  hub.state.windows[TELEGRAM_WINDOW] = {
    windowKey: TELEGRAM_WINDOW,
    label: { text: "Telegram" },
    options: [joinButtonOption()],
  };
  hub.state.windows[HOMEKIT_CHILD_WINDOW] = {
    windowKey: HOMEKIT_CHILD_WINDOW,
    label: { text: "Торшер" },
    options: [joinButtonOption()],
  };
  hub.state.windows[IR_CHILD_WINDOW] = {
    windowKey: IR_CHILD_WINDOW,
    label: { text: "ИК пульт" },
    options: [joinButtonOption()],
  };
  hub.state.windows[""].options.push(joinButtonOption());

  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-xiaomi-pairing-"),
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
    name: "xiaomi-pairing-test",
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

async function readAllStateText(stateDirectory) {
  const entries = await readdir(stateDirectory);
  const parts = [];
  for (const name of entries) {
    parts.push(await readFile(path.join(stateDirectory, name), "utf8"));
  }
  return parts.join("\n");
}

function assertNoSecrets(payload, secrets) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const secret of secrets) {
    assert.equal(
      text.includes(secret),
      false,
      `secret unexpectedly leaked: ${secret.slice(0, 12)}...`,
    );
  }
}

test("full Xiaomi pairing flow: joinRoom via window_option (undoable before join), joinButton via window_button with honest readback, history indexing, and room.get fault isolation", async (t) => {
  const { hub, client } = await setup(t);
  const winRef = windowRef(XIAOMI_ONLINE_WINDOW);

  // 1. get_entity exposes joinRoom (window_option) and joinButton (window_button, no confirmation).
  const winEntity = await callOk(client, "get_entity", { entity_ref: winRef });
  const joinRoomOpt = winEntity.entity.options.find(
    ({ key }) => key === "joinRoom",
  );
  assert.equal(joinRoomOpt.native_change.supported, true);
  assert.equal(joinRoomOpt.native_change.operation, "window_option");

  const joinCmd = winEntity.entity.commands.find(
    ({ key }) => key === "joinButton",
  );
  assert.deepEqual(joinCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
  });
  assert.equal(
    Object.hasOwn(joinCmd.native_change, "requires_confirmation"),
    false,
  );

  // 2. get_native_change_contract inspects Xiaomi joinButton cleanly within 4 KB.
  const contract = await callOk(client, "get_native_change_contract", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
  });
  assert.deepEqual(contract.contract.button, {
    key: "joinButton",
    name: "Подключить",
    kind: "xiaomi_join",
    requires_confirmation: false,
  });
  assert.ok(contract.contract.allowlist.xiaomi_join);
  assert.equal(contract.contract.restore_supported, false);
  assert.ok(
    Buffer.byteLength(JSON.stringify(contract.contract), "utf8") <= 4_096,
  );

  // 3. Set joinRoom to Kitchen via window_option, verify undo still works before join, then set Bedroom.
  const prepKitchen = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: winRef,
    option_key: "joinRoom",
    value: String(KITCHEN),
    reason: "Выбрать кухню для увлажнителя Xiaomi",
  });
  const appliedKitchen = await callOk(client, "apply_native_change", {
    change_ref: prepKitchen.change_ref,
  });
  assert.equal(appliedKitchen.status, "applied");
  const restoredRoom = await callOk(client, "restore_native_change", {
    change_ref: prepKitchen.change_ref,
  });
  assert.equal(restoredRoom.status, "restored");
  assert.equal(
    hub.state.windows[XIAOMI_ONLINE_WINDOW].options.find(
      ({ key }) => key === "joinRoom",
    ).value.stringValue,
    String(LIVING_ROOM),
  );

  const prepBedroom = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: winRef,
    option_key: "joinRoom",
    value: String(BEDROOM),
    reason: "Выбрать спальню для увлажнителя Xiaomi",
  });
  await callOk(client, "apply_native_change", {
    change_ref: prepBedroom.change_ref,
  });

  // 4. Prepare joinButton: no tell_owner, next=apply_native_change, sanitized xiaomi_join metadata.
  const writesBeforeJoinPrep = hub.writes().length;
  const prepJoin = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Подключить увлажнитель Xiaomi в спальне",
  });
  assert.equal(prepJoin.status, "prepared");
  assert.equal(prepJoin.operation, "window_button");
  assert.equal(prepJoin.button.kind, "xiaomi_join");
  assert.equal(prepJoin.button.requires_confirmation, false);
  assert.equal(prepJoin.tell_owner, undefined);
  assert.equal(prepJoin.next?.tool, "apply_native_change");
  assert.equal(prepJoin.next?.arguments?.change_ref, prepJoin.change_ref);
  assert.equal(prepJoin.restore_supported, false);
  assert.equal(prepJoin.native_write_sent, false);
  assert.equal(prepJoin.native_acknowledged, false);
  assert.deepEqual(prepJoin.xiaomi_join, {
    controller_ref: extensionRef(XIAOMI_EXT_KEY),
    extension_key: XIAOMI_EXT_KEY,
    child_id: XIAOMI_ONLINE_ID,
    child_name: "Увлажнитель Xiaomi",
    space_key: "discovery",
    online: true,
    selected_room: { value: String(BEDROOM), name: "Спальня" },
    child_unread: false,
  });
  assert.equal(hub.writes().length, writesBeforeJoinPrep);

  // 5. Apply joinButton: sends window.update joinButton={boolValue:true}, observes main + created accessory.
  const appliedJoin = await callOk(client, "apply_native_change", {
    change_ref: prepJoin.change_ref,
  });
  assert.equal(appliedJoin.status, "applied");
  assert.equal(appliedJoin.native_write_sent, true);
  assert.equal(appliedJoin.native_acknowledged, true);
  assert.equal(appliedJoin.readback_error, undefined);
  assert.equal(appliedJoin.verification.fresh, true);
  assert.equal(appliedJoin.verification.result, "xiaomi_join_observed");

  const joinWrite = hub.writes().at(-1);
  assert.deepEqual(joinWrite.params, {
    window: {
      update: {
        windowKey: XIAOMI_ONLINE_WINDOW,
        options: [{ key: "joinButton", value: { boolValue: true } }],
      },
    },
  });

  const createdAcc = hub.state.accessories.find(
    ({ deviceId }) => deviceId === XIAOMI_ONLINE_ID,
  );
  assert.ok(createdAcc, "simulated hub must create Xiaomi accessory");
  assert.equal(createdAcc.roomId, BEDROOM);
  assert.deepEqual(appliedJoin.observed_effect, {
    space_key: "main",
    online: true,
    child_present: true,
    join_button_visible: false,
    created_accessories: [
      {
        ref: accessoryRef(createdAcc.id),
        name: "Увлажнитель Xiaomi",
        room_ref: roomRef(BEDROOM),
        room_name: "Спальня",
      },
    ],
  });
  assert.ok(
    appliedJoin.limitations.some((line) => /not yet been observed/i.test(line)),
    "limitations must honestly note live joinButton was not observed on a live hub",
  );
  assert.ok(
    appliedJoin.limitations.some((line) => /offline/i.test(line)),
    "limitations must mention offline Xiaomi devices may fail or stay unjoined",
  );

  // Repeat apply MUST NOT resend!
  const writesAfterApply = hub.writes().length;
  const repeated = await callOk(client, "apply_native_change", {
    change_ref: prepJoin.change_ref,
  });
  assert.equal(repeated.status, "applied");
  assert.equal(hub.writes().length, writesAfterApply);

  // 6. History indexed under window ref, controller extension ref, child ref, AND created accessory ref!
  for (const entityRef of [
    winRef,
    extensionRef(XIAOMI_EXT_KEY),
    extensionChildRef(XIAOMI_EXT_KEY, XIAOMI_ONLINE_ID),
    accessoryRef(createdAcc.id),
  ]) {
    const history = await callOk(client, "get_native_change", {
      home_ref: HOME_REF,
      entity_ref: entityRef,
    });
    assert.ok(
      history.changes.some(
        ({ change_ref }) => change_ref === prepJoin.change_ref,
      ),
      `history for ${entityRef} must include ${prepJoin.change_ref}`,
    );
  }

  // 7. Cosmetic room.get failure during post-ACK readback keeps created_accessories (room_name: null)
  //    without triggering readback_error.
  const roomErrWinRef = windowRef(XIAOMI_ROOM_ERR_WINDOW);
  const prepRoomErr = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: roomErrWinRef,
    option_key: "joinButton",
    reason: "Подключить очиститель Xiaomi при сбое room.get",
  });
  hub.refuseNext("room.get", {
    code: -32603,
    message: "Temporary room.get failure",
  });
  const appliedRoomErr = await callOk(client, "apply_native_change", {
    change_ref: prepRoomErr.change_ref,
  });
  const createdPurifier = hub.state.accessories.find(
    ({ deviceId }) => deviceId === XIAOMI_ROOM_ERR_ID,
  );
  assert.equal(appliedRoomErr.status, "applied");
  assert.equal(appliedRoomErr.readback_error, undefined);
  assert.equal(appliedRoomErr.verification.fresh, true);
  assert.equal(appliedRoomErr.verification.result, "xiaomi_join_observed");
  assert.deepEqual(appliedRoomErr.observed_effect.created_accessories, [
    {
      ref: accessoryRef(createdPurifier.id),
      name: "Очиститель Xiaomi",
      room_ref: roomRef(KITCHEN),
      room_name: null,
    },
  ]);
});

test("Xiaomi joinButton enforces strict refusals (already-joined main/linked, non-Xiaomi windows, Xiaomi controller Login/Logout, hidden/disabled) and honest child_unread on prepare", async (t) => {
  const { hub, client } = await setup(t);

  // 1. Already-joined Xiaomi children refused with xiaomi_device_already_joined (retryable: false, no contract).
  for (const [label, targetRef] of [
    ["main space without joinButton (H5)", windowRef(XIAOMI_JOINED_WINDOW)],
    ["main space with stale joinButton", windowRef(XIAOMI_JOINED_STALE_WINDOW)],
    [
      "discovery space with confirmed linked accessory",
      windowRef(XIAOMI_LINKED_DISC_WINDOW),
    ],
  ]) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_button",
      target_ref: targetRef,
      option_key: "joinButton",
      reason: `Подключить уже добавленное (${label})`,
    });
    assert.equal(err.error.code, "xiaomi_device_already_joined", label);
    assert.equal(err.error.retryable, false, label);
    assert.equal(err.contract, undefined, label);
  }

  // 2. Non-Xiaomi windows and Xiaomi controller Login/Logout strictly refused.
  const zigbeeEntity = await callOk(client, "get_entity", {
    entity_ref: windowRef(ZIGBEE_CHILD_WINDOW),
  });
  assert.equal(
    Object.hasOwn(
      zigbeeEntity.entity.commands.find(({ key }) => key === "joinButton"),
      "native_change",
    ),
    false,
    "ZigBee child joinButton must NOT receive native_change",
  );
  const ctrlEntity = await callOk(client, "get_entity", {
    entity_ref: windowRef(XIAOMI_CTRL_WINDOW),
  });
  for (const key of ["Login", "Logout", "joinButton"]) {
    assert.equal(
      Object.hasOwn(
        ctrlEntity.entity.commands.find((cmd) => cmd.key === key),
        "native_change",
      ),
      false,
      `Xiaomi controller ${key} must NOT receive native_change`,
    );
  }

  const refusedCases = [
    ["ZigBee child joinButton", windowRef(ZIGBEE_CHILD_WINDOW), "joinButton"],
    [
      "Xiaomi controller joinButton",
      windowRef(XIAOMI_CTRL_WINDOW),
      "joinButton",
    ],
    ["Xiaomi controller Login", windowRef(XIAOMI_CTRL_WINDOW), "Login"],
    ["Xiaomi controller Logout", windowRef(XIAOMI_CTRL_WINDOW), "Logout"],
    ["Telegram joinButton", windowRef(TELEGRAM_WINDOW), "joinButton"],
    ["HomeKit child joinButton", windowRef(HOMEKIT_CHILD_WINDOW), "joinButton"],
    [
      "IR controller child joinButton",
      windowRef(IR_CHILD_WINDOW),
      "joinButton",
    ],
    ["Hub settings joinButton", windowRef(""), "joinButton"],
    ["Scenario joinButton", windowRef("Scenario/5/"), "joinButton"],
  ];
  for (const [label, targetRef, optionKey] of refusedCases) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_button",
      target_ref: targetRef,
      option_key: optionKey,
      reason: `Попробовать ${label}`,
    });
    assert.equal(err.error.code, "unsupported_window_button", label);
    assert.equal(err.contract, undefined, label);
  }

  // 3. Hidden joinButton on discovery child -> window_button_hidden (omitted from get_entity).
  const winRef = windowRef(XIAOMI_ONLINE_WINDOW);
  const joinBtn = hub.state.windows[XIAOMI_ONLINE_WINDOW].options.find(
    ({ key }) => key === "joinButton",
  );
  joinBtn.visible = false;
  const hiddenEntity = await callOk(client, "get_entity", {
    entity_ref: winRef,
  });
  assert.equal(
    hiddenEntity.entity.commands.some(({ key }) => key === "joinButton"),
    false,
  );
  const hiddenErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Нажать скрытую кнопку joinButton",
  });
  assert.equal(hiddenErr.error.code, "window_button_hidden");
  joinBtn.visible = true;

  // 4. Disabled joinButton on discovery child -> window_button_disabled (disabled: true, no native_change).
  joinBtn.disabled = true;
  const disabledEntity = await callOk(client, "get_entity", {
    entity_ref: winRef,
  });
  const disabledCmd = disabledEntity.entity.commands.find(
    ({ key }) => key === "joinButton",
  );
  assert.equal(disabledCmd.disabled, true);
  assert.equal(Object.hasOwn(disabledCmd, "native_change"), false);
  const disabledErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Нажать отключённую кнопку joinButton",
  });
  assert.equal(disabledErr.error.code, "window_button_disabled");
  joinBtn.disabled = false;

  // 5. Unexpected value on valid Xiaomi joinButton -> invalid_native_change WITH compact inline contract.
  const valueErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    value: true,
    reason: "Передать лишнее value в joinButton",
  });
  assert.equal(valueErr.error.code, "invalid_native_change");
  assert.ok(valueErr.contract);
  assert.ok(
    Buffer.byteLength(JSON.stringify(valueErr.contract), "utf8") <= 4_096,
  );

  // 6. extensionChild.list failure during prepare records child_unread: true honestly.
  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Temporary child list failure on prepare",
  });
  const prepUnread = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Подготовить подключение при сбое extensionChild.list",
  });
  assert.equal(prepUnread.status, "prepared");
  assert.deepEqual(prepUnread.xiaomi_join, {
    controller_ref: extensionRef(XIAOMI_EXT_KEY),
    extension_key: XIAOMI_EXT_KEY,
    child_id: XIAOMI_ONLINE_ID,
    child_name: "Увлажнитель Xiaomi",
    space_key: null,
    online: null,
    selected_room: { value: String(LIVING_ROOM), name: "Гостиная" },
    child_unread: true,
  });

  // Zero writes were sent during all refusals and preparations.
  assert.deepEqual(hub.writes(), []);
});

test("Xiaomi joinButton pre-write drift guard conflicts on already-joined or vanished button while transient read errors keep prepared change retryable", async (t) => {
  const { hub, client } = await setup(t, { timeoutMs: 350 });
  const winRef = windowRef(XIAOMI_ONLINE_WINDOW);
  const purifierRef = windowRef(XIAOMI_ROOM_ERR_WINDOW);

  // 1. Transient extensionChild.list timeout during apply -> retryable timeout, 0 writes, stays prepared.
  const prepRetry = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Проверить временный таймаут перед apply",
  });
  hub.state.faults.droppedReply.push({
    method: "extensionChild.list",
    remaining: 1,
    applied: false,
  });
  const timeoutErr = await callError(client, "apply_native_change", {
    change_ref: prepRetry.change_ref,
  });
  assert.equal(timeoutErr.error.code, "timeout");
  assert.equal(timeoutErr.error.retryable, true);
  assert.deepEqual(hub.writes(), []);

  // Also transient request_rejected on extensionChild.list keeps status=prepared!
  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Temporary extensionChild.list failure",
  });
  const rejectReadErr = await callError(client, "apply_native_change", {
    change_ref: prepRetry.change_ref,
  });
  assert.equal(rejectReadErr.error.code, "request_rejected");
  assert.deepEqual(hub.writes(), []);

  const stillPrepared = await callOk(client, "get_native_change", {
    change_ref: prepRetry.change_ref,
  });
  assert.equal(stillPrepared.status, "prepared");
  assert.equal(stillPrepared.verification.result, "xiaomi_not_joined");

  // Retrying apply after transient failures succeeds cleanly!
  const retriedApply = await callOk(client, "apply_native_change", {
    change_ref: prepRetry.change_ref,
  });
  assert.equal(retriedApply.status, "applied");
  assert.equal(retriedApply.verification.result, "xiaomi_join_observed");
  const writesAfterSuccess = hub.writes().length;

  // 2. Child moved to main before apply (even while joinButton still visible) -> conflict, 0 writes!
  const prepMainDrift = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: purifierRef,
    option_key: "joinButton",
    reason: "Проверить дрейф spaceKey=main до apply",
  });
  const xiaomiExt = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
  );
  const purifierChild = xiaomiExt.children.find(
    ({ id }) => id === XIAOMI_ROOM_ERR_ID,
  );
  purifierChild.spaceKey = "main";
  const mainConflict = await callOk(client, "apply_native_change", {
    change_ref: prepMainDrift.change_ref,
  });
  assert.equal(mainConflict.status, "conflict");
  assert.equal(mainConflict.conflict_reason, "xiaomi_device_already_joined");
  assert.equal(mainConflict.native_write_sent, false);
  assert.equal(hub.writes().length, writesAfterSuccess);

  // Reset to discovery and test joinButton vanishing before apply -> conflict window_button_not_found, 0 writes!
  purifierChild.spaceKey = "discovery";
  const prepVanish = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: purifierRef,
    option_key: "joinButton",
    reason: "Проверить исчезновение joinButton до apply",
  });
  hub.state.windows[XIAOMI_ROOM_ERR_WINDOW].options = hub.state.windows[
    XIAOMI_ROOM_ERR_WINDOW
  ].options.filter(({ key }) => key !== "joinButton");
  const vanishConflict = await callOk(client, "apply_native_change", {
    change_ref: prepVanish.change_ref,
  });
  assert.equal(vanishConflict.status, "conflict");
  assert.equal(vanishConflict.conflict_reason, "window_button_not_found");
  assert.equal(vanishConflict.native_write_sent, false);
  assert.equal(hub.writes().length, writesAfterSuccess);
});

test("Xiaomi joinButton honest readback covers prepared, pending/offline, lost reply uncertain, post-ACK readback_error, hub rejection, and restore refusal", async (t) => {
  let failReadbackAfterUpdate = false;
  const { hub, client } = await setup(t, {
    timeoutMs: 350,
    onRequest: ({ method }) => {
      if (failReadbackAfterUpdate && method === "window.update") {
        failReadbackAfterUpdate = false;
        hub.refuseNext("extensionChild.list", {
          code: -32603,
          message: "Temporary post-ACK child list failure",
        });
      }
    },
  });
  const offlineWinRef = windowRef(XIAOMI_OFFLINE_WINDOW);
  const onlineWinRef = windowRef(XIAOMI_ONLINE_WINDOW);
  const purifierWinRef = windowRef(XIAOMI_ROOM_ERR_WINDOW);

  // 1. Prepared change readback -> xiaomi_not_joined; readback failure on prepared -> unsent limitation.
  const prepOffline = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: offlineWinRef,
    option_key: "joinButton",
    reason: "Подключить недоступный увлажнитель Xiaomi",
  });
  assert.equal(prepOffline.xiaomi_join.online, false);

  const readPrepared = await callOk(client, "get_native_change", {
    change_ref: prepOffline.change_ref,
  });
  assert.equal(readPrepared.status, "prepared");
  assert.deepEqual(readPrepared.observed_effect, {
    space_key: "discovery",
    online: false,
    child_present: true,
    join_button_visible: true,
    created_accessories: [],
  });
  assert.equal(readPrepared.verification.fresh, true);
  assert.equal(readPrepared.verification.result, "xiaomi_not_joined");

  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Temporary read failure on prepared",
  });
  const readPreparedErr = await callOk(client, "get_native_change", {
    change_ref: prepOffline.change_ref,
  });
  assert.equal(readPreparedErr.status, "prepared");
  assert.ok(readPreparedErr.readback_error?.extension_children);
  assert.equal(readPreparedErr.verification.fresh, false);
  assert.equal(readPreparedErr.verification.result, "readback_incomplete");
  assert.equal(
    readPreparedErr.limitations.some((line) =>
      /acknowledged the button press|was sent/i.test(line),
    ),
    false,
    "unsent readback_error must NOT claim ACK or send",
  );

  // 2. ACKed join on deferred/offline child still in discovery -> status=applied, xiaomi_join_pending!
  const appliedPending = await callOk(client, "apply_native_change", {
    change_ref: prepOffline.change_ref,
  });
  assert.equal(appliedPending.status, "applied");
  assert.equal(appliedPending.native_write_sent, true);
  assert.equal(appliedPending.native_acknowledged, true);
  assert.equal(appliedPending.observed_effect.space_key, "discovery");
  assert.equal(appliedPending.observed_effect.join_button_visible, true);
  assert.deepEqual(appliedPending.observed_effect.created_accessories, []);
  assert.equal(appliedPending.verification.fresh, true);
  assert.equal(appliedPending.verification.result, "xiaomi_join_pending");

  // 3. Post-ACK readback failure preserves status=applied with readback_error; get_native_change refreshes.
  const prepReadbackErr = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: onlineWinRef,
    option_key: "joinButton",
    reason: "Подключить увлажнитель при сбое readback",
  });
  failReadbackAfterUpdate = true;
  const appliedReadbackErr = await callOk(client, "apply_native_change", {
    change_ref: prepReadbackErr.change_ref,
  });
  assert.equal(appliedReadbackErr.status, "applied");
  assert.equal(appliedReadbackErr.native_acknowledged, true);
  assert.ok(appliedReadbackErr.readback_error?.extension_children);
  assert.equal(appliedReadbackErr.verification.fresh, false);
  assert.equal(appliedReadbackErr.verification.result, "readback_incomplete");
  assert.ok(
    appliedReadbackErr.limitations.some((line) =>
      /acknowledged the button press/i.test(line),
    ),
  );
  // Window readback still succeeded and observed created accessory + join_button_visible=false!
  assert.equal(appliedReadbackErr.observed_effect.join_button_visible, false);
  assert.equal(
    appliedReadbackErr.observed_effect.created_accessories.length,
    1,
  );

  const writesBeforeRefresh = hub.writes().length;
  const refreshed = await callOk(client, "get_native_change", {
    change_ref: prepReadbackErr.change_ref,
  });
  assert.equal(refreshed.status, "applied");
  assert.equal(refreshed.readback_error, undefined);
  assert.equal(refreshed.verification.fresh, true);
  assert.equal(refreshed.verification.result, "xiaomi_join_observed");
  assert.equal(refreshed.observed_effect.space_key, "main");
  assert.equal(hub.writes().length, writesBeforeRefresh);

  // Even if a later get_native_change fails window.get transiently, history under created accessory stays indexed!
  const createdRef = refreshed.observed_effect.created_accessories[0].ref;
  hub.refuseNext("window.get", {
    code: -32603,
    message: "Transient window.get error",
  });
  const transientGet = await callOk(client, "get_native_change", {
    change_ref: prepReadbackErr.change_ref,
  });
  assert.equal(transientGet.verification.result, "readback_incomplete");
  const accHistory = await callOk(client, "get_native_change", {
    home_ref: HOME_REF,
    entity_ref: createdRef,
  });
  assert.ok(
    accHistory.changes.some(
      ({ change_ref }) => change_ref === prepReadbackErr.change_ref,
    ),
  );

  // 4. Lost reply (applied: false) -> uncertain (hub_effect: unknown), never resends, honest verification.
  const prepLost = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: purifierWinRef,
    option_key: "joinButton",
    reason: "Подключить очиститель при потере ответа",
  });
  const writesBeforeLost = hub.writes().length;
  hub.state.faults.droppedReply.push({
    method: "window.update",
    remaining: 1,
    applied: false,
  });
  const uncertain = await callOk(client, "apply_native_change", {
    change_ref: prepLost.change_ref,
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.hub_effect, "unknown");
  assert.equal(uncertain.native_write_sent, true);
  assert.equal(uncertain.native_acknowledged, false);
  assert.equal(hub.writes().length, writesBeforeLost + 1);

  // Retrying apply MUST NOT resend!
  const retriedUncertain = await callOk(client, "apply_native_change", {
    change_ref: prepLost.change_ref,
  });
  assert.equal(retriedUncertain.status, "uncertain");
  assert.equal(hub.writes().length, writesBeforeLost + 1);

  const inspectedUncertain = await callOk(client, "get_native_change", {
    change_ref: prepLost.change_ref,
  });
  assert.equal(inspectedUncertain.status, "uncertain");
  assert.equal(inspectedUncertain.verification.fresh, true);
  assert.equal(inspectedUncertain.verification.result, "xiaomi_join_pending");

  hub.refuseNext("window.get", {
    code: -32603,
    message: "Window read error on uncertain",
  });
  const uncertainReadErr = await callOk(client, "get_native_change", {
    change_ref: prepLost.change_ref,
  });
  assert.equal(uncertainReadErr.verification.result, "readback_incomplete");
  assert.ok(
    uncertainReadErr.limitations.some((line) =>
      /without a confirmed hub reply/i.test(line),
    ),
  );
  assert.equal(
    uncertainReadErr.limitations.some((line) =>
      /acknowledged the button press/i.test(line),
    ),
    false,
  );

  // 5. Hub explicit rejection -> not_applied, never resends, and get_native_change says xiaomi_not_joined!
  const prepRejected = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: purifierWinRef,
    option_key: "joinButton",
    reason: "Подключить очиститель при отказе хаба",
  });
  const writesBeforeReject = hub.writes().length;
  hub.refuseNext("window.update", {
    code: -32603,
    message: "Xiaomi device unreachable",
  });
  const rejected = await callError(client, "apply_native_change", {
    change_ref: prepRejected.change_ref,
  });
  assert.equal(rejected.hub_effect, "not_applied");
  assert.ok(rejected.rejection);
  assert.equal(hub.writes().length, writesBeforeReject + 1);

  const repeatRejected = await callOk(client, "apply_native_change", {
    change_ref: prepRejected.change_ref,
  });
  assert.equal(repeatRejected.status, "not_applied");
  assert.equal(hub.writes().length, writesBeforeReject + 1);

  const inspectedRejected = await callOk(client, "get_native_change", {
    change_ref: prepRejected.change_ref,
  });
  assert.equal(inspectedRejected.status, "not_applied");
  assert.equal(inspectedRejected.verification.fresh, true);
  assert.equal(inspectedRejected.verification.result, "xiaomi_not_joined");

  // 6. Single & batch restore_native_change honestly refuse Xiaomi joinButton, pointing to Remove.
  const singleRestore = await callError(client, "restore_native_change", {
    change_ref: prepReadbackErr.change_ref,
  });
  assert.equal(singleRestore.error.code, "restore_unsupported");
  assert.match(singleRestore.error.message, /Remove/i);

  const roomPrep = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: roomRef(BEDROOM),
    value: "Спальня 2",
    reason: "Переименовать спальню",
  });
  await callOk(client, "apply_native_change", {
    change_ref: roomPrep.change_ref,
  });
  const batchRestore = await callOk(client, "restore_native_change", {
    change_refs: [prepReadbackErr.change_ref, roomPrep.change_ref],
  });
  const joinRestoreItem = batchRestore.results.find(
    ({ change_ref }) => change_ref === prepReadbackErr.change_ref,
  );
  const roomRestoreItem = batchRestore.results.find(
    ({ change_ref }) => change_ref === roomPrep.change_ref,
  );
  assert.equal(joinRestoreItem.status, "skipped");
  assert.equal(joinRestoreItem.reason, "not_restorable");
  assert.match(joinRestoreItem.message, /Remove/i);
  assert.equal(roomRestoreItem.status, "restored");
});

test("Xiaomi joinButton redacts secrets in metadata/responses/journal files and preserves MCP surface budgets", async (t) => {
  const secretChildId = "mi_secret_09";
  const secretWindowKey = `Controller/xiaomi_1/Child/${secretChildId}/`;
  const secrets = [SECRET_CHILD_TOKEN, SECRET_ROOM_PASS, SECRET_ERR_TOKEN];

  const { hub, client, stateDirectory } = await setup(t, {
    patch: (fixture) => {
      const xiaomi = fixture.extensions.find(
        ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
      );
      xiaomi.children.push({
        id: secretChildId,
        name: `Увлажнитель Bearer ${SECRET_CHILD_TOKEN}`,
        spaceKey: "discovery",
        online: true,
        optionsWindow: secretWindowKey,
      });
      const bedroom = fixture.rooms.find(({ id }) => id === BEDROOM);
      bedroom.name = `Спальня password=${SECRET_ROOM_PASS}`;
    },
  });

  hub.state.windows[secretWindowKey] = xiaomiDiscoveryWindow(
    secretWindowKey,
    `Увлажнитель Bearer ${SECRET_CHILD_TOKEN}`,
    {
      selectedRoom: String(BEDROOM),
      roomValidValues: [
        {
          name: `Спальня password=${SECRET_ROOM_PASS}`,
          value: { stringValue: String(BEDROOM) },
        },
      ],
      error: `Xiaomi cloud error token=${SECRET_ERR_TOKEN}`,
    },
  );

  const secretWinRef = windowRef(secretWindowKey);
  const entity = await callOk(client, "get_entity", {
    entity_ref: secretWinRef,
  });
  assertNoSecrets(entity, secrets);

  const prep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: secretWinRef,
    option_key: "joinButton",
    reason: "Подключить устройство Xiaomi",
  });
  assertNoSecrets(prep, secrets);
  assert.equal(prep.xiaomi_join.child_name, "[REDACTED]");
  assert.equal(prep.xiaomi_join.selected_room.name, "[REDACTED]");

  const applied = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assertNoSecrets(applied, secrets);
  assert.equal(
    applied.observed_effect.created_accessories[0].name,
    "[REDACTED]",
  );
  assert.equal(
    applied.observed_effect.created_accessories[0].room_name,
    "[REDACTED]",
  );

  const inspected = await callOk(client, "get_native_change", {
    change_ref: prep.change_ref,
  });
  assertNoSecrets(inspected, secrets);
  assertNoSecrets(await readAllStateText(stateDirectory), secrets);

  // MCP surface budgets: 13 tools, instructions <= 2048, every description <= 1000, contract <= 4096 B.
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
  const generalContract = await callOk(client, "get_native_change_contract", {
    operation: "window_button",
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(generalContract.contract), "utf8") <=
      4_096,
    "general window_button contract must stay <= 4096 bytes",
  );
});

test("joinRoom drift between prepare and apply conflicts without writing, preserves prepared room, and detects drift across redacted room values", async (t) => {
  const secretRoomA = "RoomSecretAlpha111";
  const secretRoomB = "RoomSecretBeta222";
  const secretChildId = "mi_room_drift_10";
  const secretWindowKey = `Controller/xiaomi_1/Child/${secretChildId}/`;
  const { hub, client, stateDirectory } = await setup(t, {
    patch: (fixture) => {
      const xiaomi = fixture.extensions.find(
        ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
      );
      xiaomi.children.push({
        id: secretChildId,
        name: "Датчик с секретной комнатой",
        spaceKey: "discovery",
        online: true,
        optionsWindow: secretWindowKey,
      });
    },
  });

  // 1. Plain joinRoom change (Living Room -> Kitchen) between prepare and apply -> conflict join_room_changed, 0 writes.
  const winRef = windowRef(XIAOMI_ONLINE_WINDOW);
  const prepRoomDrift = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Подключить увлажнитель в гостиной",
  });
  assert.deepEqual(prepRoomDrift.xiaomi_join.selected_room, {
    value: String(LIVING_ROOM),
    name: "Гостиная",
  });
  hub.state.windows[XIAOMI_ONLINE_WINDOW].options.find(
    ({ key }) => key === "joinRoom",
  ).value.stringValue = String(KITCHEN);

  const conflictRoom = await callOk(client, "apply_native_change", {
    change_ref: prepRoomDrift.change_ref,
  });
  assert.equal(conflictRoom.status, "conflict");
  assert.equal(conflictRoom.conflict_reason, "join_room_changed");
  assert.equal(conflictRoom.native_write_sent, false);
  // Prepared selected_room MUST stay intact rather than being overwritten!
  assert.deepEqual(conflictRoom.xiaomi_join.selected_room, {
    value: String(LIVING_ROOM),
    name: "Гостиная",
  });
  assert.deepEqual(hub.writes(), []);

  // 2. joinRoom disappearing between prepare and apply -> conflict join_room_changed, 0 writes.
  const prepDisappear = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Подключить увлажнитель на кухне",
  });
  hub.state.windows[XIAOMI_ONLINE_WINDOW].options = hub.state.windows[
    XIAOMI_ONLINE_WINDOW
  ].options.filter(({ key }) => key !== "joinRoom");
  const conflictDisappear = await callOk(client, "apply_native_change", {
    change_ref: prepDisappear.change_ref,
  });
  assert.equal(conflictDisappear.status, "conflict");
  assert.equal(conflictDisappear.conflict_reason, "join_room_changed");
  assert.equal(conflictDisappear.native_write_sent, false);
  assert.deepEqual(hub.writes(), []);

  // 3. Two distinct credential-shaped joinRoom values both redact to [REDACTED], yet SHA-256 baseline still detects drift!
  hub.state.windows[secretWindowKey] = xiaomiDiscoveryWindow(
    secretWindowKey,
    "Датчик с секретной комнатой",
    {
      selectedRoom: `token=${secretRoomA}`,
      roomValidValues: [
        {
          name: `Комната token=${secretRoomA}`,
          value: { stringValue: `token=${secretRoomA}` },
        },
        {
          name: `Комната token=${secretRoomB}`,
          value: { stringValue: `token=${secretRoomB}` },
        },
      ],
    },
  );
  const prepSecretDrift = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(secretWindowKey),
    option_key: "joinButton",
    reason: "Подключить датчик Xiaomi",
  });
  assertNoSecrets(prepSecretDrift, [secretRoomA, secretRoomB]);
  assert.equal(prepSecretDrift.xiaomi_join.selected_room.value, "[REDACTED]");

  hub.state.windows[secretWindowKey].options.find(
    ({ key }) => key === "joinRoom",
  ).value.stringValue = `token=${secretRoomB}`;
  const conflictSecret = await callOk(client, "apply_native_change", {
    change_ref: prepSecretDrift.change_ref,
  });
  assert.equal(conflictSecret.status, "conflict");
  assert.equal(conflictSecret.conflict_reason, "join_room_changed");
  assert.equal(conflictSecret.native_write_sent, false);
  assertNoSecrets(conflictSecret, [secretRoomA, secretRoomB]);
  assertNoSecrets(await readAllStateText(stateDirectory), [
    secretRoomA,
    secretRoomB,
  ]);
  assert.deepEqual(hub.writes(), []);

  // 4. Unchanged joinRoom while online metadata flips false -> true succeeds and refreshes online.
  const purifierRef = windowRef(XIAOMI_ROOM_ERR_WINDOW);
  const xiaomiExt = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
  );
  const purifierChild = xiaomiExt.children.find(
    ({ id }) => id === XIAOMI_ROOM_ERR_ID,
  );
  purifierChild.online = false;
  const prepSameRoom = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: purifierRef,
    option_key: "joinButton",
    reason: "Подключить очиститель Xiaomi",
  });
  assert.equal(prepSameRoom.xiaomi_join.online, false);
  purifierChild.online = true;
  const appliedSameRoom = await callOk(client, "apply_native_change", {
    change_ref: prepSameRoom.change_ref,
  });
  assert.equal(appliedSameRoom.status, "applied");
  assert.equal(appliedSameRoom.xiaomi_join.online, true);
  assert.equal(appliedSameRoom.verification.result, "xiaomi_join_observed");
});

test("confirmed-missing child and non-discovery spaceKey are refused on prepare and conflict on apply", async (t) => {
  const missingChildId = "mi_missing_11";
  const missingWindowKey = `Controller/xiaomi_1/Child/${missingChildId}/`;
  const ignoredChildId = "mi_ignored_12";
  const ignoredWindowKey = `Controller/xiaomi_1/Child/${ignoredChildId}/`;
  const emptySpaceChildId = "mi_empty_space_13";
  const emptySpaceWindowKey = `Controller/xiaomi_1/Child/${emptySpaceChildId}/`;

  const { hub, client } = await setup(t, {
    patch: (fixture) => {
      const xiaomi = fixture.extensions.find(
        ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
      );
      xiaomi.children.push(
        {
          id: ignoredChildId,
          name: "Игнорируемое устройство Xiaomi",
          spaceKey: "ignored",
          online: true,
          optionsWindow: ignoredWindowKey,
        },
        {
          id: emptySpaceChildId,
          name: "Устройство без вкладки",
          spaceKey: "",
          online: true,
          optionsWindow: emptySpaceWindowKey,
        },
      );
    },
  });

  hub.state.windows[missingWindowKey] = xiaomiDiscoveryWindow(
    missingWindowKey,
    "Отсутствующий ребёнок Xiaomi",
  );
  hub.state.windows[ignoredWindowKey] = xiaomiDiscoveryWindow(
    ignoredWindowKey,
    "Игнорируемое устройство Xiaomi",
  );
  hub.state.windows[emptySpaceWindowKey] = xiaomiDiscoveryWindow(
    emptySpaceWindowKey,
    "Устройство без вкладки",
  );

  // 1. Confirmed missing child -> xiaomi_child_not_found (retryable: false, no inline contract).
  const missingErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(missingWindowKey),
    option_key: "joinButton",
    reason: "Подключить отсутствующего ребёнка Xiaomi",
  });
  assert.equal(missingErr.error.code, "xiaomi_child_not_found");
  assert.equal(missingErr.error.retryable, false);
  assert.equal(missingErr.contract, undefined);

  // 2. Unexpected spaceKey ("ignored" and "") -> xiaomi_child_not_in_discovery (retryable: false, no contract).
  for (const [label, key] of [
    ["ignored space", ignoredWindowKey],
    ["empty space", emptySpaceWindowKey],
  ]) {
    const spaceErr = await callError(client, "prepare_native_change", {
      operation: "window_button",
      target_ref: windowRef(key),
      option_key: "joinButton",
      reason: `Подключить устройство (${label})`,
    });
    assert.equal(spaceErr.error.code, "xiaomi_child_not_in_discovery", label);
    assert.equal(spaceErr.error.retryable, false, label);
    assert.equal(spaceErr.contract, undefined, label);
  }

  // 3. Child vanishes from extensionChild.list between prepare and apply -> conflict xiaomi_child_not_found, 0 writes.
  const prepVanish = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(XIAOMI_ONLINE_WINDOW),
    option_key: "joinButton",
    reason: "Подключить увлажнитель перед исчезновением из списка детей",
  });
  const xiaomiExt = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
  );
  xiaomiExt.children = xiaomiExt.children.filter(
    ({ id }) => id !== XIAOMI_ONLINE_ID,
  );
  const vanishConflict = await callOk(client, "apply_native_change", {
    change_ref: prepVanish.change_ref,
  });
  assert.equal(vanishConflict.status, "conflict");
  assert.equal(vanishConflict.conflict_reason, "xiaomi_child_not_found");
  assert.equal(vanishConflict.native_write_sent, false);

  // 4. Child moves to non-discovery spaceKey between prepare and apply -> conflict xiaomi_child_not_in_discovery, 0 writes.
  const prepSpaceDrift = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(XIAOMI_ROOM_ERR_WINDOW),
    option_key: "joinButton",
    reason: "Подключить очиститель перед сменой вкладки",
  });
  xiaomiExt.children.find(({ id }) => id === XIAOMI_ROOM_ERR_ID).spaceKey =
    "notConnected";
  const spaceConflict = await callOk(client, "apply_native_change", {
    change_ref: prepSpaceDrift.change_ref,
  });
  assert.equal(spaceConflict.status, "conflict");
  assert.equal(spaceConflict.conflict_reason, "xiaomi_child_not_in_discovery");
  assert.equal(spaceConflict.native_write_sent, false);

  // 5. prepare tolerates transient extensionChild.list failure (child_unread: true),
  //    then apply enforces confirmed discovery spaceKey and conflicts if missing!
  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Temporary child list error on prepare",
  });
  const prepUnreadMissing = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(missingWindowKey),
    option_key: "joinButton",
    reason: "Подготовить при сбое extensionChild.list",
  });
  assert.equal(prepUnreadMissing.status, "prepared");
  assert.equal(prepUnreadMissing.xiaomi_join.child_unread, true);
  const applyMissingConflict = await callOk(client, "apply_native_change", {
    change_ref: prepUnreadMissing.change_ref,
  });
  assert.equal(applyMissingConflict.status, "conflict");
  assert.equal(applyMissingConflict.conflict_reason, "xiaomi_child_not_found");
  assert.equal(applyMissingConflict.native_write_sent, false);

  assert.deepEqual(hub.writes(), []);
});

test("transient window.get request_rejected (-32603 / -32000) during apply keeps xiaomi_join prepared, while closed window after join/removal conflicts accurately", async (t) => {
  const { hub, client } = await setup(t);
  const winRef = windowRef(XIAOMI_ONLINE_WINDOW);
  const purifierRef = windowRef(XIAOMI_ROOM_ERR_WINDOW);
  const xiaomiExt = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === XIAOMI_EXT_KEY,
  );

  // 1. Transient window.get -32603 while child is still in discovery -> rethrows error, 0 writes, stays prepared!
  const prep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Подключить увлажнитель при временной ошибке window.get",
  });
  hub.refuseNext("window.get", {
    code: -32603,
    message: "Temporary internal window error",
  });
  const err32603 = await callError(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(err32603.error.code, "request_rejected");
  assert.deepEqual(hub.writes(), []);

  // 2. Transient window.get -32000 (hub busy) -> rethrows error, 0 writes, stays prepared!
  hub.refuseNext("window.get", {
    code: -32000,
    message: "Hub busy",
  });
  const err32000 = await callError(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(err32000.error.code, "request_rejected");
  assert.deepEqual(hub.writes(), []);

  // 3. Transient window.get -32603 AND extensionChild.list also fails -> rethrows original error, stays prepared!
  hub.refuseNext("window.get", {
    code: -32603,
    message: "Temporary window error during outage",
  });
  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Temporary child list error during outage",
  });
  const errBoth = await callError(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(errBoth.error.code, "request_rejected");
  assert.deepEqual(hub.writes(), []);

  // Verify status is STILL prepared and retrying apply succeeds!
  const stillPrepared = await callOk(client, "get_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(stillPrepared.status, "prepared");
  const appliedRetry = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(appliedRetry.status, "applied");
  assert.equal(appliedRetry.verification.result, "xiaomi_join_observed");
  const writesAfterRetry = hub.writes().length;

  // 4. Closed/removed window after child moved to main -> conflict xiaomi_device_already_joined, 0 writes!
  const prepClosedMain = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: purifierRef,
    option_key: "joinButton",
    reason: "Проверить закрытое окно после переноса в main",
  });
  xiaomiExt.children.find(({ id }) => id === XIAOMI_ROOM_ERR_ID).spaceKey =
    "main";
  delete hub.state.windows[XIAOMI_ROOM_ERR_WINDOW];
  hub.state.removedWindows.add(XIAOMI_ROOM_ERR_WINDOW);
  const closedMainConflict = await callOk(client, "apply_native_change", {
    change_ref: prepClosedMain.change_ref,
  });
  assert.equal(closedMainConflict.status, "conflict");
  assert.equal(
    closedMainConflict.conflict_reason,
    "xiaomi_device_already_joined",
  );
  assert.equal(closedMainConflict.native_write_sent, false);
  assert.equal(hub.writes().length, writesAfterRetry);

  // 5. Closed/removed window after child vanished from extensionChild.list -> conflict window_button_not_found, 0 writes!
  const prepClosedMissing = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(XIAOMI_OFFLINE_WINDOW),
    option_key: "joinButton",
    reason: "Проверить закрытое окно после удаления ребёнка",
  });
  xiaomiExt.children = xiaomiExt.children.filter(
    ({ id }) => id !== XIAOMI_OFFLINE_ID,
  );
  delete hub.state.windows[XIAOMI_OFFLINE_WINDOW];
  hub.state.removedWindows.add(XIAOMI_OFFLINE_WINDOW);
  const closedMissingConflict = await callOk(client, "apply_native_change", {
    change_ref: prepClosedMissing.change_ref,
  });
  assert.equal(closedMissingConflict.status, "conflict");
  assert.equal(
    closedMissingConflict.conflict_reason,
    "window_button_not_found",
  );
  assert.equal(closedMissingConflict.native_write_sent, false);
  assert.equal(hub.writes().length, writesAfterRetry);
});

test("get_native_change on unsent, rejected, or conflicted xiaomi_join changes never indexes them under a later-created accessory", async (t) => {
  const { hub, client } = await setup(t);
  const winRef = windowRef(XIAOMI_ONLINE_WINDOW);

  // Prepare 4 changes targeting the same Xiaomi discovery child:
  // A: stays prepared (unsent)
  // B: gets rejected by hub (not_applied)
  // C: conflicts due to joinRoom drift (conflict)
  // D: actually joins the Xiaomi child and creates the accessory (applied)
  const changeA = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Черновик A (не отправлен)",
  });
  const changeB = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Попытка B (отказ хаба)",
  });
  hub.refuseNext("window.update", {
    code: -32603,
    message: "Rejected by hub",
  });
  await callError(client, "apply_native_change", {
    change_ref: changeB.change_ref,
  });

  const changeC = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Попытка C (конфликт до записи)",
  });
  const joinBtn = hub.state.windows[XIAOMI_ONLINE_WINDOW].options.find(
    ({ key }) => key === "joinButton",
  );
  joinBtn.disabled = true;
  const conflictedC = await callOk(client, "apply_native_change", {
    change_ref: changeC.change_ref,
  });
  assert.equal(conflictedC.status, "conflict");
  joinBtn.disabled = false;

  const changeD = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: winRef,
    option_key: "joinButton",
    reason: "Попытка D (успешное подключение)",
  });
  const appliedD = await callOk(client, "apply_native_change", {
    change_ref: changeD.change_ref,
  });
  assert.equal(appliedD.status, "applied");
  const createdRef = appliedD.observed_effect.created_accessories[0].ref;

  // Now call get_native_change on A (prepared), B (not_applied), and C (conflict) AFTER D created the accessory.
  for (const ref of [
    changeA.change_ref,
    changeB.change_ref,
    changeC.change_ref,
  ]) {
    await callOk(client, "get_native_change", { change_ref: ref });
  }

  // History for the created accessory MUST include D and MUST NOT include A, B, or C!
  const accHistory = await callOk(client, "get_native_change", {
    home_ref: HOME_REF,
    entity_ref: createdRef,
  });
  const historyRefs = accHistory.changes.map(({ change_ref }) => change_ref);
  assert.ok(
    historyRefs.includes(changeD.change_ref),
    `created accessory history must include applied change D (${changeD.change_ref})`,
  );
  for (const [label, ref] of [
    ["unsent prepared A", changeA.change_ref],
    ["rejected not_applied B", changeB.change_ref],
    ["conflicted C", changeC.change_ref],
  ]) {
    assert.equal(
      historyRefs.includes(ref),
      false,
      `created accessory history must NOT include ${label} (${ref})`,
    );
  }
});
