import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Option windows hold the keys of the home's radio network, pairing codes
// and login links. Read off the owner's hub on 2026-10-12: the ZigBee
// controller window has NetworkKey, LinkKey and InstallCode as TEXT; the
// HomeKit bridge window has PinCode (TEXT), the same code again as
// PinCodeVisible (PINCODE), its setup payload as QRCode (QR_CODE) and
// PrivateKey; the home settings window has each user's login link as
// user_N_qr (QR_CODE) and inside user_N_url (HTML), and the access point's
// Wi-Fi QR as wlanN_ApQR (QR_CODE). Keys, types and input types below are
// those; every value is made up. Whoever holds the ZigBee network key can
// read the home's ZigBee traffic, so none of these values may reach an agent.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const ZIGBEE_WINDOW = "Controller/zigbee/";
const HOMEKIT_WINDOW = "Bridge/homekit/";
const KEYPAD_WINDOW = "Controller/zigbee/Child/00158d0001a2b3c4/";
const zigbeeWindowRef = windowRef(ZIGBEE_WINDOW);
const homekitWindowRef = windowRef(HOMEKIT_WINDOW);
const settingsWindowRef = windowRef("");
const keypadWindowRef = windowRef(KEYPAD_WINDOW);

const NETWORK_KEY = "4f1b7c2e9a0d6b3f8c5e1a7d2b9f0c6e";
const LINK_KEY = "b31f0a9c47e25d68f1a03c9e7b5d2468";
const INSTALL_CODE = "83FED3407A939723A5C639B26916D505C3B5";
// Key material under names no rule knows: a hex key and a base64 one.
const DEVICE_KEY = "9c2e4a6f8b0d1e3a5c7f9b2d4e6a8c0f";
const CLOUD_KEY = "q3Jt9Vx2Lm8Pz4Rk7Wn1Yb6Hd0Fs5Gc+";
const HOMEKIT_PIN = "31415926";
const HOMEKIT_SETUP_PAYLOAD = "X-HM://0023ISYWY7Q2K";
const HOMEKIT_PRIVATE_KEY =
  "8d1f3a5c7e9b0d2f4a6c8e1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d1f";
const LOGIN_CODE = "Zx8kP2qLm4Rt7Vw1Ny3B";
const AP_PASSWORD = "correct-horse-battery";
const SECRETS = {
  NETWORK_KEY,
  LINK_KEY,
  INSTALL_CODE,
  DEVICE_KEY,
  CLOUD_KEY,
  HOMEKIT_PIN,
  HOMEKIT_SETUP_PAYLOAD,
  HOMEKIT_PRIVATE_KEY,
  LOGIN_CODE,
  AP_PASSWORD,
};

function windowRef(windowKey) {
  return `${homeRef}/window/${encodeURIComponent(windowKey)}`;
}

function option(key, name, type, inputType, value, extra = {}) {
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

const text = (key, name, value, extra) =>
  option(key, name, "GenericString", "TEXT", { stringValue: value }, extra);
const status = (key, name, value) =>
  option(
    key,
    name,
    "GenericString",
    "STATUS",
    { stringValue: value },
    { write: false },
  );

function zigbeeControllerWindow() {
  return {
    windowKey: ZIGBEE_WINDOW,
    label: { text: "ZigBee" },
    options: [
      option(
        "expert",
        "Экспертные",
        "GenericInteger",
        "GROUP",
        { intValue: 0 },
        { write: false },
      ),
      text("Port", "Порт", "/dev/ttyUSB0"),
      text("InstallCode", "Install code", INSTALL_CODE),
      status("IeeeAddress", "IEEE адрес", "00124b0024c1a2b3"),
      option(
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
      option(
        "PanId",
        "ID сети",
        "GenericInteger",
        "NUMBER",
        { intValue: 6754 },
        { minValue: 0, maxValue: 65535, minStep: 1 },
      ),
      text("ExtendedPanId", "Расширенный ID сети", "dd8f2a4c6e1b3d5f"),
      text("NetworkKey", "Ключ сети", NETWORK_KEY),
      text("LinkKey", "Ключ связи", LINK_KEY),
      text("DeviceKey", "Ключ устройства", DEVICE_KEY),
      text("CloudKey", "Облачный ключ", CLOUD_KEY),
      // A key or code in the name with an ordinary value stays visible.
      text("KeyboardLayout", "Раскладка", "us"),
      status("ProductCode", "Код изделия", "4607001234567890"),
      option(
        "testManufacturerCode",
        "Код производителя",
        "GenericString",
        "LIST",
        { stringValue: "115F" },
        {
          validValues: [
            { name: "Xiaomi (115F)", value: { stringValue: "115F" } },
            { name: "Tuya (1002)", value: { stringValue: "1002" } },
          ],
        },
      ),
    ],
  };
}

function homekitOptions() {
  return [
    option("QRCode", "QR-код", "GenericString", "QR_CODE", {
      stringValue: HOMEKIT_SETUP_PAYLOAD,
    }),
    option(
      "PinCodeVisible",
      "PIN-код",
      "GenericString",
      "PINCODE",
      { stringValue: HOMEKIT_PIN },
      { write: false, maxLen: 8 },
    ),
    text("SetupId", "Setup ID", "Q2K7"),
    text("PinCode", "PIN-код", HOMEKIT_PIN),
    text("PrivateKey", "Закрытый ключ", HOMEKIT_PRIVATE_KEY),
  ];
}

function settingsOptions() {
  const loginLink = `http://192.168.1.10/user/login?code=${LOGIN_CODE}`;
  return [
    option(
      "DiscoveryTime",
      "Время поиска",
      "GenericInteger",
      "LIST",
      { intValue: 60 },
      {
        validValues: [30, 60, 120].map((seconds) => ({
          name: `${seconds} с`,
          value: { intValue: seconds },
        })),
      },
    ),
    status("user_0_email", "Почта", "owner@example.invalid"),
    option("user_0_qr", "QR-код входа", "GenericString", "QR_CODE", {
      stringValue: loginLink,
    }),
    option("user_0_url", "Ссылка входа", "GenericString", "HTML", {
      stringValue: `<a href="${loginLink}" target="_blank">${loginLink}</a>`,
    }),
    option("DebugInfo", "Отладка", "GenericString", "INFO", {
      stringValue: "Журнал отладки выключен",
    }),
    option("wlan0_ApQR", "QR точки доступа", "GenericString", "QR_CODE", {
      stringValue: `WIFI:T:WPA;S:sprut-ap;P:${AP_PASSWORD};;`,
    }),
  ];
}

function keypadWindow() {
  const number = (key, name, value, max) =>
    option(
      key,
      name,
      "GenericInteger",
      "NUMBER",
      { intValue: value },
      { minValue: 0, maxValue: max, minStep: 1 },
    );
  return {
    windowKey: KEYPAD_WINDOW,
    label: { text: "Кодовая панель" },
    options: [
      number("Passcode", "Код доступа", 731904, 999999),
      number("AutoLockTime", "Автоблокировка, с", 30, 600),
    ],
  };
}

async function setup(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  hub.state.windows[ZIGBEE_WINDOW] = zigbeeControllerWindow();
  hub.state.windows[HOMEKIT_WINDOW].options.push(...homekitOptions());
  hub.state.windows[""].options.push(...settingsOptions());
  hub.state.windows[KEYPAD_WINDOW] = keypadWindow();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-window-secrets-"),
  );
  const client = new Client({ name: "window-secrets-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
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
    }),
  );
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  // Every answer an agent got, as the text it reads.
  const answers = [];
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    answers.push(result.content.map((item) => item.text ?? "").join(""));
    return result;
  };
  const ok = async (name, args) => {
    const result = await call(name, args);
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return result.structuredContent;
  };
  // The error of a refused call, or "answered" when the call was not
  // refused; checked after every answer was collected.
  const refusal = async (name, args) => {
    const result = await call(name, args);
    return result.isError === true
      ? result.structuredContent.error
      : "answered";
  };
  const refused = async (name, args) => {
    const error = await refusal(name, args);
    return error === "answered" ? error : error.code;
  };
  return { hub, stateDirectory, answers, ok, refused, refusal };
}

