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
const TELEGRAM_EXTENSION_KEY = "Notification:telegram_1";
const TELEGRAM_WINDOW = "Notification/telegram_1/";
const ZIGBEE_CONTROLLER_WINDOW = "Controller/zigbee_1/";
const ZIGBEE_THERMOSTAT_WINDOW = "Controller/zigbee_1/Child/0x1234/";
const XIAOMI_CHILD_WINDOW = "Controller/xiaomi_1/Child/mi_01/";
const CALIBRATION_KEY =
  "/1/FCC0_ManufacturerSpecific/00F4_ThermostatValveCalibration/false";
const CALIBRATION_STATUS_KEY =
  "/1/FCC0_ManufacturerSpecific/00F5_ThermostatValveCalibrationStatus/0";

const TELEGRAM_BOT_TOKEN = "987654321:AAFakeBotTokenSecretValueDoNotLeak12345";
const PROXY_LOGIN_SECRET = "proxy-secret-user-991";
const PROXY_PASSWORD_SECRET = "proxy-secret-pass-773";
const EMBEDDED_URL_SECRET = "embUser99:embPass88";

function windowRef(windowKey) {
  return `${HOME_REF}/window/${encodeURIComponent(windowKey)}`;
}

function extensionRef(extensionKey) {
  return `${HOME_REF}/extension/${encodeURIComponent(extensionKey)}`;
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

function telegramExtension() {
  return {
    extensionKey: TELEGRAM_EXTENSION_KEY,
    type: "telegram",
    index: "telegram_1",
    bundleType: "NOTIFICATION",
    name: "Telegram",
    state: "FAILED",
    enabled: true,
    optionsWindow: TELEGRAM_WINDOW,
    spaces: [],
  };
}

function telegramWindow({
  token = TELEGRAM_BOT_TOKEN,
  loggedIn = false,
  proxyType = "NONE",
  error = "Ошибка загрузки",
  status = "",
} = {}) {
  const showProxy = proxyType !== "NONE";
  return {
    windowKey: TELEGRAM_WINDOW,
    label: {
      text: "Telegram",
      ...(error !== undefined ? { error } : {}),
      ...(status !== undefined ? { status } : {}),
    },
    options: [
      optionEntry("Name", "Имя", "GenericString", "TEXT", {
        stringValue: "Telegram",
      }),
      optionEntry(
        "Token",
        "Токен бота",
        "GenericString",
        "PASSWORD",
        { stringValue: token },
        { visible: true },
      ),
      optionEntry("BotApiUrl", "URL Bot API", "GenericString", "TEXT", {
        stringValue: "",
      }),
      optionEntry(
        "ProxyType",
        "Тип прокси",
        "GenericString",
        "LIST",
        { stringValue: proxyType },
        {
          validValues: ["NONE", "HTTP", "SOCKS5"].map((mode) => ({
            name: mode,
            value: { stringValue: mode },
          })),
        },
      ),
      optionEntry(
        "ProxyHost",
        "Хост прокси",
        "GenericString",
        "TEXT",
        { stringValue: "" },
        { visible: showProxy },
      ),
      optionEntry(
        "ProxyPort",
        "Порт прокси",
        "GenericString",
        "TEXT",
        { stringValue: "" },
        { visible: showProxy },
      ),
      optionEntry(
        "ProxyLogin",
        "Логин прокси",
        "GenericString",
        "TEXT",
        { stringValue: PROXY_LOGIN_SECRET },
        { visible: showProxy },
      ),
      optionEntry(
        "ProxyPassword",
        "Пароль прокси",
        "GenericString",
        "PASSWORD",
        { stringValue: PROXY_PASSWORD_SECRET },
        { visible: showProxy },
      ),
      optionEntry(
        "Login",
        "Войти",
        "GenericBoolean",
        "BUTTON",
        { boolValue: true },
        { visible: !loggedIn },
      ),
      optionEntry(
        "Logout",
        "Выйти",
        "GenericBoolean",
        "BUTTON",
        { boolValue: true },
        { visible: loggedIn },
      ),
      optionEntry(
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
      ),
    ],
  };
}

function zigbeeThermostatWindow({ includeStatus = true } = {}) {
  return {
    windowKey: ZIGBEE_THERMOSTAT_WINDOW,
    label: { text: "Термоголовка в спальне" },
    options: [
      optionEntry(
        CALIBRATION_KEY,
        "Калибровка клапана",
        "GenericBoolean",
        "BUTTON",
        { boolValue: false },
      ),
      ...(includeStatus
        ? [
            optionEntry(
              CALIBRATION_STATUS_KEY,
              "Статус калибровки",
              "GenericInteger",
              "LIST",
              { intValue: 0 },
              {
                write: false,
                validValues: [
                  { name: "Не откалиброван", value: { intValue: 0 } },
                  { name: "Калибровка", value: { intValue: 1 } },
                  { name: "Откалиброван", value: { intValue: 2 } },
                ],
              },
            ),
          ]
        : []),
      optionEntry("Repair", "Переспарить", "GenericBoolean", "BUTTON", {
        boolValue: false,
      }),
      optionEntry(
        "readAllAttributes",
        "Прочитать все атрибуты",
        "GenericBoolean",
        "BUTTON",
        { boolValue: false },
      ),
      optionEntry(
        "testReadAttribute",
        "testReadAttribute",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
        { visible: false },
      ),
      optionEntry(
        "testWriteAttribute",
        "testWriteAttribute",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
        { visible: false },
      ),
      optionEntry(
        "testCommand",
        "testCommand",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
        { visible: false },
      ),
      optionEntry(
        "testBind",
        "testBind",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
        { visible: false },
      ),
      optionEntry(
        "testUnbind",
        "testUnbind",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
        { visible: false },
      ),
      optionEntry(
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
      ),
    ],
  };
}

function zigbeeControllerWindow() {
  return {
    windowKey: ZIGBEE_CONTROLLER_WINDOW,
    label: { text: "ZigBee" },
    options: [
      optionEntry(
        "DeleteAllAccessories",
        "Удалить все аксессуары",
        "GenericString",
        "BUTTON",
        { stringValue: "" },
      ),
      optionEntry(
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
      ),
    ],
  };
}

function xiaomiChildWindow() {
  return {
    windowKey: XIAOMI_CHILD_WINDOW,
    label: { text: "Увлажнитель Xiaomi" },
    options: [
      optionEntry(
        "joinRoom",
        "Комната",
        "GenericString",
        "TEXT",
        { stringValue: "3" },
        {
          validValues: [
            { name: "Кухня", value: { stringValue: "1" } },
            { name: "Спальня", value: { stringValue: "2" } },
            { name: "Гостиная", value: { stringValue: "3" } },
          ],
        },
      ),
      optionEntry("ip", "IP-адрес", "GenericString", "TEXT", {
        stringValue: "192.168.1.44",
      }),
      optionEntry("joinButton", "Подключить", "GenericBoolean", "BUTTON", {
        boolValue: true,
      }),
    ],
  };
}

async function setup(
  t,
  {
    telegramOptions = {},
    thermostatOptions = {},
    faults = {},
    onRequest,
    timeoutMs = ORDINARY_HUB_TIMEOUT_MS,
  } = {},
) {
  const fixture = await loadHomeFixture("apartment");
  const hub = await startSimulatedHub(fixture, { faults, onRequest });
  hub.state.extensions.push(telegramExtension());
  hub.state.windows[TELEGRAM_WINDOW] = telegramWindow(telegramOptions);
  hub.state.windows[ZIGBEE_THERMOSTAT_WINDOW] =
    zigbeeThermostatWindow(thermostatOptions);
  hub.state.windows[ZIGBEE_CONTROLLER_WINDOW] = zigbeeControllerWindow();
  hub.state.windows[XIAOMI_CHILD_WINDOW] = xiaomiChildWindow();
  // Add hub-window buttons so refusals on "" can be exercised too.
  hub.state.windows[""].options.push(
    optionEntry("RebootHub", "Перезагрузить", "GenericBoolean", "BUTTON", {
      boolValue: true,
    }),
    optionEntry("UpdateHub", "Обновить", "GenericBoolean", "BUTTON", {
      boolValue: true,
    }),
    optionEntry(
      "DiskAction",
      "Диск",
      "GenericInteger",
      "BUTTON",
      { intValue: 1 },
      {
        read: false,
        validValues: [{ name: "Очистить", value: { intValue: 1 } }],
      },
    ),
  );

  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-window-buttons-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "window-buttons-test",
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
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return result.structuredContent;
}

async function readAllStateText(stateDirectory) {
  const entries = await readdir(stateDirectory);
  const parts = [];
  for (const name of entries) {
    const content = await readFile(path.join(stateDirectory, name), "utf8");
    parts.push(content);
  }
  return parts.join("\n");
}

function assertNoSecrets(payload, extraSecrets = []) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const secret of [
    TELEGRAM_BOT_TOKEN,
    PROXY_LOGIN_SECRET,
    PROXY_PASSWORD_SECRET,
    EMBEDDED_URL_SECRET,
    ...extraSecrets,
  ]) {
    assert.equal(
      text.includes(secret),
      false,
      `secret unexpectedly leaked: ${secret.slice(0, 8)}...`,
    );
  }
}

