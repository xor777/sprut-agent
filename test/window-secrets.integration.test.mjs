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
  // The error code of a refused call, or "answered" when the call was not
  // refused; checked after every answer was collected.
  const refused = async (name, args) => {
    const result = await call(name, args);
    return result.isError === true
      ? result.structuredContent.error.code
      : "answered";
  };
  return { hub, stateDirectory, answers, ok, refused };
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
  assert.deepEqual(zigbeeOptions.selected, zigbee.options);
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
    path.join(
      stateDirectory,
      `automation-changes-${fingerprint.slice(0, 24)}.json`,
    ),
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
