import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { FAKE_HUB_HOST, ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const serial = "config-point-hub";
const otherSerial = "other-home";
const homeRef = `spruthub://hub/${serial}`;
const otherHomeRef = `spruthub://hub/${otherSerial}`;
const roomRef = `${homeRef}/room/1`;
const workshopRoomRef = `${homeRef}/room/2`;
const accessoryRef = `${homeRef}/accessory/34`;
const missingAccessoryRef = `${homeRef}/accessory/99`;
const serviceRef = `${homeRef}/accessory/34/service/13`;
const characteristicRef = `${serviceRef}/characteristic/15`;
const breezerAccessoryRef = `${homeRef}/accessory/40`;
const climateServiceRef = `${breezerAccessoryRef}/service/20`;
const targetTemperatureRef = `${climateServiceRef}/characteristic/1`;
const targetModeRef = `${climateServiceRef}/characteristic/2`;
const fanSpeedRef = `${climateServiceRef}/characteristic/3`;
const currentTemperatureRef = `${climateServiceRef}/characteristic/4`;
const currentModeRef = `${climateServiceRef}/characteristic/5`;
const logicType = "SmoothBrightnessChange";
const logicRef = `${serviceRef}/logic/${logicType}`;
const scenarioRef = `${homeRef}/scenario/office-light`;
const deviceWindowKey = "Controller/zigbee_demo/Child/DEVICE_A/";
const deviceWindowRef = `${homeRef}/window/${encodeURIComponent(deviceWindowKey)}`;
const homeWindowRef = `${homeRef}/window/`;
const startupOptionKey = "/11/0006_OnOff/4003_StartUpOnOff/255";
const wifiSecret = "wifi-secret-must-not-leak";
const windowPasswordSecret = "window-password-must-not-leak";
const replacementWindowPasswordSecret = "new-window-password-must-not-leak";
const accessTokenSecret = "token-secret-must-not-leak";
const replacementTokenSecret = "other-token-must-not-leak";
const thenDelayPath = ["configuration", "value", "targets", 0, "then_delay"];

function officeBlockData({ delay = 0, blockId = 7, targetCount = 1 } = {}) {
  return {
    blockId,
    targets: Array.from({ length: targetCount }, (_, index) => ({
      type: "if",
      blockId: index + 1,
      mode: "EVERY",
      if: {
        type: "condition",
        blockId: 1000 + index,
        mode: "AND",
        state: "runtime-projection",
        conditions: [],
      },
      // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK scenarios use this native key.
      then: [],
      else: [],
      then_delay: index === 0 ? delay : 0,
      else_delay: 0,
    })),
  };
}

function smoothLogicOptions(duration = 900) {
  return [
    {
      key: "Primary",
      name: "Плавное изменение яркости",
      type: "Group",
      inputType: "GROUP",
      read: true,
      write: false,
      disabled: false,
    },
    {
      key: "Duration",
      name: "Продолжительность",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: duration },
    },
    {
      key: "AccessToken",
      name: "Access token",
      type: "GenericString",
      inputType: "LIST",
      read: true,
      write: true,
      disabled: false,
      value: { stringValue: accessTokenSecret },
      validValues: [
        { name: "Current", value: { stringValue: accessTokenSecret } },
        { name: "Replacement", value: { stringValue: replacementTokenSecret } },
      ],
    },
  ];
}

function deviceWindowOptions(startupValue = 255) {
  return [
    {
      key: startupOptionKey,
      name: "После восстановления питания",
      type: "GenericInteger",
      inputType: "LIST",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: startupValue },
      validValues: [
        { name: "Выключена", value: { intValue: 0 } },
        { name: "Включена", value: { intValue: 1 } },
        { name: "Предыдущее состояние", value: { intValue: 255 } },
      ],
    },
    {
      key: "DevicePassword",
      name: "Пароль устройства",
      type: "GenericString",
      inputType: "PASSWORD",
      read: true,
      write: true,
      disabled: false,
      value: { stringValue: windowPasswordSecret },
    },
    {
      key: "Reboot",
      name: "Перезагрузить",
      type: "GenericBoolean",
      inputType: "BUTTON",
      read: false,
      write: true,
      disabled: false,
      value: { boolValue: false },
    },
  ];
}

function heatingCoolingValues(kind) {
  return kind === "current"
    ? [
        { key: "OFF", name: "Выключен", value: { intValue: 0 } },
        { key: "HEAT", name: "Нагревает", value: { intValue: 1 } },
        { key: "COOL", name: "Охлаждает", value: { intValue: 2 } },
      ]
    : [
        { key: "OFF", name: "Выключено", value: { intValue: 0 } },
        { key: "HEAT", name: "Нагрев", value: { intValue: 1 } },
        { key: "COOL", name: "Охлаждение", value: { intValue: 2 } },
      ];
}

function fanSpeedValues() {
  return [
    { key: "LOW", name: "Медленно", value: { intValue: 30 } },
    { key: "MEDIUM", name: "Средне", value: { intValue: 60 } },
    { key: "HIGH", name: "Быстро", value: { intValue: 90 } },
  ];
}

function breezerAccessory({
  online = true,
  targetTemperature = 26,
  targetMode = 0,
  fanSpeed = 30,
  currentTemperature = 21,
  currentMode = 0,
} = {}) {
  return {
    id: 40,
    roomId: 3,
    name: "Бризер детской",
    online,
    services: [
      {
        aId: 40,
        sId: 20,
        name: "Климат",
        type: "HeaterCooler",
        characteristics: [
          {
            aId: 40,
            sId: 20,
            cId: 1,
            hasOptions: false,
            control: {
              name: "Уставка",
              type: "TargetTemperature",
              read: true,
              write: true,
              events: true,
              unit: "°C",
              minValue: 10,
              maxValue: 30,
              minStep: 0.5,
              value: { doubleValue: targetTemperature },
            },
          },
          {
            aId: 40,
            sId: 20,
            cId: 2,
            hasOptions: false,
            control: {
              name: "Целевой режим",
              type: "TargetHeatingCoolingState",
              read: true,
              write: true,
              events: true,
              value: { intValue: targetMode },
              validValues: heatingCoolingValues("target"),
            },
          },
          {
            aId: 40,
            sId: 20,
            cId: 3,
            hasOptions: false,
            control: {
              name: "Скорость",
              type: "C_FanSpeed",
              read: true,
              write: true,
              events: true,
              value: { intValue: fanSpeed },
              validValues: fanSpeedValues(),
            },
          },
          {
            aId: 40,
            sId: 20,
            cId: 4,
            hasOptions: false,
            control: {
              name: "Температура",
              type: "CurrentTemperature",
              read: true,
              write: false,
              events: true,
              unit: "°C",
              value: { doubleValue: currentTemperature },
            },
          },
          {
            aId: 40,
            sId: 20,
            cId: 5,
            hasOptions: false,
            control: {
              name: "Текущий режим",
              type: "CurrentHeatingCoolingState",
              read: true,
              write: false,
              events: true,
              value: { intValue: currentMode },
              validValues: heatingCoolingValues("current"),
            },
          },
        ],
      },
    ],
  };
}