test("get_entity surfaces window label error/status, filters hidden buttons, marks hidden options, and decorates only allowlisted controls", async (t) => {
  const { hub, client } = await setup(t, {
    telegramOptions: {
      loggedIn: false,
      proxyType: "NONE",
      error: "Ошибка загрузки",
      status: "Подключение не активно",
    },
  });

  // 1. Telegram window while logged out with ProxyType=NONE
  const tg = await callOk(client, "get_entity", {
    entity_ref: windowRef(TELEGRAM_WINDOW),
  });
  assertNoSecrets(tg);
  const tgConfig = tg.entity;
  assert.equal(tgConfig.error, "Ошибка загрузки");
  assert.equal(tgConfig.status, "Подключение не активно");

  // Hidden button Logout must be omitted; visible Login gets window_button native_change;
  // unsupported Remove has NO native_change.
  assert.deepEqual(
    tgConfig.commands.map(({ key }) => key),
    ["Login", "Remove"],
  );
  const loginCmd = tgConfig.commands.find(({ key }) => key === "Login");
  assert.deepEqual(loginCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
  });
  assert.equal(Object.hasOwn(loginCmd, "disabled"), false);
  const removeCmd = tgConfig.commands.find(({ key }) => key === "Remove");
  assert.equal(Object.hasOwn(removeCmd, "native_change"), false);

  // Sensitive options (Token, ProxyLogin, ProxyPassword) are redacted; none leak secrets.
  const redactedOptions = tgConfig.options.filter(
    (item) => item.redacted === true,
  );
  assert.equal(redactedOptions.length, 3);
  for (const key of ["Token", "ProxyLogin", "ProxyPassword"]) {
    assert.equal(
      tgConfig.options.some((item) => item.key === key),
      false,
      `sensitive option ${key} must be redacted`,
    );
  }

  // Hidden options ProxyHost/ProxyPort carry visible: false and reason: option_hidden.
  for (const key of ["ProxyHost", "ProxyPort"]) {
    const opt = tgConfig.options.find((item) => item.key === key);
    assert.equal(opt.visible, false);
    assert.deepEqual(opt.native_change, {
      native_write: true,
      supported: false,
      reason: "option_hidden",
    });
  }

  // Visible Telegram safe TEXT options (BotApiUrl, Name) omit visible and have supported: true.
  for (const key of ["BotApiUrl", "Name"]) {
    const opt = tgConfig.options.find((item) => item.key === key);
    assert.equal(Object.hasOwn(opt, "visible"), false);
    assert.equal(opt.native_change.supported, true);
    assert.equal(opt.native_change.operation, "window_option");
  }

  // 2. Telegram window when logged in (Logout visible, Login hidden, empty error/status omitted)
  hub.state.windows[TELEGRAM_WINDOW] = telegramWindow({
    loggedIn: true,
    proxyType: "SOCKS5",
    error: "",
    status: "",
  });
  const tgLoggedIn = await callOk(client, "get_entity", {
    entity_ref: windowRef(TELEGRAM_WINDOW),
  });
  const tgInConfig = tgLoggedIn.entity;
  assert.equal(Object.hasOwn(tgInConfig, "error"), false);
  assert.equal(Object.hasOwn(tgInConfig, "status"), false);
  assert.deepEqual(
    tgInConfig.commands.map(({ key }) => key),
    ["Logout", "Remove"],
  );
  const logoutCmd = tgInConfig.commands.find(({ key }) => key === "Logout");
  assert.deepEqual(logoutCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
    requires_confirmation: true,
  });
  // ProxyHost & ProxyPort are now visible and writable.
  for (const key of ["ProxyHost", "ProxyPort"]) {
    const opt = tgInConfig.options.find((item) => item.key === key);
    assert.equal(Object.hasOwn(opt, "visible"), false);
    assert.equal(opt.native_change.supported, true);
    assert.equal(opt.native_change.operation, "window_option");
  }

  // 3. Disabled allowlisted button includes disabled: true and no supported native_change.
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "Logout",
  ).disabled = true;
  const tgDisabled = await callOk(client, "get_entity", {
    entity_ref: windowRef(TELEGRAM_WINDOW),
  });
  const disabledLogout = tgDisabled.entity.commands.find(
    ({ key }) => key === "Logout",
  );
  assert.equal(disabledLogout.disabled, true);
  assert.equal(Object.hasOwn(disabledLogout, "native_change"), false);

  // 4. ZigBee thermostat window: 5 hidden debug buttons omitted; calibration button supported;
  // Repair/readAllAttributes/Remove stay compact without native_change.
  const trv = await callOk(client, "get_entity", {
    entity_ref: windowRef(ZIGBEE_THERMOSTAT_WINDOW),
  });
  const trvCommands = trv.entity.commands;
  assert.deepEqual(
    trvCommands.map(({ key }) => key),
    [CALIBRATION_KEY, "Repair", "readAllAttributes", "Remove"],
  );
  const calCmd = trvCommands.find(({ key }) => key === CALIBRATION_KEY);
  assert.deepEqual(calCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
  });
  for (const key of ["Repair", "readAllAttributes", "Remove"]) {
    assert.equal(
      Object.hasOwn(
        trvCommands.find((cmd) => cmd.key === key),
        "native_change",
      ),
      false,
    );
  }

  // Also verify accessory get_entity with include=["physical_configuration"] filters hidden buttons
  // and redacts credential-shaped window.label.error.
  const acc = hub.state.accessories[0];
  acc.deviceWindow = ZIGBEE_THERMOSTAT_WINDOW;
  hub.state.windows[ZIGBEE_THERMOSTAT_WINDOW].label.error =
    `Error calling https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`;
  const accEntity = await callOk(client, "get_entity", {
    entity_ref: `${HOME_REF}/accessory/${acc.id}`,
    include: ["physical_configuration"],
  });
  assertNoSecrets(accEntity);
  assert.equal(accEntity.entity.physical_configuration.error, "[REDACTED]");
  assert.deepEqual(
    accEntity.entity.physical_configuration.commands.map(({ key }) => key),
    [CALIBRATION_KEY, "Repair", "readAllAttributes", "Remove"],
  );

  // 5. Xiaomi child window: joinRoom TEXT-with-validValues is supported; plain TEXT ip is not.
  const xiaomi = await callOk(client, "get_entity", {
    entity_ref: windowRef(XIAOMI_CHILD_WINDOW),
  });
  const joinRoomOpt = xiaomi.entity.options.find(
    ({ key }) => key === "joinRoom",
  );
  const ipOpt = xiaomi.entity.options.find(({ key }) => key === "ip");
  assert.equal(joinRoomOpt.native_change.supported, true);
  assert.equal(joinRoomOpt.native_change.operation, "window_option");
  assert.equal(ipOpt.native_change.supported, false);
  assert.equal(ipOpt.native_change.reason, "unsupported_input_type");
  assert.equal(
    Object.hasOwn(
      xiaomi.entity.commands.find(({ key }) => key === "joinButton"),
      "native_change",
    ),
    false,
  );
});