function changeStorePath(hub, stateDirectory) {
  const fingerprint = createHash("sha256")
    .update(`${hub.url}\0${hub.serial}`)
    .digest("hex");
  return path.join(
    stateDirectory,
    `automation-changes-${fingerprint.slice(0, 24)}.json`,
  );
}

function leakedSecrets(answers, secrets = SECRETS) {
  const all = answers.join("\n").toLowerCase();
  return Object.entries(secrets)
    .filter(([, value]) => all.includes(String(value).toLowerCase()))
    .map(([name]) => name);
}

function shownOptions(options) {
  return Object.fromEntries(
    options
      .filter((entry) => entry.redacted !== true)
      .map((entry) => [entry.key, entry.configured_value]),
  );
}

function hiddenCount(options) {
  return options.filter((entry) => entry.redacted === true).length;
}

function windowWrites(hub) {
  return hub.requests.filter(({ method }) => method === "window.update");
}

test("keys, pairing codes and login links in option windows reach no answer, while ordinary settings do", async (t) => {
  const { hub, answers, ok, refused } = await setup(t);
  const zigbeeLine = `ZigBee: NetworkKey=${NETWORK_KEY}, channel 15`;
  hub.state.log.push({
    time: Date.now(),
    level: "LOG_LEVEL_INFO",
    path: "Controller.Zigbee",
    message: zigbeeLine,
  });

  await ok("home_overview", {});
  const zigbee = (await ok("get_entity", { entity_ref: zigbeeWindowRef }))
    .entity;
  const zigbeeOptions = await ok("get_entity", {
    entity_ref: zigbeeWindowRef,
    pointer: "/options",
  });
  const homekit = (await ok("get_entity", { entity_ref: homekitWindowRef }))
    .entity;
  const settings = (
    await ok("get_entity", {
      entity_ref: settingsWindowRef,
      include: ["diagnostics"],
      max_bytes: 32_768,
    })
  ).entity;

  const contractError = await refused("get_native_change_contract", {
    operation: "window_option",
    target_ref: zigbeeWindowRef,
    option_key: "NetworkKey",
  });
  // Sending the hidden marker back must not store it on the hub.
  const prepareError = await refused("prepare_native_change", {
    operation: "window_option",
    target_ref: zigbeeWindowRef,
    option_key: "NetworkKey",
    value: "[REDACTED]",
    reason: "Вернуть ключ сети",
  });

  const point = await ok("save_configuration_point", {
    home_ref: homeRef,
    entity_refs: [zigbeeWindowRef, homekitWindowRef],
  });
  await ok("get_configuration_point", { point_ref: point.point_ref });
  await ok("get_configuration_point", {
    point_ref: point.point_ref,
    compare: true,
  });
  await ok("list_configuration_points", { home_ref: homeRef });
  const log = await ok("read_hub_log", { home_ref: homeRef });

  assert.deepEqual(leakedSecrets(answers), []);
  assert.deepEqual(shownOptions(zigbee.options), {
    Port: "/dev/ttyUSB0",
    IeeeAddress: "00124b0024c1a2b3",
    Channel: 15,
    PanId: 6754,
    ExtendedPanId: "dd8f2a4c6e1b3d5f",
    KeyboardLayout: "us",
    ProductCode: "4607001234567890",
    testManufacturerCode: "115F",
  });
  // NetworkKey, LinkKey, InstallCode, DeviceKey and CloudKey.
  assert.equal(hiddenCount(zigbee.options), 5);
  assert.deepEqual(zigbeeOptions.selection.value, zigbee.options);
  assert.deepEqual(shownOptions(homekit.options), {
    AutoAddNewAccessory: false,
    SetupId: "Q2K7",
  });
  assert.equal(hiddenCount(homekit.options), 4);
  const settingsShown = shownOptions(settings.options);
  assert.equal(settingsShown.TimeZone, "Europe/Moscow");
  assert.equal(settingsShown.DiscoveryTime, 60);
  assert.equal(settingsShown.user_0_email, "owner@example.invalid");
  for (const key of ["user_0_qr", "wlan0_ApQR"]) {
    assert.equal(Object.hasOwn(settingsShown, key), false, key);
  }
  assert.deepEqual(
    Object.fromEntries(
      settings.diagnostics.map(({ key, text: shown }) => [key, shown]),
    ),
    {
      user_0_url: "[REDACTED]",
      DebugInfo: "Журнал отладки выключен",
    },
  );
  assert.equal(contractError, "sensitive_native_data");
  assert.equal(prepareError, "sensitive_native_data");
  assert.deepEqual(windowWrites(hub), []);
  const zigbeeLog = log.entries.find(
    ({ path: logPath }) => logPath === "Controller.Zigbee",
  );
  assert.equal(zigbeeLog?.message, "[REDACTED]");
});