function characteristicControl(state, ref) {
  const match =
    /\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/.exec(ref);
  assert.ok(match, `unexpected characteristic ref: ${ref}`);
  const [, aId, sId, cId] = match.map(Number);
  const control = state.accessories
    .find(({ id }) => id === aId)
    ?.services.find((service) => service.sId === sId)
    ?.characteristics.find(
      (characteristic) => characteristic.cId === cId,
    )?.control;
  assert.ok(control, `missing characteristic ${ref}`);
  return control;
}

function capturedEntity(point, entityRef) {
  return point.entity.entities.find(
    ({ entity_ref }) => entity_ref === entityRef,
  );
}

function createState() {
  return {
    rooms: [
      { id: 1, name: "Офис" },
      { id: 2, name: "Мастерская" },
      { id: 3, name: "Детская" },
    ],
    accessories: [
      {
        id: 34,
        roomId: 1,
        name: "Лампа офиса",
        online: true,
        extensionKey: "zigbee",
        deviceId: "device-a",
        deviceWindow: deviceWindowKey,
        services: [
          {
            aId: 34,
            sId: 13,
            name: "Свет",
            type: "Lightbulb",
            characteristics: [
              {
                aId: 34,
                sId: 13,
                cId: 15,
                hasOptions: false,
                control: {
                  name: "On",
                  type: "On",
                  read: true,
                  write: true,
                  events: true,
                  value: { boolValue: false },
                },
              },
              {
                aId: 34,
                sId: 13,
                cId: 16,
                hasOptions: false,
                control: {
                  name: "WiFiPassword",
                  type: "GenericString",
                  read: true,
                  write: false,
                  events: false,
                  value: { stringValue: wifiSecret },
                },
              },
            ],
          },
        ],
      },
      breezerAccessory(),
    ],
    scenarios: [
      {
        index: "office-light",
        name: "Свет в офисе",
        desc: "Вечерний свет",
        type: "BLOCK",
        predefined: false,
        active: true,
        onStart: false,
        sync: false,
        rooms: [1],
        iconsIf: ["light"],
        iconsThen: ["bulb"],
        error: false,
        order: 4,
        optionsWindow: "opaque-scenario-window",
        data: JSON.stringify(officeBlockData()),
      },
    ],
    logics: [
      {
        aId: 34,
        sId: 13,
        type: logicType,
        name: "Плавное изменение яркости",
        active: true,
        optionsWindow: "logic-window",
      },
    ],
    logicTypes: [
      {
        type: logicType,
        name: "Плавное изменение яркости",
        desc: "Плавно меняет яркость",
      },
    ],
    logicOptions: smoothLogicOptions(),
    windows: {
      [deviceWindowKey]: {
        windowKey: deviceWindowKey,
        label: { text: "Настройки лампы" },
        options: deviceWindowOptions(),
      },
      "opaque-scenario-window": {
        windowKey: "opaque-scenario-window",
        label: { text: "Свет в офисе" },
        options: [
          {
            key: "Name",
            name: "Name",
            type: "GenericString",
            inputType: "TEXT",
            read: true,
            write: true,
            value: { stringValue: "Свет в офисе" },
          },
        ],
      },
      "": {
        windowKey: "",
        label: { text: "Настройки хаба" },
        options: [
          {
            key: "Time",
            name: "Time",
            type: "GenericString",
            inputType: "STATUS",
            read: true,
            write: false,
            value: { stringValue: "2026-09-16 - 12:00:00 (GMT+00:00)" },
          },
        ],
      },
    },
    behavior: {
      failNextWindowGet: false,
      failLogicGet: false,
    },
  };
}

async function startHub() {
  const state = createState();
  const requests = [];
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const params = request.params ?? {};
      if (state.behavior.failNextWindowGet && params.window?.get) {
        state.behavior.failNextWindowGet = false;
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32000, message: "window get failed" },
          }),
        );
        return;
      }
      if (state.behavior.failLogicGet && params.logic?.get) {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32000, message: "logic get failed" },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({ id: request.id, result: respond(state, request) }),
      );
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    state,
    requests,
    server,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(state, request) {
  const params = request.params;
  if (params.hub?.list) {
    return {
      hub: {
        list: {
          hubs: [
            {
              serial,
              name: "Офис",
              online: true,
              owner: "owner@example.invalid",
              model: "Sprut.hub 2",
              version: { current: { version: "3.0.0b", revision: "20131" } },
            },
            {
              serial: otherSerial,
              name: "Другой дом",
              online: true,
              owner: "other@example.invalid",
              model: "Sprut.hub 2",
              version: { current: { version: "3.0.0b", revision: "20131" } },
            },
          ],
        },
      },
    };
  }
  if (params.room?.list) return { room: { list: { rooms: state.rooms } } };
  if (params.room?.get) {
    return {
      room: {
        get: state.rooms.find(({ id }) => id === params.room.get.id) ?? null,
      },
    };
  }
  if (params.accessory?.list) {
    return {
      accessory: {
        list: {
          accessories: state.accessories.filter(
            ({ roomId }) =>
              params.accessory.list.roomId === undefined ||
              roomId === params.accessory.list.roomId,
          ),
        },
      },
    };
  }
  if (params.accessory?.get) {
    return {
      accessory: {
        get:
          state.accessories.find(({ id }) => id === params.accessory.get.id) ??
          null,
      },
    };
  }
  if (params.scenario?.list) {
    return { scenario: { list: { scenarios: state.scenarios } } };
  }
  if (params.scenario?.get) {
    return {
      scenario: {
        get:
          state.scenarios.find(
            ({ index }) => index === params.scenario.get.index,
          ) ?? null,
      },
    };
  }
  if (params.logic?.types) {
    return { logic: { types: { logicTypes: state.logicTypes } } };
  }
  if (params.logic?.list) {
    return {
      logic: {
        list: {
          logics: state.logics.filter(
            ({ aId, sId }) =>
              aId === params.logic.list.aId && sId === params.logic.list.sId,
          ),
        },
      },
    };
  }
  if (params.logic?.get) {
    const logic = state.logics.find(
      ({ aId, sId, type }) =>
        aId === params.logic.get.aId &&
        sId === params.logic.get.sId &&
        type === params.logic.get.type,
    );
    return { logic: { get: structuredClone(logic) ?? null } };
  }
  if (params.logic?.getOptions) {
    return { logic: { getOptions: { options: state.logicOptions } } };
  }
  if (params.window?.get) {
    const window = state.windows[params.window.get.windowKey];
    return { window: { get: structuredClone(window) ?? null } };
  }
  if (params.link?.list) return { link: { list: { links: [] } } };
  throw new Error(`unexpected hub request ${JSON.stringify(params)}`);
}