test("window_option supports TEXT with validValues (Xiaomi joinRoom), safe Telegram TEXT settings with validation and undo, while refusing hidden, sensitive, and generic TEXT options", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const tgRef = windowRef(TELEGRAM_WINDOW);
  const xiaomiRef = windowRef(XIAOMI_CHILD_WINDOW);

  // 1. Xiaomi joinRoom: invalid value rejected with inline contract; valid value applies & restores.
  const badRoom = await callError(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: xiaomiRef,
    option_key: "joinRoom",
    value: "99",
    reason: "Выбрать комнату для Xiaomi",
  });
  assert.equal(badRoom.error.code, "invalid_native_value");
  assert.ok(badRoom.contract, "joinRoom validation error must inline contract");
  assert.equal(badRoom.contract.input_type, "TEXT");
  assert.equal(badRoom.contract.valid_values.length, 3);

  const prepRoom = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: xiaomiRef,
    option_key: "joinRoom",
    value: "1",
    reason: "Выбрать кухню для Xiaomi",
  });
  const appliedRoom = await callOk(client, "apply_native_change", {
    change_ref: prepRoom.change_ref,
  });
  assert.equal(appliedRoom.status, "applied");
  assert.equal(
    hub.state.windows[XIAOMI_CHILD_WINDOW].options.find(
      ({ key }) => key === "joinRoom",
    ).value.stringValue,
    "1",
  );
  const restoredRoom = await callOk(client, "restore_native_change", {
    change_ref: prepRoom.change_ref,
  });
  assert.equal(restoredRoom.status, "restored");
  assert.equal(
    hub.state.windows[XIAOMI_CHILD_WINDOW].options.find(
      ({ key }) => key === "joinRoom",
    ).value.stringValue,
    "3",
  );

  // Plain TEXT ip on Xiaomi stays refused.
  const badIp = await callError(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: xiaomiRef,
    option_key: "ip",
    value: "192.168.1.99",
    reason: "Поменять IP Xiaomi",
  });
  assert.equal(badIp.error.code, "unsupported_window_option");
  assert.equal(badIp.contract, undefined);

  // 2. Hidden Telegram options ProxyHost/ProxyPort refused with window_option_hidden while ProxyType=NONE.
  for (const key of ["ProxyHost", "ProxyPort"]) {
    const hiddenErr = await callError(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: tgRef,
      option_key: key,
      value: key === "ProxyPort" ? "1080" : "proxy.example.com",
      reason: `Настроить ${key}`,
    });
    assert.equal(hiddenErr.error.code, "window_option_hidden");
    assert.match(hiddenErr.error.message, /hidden|ProxyType/i);
    assert.equal(hiddenErr.contract, undefined);
  }

  // 3. Sensitive options (Token, ProxyLogin, ProxyPassword) ALWAYS refused (both hidden & visible).
  for (const key of ["Token", "ProxyLogin", "ProxyPassword"]) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: tgRef,
      option_key: key,
      value: "anything",
      reason: `Поменять ${key}`,
    });
    assert.equal(err.error.code, "sensitive_native_data", key);
    assert.equal(err.contract, undefined);
    assertNoSecrets(err);
  }

  // 4. Enable ProxyType=SOCKS5 -> ProxyHost and ProxyPort become visible and editable,
  // while ProxyLogin and ProxyPassword remain sensitive_native_data.
  const prepProxyType = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "ProxyType",
    value: "SOCKS5",
    reason: "Включить SOCKS5 прокси для Telegram",
  });
  await callOk(client, "apply_native_change", {
    change_ref: prepProxyType.change_ref,
  });

  for (const key of ["ProxyLogin", "ProxyPassword"]) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: tgRef,
      option_key: key,
      value: "new-secret",
      reason: `Поменять ${key}`,
    });
    assert.equal(err.error.code, "sensitive_native_data", `${key} visible`);
    assertNoSecrets(err);
  }

  // 5. ProxyPort validation + write + clear + undo.
  for (const badPort of ["0", "65536", "-1", "080", "abc", 1080]) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: tgRef,
      option_key: "ProxyPort",
      value: badPort,
      reason: "Задать неверный порт",
    });
    assert.equal(err.error.code, "invalid_native_value", String(badPort));
    assert.ok(err.contract, `ProxyPort error for ${badPort} inlines contract`);
  }
  const redactedPort = await callError(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "ProxyPort",
    value: "[REDACTED]",
    reason: "Задать маркер",
  });
  assert.equal(redactedPort.error.code, "invalid_native_value");
  assert.equal(redactedPort.contract, undefined);

  const prepPort = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "ProxyPort",
    value: "1080",
    reason: "Задать порт прокси 1080",
  });
  const appliedPort = await callOk(client, "apply_native_change", {
    change_ref: prepPort.change_ref,
  });
  assert.equal(appliedPort.status, "applied");
  assert.equal(
    hub.state.windows[TELEGRAM_WINDOW].options.find(
      ({ key }) => key === "ProxyPort",
    ).value.stringValue,
    "1080",
  );

  // Clear ProxyPort with "" works and restores back to "1080".
  const prepClearPort = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "ProxyPort",
    value: "",
    reason: "Очистить порт прокси",
  });
  const appliedClearPort = await callOk(client, "apply_native_change", {
    change_ref: prepClearPort.change_ref,
  });
  assert.equal(appliedClearPort.status, "applied");
  assert.equal(
    hub.state.windows[TELEGRAM_WINDOW].options.find(
      ({ key }) => key === "ProxyPort",
    ).value.stringValue,
    "",
  );
  await callOk(client, "restore_native_change", {
    change_ref: prepClearPort.change_ref,
  });
  assert.equal(
    hub.state.windows[TELEGRAM_WINDOW].options.find(
      ({ key }) => key === "ProxyPort",
    ).value.stringValue,
    "1080",
  );

  // 6. BotApiUrl validation (reject ftp, bad url, embedded credentials, [REDACTED]) + write + undo.
  for (const badUrl of [
    "ftp://api.example.org",
    "not-a-url",
    `https://${EMBEDDED_URL_SECRET}@api.example.org`,
    "https://onlyuser@api.example.org",
    "https://:onlypass@api.example.org",
  ]) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_option",
      target_ref: tgRef,
      option_key: "BotApiUrl",
      value: badUrl,
      reason: "Задать неверный URL",
    });
    assert.equal(err.error.code, "invalid_native_value", badUrl);
    assertNoSecrets(err);
  }
  const redactedUrl = await callError(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "BotApiUrl",
    value: "https://example.org/[REDACTED]",
    reason: "Задать URL с маркером",
  });
  assert.equal(redactedUrl.error.code, "invalid_native_value");
  assert.equal(redactedUrl.contract, undefined);

  const prepUrl = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "BotApiUrl",
    value: "https://bot-api.example.org",
    reason: "Задать локальный Bot API URL",
  });
  const appliedUrl = await callOk(client, "apply_native_change", {
    change_ref: prepUrl.change_ref,
  });
  assert.equal(appliedUrl.status, "applied");
  assert.equal(
    hub.state.windows[TELEGRAM_WINDOW].options.find(
      ({ key }) => key === "BotApiUrl",
    ).value.stringValue,
    "https://bot-api.example.org",
  );
  const restoredUrl = await callOk(client, "restore_native_change", {
    change_ref: prepUrl.change_ref,
  });
  assert.equal(restoredUrl.status, "restored");
  assert.equal(
    hub.state.windows[TELEGRAM_WINDOW].options.find(
      ({ key }) => key === "BotApiUrl",
    ).value.stringValue,
    "",
  );

  // 7. ProxyHost and Name on Telegram write + undo, plus mid-flight hide blocks apply.
  const prepHost = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "ProxyHost",
    value: "10.0.0.5",
    reason: "Задать хост прокси",
  });
  // Hide ProxyHost before apply -> apply must refuse without writing!
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "ProxyHost",
  ).visible = false;
  const writesBeforeHiddenApply = hub.writes().length;
  const hiddenApplyErr = await callError(client, "apply_native_change", {
    change_ref: prepHost.change_ref,
  });
  assert.equal(hiddenApplyErr.error.code, "window_option_hidden");
  assert.equal(hub.writes().length, writesBeforeHiddenApply);

  // Make visible again -> apply and restore succeed.
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "ProxyHost",
  ).visible = true;
  const appliedHost = await callOk(client, "apply_native_change", {
    change_ref: prepHost.change_ref,
  });
  assert.equal(appliedHost.status, "applied");
  const restoredHost = await callOk(client, "restore_native_change", {
    change_ref: prepHost.change_ref,
  });
  assert.equal(restoredHost.status, "restored");

  const prepName = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "Name",
    value: "Телеграм дома",
    reason: "Переименовать расширение Telegram",
  });
  const appliedName = await callOk(client, "apply_native_change", {
    change_ref: prepName.change_ref,
  });
  assert.equal(appliedName.status, "applied");
  await callOk(client, "restore_native_change", {
    change_ref: prepName.change_ref,
  });
  assert.equal(
    hub.state.windows[TELEGRAM_WINDOW].options.find(({ key }) => key === "Name")
      .value.stringValue,
    "Telegram",
  );

  // Verify no secret ever landed in any journal file on disk.
  assertNoSecrets(await readAllStateText(stateDirectory));
});