// A keypad's NUMBER passcode was an ordinary setting before it was hidden:
// an agent read it, a configuration point kept it, and a window_option
// change stored its old and new codes (the fixture is what e68d6b1 stored
// for such a change, applied and restored).
test("a passcode saved before it was hidden stays hidden in points and changes, and is never written back", async (t) => {
  const { hub, stateDirectory, answers, ok, refused } = await setup(t);
  const fixture = JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "test/fixtures/published-window-passcode-change.json",
      ),
      "utf8",
    ),
  );
  const change = fixture.change;
  const fingerprint = createHash("sha256")
    .update(`${hub.url}\0${hub.serial}`)
    .digest("hex");
  await writeFile(
    changeStorePath(hub, stateDirectory),
    `${JSON.stringify(
      {
        version: 1,
        hub_fingerprint: fingerprint,
        changes: { [change.id]: change },
      },
      null,
      2,
    )}\n`,
  );
  const changeRef = `spruthub-change://native/${change.id}`;

  const keypad = (await ok("get_entity", { entity_ref: keypadWindowRef }))
    .entity;
  const readChange = await refused("get_native_change", {
    change_ref: changeRef,
  });
  const appliedAgain = await ok("apply_native_change", {
    change_ref: changeRef,
  });
  const restoredAgain = await ok("restore_native_change", {
    change_ref: changeRef,
  });
  const listed = await ok("list_native_changes", { home_ref: homeRef });
  const prepared = await refused("prepare_native_change", {
    operation: "window_option",
    target_ref: keypadWindowRef,
    option_key: "Passcode",
    value: 111111,
    reason: "Сменить код",
  });

  const point = await ok("save_configuration_point", {
    home_ref: homeRef,
    entity_refs: [keypadWindowRef],
  });
  const pointDirectory = (await readdir(stateDirectory)).find((name) =>
    name.startsWith("configuration-points-"),
  );
  const pointFile = path.join(
    stateDirectory,
    pointDirectory,
    `${point.point_ref.split("/").at(-1)}.json`,
  );
  // As an earlier version captured the keypad window: the passcode was an
  // ordinary NUMBER option next to the others.
  const stored = JSON.parse(await readFile(pointFile, "utf8"));
  stored.captured[0].settings.options.Passcode = {
    name: "Код доступа",
    type: "GenericInteger",
    input_type: "NUMBER",
    configured_value: 731904,
  };
  delete stored.captured[0].not_captured_options;
  await writeFile(pointFile, `${JSON.stringify(stored, null, 2)}\n`);
  const shownPoint = await ok("get_configuration_point", {
    point_ref: point.point_ref,
  });
  const compared = await ok("get_configuration_point", {
    point_ref: point.point_ref,
    compare: true,
  });

  assert.deepEqual(leakedSecrets(answers, { old: 731904, new: 582614 }), []);
  assert.deepEqual(shownOptions(keypad.options), { AutoLockTime: 30 });
  assert.equal(hiddenCount(keypad.options), 1);
  assert.equal(readChange, "sensitive_native_data");
  const hidden = { redacted: true, reason: "sensitive_native_data" };
  for (const shown of [appliedAgain, restoredAgain]) {
    assert.deepEqual(
      [shown.change_ref, shown.status, shown.option_key],
      [changeRef, "restored", "Passcode"],
    );
    assert.deepEqual(shown.diff.value, {
      from: hidden,
      to: hidden,
      kind: "intValue",
    });
  }
  assert.deepEqual(
    listed.changes.map(({ change_ref: ref }) => ref),
    [changeRef],
  );
  assert.equal(prepared, "sensitive_native_data");
  assert.deepEqual(windowWrites(hub), []);
  assert.deepEqual(hub.state.windows[KEYPAD_WINDOW].options[0].value, {
    intValue: 731904,
  });
  const pointOptions = shownPoint.entity.entities[0].settings.options;
  assert.deepEqual(pointOptions.Passcode, hidden);
  assert.equal(pointOptions.AutoLockTime.configured_value, 30);
  const comparison = compared.comparison.entities[0];
  assert.deepEqual(comparison.changes, []);
  assert.ok(
    comparison.not_compared.some(
      (entry) =>
        JSON.stringify(entry) ===
        JSON.stringify({ path: ["options", "Passcode"], reason: "redacted" }),
    ),
    JSON.stringify(comparison.not_compared),
  );
});