function hubWriteRequests(requests) {
  return requests.filter((request) => {
    const params = request.params ?? {};
    return Object.values(params).some((section) => {
      if (!section || typeof section !== "object") return false;
      return [
        "update",
        "create",
        "delete",
        "run",
        "setOptions",
        "add",
        "remove",
        "backups",
        "prepare",
        "part",
        "complete",
      ].some((method) => Object.hasOwn(section, method));
    });
  });
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-config-point-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function startClient(t, hub, stateDirectory, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "config-point-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "config-point-test-client",
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "config-point-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

function toolResult(result) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function toolError(result) {
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent;
}

function comparisonFor(compared, entityRef) {
  return compared.comparison.entities.find(
    (entity) => entity.entity_ref === entityRef,
  );
}

function changeAt(entity, path) {
  return entity.changes.find(
    (change) => JSON.stringify(change.path) === JSON.stringify(path),
  );
}

function findComparedChange(result, entityRef, path) {
  const candidates = [];
  if (result.comparison) candidates.push(result.comparison);
  const selected = result.selection?.value;
  if (selected && typeof selected === "object") candidates.push(selected);
  for (const candidate of candidates) {
    const entities = Array.isArray(candidate.entities)
      ? candidate.entities
      : candidate.entity_ref
        ? [candidate]
        : [];
    for (const entity of entities) {
      if (entity.entity_ref !== entityRef || !Array.isArray(entity.changes)) {
        continue;
      }
      const change = changeAt(entity, path);
      if (change) return change;
    }
  }
  return null;
}

function nextTowardComparison(result) {
  const parts = result.representation?.available_parts ?? [];
  const comparisonPart = parts.find((part) =>
    (part.pointer ?? "").startsWith("/comparison"),
  );
  if (comparisonPart?.next) return comparisonPart.next;
  if (result.representation?.next) return result.representation.next;
  if (result.selection?.next) return result.selection.next;
  return null;
}

function hubMethodNames(requests) {
  return requests.flatMap((request) =>
    Object.entries(request.params ?? {}).flatMap(([section, body]) =>
      Object.keys(body && typeof body === "object" ? body : {}).map(
        (method) => `${section}.${method}`,
      ),
    ),
  );
}

function findCurrentObservation(result, entityRef) {
  const candidates = [];
  if (result.comparison) candidates.push(result.comparison);
  const selected = result.selection?.value;
  if (selected && typeof selected === "object") candidates.push(selected);
  for (const candidate of candidates) {
    const entities = Array.isArray(candidate.entities)
      ? candidate.entities
      : candidate.entity_ref
        ? [candidate]
        : [];
    for (const entity of entities) {
      if (entity.entity_ref === entityRef && entity.current_observation) {
        return entity.current_observation;
      }
    }
    if (
      (result.selection?.pointer ?? "").endsWith("/current_observation") &&
      Object.hasOwn(candidate, "available") &&
      Object.hasOwn(candidate, "observed_at") &&
      Object.hasOwn(candidate, "source_timestamp")
    ) {
      return candidate;
    }
  }
  return null;
}

async function followCurrentObservation(client, page, entityRef) {
  let current = page;
  for (let step = 0; step < 40; step += 1) {
    const found = findCurrentObservation(current, entityRef);
    if (found) return found;
    const nextCall = nextTowardComparison(current);
    assert.ok(
      nextCall,
      `current observation of ${entityRef} was not addressable`,
    );
    current = toolResult(
      await client.callTool({
        name: nextCall.tool,
        arguments: nextCall.arguments,
      }),
    );
  }
  assert.fail(`current observation of ${entityRef} was not reached`);
}

function comparisonEntitiesListNext(result) {
  const next = result.representation?.next ?? null;
  if (!next) return null;
  assert.equal(next.tool, "get_configuration_point");
  assert.equal(next.arguments.pointer, "/comparison/entities");
  assert.equal(typeof next.arguments.version, "string");
  assert.equal(Number.isInteger(next.arguments.offset), true);
  assert.ok(next.arguments.offset > 0);
  return next;
}

async function followComparisonEntityList(client, firstPage) {
  const parts = [];
  const executedNexts = [];
  let current = firstPage;
  for (let step = 0; step < 40; step += 1) {
    parts.push(...(current.representation?.available_parts ?? []));
    const next = comparisonEntitiesListNext(current);
    if (!next) {
      return { parts, executedNexts };
    }
    executedNexts.push(next);
    current = toolResult(
      await client.callTool({
        name: next.tool,
        arguments: next.arguments,
      }),
    );
  }
  assert.fail("comparison entity list continuation did not complete");
}

async function followComparedChange(client, page, entityRef, path) {
  let current = page;
  for (let step = 0; step < 20; step += 1) {
    const found = findComparedChange(current, entityRef, path);
    if (found) return found;
    const nextCall = nextTowardComparison(current);
    assert.ok(
      nextCall,
      `compared change ${JSON.stringify(path)} was not addressable`,
    );
    current = toolResult(
      await client.callTool({
        name: nextCall.tool,
        arguments: nextCall.arguments,
      }),
    );
  }
  assert.fail(`compared change ${JSON.stringify(path)} was not reached`);
}

function assertNotComparedOption(entity, optionKey, reason) {
  assert.equal(
    entity.changes.some((change) =>
      optionKey ? change.path.includes(optionKey) : false,
    ),
    false,
    JSON.stringify(entity.changes),
  );
  assert.equal(
    entity.not_compared.some(
      (item) =>
        item.reason === reason &&
        (optionKey
          ? JSON.stringify(item.path) === JSON.stringify(["options", optionKey])
          : JSON.stringify(item.path) === JSON.stringify(["options"])),
    ),
    true,
    JSON.stringify(entity.not_compared),
  );
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

test("a later agent finds a saved configuration point and compares real setting changes after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await firstClient.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [
          scenarioRef,
          accessoryRef,
          logicRef,
          deviceWindowRef,
          roomRef,
          homeWindowRef,
          characteristicRef,
        ],
      },
    }),
  );
  assert.equal(saved.status, "ok");
  assert.match(
    saved.point_ref,
    /^spruthub-point:\/\/hub\/config-point-hub\/configuration\/[a-f0-9]{24}$/,
  );
  assert.equal(saved.coverage, "selected_entities");
  assert.equal(saved.house_complete, false);
  assert.ok(Date.parse(saved.capture_started_at));
  assert.ok(Date.parse(saved.capture_finished_at));
  assert.deepEqual(
    saved.captured.map(({ entity_ref, kind }) => ({ entity_ref, kind })),
    [
      { entity_ref: scenarioRef, kind: "scenario" },
      { entity_ref: accessoryRef, kind: "accessory" },
      { entity_ref: logicRef, kind: "logic" },
      { entity_ref: deviceWindowRef, kind: "window" },
    ],
  );
  assert.deepEqual(
    saved.not_captured.map(({ entity_ref, reason }) => ({
      entity_ref,
      reason,
    })),
    [
      { entity_ref: roomRef, reason: "unsupported_entity_kind" },
      { entity_ref: homeWindowRef, reason: "home_settings_window" },
      {
        entity_ref: characteristicRef,
        reason: "unsupported_characteristic_type",
      },
    ],
  );
  assert.deepEqual(saved.next, {
    tool: "get_configuration_point",
    arguments: { point_ref: saved.point_ref },
  });
  await firstClient.close();

  const accessory = hub.state.accessories[0];
  accessory.name = "Лампа кабинета";
  accessory.roomId = 2;
  accessory.online = false;
  accessory.services[0].characteristics[0].control.value = { boolValue: true };
  hub.state.scenarios[0].name = "Свет кабинета";
  hub.state.scenarios[0].error = true;
  hub.state.scenarios[0].rooms = [2];
  hub.state.scenarios[0].iconsIf = ["night"];
  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 5, blockId: 99 }),
  );
  hub.state.logics[0].active = false;
  hub.state.logicOptions = smoothLogicOptions(300);
  hub.state.logicOptions.find(({ key }) => key === "AccessToken").value = {
    stringValue: replacementTokenSecret,
  };
  hub.state.windows[deviceWindowKey].options = deviceWindowOptions(1);

  const secondClient = await startClient(t, hub, stateDirectory);
  const listed = toolResult(
    await secondClient.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef, entity_ref: accessoryRef },
    }),
  );
  assert.equal(listed.points.length, 1);
  assert.equal(listed.points[0].point_ref, saved.point_ref);
  assert.equal(listed.coverage, "selected_entities");

  const past = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  assert.equal(past.entity.kind, "configuration_point");
  assert.equal(past.entity.ref, saved.point_ref);
  assert.equal(past.comparison, undefined);
  const pastAccessory = past.entity.entities.find(
    ({ entity_ref }) => entity_ref === accessoryRef,
  );
  assert.deepEqual(pastAccessory.settings, {
    name: "Лампа офиса",
    room_ref: roomRef,
  });
  assert.equal(
    past.entity.entities.some((entity) =>
      JSON.stringify(entity).includes("online"),
    ),
    false,
  );

  const compared = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  assert.equal(compared.comparison.coverage, "selected_entities");
  assert.equal(compared.comparison.house_complete, false);

  const accessoryDiff = comparisonFor(compared, accessoryRef);
  assert.equal(accessoryDiff.status, "changed");
  assert.deepEqual(changeAt(accessoryDiff, ["name"]), {
    path: ["name"],
    from: "Лампа офиса",
    to: "Лампа кабинета",
  });
  assert.deepEqual(changeAt(accessoryDiff, ["room_ref"]), {
    path: ["room_ref"],
    from: roomRef,
    to: workshopRoomRef,
  });
  assert.equal(
    accessoryDiff.changes.some((change) =>
      JSON.stringify(change.path).includes("online"),
    ),
    false,
  );

  const scenarioDiff = comparisonFor(compared, scenarioRef);
  assert.equal(scenarioDiff.status, "changed");
  assert.deepEqual(changeAt(scenarioDiff, ["name"]), {
    path: ["name"],
    from: "Свет в офисе",
    to: "Свет кабинета",
  });
  assert.deepEqual(
    changeAt(scenarioDiff, [
      "configuration",
      "value",
      "targets",
      0,
      "then_delay",
    ]),
    {
      path: ["configuration", "value", "targets", 0, "then_delay"],
      from: 0,
      to: 5,
    },
  );
  assert.equal(
    scenarioDiff.changes.some((change) =>
      ["error", "rooms", "iconsIf", "blockId", "state"].some((noise) =>
        change.path.includes(noise),
      ),
    ),
    false,
  );

  const logicDiff = comparisonFor(compared, logicRef);
  assert.equal(logicDiff.status, "changed");
  assert.deepEqual(changeAt(logicDiff, ["active"]), {
    path: ["active"],
    from: true,
    to: false,
  });
  assert.deepEqual(
    changeAt(logicDiff, ["options", "Duration", "configured_value"]),
    {
      path: ["options", "Duration", "configured_value"],
      from: 900,
      to: 300,
    },
  );
  assert.equal(
    logicDiff.not_compared.some((item) => item.reason === "redacted"),
    true,
  );
  assert.equal(JSON.stringify(logicDiff).includes("AccessToken"), false);
  assert.equal(
    logicDiff.changes.some((change) => change.path.includes("AccessToken")),
    false,
  );

  const windowDiff = comparisonFor(compared, deviceWindowRef);
  assert.equal(windowDiff.status, "changed");
  assert.deepEqual(
    changeAt(windowDiff, ["options", startupOptionKey, "configured_value"]),
    {
      path: ["options", startupOptionKey, "configured_value"],
      from: 255,
      to: 1,
    },
  );
  assert.equal(
    windowDiff.changes.some((change) => change.path.includes("Reboot")),
    false,
  );

  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("sensitive configuration is redacted before save and hidden values are not treated as equal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [logicRef, deviceWindowRef, accessoryRef],
      },
    }),
  );
  const dumped = JSON.stringify([
    saved,
    toolResult(
      await client.callTool({
        name: "get_configuration_point",
        arguments: { point_ref: saved.point_ref },
      }),
    ),
  ]);
  for (const secret of [
    wifiSecret,
    windowPasswordSecret,
    accessTokenSecret,
    replacementTokenSecret,
  ]) {
    assert.equal(dumped.includes(secret), false, secret);
  }

  const stored = await filesUnder(stateDirectory);
  assert.ok(stored.length > 0);
  for (const file of stored) {
    const text = await readFile(file, "utf8");
    for (const secret of [
      wifiSecret,
      windowPasswordSecret,
      accessTokenSecret,
      replacementTokenSecret,
    ]) {
      assert.equal(text.includes(secret), false, `${file} ${secret}`);
    }
  }
});