test("window_button supports Telegram Login/Logout and ZigBee ThermostatValveCalibration (C1 & C3) with honest readback, repeat-apply guard, history, and non-restorability", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const tgRef = windowRef(TELEGRAM_WINDOW);
  const trvRef = windowRef(ZIGBEE_THERMOSTAT_WINDOW);

  // 1. Telegram Login: no tell_owner, has next: apply_native_change, sends {boolValue: true}, reads back effect.
  const prepLogin = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    reason: "Войти в Telegram-бота",
  });
  assert.equal(prepLogin.status, "prepared");
  assert.equal(prepLogin.operation, "window_button");
  assert.equal(prepLogin.restore_supported, false);
  assert.equal(prepLogin.tell_owner, undefined);
  assert.equal(prepLogin.next?.tool, "apply_native_change");
  assert.equal(prepLogin.next?.arguments?.change_ref, prepLogin.change_ref);
  assertNoSecrets(prepLogin);

  const appliedLogin = await callOk(client, "apply_native_change", {
    change_ref: prepLogin.change_ref,
  });
  assert.equal(appliedLogin.status, "applied");
  assert.equal(appliedLogin.native_write_sent, true);
  assert.equal(appliedLogin.native_acknowledged, true);
  assert.deepEqual(appliedLogin.observed_effect, {
    extension_state: "LOADED",
    enabled: true,
    window_error: null,
    login_visible: false,
    logout_visible: true,
  });
  assertNoSecrets(appliedLogin);

  const loginWrite = hub.writes().at(-1);
  assert.deepEqual(loginWrite.params, {
    window: {
      update: {
        windowKey: TELEGRAM_WINDOW,
        options: [{ key: "Login", value: { boolValue: true } }],
      },
    },
  });

  // Repeat apply on already-applied button must NOT resend!
  const writesAfterLogin = hub.writes().length;
  const repeatLogin = await callOk(client, "apply_native_change", {
    change_ref: prepLogin.change_ref,
  });
  assert.equal(repeatLogin.status, "applied");
  assert.equal(hub.writes().length, writesAfterLogin);

  // History filtered by Telegram extension ref finds the Login press.
  const history = await callOk(client, "get_native_change", {
    entity_ref: extensionRef(TELEGRAM_EXTENSION_KEY),
  });
  assert.ok(
    history.changes.some(
      (entry) =>
        entry.change_ref === prepLogin.change_ref &&
        entry.operation === "window_button",
    ),
  );

  // 2. Telegram Logout (now visible): ALWAYS sets tell_owner and omits next: apply_native_change!
  const prepLogout = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Logout",
    reason: "Выйти из Telegram-бота",
  });
  assert.equal(prepLogout.status, "prepared");
  assert.equal(typeof prepLogout.tell_owner, "string");
  assert.ok(prepLogout.tell_owner.length > 0);
  assert.equal(prepLogout.next, undefined);
  assertNoSecrets(prepLogout);

  // Applying Logout after owner confirmation succeeds and reads back FAILED + error + visibility swap.
  const appliedLogout = await callOk(client, "apply_native_change", {
    change_ref: prepLogout.change_ref,
  });
  assert.equal(appliedLogout.status, "applied");
  assert.deepEqual(appliedLogout.observed_effect, {
    extension_state: "FAILED",
    enabled: true,
    window_error: "Ошибка загрузки",
    login_visible: true,
    logout_visible: false,
  });

  // 3. ZigBee ThermostatValveCalibration (C1: read=true -> sends current {boolValue: false}).
  const prepCal = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: trvRef,
    option_key: CALIBRATION_KEY,
    reason: "Откалибровать клапан термоголовки в спальне",
  });
  assert.equal(prepCal.status, "prepared");
  assert.equal(prepCal.tell_owner, undefined);
  assert.equal(prepCal.next?.tool, "apply_native_change");

  const appliedCal = await callOk(client, "apply_native_change", {
    change_ref: prepCal.change_ref,
  });
  assert.equal(appliedCal.status, "applied");
  assert.deepEqual(appliedCal.observed_effect, {
    calibration_status: { value: 1, label: "Калибровка" },
  });
  assert.ok(
    appliedCal.limitations.some((line) => /physical|valve/i.test(line)),
    "calibration result must note physical valve limitation",
  );
  assert.deepEqual(hub.writes().at(-1).params, {
    window: {
      update: {
        windowKey: ZIGBEE_THERMOSTAT_WINDOW,
        options: [{ key: CALIBRATION_KEY, value: { boolValue: false } }],
      },
    },
  });

  // 4. ZigBee ThermostatValveCalibration with C3 write-only single validValue AND no status option.
  const c3WindowKey = "Controller/zigbee_1/Child/0x5678/";
  const c3CalKey =
    "/1/FCC0_ManufacturerSpecific/00F4_ThermostatValveCalibration/1";
  hub.state.windows[c3WindowKey] = {
    windowKey: c3WindowKey,
    label: { text: "Термоголовка в детской" },
    options: [
      optionEntry(
        c3CalKey,
        "Калибровка клапана",
        "GenericInteger",
        "BUTTON",
        null,
        {
          read: false,
          write: true,
          validValues: [{ name: "Старт", value: { intValue: 1 } }],
        },
      ),
    ],
  };
  const prepC3 = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(c3WindowKey),
    option_key: c3CalKey,
    reason: "Запустить калибровку клапана",
  });
  const appliedC3 = await callOk(client, "apply_native_change", {
    change_ref: prepC3.change_ref,
  });
  assert.equal(appliedC3.status, "applied");
  assert.deepEqual(appliedC3.observed_effect, { calibration_status: null });
  assert.deepEqual(hub.writes().at(-1).params, {
    window: {
      update: {
        windowKey: c3WindowKey,
        options: [{ key: c3CalKey, value: { intValue: 1 } }],
      },
    },
  });

  // 5. restore_native_change honestly refuses window_button (single and batch).
  const singleRestore = await callError(client, "restore_native_change", {
    change_ref: prepCal.change_ref,
  });
  assert.equal(singleRestore.error.code, "restore_unsupported");

  // Batch restore skips window_button as not_restorable while restoring a restorable window_option.
  const prepName = await callOk(client, "prepare_native_change", {
    operation: "window_option",
    target_ref: tgRef,
    option_key: "Name",
    value: "Телеграм 2",
    reason: "Переименовать Telegram",
  });
  await callOk(client, "apply_native_change", {
    change_ref: prepName.change_ref,
  });
  const batchRestore = await callOk(client, "restore_native_change", {
    change_refs: [prepCal.change_ref, prepName.change_ref],
  });
  const btnRestoreItem = batchRestore.results.find(
    ({ change_ref }) => change_ref === prepCal.change_ref,
  );
  const optRestoreItem = batchRestore.results.find(
    ({ change_ref }) => change_ref === prepName.change_ref,
  );
  assert.equal(btnRestoreItem.status, "skipped");
  assert.equal(btnRestoreItem.reason, "not_restorable");
  assert.equal(optRestoreItem.status, "restored");

  // No secrets leaked in journal files.
  assertNoSecrets(await readAllStateText(stateDirectory));
});