// get_entity shows the owner's text that carries a credential as
// [REDACTED]: here a scenario description with a camera's snapshot link and
// its key. An agent that edits the description from that read sends the
// mark back, and written, it would replace the owner's text on the hub for
// good. Every text an agent writes to the hub is refused with the mark in
// it, and so is a change prepared with it by an earlier version.
test("text carrying [REDACTED] from an answer is never written over the owner's text", async (t) => {
  const { hub, stateDirectory, answers, ok, refusal } = await setup(t);
  const cameraKey = "cam-snapshot-7Hq2";
  const ownerDesc = `Камера: http://192.168.1.20/snapshot?key=${cameraKey}`;
  const scenario = (index) =>
    hub.state.scenarios.find((candidate) => candidate.index === index);
  scenario("3").desc = ownerDesc;
  const blockRef = `${homeRef}/scenario/3`;
  const logicSource = scenario("9").data;
  const scenarioCount = hub.state.scenarios.length;
  const accessoryCount = hub.state.accessories.length;
  const mark = "[REDACTED]";

  const shown = (await ok("get_entity", { entity_ref: blockRef })).entity;
  const attempts = {
    desc: await refusal("prepare_native_change", {
      operation: "window_option",
      target_ref: blockRef,
      option_key: "Desc",
      value: `${mark}\nЛетний режим`,
      reason: "Дописать летний режим",
    }),
    name: await refusal("prepare_native_change", {
      operation: "window_option",
      target_ref: blockRef,
      option_key: "Name",
      value: `${mark} (лето)`,
      reason: "Пометить летний сценарий",
    }),
    room: await refusal("prepare_native_change", {
      operation: "room_name",
      target_ref: `${homeRef}/room/2`,
      value: mark,
      reason: "Вернуть имя комнаты",
    }),
    placement: await refusal("prepare_native_change", {
      operation: "accessory_placement",
      target_ref: `${homeRef}/accessory/14`,
      room_ref: `${homeRef}/room/2`,
      name: mark,
      reason: "Вернуть имя светильника",
    }),
    logic: await refusal("prepare_native_change", {
      operation: "logic_source_update",
      target_ref: `${homeRef}/scenario/9`,
      source: mark,
      reason: "Вернуть код",
    }),
    block: await refusal("prepare_native_change", {
      operation: "block_create",
      target_ref: homeRef,
      name: "Протечка в ванной",
      description: mark,
      active: true,
      on_start: false,
      sync: false,
      reason: "Скопировать сценарий",
      data: {
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
                  aId: 37,
                  sId: 13,
                  cId: 14,
                  hs: "LeakSensor",
                  hc: "LeakDetected",
                  trigger: true,
                  cond: "=",
                  value: "1",
                  timeCond: "",
                  time: 0,
                },
              ],
            },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK scenarios use this native key.
            then: [
              {
                type: "service",
                aId: 36,
                sId: 13,
                hs: "Fan",
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
      },
    }),
    automation: await refusal("preview_boolean_automation", {
      name: `${mark} (копия)`,
      reason: "Скопировать сценарий",
      source_room_ref: `${homeRef}/room/2`,
      source_characteristic_ref: `${homeRef}/accessory/13/service/13/characteristic/14`,
      source_value: true,
      target_room_ref: `${homeRef}/room/2`,
      target_characteristic_ref: `${homeRef}/accessory/14/service/13/characteristic/14`,
      target_value: true,
    }),
  };

  // Changes an earlier version prepared with the mark: a Desc, an
  // accessory's name and a virtual light group's name.
  const olderDesc = await ok("prepare_native_change", {
    operation: "window_option",
    target_ref: blockRef,
    option_key: "Desc",
    value: "Летний режим",
    reason: "Дописать летний режим",
  });
  const olderPlacement = await ok("prepare_native_change", {
    operation: "accessory_placement",
    target_ref: `${homeRef}/accessory/14`,
    room_ref: `${homeRef}/room/2`,
    name: "Свет в коридоре у двери",
    reason: "Уточнить имя светильника",
  });
  const olderGroup = await ok("prepare_native_change", {
    operation: "virtual_light_group",
    target_ref: homeRef,
    room_ref: `${homeRef}/room/3`,
    name: "Свет гостиной",
    member_service_refs: [
      `${homeRef}/accessory/15/service/13`,
      `${homeRef}/accessory/16/service/13`,
    ],
    characteristic_types: ["On", "Brightness"],
    reason: "Один свет для гостиной",
  });
  const storePath = changeStorePath(hub, stateDirectory);
  const store = JSON.parse(await readFile(storePath, "utf8"));
  const stored = (prepared) =>
    store.changes[prepared.change_ref.split("/").at(-1)];
  stored(olderDesc).requested_value.value = `${mark}\nЛетний режим`;
  stored(olderPlacement).requested_snapshot.name = mark;
  stored(olderGroup).requested_name = mark;
  stored(olderGroup).create_request.name = mark;
  stored(olderGroup).create_request.services[0].name = mark;
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);
  const olderApplies = {};
  for (const [kind, prepared] of Object.entries({
    olderDesc,
    olderPlacement,
    olderGroup,
  })) {
    olderApplies[kind] = await refusal("apply_native_change", {
      change_ref: prepared.change_ref,
    });
  }
  const writesBefore = windowWrites(hub).length;
  const descAfterRefusals = scenario("3").desc;

  // The owner's full new text is written as usual.
  const written = await ok("prepare_native_change", {
    operation: "window_option",
    target_ref: blockRef,
    option_key: "Desc",
    value: "Летний режим",
    reason: "Владелец продиктовал описание",
  });
  const applied = await ok("apply_native_change", {
    change_ref: written.change_ref,
  });

  assert.equal(shown.description, mark);
  for (const [path, error] of Object.entries({
    ...attempts,
    ...olderApplies,
  })) {
    assert.notEqual(error, "answered", path);
    assert.equal(error.code, "invalid_native_value", path);
    assert.ok(error.message.includes(mark), `${path}: ${error.message}`);
    assert.match(error.message, /ask the owner/i, path);
  }
  assert.equal(writesBefore, 0);
  assert.equal(descAfterRefusals, ownerDesc);
  assert.equal(hub.state.rooms.find(({ id }) => id === 2)?.name, "Коридор");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 14)?.name,
    "Свет в коридоре",
  );
  assert.equal(scenario("9").data, logicSource);
  assert.equal(hub.state.scenarios.length, scenarioCount);
  assert.equal(hub.state.accessories.length, accessoryCount);
  assert.equal(applied.status, "applied");
  assert.equal(scenario("3").desc, "Летний режим");
  assert.deepEqual(leakedSecrets(answers, { cameraKey }), []);
});