test("a broken point, a failed entity read, and another home stay distinct from missing history", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [accessoryRef, logicRef, missingAccessoryRef],
      },
    }),
  );
  assert.equal(
    saved.not_captured.find(
      ({ entity_ref }) => entity_ref === missingAccessoryRef,
    )?.reason,
    "entity_not_found",
  );
  assert.equal(
    saved.captured.some(({ entity_ref }) => entity_ref === accessoryRef),
    true,
  );

  hub.state.behavior.failLogicGet = true;
  const partial = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [accessoryRef, logicRef],
      },
    }),
  );
  assert.equal(
    partial.not_captured.find(({ entity_ref }) => entity_ref === logicRef)
      ?.reason,
    "read_error",
  );
  assert.equal(
    partial.captured.some(({ entity_ref }) => entity_ref === accessoryRef),
    true,
  );

  const otherHome = toolError(
    await client.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: otherHomeRef },
    }),
  );
  assert.equal(otherHome.error.code, "wrong_home");

  const pointDirs = (await readdir(stateDirectory)).filter((name) =>
    name.startsWith("configuration-points-"),
  );
  assert.equal(pointDirs.length, 1);
  const pointDir = path.join(stateDirectory, pointDirs[0]);
  await writeFile(path.join(pointDir, `${"ab".repeat(12)}.json`), "{", {
    mode: 0o600,
  });
  const listed = toolResult(
    await client.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef },
    }),
  );
  assert.equal(
    listed.points.some(({ point_ref }) => point_ref === saved.point_ref),
    true,
  );
  assert.equal(
    listed.unavailable.some(
      ({ reason }) => reason === "corrupt_configuration_point",
    ),
    true,
  );
  const corrupt = toolError(
    await client.callTool({
      name: "get_configuration_point",
      arguments: {
        point_ref: `spruthub-point://hub/${serial}/configuration/${"ab".repeat(12)}`,
      },
    }),
  );
  assert.equal(corrupt.error.code, "corrupt_configuration_point");

  const foreignDir = path.join(
    stateDirectory,
    "configuration-points-ffffffffffffffffffffffff",
  );
  await mkdir(foreignDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(foreignDir, `${"cd".repeat(12)}.json`),
    `${JSON.stringify({
      version: 1,
      id: "cd".repeat(12),
      home_ref: otherHomeRef,
    })}\n`,
    { mode: 0o600 },
  );
  const afterForeign = toolResult(
    await client.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef },
    }),
  );
  assert.equal(
    afterForeign.points.some((point) =>
      point.point_ref.includes("cd".repeat(12)),
    ),
    false,
  );
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("the saved point remains readable after restart without a live hub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await firstClient.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [accessoryRef, logicRef] },
    }),
  );
  await firstClient.close();
  for (const socket of hub.server.clients) socket.terminate();
  await new Promise((resolve) => hub.server.close(resolve));

  const offlineClient = await startClient(t, { url: hub.url }, stateDirectory);
  const listed = toolResult(
    await offlineClient.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef },
    }),
  );
  assert.equal(listed.points[0].point_ref, saved.point_ref);
  const past = toolResult(
    await offlineClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  assert.equal(
    past.entity.entities.find(({ entity_ref }) => entity_ref === accessoryRef)
      .settings.name,
    "Лампа офиса",
  );
  const compareOffline = toolError(
    await offlineClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  assert.equal(
    ["connection_failed", "connection_closed", "timeout"].includes(
      compareOffline.error.code,
    ),
    true,
    compareOffline.error.code,
  );
});