test("window_button enforces strict allowlist refusals, hidden/disabled/token checks, inline validation contract, and pre-write drift guard", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const tgRef = windowRef(TELEGRAM_WINDOW);
  const trvRef = windowRef(ZIGBEE_THERMOSTAT_WINDOW);
  const zigbeeCtrlRef = windowRef(ZIGBEE_CONTROLLER_WINDOW);
  const hubWinRef = windowRef("");
  const scenarioWinRef = windowRef("Scenario/5/");

  // 1. Strict non-allowlisted refusals (no inline contract, zero hub writes).
  const refusedCases = [
    ["Telegram Remove", tgRef, "Remove", "unsupported_window_button"],
    ["ZigBee child Remove", trvRef, "Remove", "unsupported_window_button"],
    ["ZigBee child Repair", trvRef, "Repair", "unsupported_window_button"],
    [
      "ZigBee child readAllAttributes",
      trvRef,
      "readAllAttributes",
      "unsupported_window_button",
    ],
    [
      "ZigBee child hidden testReadAttribute",
      trvRef,
      "testReadAttribute",
      "unsupported_window_button",
    ],
    [
      "ZigBee controller DeleteAllAccessories",
      zigbeeCtrlRef,
      "DeleteAllAccessories",
      "unsupported_window_button",
    ],
    [
      "ZigBee controller Remove",
      zigbeeCtrlRef,
      "Remove",
      "unsupported_window_button",
    ],
    [
      "Hub window RebootHub",
      hubWinRef,
      "RebootHub",
      "unsupported_window_button",
    ],
    [
      "Hub window UpdateHub",
      hubWinRef,
      "UpdateHub",
      "unsupported_window_button",
    ],
    [
      "Hub window DiskAction",
      hubWinRef,
      "DiskAction",
      "unsupported_window_button",
    ],
    ["Scenario Remove", scenarioWinRef, "Remove", "unsupported_window_button"],
    [
      "Xiaomi joinButton (not allowlisted)",
      windowRef(XIAOMI_CHILD_WINDOW),
      "joinButton",
      "unsupported_window_button",
    ],
    ["Hidden allowlisted Logout", tgRef, "Logout", "window_button_hidden"],
    [
      "Unknown key on Telegram window",
      tgRef,
      "DoesNotExist",
      "window_button_not_found",
    ],
    [
      "Sensitive Token passed as window_button",
      tgRef,
      "Token",
      "sensitive_native_data",
    ],
  ];

  for (const [label, targetRef, optionKey, expectedCode] of refusedCases) {
    const err = await callError(client, "prepare_native_change", {
      operation: "window_button",
      target_ref: targetRef,
      option_key: optionKey,
      reason: `Попробовать ${label}`,
    });
    assert.equal(err.error.code, expectedCode, label);
    assert.equal(
      err.contract,
      undefined,
      `${label} refusal must not attach inline contract`,
    );
    assertNoSecrets(err);
  }

  // 2. Disabled allowlisted button -> window_button_disabled.
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "Login",
  ).disabled = true;
  const disabledErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    reason: "Войти в отключённый Telegram",
  });
  assert.equal(disabledErr.error.code, "window_button_disabled");
  assert.equal(disabledErr.contract, undefined);
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "Login",
  ).disabled = false;

  // 3. Missing option_key -> option_key_required.
  const missingKeyErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    reason: "Забыли option_key",
  });
  assert.equal(missingKeyErr.error.code, "option_key_required");

  // 4. Unexpected value passed to valid window_button -> invalid_native_change WITH compact inline contract!
  const unexpectedValErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    value: true,
    reason: "Войти в Telegram с лишним value",
  });
  assert.equal(unexpectedValErr.error.code, "invalid_native_change");
  assert.ok(
    unexpectedValErr.contract,
    "unexpected value on window_button must attach compact inline contract",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(unexpectedValErr.contract), "utf8") <=
      4_096,
  );
  assert.equal(unexpectedValErr.contract.restore_supported, false);

  // 5. Telegram Login when Token is empty -> telegram_token_missing (and no token leak).
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "Token",
  ).value.stringValue = "";
  const missingTokenErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    reason: "Войти без токена",
  });
  assert.equal(missingTokenErr.error.code, "telegram_token_missing");
  assert.match(missingTokenErr.error.message, /token|SprutHub app/i);
  assert.equal(missingTokenErr.contract, undefined);
  assertNoSecrets(missingTokenErr);

  // Restore Token, prepare Login, then clear Token before apply -> conflict, zero hub writes!
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "Token",
  ).value.stringValue = TELEGRAM_BOT_TOKEN;
  const prepDrift = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    reason: "Войти в Telegram",
  });
  hub.state.windows[TELEGRAM_WINDOW].options.find(
    ({ key }) => key === "Token",
  ).value.stringValue = "";
  const conflictApply = await callOk(client, "apply_native_change", {
    change_ref: prepDrift.change_ref,
  });
  assert.equal(conflictApply.status, "conflict");
  assert.equal(conflictApply.conflict_reason, "telegram_token_missing");
  assert.equal(conflictApply.native_write_sent, false);

  // Zero writes were sent to the hub during all refusal & drift tests!
  assert.deepEqual(hub.writes(), []);
  assertNoSecrets(await readAllStateText(stateDirectory));
});