// Secrets that reach answers as free text or under names the first rule
// missed (review of c8c3784, 2026-10-12). The text shapes are those of the
// hub's own values: the HomeKit setup payload behind the bridge's QR code,
// the access point's Wi-Fi QR, a user's login link, which the web client
// also gives without its host, and a key under a label in device HTML. The
// names are those of ZigBee device windows (a cluster attribute path such
// as /1/0101_DoorLock/0005_PinCode/255), of extension settings and of
// zigbee2mqtt-style configs, where a network key is a list of decimal
// bytes. Every value is made up.
const LOCK_WINDOW = "Controller/zigbee/Child/00158d0001d0e1f2/";
const SETUP_PAYLOAD = "X-HM://0026PZ9ERM8T4";
const WIFI_PASSWORD = "dacha-pass-2026";
const RELATIVE_LOGIN_CODE = "Qm7tR2xV9pLk3Ws8Zb1N";
const LABELLED_INSTALL_CODE = "6D2F04A19B83E75C0D4A6E91B2C8F357A1D0";
const BYTE_KEY = "[1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13]";
const LOCK_SECRETS = {
  "/1/0101_DoorLock/0005_PinCode/255": "pin-code-7391",
  "Zigbee/NetworkKey": "net-key-73a9",
  "zigbee.networkKey": "net-key-41b2",
  "wifi.passphrase": "correct horse dacha",
  Pin: "pin-4826-x",
  AdminPin: "admin-pin-1357",
  UserCode: "user-code-2468",
  MqttPass: "mqtt-pw-8812",
  wifiPass: "wifi-pw-5531",
  ApPass: "ap-pw-7720",
  WpaKey: "wpa-k-1188",
  WEPKey: "wep-k-3344",
  LocalKey: "lk-9a8b7c",
  Cookie: "SID-7f3k-cookie",
  Session: "sess-55aa-token",
  Key: "k-1234-key",
  TransportKey: "79,27,113,4,200,17,9,64,250,33,18,77,5,140,91,6",
};

function lockWindow() {
  return {
    windowKey: LOCK_WINDOW,
    label: { text: "Замок" },
    options: [
      ...Object.entries(LOCK_SECRETS).map(([key, value]) =>
        text(key, key, value),
      ),
      // Look-alikes of the names above that are ordinary settings.
      option(
        "SessionTimeout",
        "Таймаут сессии, мин",
        "GenericInteger",
        "NUMBER",
        { intValue: 30 },
        { minValue: 1, maxValue: 120, minStep: 1 },
      ),
      option(
        "ResetPin",
        "Вывод сброса",
        "GenericInteger",
        "NUMBER",
        { intValue: 4 },
        { minValue: 0, maxValue: 39, minStep: 1 },
      ),
      option("PassThrough", "Транзит", "GenericBoolean", "CHECKBOX", {
        boolValue: false,
      }),
      option(
        "KeyRepeatDelay",
        "Повтор кнопки, мс",
        "GenericInteger",
        "NUMBER",
        { intValue: 250 },
        { minValue: 0, maxValue: 1000, minStep: 10 },
      ),
      text("ChannelMask", "Каналы", "11, 15, 20, 25"),
    ],
  };
}