test("a later agent follows get_configuration_point next to a compared change of a large saved point", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 0, targetCount: 250 }),
  );
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [scenarioRef] },
    }),
  );
  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 5, targetCount: 250 }),
  );

  for (const maxBytes of [16_000, 32_768]) {
    const overview = toolResult(
      await client.callTool({
        name: "get_configuration_point",
        arguments: {
          point_ref: saved.point_ref,
          compare: true,
          max_bytes: maxBytes,
        },
      }),
    );
    assert.equal(overview.representation.kind, "entity_overview");
    assert.equal(overview.comparison, undefined);
    assert.deepEqual(
      await followComparedChange(client, overview, scenarioRef, thenDelayPath),
      { path: thenDelayPath, from: 0, to: 5 },
    );
  }
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("a BLOCK kept with or without the web client's if defaults compares unchanged", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  // The web client leaves out if mode, branch delays and else
  // (research/protocol/2026-09-24-web-client-evidence.md); the same BLOCK
  // saved again may hold them written out.
  const interfaceForm = officeBlockData();
  for (const key of ["mode", "then_delay", "else_delay", "else"]) {
    delete interfaceForm.targets[0][key];
  }
  hub.state.scenarios[0].data = JSON.stringify(interfaceForm);
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [scenarioRef] },
    }),
  );
  const compare = async () =>
    comparisonFor(
      toolResult(
        await client.callTool({
          name: "get_configuration_point",
          arguments: { point_ref: saved.point_ref, compare: true },
        }),
      ),
      scenarioRef,
    );

  hub.state.scenarios[0].data = JSON.stringify(officeBlockData({ blockId: 8 }));
  const writtenOut = await compare();
  assert.deepEqual([writtenOut.status, writtenOut.changes], ["unchanged", []]);

  // A point saved before this form was compared as one kept the if as read.
  const pointDir = (await readdir(stateDirectory)).find((name) =>
    name.startsWith("configuration-points-"),
  );
  const pointFile = path.join(
    stateDirectory,
    pointDir,
    `${saved.point_ref.split("/").at(-1)}.json`,
  );
  const point = JSON.parse(await readFile(pointFile, "utf8"));
  const earlierCapture = structuredClone(interfaceForm);
  delete earlierCapture.blockId;
  for (const target of earlierCapture.targets) {
    delete target.blockId;
    delete target.if.blockId;
  }
  point.captured[0].settings.configuration.value = earlierCapture;
  await writeFile(pointFile, `${JSON.stringify(point, null, 2)}\n`);
  const fromEarlierPoint = await compare();
  assert.deepEqual(
    [fromEarlierPoint.status, fromEarlierPoint.changes],
    ["unchanged", []],
  );

  hub.state.scenarios[0].data = JSON.stringify(officeBlockData({ delay: 5 }));
  const realChange = await compare();
  assert.deepEqual(realChange.changes, [
    { path: thenDelayPath, from: 0, to: 5 },
  ]);
});