test("window_button preserves applied status on post-ACK readback failure, records uncertain without resending on lost reply, and records rejection cleanly", async (t) => {
  // Part A: Post-ACK readback failure keeps status=applied with readback_error.
  let failReadbackAfterUpdate = false;
  const { hub, client } = await setup(t, {
    onRequest: ({ method }) => {
      if (failReadbackAfterUpdate && method === "window.update") {
        failReadbackAfterUpdate = false;
        hub.refuseNext("extension.get", {
          code: -32603,
          message: "Temporary extension read error",
        });
      }
    },
  });
  const tgRef = windowRef(TELEGRAM_WINDOW);

  const prepLogin = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    reason: "Войти в Telegram",
  });
  failReadbackAfterUpdate = true;
  const appliedWithReadbackErr = await callOk(client, "apply_native_change", {
    change_ref: prepLogin.change_ref,
  });
  assert.equal(appliedWithReadbackErr.status, "applied");
  assert.equal(appliedWithReadbackErr.native_write_sent, true);
  assert.equal(appliedWithReadbackErr.native_acknowledged, true);
  assert.ok(appliedWithReadbackErr.readback_error?.extension);
  // Window readback still succeeded so login/logout visibility is reported honestly.
  assert.equal(appliedWithReadbackErr.observed_effect.extension_state, null);
  assert.equal(appliedWithReadbackErr.observed_effect.login_visible, false);
  assert.equal(appliedWithReadbackErr.observed_effect.logout_visible, true);

  // Later get_native_change refreshes observed_effect cleanly without sending any write.
  const writesBeforeGet = hub.writes().length;
  const refreshed = await callOk(client, "get_native_change", {
    change_ref: prepLogin.change_ref,
  });
  assert.equal(refreshed.status, "applied");
  assert.equal(refreshed.readback_error, undefined);
  assert.deepEqual(refreshed.observed_effect, {
    extension_state: "LOADED",
    enabled: true,
    window_error: null,
    login_visible: false,
    logout_visible: true,
  });
  assert.equal(hub.writes().length, writesBeforeGet);

  // Part B: Explicit hub rejection marks not_applied and never resends.
  const prepLogout = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Logout",
    reason: "Выйти из Telegram",
  });
  hub.refuseNext("window.update", {
    code: -32603,
    message: "Logout refused by hub",
  });
  const rejected = await callError(client, "apply_native_change", {
    change_ref: prepLogout.change_ref,
  });
  assert.equal(rejected.hub_effect, "not_applied");
  assert.ok(rejected.rejection);
  const writesAfterReject = hub.writes().length;
  const repeatRejected = await callOk(client, "apply_native_change", {
    change_ref: prepLogout.change_ref,
  });
  assert.equal(repeatRejected.status, "not_applied");
  assert.equal(hub.writes().length, writesAfterReject);
});