test("setup payloads, Wi-Fi QR, relative login links, labelled keys and keys under path, dotted or short names reach no answer, while look-alikes stay", async (t) => {
  const { hub, answers, ok } = await setup(t);
  hub.state.windows[LOCK_WINDOW] = lockWindow();
  const wifiQr = `WIFI:S:dacha-ap;T:WPA;P:${WIFI_PASSWORD};H:false;;`;
  const relativeLogin = `/user/login?code=${RELATIVE_LOGIN_CODE}`;
  const ieee = "IEEE: 00:12:4b:00:24:c1:a2:b3";
  hub.state.windows[""].options.push(
    option("homekit_html", "HomeKit", "GenericString", "HTML", {
      stringValue: `<p>Код для HomeKit: <b>${SETUP_PAYLOAD}</b></p>`,
    }),
    option("ap_info", "Точка доступа", "GenericString", "INFO", {
      stringValue: `Точка доступа: ${wifiQr}`,
    }),
    option("user_1_url", "Ссылка входа", "GenericString", "HTML", {
      stringValue: `<a href="${relativeLogin}">Войти</a>`,
    }),
    option("zigbee_html", "ZigBee", "GenericString", "HTML", {
      stringValue: `<b>Install code</b>: ${LABELLED_INSTALL_CODE}`,
    }),
    option("network_html", "Сеть", "GenericString", "HTML", {
      stringValue: `<b>Ключ сети</b>: ${BYTE_KEY}`,
    }),
    option("radio_html", "Радио", "GenericString", "HTML", {
      stringValue: `<b>IEEE</b>: 00:12:4b:00:24:c1:a2:b3<br><b>Network key</b>: изменён 12.10`,
    }),
    option("links_info", "Ссылки", "GenericString", "INFO", {
      stringValue: "Профиль: /user/profile?tab=main; WIFI: подключено",
    }),
    status("BridgeStatus", "Мост", `Ожидает сопряжения: ${SETUP_PAYLOAD}`),
    status("ApStatus", "Точка доступа", wifiQr),
    status("LastLogin", "Последний вход", relativeLogin),
    status("RadioInfo", "Радио", `Install code: ${LABELLED_INSTALL_CODE}`),
    status("RadioIds", "Адреса", ieee),
  );
  const logLines = {
    "Test.HomeKit": `HomeKit: setup payload ${SETUP_PAYLOAD}`,
    "Test.Ap": `AP ready: ${wifiQr}`,
    "Test.Login": `Login link ${relativeLogin} issued`,
    "Test.Install": `<b>Install code</b>: ${LABELLED_INSTALL_CODE}`,
    "Test.Mqtt": `MQTT config: mqttPass=${LOCK_SECRETS.MqttPass}`,
    "Test.Lock": `Lock: adminPin: ${LOCK_SECRETS.AdminPin}`,
    "Test.Zigbee": `{"zigbee.networkKey": "${LOCK_SECRETS["zigbee.networkKey"]}"}`,
    "Test.Ieee": ieee,
    "Test.Profile": "Open /user/profile?tab=main",
  };
  for (const [logPath, message] of Object.entries(logLines)) {
    hub.state.log.push({
      time: Date.now(),
      level: "LOG_LEVEL_INFO",
      path: logPath,
      message,
    });
  }

  await ok("home_overview", {});
  const lock = (await ok("get_entity", { entity_ref: windowRef(LOCK_WINDOW) }))
    .entity;
  const settings = (
    await ok("get_entity", {
      entity_ref: settingsWindowRef,
      include: ["diagnostics"],
      max_bytes: 32_768,
    })
  ).entity;
  const log = await ok("read_hub_log", { home_ref: homeRef, limit: 50 });

  assert.deepEqual(
    leakedSecrets(answers, {
      SETUP_PAYLOAD,
      WIFI_PASSWORD,
      RELATIVE_LOGIN_CODE,
      LABELLED_INSTALL_CODE,
      BYTE_KEY,
      ...LOCK_SECRETS,
    }),
    [],
  );
  assert.deepEqual(shownOptions(lock.options), {
    SessionTimeout: 30,
    ResetPin: 4,
    PassThrough: false,
    KeyRepeatDelay: 250,
    ChannelMask: "11, 15, 20, 25",
  });
  assert.equal(hiddenCount(lock.options), Object.keys(LOCK_SECRETS).length);
  const diagnostics = Object.fromEntries(
    settings.diagnostics.map(({ key, text: shown }) => [key, shown]),
  );
  for (const key of [
    "homekit_html",
    "ap_info",
    "user_1_url",
    "zigbee_html",
    "network_html",
  ]) {
    assert.equal(diagnostics[key], "[REDACTED]", key);
  }
  assert.equal(
    diagnostics.radio_html,
    "<b>IEEE</b>: 00:12:4b:00:24:c1:a2:b3<br><b>Network key</b>: изменён 12.10",
  );
  assert.equal(
    diagnostics.links_info,
    "Профиль: /user/profile?tab=main; WIFI: подключено",
  );
  const settingsShown = shownOptions(settings.options);
  for (const key of ["BridgeStatus", "ApStatus", "LastLogin", "RadioInfo"]) {
    assert.equal(settingsShown[key], "[REDACTED]", key);
  }
  assert.equal(settingsShown.RadioIds, ieee);
  const messages = Object.fromEntries(
    log.entries
      .filter(({ path: logPath }) => logPath.startsWith("Test."))
      .map(({ path: logPath, message }) => [logPath, message]),
  );
  assert.deepEqual(messages, {
    "Test.HomeKit": "[REDACTED]",
    "Test.Ap": "[REDACTED]",
    "Test.Login": "[REDACTED]",
    "Test.Install": "[REDACTED]",
    "Test.Mqtt": "[REDACTED]",
    "Test.Lock": "[REDACTED]",
    "Test.Zigbee": "[REDACTED]",
    "Test.Ieee": ieee,
    "Test.Profile": "Open /user/profile?tab=main",
  });
});

// A hub text of many Wi-Fi QR beginnings and no password, as a log line of
// «WIFI:;» repeated, took seconds to check for a password, growing with
// the square of its length (8 s for 160 KB), and held up every other call
// of the server meanwhile; the owner's hub texts take milliseconds. A
// payload with a password after such a run is still hidden.
test("a long hub text of Wi-Fi QR beginnings is answered at once, and a password after them stays hidden", async (t) => {
  const { hub, ok } = await setup(t);
  const beginnings = "WIFI:;".repeat(27_000);
  hub.state.log.push(
    {
      time: Date.now() - 1_000,
      level: "LOG_LEVEL_WARN",
      path: "Test.ApAfterBeginnings",
      message: `${beginnings}WIFI:S:dacha-ap;T:WPA;P:${WIFI_PASSWORD};;`,
    },
    {
      time: Date.now(),
      level: "LOG_LEVEL_INFO",
      path: "Test.Beginnings",
      message: beginnings,
    },
  );

  const timed = async (args) => {
    const started = performance.now();
    const log = await ok("read_hub_log", { home_ref: homeRef, ...args });
    return { log, ms: performance.now() - started };
  };
  const all = await timed({ max_bytes: 32_768 });
  const warnings = await timed({ min_level: "warn" });

  // Generous for a slow machine: each read checks both texts, which took
  // over 8 s before.
  assert.ok(all.ms < 2_000, `read_hub_log took ${Math.round(all.ms)} ms`);
  assert.ok(
    warnings.ms < 2_000,
    `read_hub_log took ${Math.round(warnings.ms)} ms`,
  );
  const shown = all.log.entries[0];
  assert.equal(shown.path, "Test.Beginnings");
  assert.equal(shown.message_truncated, true);
  assert.ok(shown.message.startsWith("WIFI:;WIFI:;"), shown.message);
  const ap = warnings.log.entries.find(
    ({ path: logPath }) => logPath === "Test.ApAfterBeginnings",
  );
  assert.equal(ap?.message, "[REDACTED]");
});