test("incomplete logic and window options are not compared as added, removed, or equal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const available = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [logicRef, deviceWindowRef],
      },
    }),
  );

  hub.state.windows[deviceWindowKey].options.find(
    ({ key }) => key === "DevicePassword",
  ).value = { stringValue: replacementWindowPasswordSecret };
  const passwordCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: available.point_ref, compare: true },
    }),
  );
  const passwordWindow = comparisonFor(passwordCompared, deviceWindowRef);
  assert.equal(passwordWindow.status, "unchanged");
  assert.equal(passwordWindow.changes.length, 0);
  assertNotComparedOption(passwordWindow, null, "redacted");
  const passwordDump = JSON.stringify(passwordCompared);
  assert.equal(passwordDump.includes("DevicePassword"), false);
  assert.equal(passwordDump.includes(replacementWindowPasswordSecret), false);
  assert.equal(passwordDump.includes(windowPasswordSecret), false);

  hub.state.logicOptions.find(({ key }) => key === "Duration").disabled = true;
  hub.state.windows[deviceWindowKey].options = deviceWindowOptions(7);
  const unavailableCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: available.point_ref, compare: true },
    }),
  );
  assertNotComparedOption(
    comparisonFor(unavailableCompared, logicRef),
    "Duration",
    "disabled",
  );
  assertNotComparedOption(
    comparisonFor(unavailableCompared, deviceWindowRef),
    startupOptionKey,
    "current_value_not_listed",
  );

  const unavailable = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [logicRef, deviceWindowRef],
      },
    }),
  );
  hub.state.logicOptions = smoothLogicOptions(300);
  hub.state.windows[deviceWindowKey].options = deviceWindowOptions(1);
  const restoredCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: unavailable.point_ref, compare: true },
    }),
  );
  assertNotComparedOption(
    comparisonFor(restoredCompared, logicRef),
    "Duration",
    "disabled",
  );
  assertNotComparedOption(
    comparisonFor(restoredCompared, deviceWindowRef),
    startupOptionKey,
    "current_value_not_listed",
  );
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("a later agent recalls saved climate setpoints after telemetry and off-state noise", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await firstClient.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [
          targetTemperatureRef,
          targetModeRef,
          fanSpeedRef,
          currentTemperatureRef,
          currentModeRef,
          characteristicRef,
        ],
      },
    }),
  );
  assert.equal(saved.status, "ok");
  assert.deepEqual(
    saved.captured.map(({ entity_ref, kind }) => ({ entity_ref, kind })),
    [
      { entity_ref: targetTemperatureRef, kind: "characteristic" },
      { entity_ref: targetModeRef, kind: "characteristic" },
      { entity_ref: fanSpeedRef, kind: "characteristic" },
    ],
  );
  assert.deepEqual(
    saved.not_captured.map(({ entity_ref, reason }) => ({
      entity_ref,
      reason,
    })),
    [
      {
        entity_ref: currentTemperatureRef,
        reason: "unsupported_characteristic_type",
      },
      {
        entity_ref: currentModeRef,
        reason: "unsupported_characteristic_type",
      },
      {
        entity_ref: characteristicRef,
        reason: "unsupported_characteristic_type",
      },
    ],
  );
  await firstClient.close();

  characteristicControl(hub.state, currentTemperatureRef).value = {
    doubleValue: 24,
  };
  characteristicControl(hub.state, currentModeRef).value = { intValue: 1 };
  characteristicControl(hub.state, fanSpeedRef).value = { intValue: 60 };
  characteristicControl(hub.state, targetTemperatureRef).name =
    "Целевая температура";
  hub.state.accessories.find(({ id }) => id === 40).online = false;

  const secondClient = await startClient(t, hub, stateDirectory);
  const listed = toolResult(
    await secondClient.callTool({
      name: "list_configuration_points",
      arguments: { home_ref: homeRef, entity_ref: fanSpeedRef },
    }),
  );
  assert.equal(listed.points.length, 1);
  assert.equal(listed.points[0].point_ref, saved.point_ref);
  assert.equal(
    listed.points[0].captured_kinds.includes("characteristic"),
    true,
  );

  const past = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  const pastTemperature = capturedEntity(past, targetTemperatureRef);
  assert.equal(pastTemperature.kind, "characteristic");
  assert.equal(pastTemperature.settings.type, "TargetTemperature");
  assert.equal(pastTemperature.settings.name, "Уставка");
  assert.equal(pastTemperature.settings.value, 26);
  assert.equal(pastTemperature.settings.unit, "°C");
  assert.equal(pastTemperature.settings.available, true);
  assert.equal(pastTemperature.settings.source_timestamp, null);
  assert.ok(Date.parse(pastTemperature.settings.observed_at));
  const pastMode = capturedEntity(past, targetModeRef);
  assert.equal(pastMode.settings.value, 0);
  assert.deepEqual(pastMode.settings.enum, { key: "OFF", name: "Выключено" });
  const pastFan = capturedEntity(past, fanSpeedRef);
  assert.equal(pastFan.settings.value, 30);
  assert.deepEqual(pastFan.settings.enum, { key: "LOW", name: "Медленно" });
  assert.equal(capturedEntity(past, currentTemperatureRef), undefined);
  assert.equal(
    JSON.stringify(past.entity.entities).includes("CurrentTemperature"),
    false,
  );

  const compared = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  const temperatureDiff = comparisonFor(compared, targetTemperatureRef);
  assert.equal(temperatureDiff.status, "unchanged");
  assert.equal(changeAt(temperatureDiff, ["value"]), undefined);
  const modeDiff = comparisonFor(compared, targetModeRef);
  assert.equal(modeDiff.status, "unchanged");
  assert.equal(changeAt(modeDiff, ["value"]), undefined);
  const fanDiff = comparisonFor(compared, fanSpeedRef);
  assert.equal(fanDiff.status, "changed");
  assert.deepEqual(changeAt(fanDiff, ["value"]), {
    path: ["value"],
    from: {
      value: 30,
      enum: { key: "LOW", name: "Медленно" },
      unit: null,
    },
    to: {
      value: 60,
      enum: { key: "MEDIUM", name: "Средне" },
      unit: null,
    },
  });
  assert.equal(comparisonFor(compared, currentTemperatureRef), undefined);
  assert.equal(comparisonFor(compared, currentModeRef), undefined);
  for (const entity of compared.comparison.entities) {
    assert.equal(
      entity.changes.some((change) =>
        ["name", "available", "observed_at", "source_timestamp"].some((noise) =>
          change.path.includes(noise),
        ),
      ),
      false,
      JSON.stringify(entity.changes),
    );
  }

  characteristicControl(hub.state, targetTemperatureRef).value = {
    doubleValue: 22,
  };
  const afterSetpoint = toolResult(
    await secondClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  assert.deepEqual(
    changeAt(comparisonFor(afterSetpoint, targetTemperatureRef), ["value"]),
    {
      path: ["value"],
      from: { value: 26, unit: "°C" },
      to: { value: 22, unit: "°C" },
    },
  );
  assert.equal(comparisonFor(afterSetpoint, targetModeRef).status, "unchanged");
  assert.equal(hubWriteRequests(hub.requests).length, 0);

  await secondClient.close();
  for (const socket of hub.server.clients) socket.terminate();
  await new Promise((resolve) => hub.server.close(resolve));
  const offlineClient = await startClient(t, { url: hub.url }, stateDirectory);
  const offlinePast = toolResult(
    await offlineClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  assert.equal(
    capturedEntity(offlinePast, targetTemperatureRef).settings.value,
    26,
  );
  assert.equal(capturedEntity(offlinePast, targetModeRef).settings.value, 0);
  assert.equal(capturedEntity(offlinePast, fanSpeedRef).settings.value, 30);
  const compareOffline = toolError(
    await offlineClient.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  assert.equal(
    ["connection_failed", "connection_closed", "timeout"].includes(
      compareOffline.error.code,
    ),
    true,
    compareOffline.error.code,
  );
});

test("unsaved climate characteristics and changed setpoint meaning are not compared as numbers", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const accessoryOnly = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [accessoryRef] },
    }),
  );
  characteristicControl(hub.state, targetTemperatureRef).value = {
    doubleValue: 22,
  };
  characteristicControl(hub.state, fanSpeedRef).value = { intValue: 0 };
  const oldPast = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: accessoryOnly.point_ref },
    }),
  );
  assert.equal(oldPast.entity.entities.length, 1);
  assert.equal(oldPast.entity.entities[0].kind, "accessory");
  assert.equal(capturedEntity(oldPast, targetTemperatureRef), undefined);
  assert.equal(JSON.stringify(oldPast).includes("TargetTemperature"), false);
  const oldCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: accessoryOnly.point_ref, compare: true },
    }),
  );
  assert.equal(oldCompared.comparison.entities.length, 1);
  assert.equal(
    oldCompared.comparison.entities.some(
      (entity) => entity.kind === "characteristic",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(oldCompared.comparison).includes('"from":0'),
    false,
  );
  assert.equal(
    JSON.stringify(oldCompared.comparison).includes('"from":22'),
    false,
  );

  characteristicControl(hub.state, fanSpeedRef).value = { intValue: 30 };
  const fanSaved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [fanSpeedRef] },
    }),
  );
  assert.deepEqual(
    fanSaved.captured.map(({ entity_ref, kind }) => ({ entity_ref, kind })),
    [{ entity_ref: fanSpeedRef, kind: "characteristic" }],
  );
  const fanControl = characteristicControl(hub.state, fanSpeedRef);
  fanControl.validValues[0].key = "QUIET";
  fanControl.validValues[0].name = "Тихо";
  const remapped = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: fanSaved.point_ref, compare: true },
    }),
  );
  const remappedFan = comparisonFor(remapped, fanSpeedRef);
  assert.equal(remappedFan.status, "unchanged");
  assert.equal(remappedFan.changes.length, 0);
  assert.deepEqual(remappedFan.not_compared, [
    { path: ["value"], reason: "incomparable_semantics" },
  ]);

  const temperatureSaved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: [targetTemperatureRef] },
    }),
  );
  assert.deepEqual(
    temperatureSaved.captured.map(({ entity_ref, kind }) => ({
      entity_ref,
      kind,
    })),
    [{ entity_ref: targetTemperatureRef, kind: "characteristic" }],
  );
  characteristicControl(hub.state, targetTemperatureRef).type =
    "CurrentTemperature";
  const retyped = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: temperatureSaved.point_ref, compare: true },
    }),
  );
  const retypedTemperature = comparisonFor(retyped, targetTemperatureRef);
  assert.equal(retypedTemperature.status, "unchanged");
  assert.equal(retypedTemperature.changes.length, 0);
  assert.deepEqual(retypedTemperature.not_compared, [
    { path: ["value"], reason: "incomparable_semantics" },
  ]);
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("a later agent sees current climate availability of an unchanged saved setpoint without another get_entity", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [targetTemperatureRef, targetModeRef, fanSpeedRef],
      },
    }),
  );
  assert.equal(saved.status, "ok");
  const past = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref },
    }),
  );
  const pastTemperature = capturedEntity(past, targetTemperatureRef);
  assert.equal(pastTemperature.settings.available, true);
  assert.equal(pastTemperature.settings.value, 26);
  assert.equal(pastTemperature.settings.source_timestamp, null);
  const pastObservedAt = pastTemperature.settings.observed_at;

  const beforeOnline = hub.requests.length;
  const onlineCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  const onlineMethods = hubMethodNames(hub.requests.slice(beforeOnline));
  assert.equal(
    onlineMethods.every((method) =>
      ["hub.list", "accessory.get"].includes(method),
    ),
    true,
    JSON.stringify(onlineMethods),
  );
  const onlineTemperature = comparisonFor(onlineCompared, targetTemperatureRef);
  assert.equal(onlineTemperature.status, "unchanged");
  assert.equal(changeAt(onlineTemperature, ["value"]), undefined);
  assert.equal(
    onlineTemperature.current_observation?.available,
    true,
    JSON.stringify(onlineTemperature),
  );
  assert.equal(onlineTemperature.current_observation.source_timestamp, null);
  assert.ok(Date.parse(onlineTemperature.current_observation.observed_at));
  assert.notEqual(
    onlineTemperature.current_observation.observed_at,
    pastObservedAt,
  );

  hub.state.accessories.find(({ id }) => id === 40).online = false;
  const liveOffline = toolResult(
    await client.callTool({
      name: "get_entity",
      arguments: { entity_ref: targetTemperatureRef },
    }),
  );
  assert.equal(liveOffline.entity.available, false);
  assert.equal(liveOffline.entity.current_value.source_timestamp, null);

  const beforeOffline = hub.requests.length;
  const offlineCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  const offlineMethods = hubMethodNames(hub.requests.slice(beforeOffline));
  assert.equal(
    offlineMethods.every((method) =>
      ["hub.list", "accessory.get"].includes(method),
    ),
    true,
    JSON.stringify(offlineMethods),
  );
  const offlineTemperature = comparisonFor(
    offlineCompared,
    targetTemperatureRef,
  );
  assert.equal(offlineTemperature.status, "unchanged");
  assert.equal(changeAt(offlineTemperature, ["value"]), undefined);
  assert.equal(
    offlineTemperature.current_observation?.available,
    liveOffline.entity.available,
    JSON.stringify(offlineTemperature),
  );
  assert.notEqual(
    offlineTemperature.current_observation.available,
    onlineTemperature.current_observation.available,
  );
  assert.equal(
    offlineTemperature.current_observation.source_timestamp,
    liveOffline.entity.current_value.source_timestamp,
  );
  assert.equal(
    Number.isFinite(
      Date.parse(offlineTemperature.current_observation.source_timestamp),
    ),
    false,
  );
  assert.ok(Date.parse(offlineTemperature.current_observation.observed_at));
  assert.notEqual(
    offlineTemperature.current_observation.observed_at,
    pastObservedAt,
  );
  const pastOfflineTemperature = capturedEntity(
    offlineCompared,
    targetTemperatureRef,
  );
  assert.equal(pastOfflineTemperature.settings.available, true);
  assert.equal(pastOfflineTemperature.settings.value, 26);
  assert.equal(
    offlineTemperature.changes.some((change) =>
      ["available", "observed_at", "source_timestamp"].some((noise) =>
        change.path.includes(noise),
      ),
    ),
    false,
  );

  characteristicControl(hub.state, fanSpeedRef).value = { intValue: 60 };
  const changedCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  const changedFan = comparisonFor(changedCompared, fanSpeedRef);
  assert.equal(changedFan.status, "changed");
  assert.deepEqual(changeAt(changedFan, ["value"]), {
    path: ["value"],
    from: {
      value: 30,
      enum: { key: "LOW", name: "Медленно" },
      unit: null,
    },
    to: {
      value: 60,
      enum: { key: "MEDIUM", name: "Средне" },
      unit: null,
    },
  });
  assert.equal(changedFan.current_observation?.available, false);
  assert.equal(changedFan.current_observation.source_timestamp, null);
  assert.ok(Date.parse(changedFan.current_observation.observed_at));
  assert.equal(capturedEntity(changedCompared, fanSpeedRef).settings.value, 30);
  assert.equal(
    capturedEntity(changedCompared, fanSpeedRef).settings.available,
    true,
  );

  characteristicControl(hub.state, fanSpeedRef).value = { intValue: 30 };
  const fanControl = characteristicControl(hub.state, fanSpeedRef);
  fanControl.validValues[0].key = "QUIET";
  fanControl.validValues[0].name = "Тихо";
  const remapped = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  const remappedFan = comparisonFor(remapped, fanSpeedRef);
  assert.equal(remappedFan.status, "unchanged");
  assert.deepEqual(remappedFan.not_compared, [
    { path: ["value"], reason: "incomparable_semantics" },
  ]);
  assert.equal(remappedFan.current_observation?.available, false);
  assert.equal(remappedFan.current_observation.source_timestamp, null);
  assert.ok(Date.parse(remappedFan.current_observation.observed_at));

  hub.state.scenarios[0].data = JSON.stringify(
    officeBlockData({ delay: 0, targetCount: 250 }),
  );
  const largeSaved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: {
        home_ref: homeRef,
        entity_refs: [scenarioRef, targetTemperatureRef],
      },
    }),
  );
  const overview = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: {
        point_ref: largeSaved.point_ref,
        compare: true,
        max_bytes: 16_000,
      },
    }),
  );
  assert.equal(overview.representation.kind, "entity_overview");
  assert.equal(overview.comparison, undefined);
  const addressed = await followCurrentObservation(
    client,
    overview,
    targetTemperatureRef,
  );
  assert.equal(addressed.available, false);
  assert.equal(addressed.source_timestamp, null);
  assert.ok(Date.parse(addressed.observed_at));

  hub.state.accessories = hub.state.accessories.filter(({ id }) => id !== 40);
  const missingCompared = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: { point_ref: saved.point_ref, compare: true },
    }),
  );
  const missingTemperature = comparisonFor(
    missingCompared,
    targetTemperatureRef,
  );
  assert.equal(missingTemperature.status, "missing");
  assert.equal(missingTemperature.current_observation, undefined);
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});