test("window_button lost reply marks change uncertain (hub_effect: unknown) and never resends on retry", async (t) => {
  const { hub, client } = await setup(t, {
    faults: {
      droppedReply: [{ method: "window.update", times: 1, applied: true }],
    },
    timeoutMs: 350,
  });
  const tgRef = windowRef(TELEGRAM_WINDOW);

  const prep = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: tgRef,
    option_key: "Login",
    reason: "Войти в Telegram при потере ответа",
  });
  const uncertain = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.hub_effect, "unknown");
  assert.equal(uncertain.native_write_sent, true);
  assert.equal(uncertain.native_acknowledged, false);
  assert.equal(hub.writes().length, 1);

  // Retrying apply_native_change MUST NOT resend window.update!
  const retried = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(retried.status, "uncertain");
  assert.equal(retried.hub_effect, "unknown");
  assert.equal(hub.writes().length, 1);

  // get_native_change reads fresh observed_effect honestly while staying uncertain.
  const inspected = await callOk(client, "get_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(inspected.status, "uncertain");
  assert.equal(inspected.hub_effect, "unknown");
  assert.equal(inspected.observed_effect.extension_state, "LOADED");
  assert.equal(hub.writes().length, 1);
});

test("window_button contract stays compact and MCP tool count/metadata budgets stay intact", async (t) => {
  const { client } = await setup(t);
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

  const contract = await callOk(client, "get_native_change_contract", {
    operation: "window_button",
    target_ref: windowRef(TELEGRAM_WINDOW),
    option_key: "Login",
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(contract.contract), "utf8") <= 4_096,
    "window_button contract must stay <= 4096 bytes",
  );
  assert.equal(contract.contract.restore_supported, false);
});