// A network name that ends in WIFI:, glued to a word as in Home_WIFI: or
// HomeWIFI:, does not begin another payload: the password after it is
// still the payload's.
test("a Wi-Fi QR whose network name ends in WIFI: keeps its password hidden", async (t) => {
  const { hub, answers, ok } = await setup(t);
  const lines = {
    "Test.ApUnderscore": `WIFI:S:Home_WIFI:5G;T:WPA;P:${WIFI_PASSWORD};;`,
    "Test.ApLetter": `AP ready: WIFI:S:HomeWIFI:5G;T:WPA;P:${WIFI_PASSWORD};;`,
  };
  for (const [logPath, message] of Object.entries(lines)) {
    hub.state.log.push({
      time: Date.now(),
      level: "LOG_LEVEL_INFO",
      path: logPath,
      message,
    });
  }

  const log = await ok("read_hub_log", { home_ref: homeRef, limit: 50 });

  assert.deepEqual(leakedSecrets(answers, { WIFI_PASSWORD }), []);
  assert.deepEqual(
    Object.fromEntries(
      log.entries
        .filter(({ path: logPath }) => logPath.startsWith("Test."))
        .map(({ path: logPath, message }) => [logPath, message]),
    ),
    { "Test.ApUnderscore": "[REDACTED]", "Test.ApLetter": "[REDACTED]" },
  );
});

// Settings named after key material that hold no key: a flag that turns
// install codes on, a PIN length, and codes that are not secrets: a Pronto
// IR code, a Broadlink IR code and product and scene identifiers. Hidden,
// they would also be unwritable. A Broadlink RF code (a gate remote) and a
// filled InstallCode stay hidden.
const IR_WINDOW = "Controller/zigbee/Child/00158d0001e0f1a2/";
// Learned IR (0000), carrier 0x6D, two burst pairs once, none repeated.
const PRONTO_CODE = "0000 006D 0002 0000 0157 00AC 0015 0689";
// Broadlink packets: 0x26 is infrared, 0xb2 a 433 MHz remote; then the
// repeat count and the length of the pulse data.
const BROADLINK_IR_CODE = "JgAOAJSSEzcTEhQ2ExITNw0F";
const BROADLINK_RF_CODE = "sgAOAJSSEzcTEhQ2ExITNw0F";
const PRODUCT_KEY = "6a1f9c3e7b2d4085";
const PRODUCT_CODE = "8C2F1E9A7B3D4F60";
const SCENE_CODE = "0a1b2c3d4e5f6071";
const FILLED_INSTALL_CODE = "1F2E3D4C5B6A79880716253443526170";

function irWindow() {
  const number = (key, name, value) =>
    option(
      key,
      name,
      "GenericInteger",
      "NUMBER",
      { intValue: value },
      { minValue: 4, maxValue: 8, minStep: 1 },
    );
  const checkbox = (key, name, value) =>
    option(key, name, "GenericBoolean", "CHECKBOX", { boolValue: value });
  return {
    windowKey: IR_WINDOW,
    label: { text: "Пульт и замок" },
    options: [
      checkbox("InstallCodeEnabled", "Install code", true),
      checkbox("UseInstallCode", "Использовать install code", false),
      number("PinCodeLength", "Длина PIN-кода", 4),
      number("PasscodeLength", "Длина кода", 6),
      number("MaxPINCodeLength", "Наибольшая длина PIN-кода", 8),
      text("IrCode", "ИК-код", PRONTO_CODE),
      text("LearnedCode", "Выученный код", BROADLINK_IR_CODE),
      text("ProductKey", "Ключ продукта", PRODUCT_KEY),
      status("ProductCode", "Код изделия", PRODUCT_CODE),
      text("SceneCode", "Код сцены", SCENE_CODE),
      text("RemoteRfCode", "Код радиопульта", BROADLINK_RF_CODE),
      text("InstallCode", "Install code", FILLED_INSTALL_CODE),
    ],
  };
}

test("flag and length settings named after codes, IR codes and product identifiers stay shown and writable", async (t) => {
  const { hub, answers, ok } = await setup(t);
  hub.state.windows[IR_WINDOW] = irWindow();
  const irWindowRef = windowRef(IR_WINDOW);
  hub.state.log.push(
    {
      time: Date.now(),
      level: "LOG_LEVEL_INFO",
      path: "Test.Ir",
      message: `IR code: ${PRONTO_CODE}`,
    },
    {
      time: Date.now(),
      level: "LOG_LEVEL_INFO",
      path: "Test.Product",
      message: `Product key: ${PRODUCT_KEY}`,
    },
  );

  const shown = (await ok("get_entity", { entity_ref: irWindowRef })).entity;
  const log = await ok("read_hub_log", { home_ref: homeRef });
  const writes = {};
  for (const [optionKey, value] of [
    ["InstallCodeEnabled", false],
    ["PinCodeLength", 6],
  ]) {
    const prepared = await ok("prepare_native_change", {
      operation: "window_option",
      target_ref: irWindowRef,
      option_key: optionKey,
      value,
      reason: "Владелец попросил",
    });
    const applied = await ok("apply_native_change", {
      change_ref: prepared.change_ref,
    });
    writes[optionKey] = {
      status: applied.status,
      diff: applied.diff.value,
    };
  }
  const options = Object.fromEntries(
    hub.state.windows[IR_WINDOW].options.map(({ key, value }) => [key, value]),
  );

  assert.deepEqual(shownOptions(shown.options), {
    InstallCodeEnabled: true,
    UseInstallCode: false,
    PinCodeLength: 4,
    PasscodeLength: 6,
    MaxPINCodeLength: 8,
    IrCode: PRONTO_CODE,
    LearnedCode: BROADLINK_IR_CODE,
    ProductKey: PRODUCT_KEY,
    ProductCode: PRODUCT_CODE,
    SceneCode: SCENE_CODE,
  });
  // RemoteRfCode and InstallCode.
  assert.equal(hiddenCount(shown.options), 2);
  assert.deepEqual(
    leakedSecrets(answers, { BROADLINK_RF_CODE, FILLED_INSTALL_CODE }),
    [],
  );
  assert.deepEqual(
    Object.fromEntries(
      log.entries
        .filter(({ path: logPath }) => logPath.startsWith("Test."))
        .map(({ path: logPath, message }) => [logPath, message]),
    ),
    {
      "Test.Ir": `IR code: ${PRONTO_CODE}`,
      "Test.Product": `Product key: ${PRODUCT_KEY}`,
    },
  );
  assert.deepEqual(writes, {
    InstallCodeEnabled: {
      status: "applied",
      diff: { from: true, to: false, kind: "boolValue" },
    },
    PinCodeLength: {
      status: "applied",
      diff: { from: 4, to: 6, kind: "intValue" },
    },
  });
  assert.deepEqual(options.InstallCodeEnabled, { boolValue: false });
  assert.deepEqual(options.PinCodeLength, { intValue: 6 });
});