test("a later agent pages mixed comparison entities by returned offset while observation time changes", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const mixedRefs = [
    scenarioRef,
    accessoryRef,
    logicRef,
    deviceWindowRef,
    breezerAccessoryRef,
    targetTemperatureRef,
    targetModeRef,
    fanSpeedRef,
  ];
  const saved = toolResult(
    await client.callTool({
      name: "save_configuration_point",
      arguments: { home_ref: homeRef, entity_refs: mixedRefs },
    }),
  );
  assert.equal(saved.status, "ok");
  assert.deepEqual(
    saved.captured.map(({ entity_ref }) => entity_ref),
    mixedRefs,
  );

  characteristicControl(hub.state, targetTemperatureRef).value = {
    doubleValue: 22,
  };
  characteristicControl(hub.state, targetModeRef).value = { intValue: 1 };
  characteristicControl(hub.state, fanSpeedRef).value = { intValue: 90 };

  const listArguments = {
    point_ref: saved.point_ref,
    compare: true,
    max_bytes: 2048,
    pointer: "/comparison/entities",
  };
  const first = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: listArguments,
    }),
  );
  assert.equal(first.representation.kind, "selected_value");
  assert.equal(first.representation.selected_pointer, "/comparison/entities");
  const firstListNext = comparisonEntitiesListNext(first);
  assert.ok(
    firstListNext,
    "comparison.entities must not fit into 2048 so offset continuation is required",
  );

  const { parts, executedNexts } = await followComparisonEntityList(
    client,
    first,
  );
  assert.ok(executedNexts.length >= 1);
  assert.equal(
    executedNexts.every(
      (next) => next.arguments.pointer === "/comparison/entities",
    ),
    true,
  );
  assert.equal(parts.length, mixedRefs.length);
  assert.deepEqual(
    parts.map((part) => part.identity?.entity_ref),
    mixedRefs,
  );

  const loaded = [];
  for (const part of parts) {
    const childPointer = part.next?.arguments.pointer ?? "";
    assert.equal(
      childPointer.startsWith("/comparison/entities/"),
      true,
      childPointer,
    );
    assert.notEqual(childPointer, "/comparison/entities");
    loaded.push(
      toolResult(
        await client.callTool({
          name: part.next.tool,
          arguments: part.next.arguments,
        }),
      ).selection.value,
    );
  }
  assert.deepEqual(
    loaded.map((entity) => entity.entity_ref),
    mixedRefs,
  );
  const climateObservations = {};
  for (const climateRef of [targetTemperatureRef, targetModeRef, fanSpeedRef]) {
    const entity = loaded.find(({ entity_ref }) => entity_ref === climateRef);
    assert.ok(entity.current_observation, JSON.stringify(entity));
    assert.ok(Date.parse(entity.current_observation.observed_at));
    climateObservations[climateRef] = entity.current_observation.observed_at;
  }
  const temperatureDiff = comparisonFor(
    { comparison: { entities: loaded } },
    targetTemperatureRef,
  );
  assert.equal(temperatureDiff.status, "changed");
  assert.deepEqual(changeAt(temperatureDiff, ["value"]), {
    path: ["value"],
    from: { value: 26, unit: "°C" },
    to: { value: 22, unit: "°C" },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  const climatePart = parts.find(
    (part) => part.identity.entity_ref === targetTemperatureRef,
  );
  const rereadClimate = toolResult(
    await client.callTool({
      name: climatePart.next.tool,
      arguments: climatePart.next.arguments,
    }),
  );
  assert.ok(
    Date.parse(rereadClimate.selection.value.current_observation.observed_at),
  );
  assert.notEqual(
    rereadClimate.selection.value.current_observation.observed_at,
    climateObservations[targetTemperatureRef],
  );

  const afterObservation = toolResult(
    await client.callTool({
      name: "get_configuration_point",
      arguments: listArguments,
    }),
  );
  const afterNext = comparisonEntitiesListNext(afterObservation);
  assert.equal(afterNext.arguments.version, firstListNext.arguments.version);
  const afterContinued = toolResult(
    await client.callTool({
      name: firstListNext.tool,
      arguments: firstListNext.arguments,
    }),
  );
  assert.equal(afterContinued.representation.available_parts.length > 0, true);

  const uniqueItems = Array.from({ length: 24 }, (_, index) => ({
    entity_ref: `${homeRef}/accessory/${index + 100}`,
    marker: `unique-${index}-${"x".repeat(80)}`,
  }));
  hub.state.scenarios.push({
    index: "entity-ref-identity",
    name: "Карта entity_ref",
    type: "BLOCK",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: JSON.stringify({ items: uniqueItems }),
  });
  const identityRef = `${homeRef}/scenario/entity-ref-identity`;
  const identityArguments = {
    entity_ref: identityRef,
    include: ["configuration"],
    pointer: "/configuration/value/items",
    max_bytes: 2048,
  };
  const identityFirst = toolResult(
    await client.callTool({
      name: "get_entity",
      arguments: identityArguments,
    }),
  );
  const identityNext = identityFirst.representation.next;
  assert.ok(identityNext?.arguments.version);
  [uniqueItems[0], uniqueItems[1]] = [uniqueItems[1], uniqueItems[0]];
  hub.state.scenarios.find(
    ({ index }) => index === "entity-ref-identity",
  ).data = JSON.stringify({ items: uniqueItems });
  const reordered = await client.callTool({
    name: identityNext.tool,
    arguments: identityNext.arguments,
  });
  assert.equal(reordered.isError, true);
  assert.equal(reordered.structuredContent.error.code, "stale_entity_content");

  [uniqueItems[0], uniqueItems[1]] = [uniqueItems[1], uniqueItems[0]];
  hub.state.scenarios.find(
    ({ index }) => index === "entity-ref-identity",
  ).data = JSON.stringify({ items: uniqueItems });
  const beforeValueChange = toolResult(
    await client.callTool({
      name: "get_entity",
      arguments: identityArguments,
    }),
  );
  const valueNext = beforeValueChange.representation.next;
  assert.ok(valueNext?.arguments.version);
  uniqueItems[10].marker = `changed-${"y".repeat(80)}`;
  hub.state.scenarios.find(
    ({ index }) => index === "entity-ref-identity",
  ).data = JSON.stringify({ items: uniqueItems });
  const valueChanged = toolResult(
    await client.callTool({
      name: valueNext.tool,
      arguments: valueNext.arguments,
    }),
  );
  assert.equal(valueChanged.representation.available_parts.length > 0, true);

  const duplicates = Array.from({ length: 24 }, (_, index) => ({
    entity_ref: `${homeRef}/accessory/1`,
    marker: `dup-${index}-${"z".repeat(80)}`,
  }));
  hub.state.scenarios.find(
    ({ index }) => index === "entity-ref-identity",
  ).data = JSON.stringify({ items: duplicates });
  const beforeAmbiguous = toolResult(
    await client.callTool({
      name: "get_entity",
      arguments: identityArguments,
    }),
  );
  const ambiguousNext = beforeAmbiguous.representation.next;
  assert.ok(ambiguousNext?.arguments.version);
  duplicates[10].marker = `new-dup-${"q".repeat(80)}`;
  hub.state.scenarios.find(
    ({ index }) => index === "entity-ref-identity",
  ).data = JSON.stringify({ items: duplicates });
  const ambiguousChanged = await client.callTool({
    name: ambiguousNext.tool,
    arguments: ambiguousNext.arguments,
  });
  assert.equal(ambiguousChanged.isError, true);
  assert.equal(
    ambiguousChanged.structuredContent.error.code,
    "stale_entity_content",
  );
  assert.equal(hubWriteRequests(hub.requests).length, 0);
});