// A flag or size name decides for its label only where its value cannot be
// what the label names. A number under Mode labelled «Password» may be the
// password itself; a CHECKBOX labelled «Install code» and a number
// labelled «PIN code length» are a flag and a size.
const ALARM_WINDOW = "Controller/zigbee/Child/00158d0001f0a1b2/";
const ALARM_PASSWORD = 73195046;
const ALARM_PIN = 482913;

test("a number under a flag or size name labelled as a password stays hidden, while flags and sizes labelled after codes stay shown", async (t) => {
  const { hub, answers, ok, refused } = await setup(t);
  const number = (key, name, value, extra) =>
    option(
      key,
      name,
      "GenericInteger",
      "NUMBER",
      { intValue: value },
      { minValue: 0, maxValue: 99_999_999, minStep: 1, ...extra },
    );
  hub.state.windows[ALARM_WINDOW] = {
    windowKey: ALARM_WINDOW,
    label: { text: "Сигнализация" },
    options: [
      number("Mode", "Password", ALARM_PASSWORD),
      number("PinMode", "PIN", ALARM_PIN, { inputType: "PASSWORD" }),
      number("PinCodeLength", "PIN code length", 6),
      option(
        "InstallCodeEnabled",
        "Install code",
        "GenericBoolean",
        "CHECKBOX",
        {
          boolValue: true,
        },
      ),
    ],
  };
  const alarmRef = windowRef(ALARM_WINDOW);

  const shown = (await ok("get_entity", { entity_ref: alarmRef })).entity;
  const prepared = await refused("prepare_native_change", {
    operation: "window_option",
    target_ref: alarmRef,
    option_key: "Mode",
    value: 1,
    reason: "Владелец попросил",
  });

  assert.deepEqual(leakedSecrets(answers, { ALARM_PASSWORD, ALARM_PIN }), []);
  assert.deepEqual(shownOptions(shown.options), {
    PinCodeLength: 6,
    InstallCodeEnabled: true,
  });
  assert.equal(hiddenCount(shown.options), 2);
  assert.equal(prepared, "sensitive_native_data");
  assert.deepEqual(windowWrites(hub), []);
});

// The Xiaomi controller's window has a writable TEXT Ticket labelled as a
// confirmation code: during a login to the Xiaomi cloud it holds the
// one-time code the cloud sent the owner. Empty, it shows that a login
// waits for the code; filled, the code reaches no answer, also from a
// configuration point saved while it was empty. A field labelled so under
// another key is a code too, and so is a Ticket under another label, as a
// second controller's label left untranslated.
const XIAOMI_WINDOW = "Controller/xiaomi_1/";
const SECOND_XIAOMI_WINDOW = "Controller/xiaomi_2/";
const XIAOMI_TICKET = "731946";
const SMS_CODE = "582017";
const SECOND_TICKET = "604285";

test("a confirmation code typed during a Xiaomi cloud login reaches no answer, while the empty field stays shown", async (t) => {
  const { hub, answers, ok } = await setup(t);
  hub.state.windows[XIAOMI_WINDOW] = {
    windowKey: XIAOMI_WINDOW,
    label: { text: "Xiaomi" },
    options: [
      text("Login", "Логин", "owner@example.invalid"),
      text("Ticket", "Код подтверждения", ""),
      text("SmsCode", "Код подтверждения из SMS", ""),
      option(
        "CloudDevices",
        "Облачные устройства",
        "GenericBoolean",
        "CHECKBOX",
        {
          boolValue: true,
        },
      ),
    ],
  };
  hub.state.windows[SECOND_XIAOMI_WINDOW] = {
    windowKey: SECOND_XIAOMI_WINDOW,
    label: { text: "Xiaomi 2" },
    options: [text("Ticket", "Ticket", SECOND_TICKET)],
  };
  const xiaomiRef = windowRef(XIAOMI_WINDOW);

  const waiting = (await ok("get_entity", { entity_ref: xiaomiRef })).entity;
  const second = (
    await ok("get_entity", { entity_ref: windowRef(SECOND_XIAOMI_WINDOW) })
  ).entity;
  const point = await ok("save_configuration_point", {
    home_ref: homeRef,
    entity_refs: [xiaomiRef],
  });
  const fill = (key, value) => {
    hub.state.windows[XIAOMI_WINDOW].options.find(
      (candidate) => candidate.key === key,
    ).value = { stringValue: value };
  };
  fill("Ticket", XIAOMI_TICKET);
  fill("SmsCode", SMS_CODE);
  const filled = (await ok("get_entity", { entity_ref: xiaomiRef })).entity;
  await ok("get_configuration_point", {
    point_ref: point.point_ref,
    compare: true,
  });
  await ok("save_configuration_point", {
    home_ref: homeRef,
    entity_refs: [xiaomiRef],
  });

  assert.deepEqual(shownOptions(waiting.options), {
    Login: "owner@example.invalid",
    Ticket: "",
    SmsCode: "",
    CloudDevices: true,
  });
  assert.deepEqual(
    leakedSecrets(answers, { XIAOMI_TICKET, SMS_CODE, SECOND_TICKET }),
    [],
  );
  assert.deepEqual(shownOptions(filled.options), {
    Login: "owner@example.invalid",
    CloudDevices: true,
  });
  assert.equal(hiddenCount(filled.options), 2);
  assert.equal(hiddenCount(second.options), 1);
});
