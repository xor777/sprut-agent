import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "native-change-test-hub";
const homeRef = `spruthub://hub/${serial}`;
const accessoryRef = `${homeRef}/accessory/34`;
const workshopRoomRef = `${homeRef}/room/2`;
const characteristicRef = `spruthub://hub/${serial}/accessory/34/service/13/characteristic/15`;
const serviceRef = `spruthub://hub/${serial}/accessory/34/service/13`;
const smoothLogicType = "SmoothBrightnessChange";
const smoothLogicRef = `${serviceRef}/logic/${smoothLogicType}`;
const scenarioRef = `spruthub://hub/${serial}/scenario/existing-block`;
const scenarioSdk =
  "interface Characteristic { getValue(): any; setValue(value: any): void; }";
const firstLogicSource = `info = {
  name: "Bedside start level",
  description: "Set the initial brightness once",
  version: "1.0",
  author: "sprut-agent",
  onStart: false,
  sourceServices: [HS.Lightbulb],
  sourceCharacteristics: [HC.On],
  options: [],
  variables: { wasOn: false }
};

function trigger(source, value, variables, options, context) {
  if (value === true && variables.wasOn === false) {
    source.getService().getCharacteristic(HC.Brightness).setValue(15);
  }
  variables.wasOn = value === true;
}`;
const secondLogicSource = firstLogicSource.replace(
  "variables.wasOn === false",
  "!variables.wasOn",
);
const deviceWindowRef = `${homeRef}/window/Controller%2Fzigbee_demo%2FChild%2FDEVICE_A%2F`;
const startupOptionKey = "/11/0006_OnOff/4003_StartUpOnOff/255";
const smoothOptionKeys = {
  start: "StartValue",
  end: "EndValue",
  duration: "Duration",
};

function smoothLogicOptions() {
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
      key: smoothOptionKeys.start,
      name: "Начальная яркость",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 1 },
    },
    {
      key: smoothOptionKeys.end,
      name: "Конечная яркость",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 100 },
    },
    {
      key: smoothOptionKeys.duration,
      name: "Продолжительность",
      type: "GenericInteger",
      inputType: "NUMBER",
      read: true,
      write: true,
      disabled: false,
      value: { intValue: 900 },
    },
  ];
}

function logicOptionsKey(aId, sId, type) {
  return `${aId}:${sId}:${type}`;
}

function configuredSmoothLogicOptions(state) {
  return state.logicOptions[logicOptionsKey(34, 13, smoothLogicType)];
}

function assignedSmoothLogic({ active = false } = {}) {
  return {
    aId: 34,
    sId: 13,
    type: smoothLogicType,
    name: "Плавное изменение яркости",
    active,
    optionsWindow: `Logic/${smoothLogicType}/34/13`,
  };
}

function setAction({
  aId = 34,
  sId = 13,
  cId = 15,
  hc = "On",
  value = "true",
} = {}) {
  return {
    type: "service",
    aId,
    sId,
    hs: "Lightbulb",
    characteristics: [{ type: "set", cId, hc, value }],
  };
}

function characteristicCondition({
  aId = 32,
  sId = 13,
  cId = 15,
  trigger = true,
} = {}) {
  return {
    type: "characteristic",
    aId,
    sId,
    cId,
    hs: "MotionSensor",
    hc: "MotionDetected",
    trigger,
    cond: "=",
    value: "true",
    timeCond: "",
    time: 0,
  };
}

function blockData({ delay = 60_000, nested = false } = {}) {
  const delayedOff = {
    type: "delay",
    index: 1,
    mode: "RESET",
    time: delay,
    targets: [setAction({ value: "false" })],
  };
  return {
    vendorConfiguration: { preserved: true },
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: nested ? "OR" : "AND",
          conditions: [
            characteristicCondition(),
            ...(nested
              ? [
                  {
                    type: "condition",
                    mode: "AND",
                    conditions: [characteristicCondition({ trigger: false })],
                  },
                ]
              : []),
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [setAction(), delayedOff],
        else: nested ? [setAction({ value: "false" })] : [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

function withRuntimeBlockFields(data) {
  let nextBlockId = 1;
  const childFields = {
    root: ["targets"],
    if: ["if", "then", "else"],
    condition: ["conditions"],
    service: ["characteristics"],
    delay: ["targets"],
  };
  const visit = (value, kind) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return structuredClone(value);
    const normalized = structuredClone(value);
    if (kind !== "root") {
      normalized.blockId = nextBlockId++;
      if (kind === "if") normalized.state = false;
    }
    for (const key of childFields[kind] ?? []) {
      normalized[key] = Array.isArray(value[key])
        ? value[key].map((child) => visit(child, child?.type))
        : visit(value[key], value[key]?.type);
    }
    return normalized;
  };
  return visit(data, "root");
}

async function startHub() {
  const requests = [];
  const state = {
    rooms: [
      { id: 1, order: 1, name: "Офис", visible: true },
      { id: 2, order: 2, name: "Мастерская", visible: true },
    ],
    characteristic: {
      aId: 34,
      sId: 13,
      cId: 15,
      control: {
        name: "Включена",
        type: "On",
        read: true,
        write: true,
        value: { boolValue: false },
      },
    },
    accessories: [
      {
        id: 32,
        roomId: 1,
        name: "Датчик",
        online: true,
        services: [
          {
            aId: 32,
            sId: 13,
            name: "Движение",
            type: "MotionSensor",
            characteristics: [
              {
                aId: 32,
                sId: 13,
                cId: 15,
                control: {
                  name: "Движение",
                  type: "MotionDetected",
                  read: true,
                  write: false,
                  value: { boolValue: false },
                },
              },
            ],
          },
        ],
      },
      {
        id: 34,
        roomId: 1,
        name: "Лампа",
        online: true,
        extensionKey: "zigbee_demo",
        deviceId: "DEVICE_A",
        services: [
          {
            aId: 34,
            sId: 13,
            name: "Свет",
            type: "Lightbulb",
            characteristics: [],
          },
        ],
      },
      {
        id: 35,
        roomId: 1,
        name: "Подсветка той же лампы",
        online: true,
        extensionKey: "zigbee_demo",
        deviceId: "DEVICE_A",
        services: [],
      },
    ],
    scenarios: [
      {
        index: "existing-block",
        name: "Существующий BLOCK",
        desc: "Ручная конфигурация",
        active: false,
        onStart: false,
        sync: false,
        type: "BLOCK",
        data: JSON.stringify(blockData()),
        vendorTopLevel: "preserve-me",
      },
    ],
    window: {
      windowKey: "Controller/zigbee_demo/Child/DEVICE_A/",
      label: { text: "Настройки лампы" },
      options: [
        {
          key: startupOptionKey,
          name: "После восстановления питания",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 255 },
          validValues: [
            { name: "Выключена", value: { intValue: 0 }, checked: true },
            { name: "Включена", value: { intValue: 1 }, checked: true },
            {
              name: "Предыдущее состояние",
              value: { intValue: 255 },
              checked: true,
            },
          ],
        },
        {
          key: "/11/0008_Level/4000_Transition/0",
          name: "Плавность включения",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 1 },
          validValues: [
            { name: "Сразу", value: { intValue: 0 } },
            { name: "Плавно", value: { intValue: 1 } },
          ],
        },
      ],
    },
    logicTypes: [
      {
        type: smoothLogicType,
        name: "Плавное изменение яркости",
        desc: "Плавно меняет яркость при включении света",
      },
    ],
    logics: [],
    logicOptions: {
      [logicOptionsKey(34, 13, smoothLogicType)]: smoothLogicOptions(),
    },
    scenarioLogicTypes: {},
    nextScenario: 1,
    behavior: {
      closeAfterCreate: false,
      rejectNextScenarioCreate: false,
      closeAfterCharacteristicUpdate: false,
      closeAfterWindowUpdate: false,
      dropNextWindowUpdate: false,
      holdNextWindowUpdate: false,
      failNextCharacteristicGet: false,
      failNextWindowGet: false,
      failWindowGetAfterUpdate: false,
      failNextScenarioGet: false,
      rejectNextWindowUpdate: false,
      ignoreNextUpdate: false,
      invalidNextScenarioList: false,
      missingScenarioGetAsNotFoundError: false,
      rejectScenarioGetAsInternalError: false,
      closeAfterLogicCreate: false,
      closeAfterLogicSetOptions: false,
      failNextLogicList: false,
      closeAfterAccessoryUpdate: false,
      closeAfterRoomCreate: false,
      dropNextAccessoryUpdate: false,
      failAccessoryGetAfterUpdate: false,
      failNextAccessoryGet: false,
      invalidNextRoomList: false,
      missingRoomGetAsNotFoundError: false,
      normalizeNextAccessoryName: false,
      rejectNextRoomGetAsInternalError: false,
    },
  };
  state.accessories[1].services[0].characteristics.push(state.characteristic);
  state.accessories[1].services[0].characteristics.push(
    {
      aId: 34,
      sId: 13,
      cId: 16,
      control: {
        name: "Яркость",
        type: "Brightness",
        read: true,
        write: true,
        minValue: 0,
        maxValue: 100,
        minStep: 1,
        value: { intValue: 20 },
      },
    },
    {
      aId: 34,
      sId: 13,
      cId: 17,
      control: {
        name: "Только чтение",
        type: "StatusActive",
        read: true,
        write: false,
        value: { boolValue: true },
      },
    },
    {
      aId: 34,
      sId: 13,
      cId: 18,
      control: {
        name: "Режим",
        type: "TargetMode",
        read: true,
        write: true,
        value: { stringValue: "home" },
        validValues: [
          {
            key: "home",
            name: "Дома",
            value: { stringValue: "home" },
          },
          {
            key: "away",
            name: "Вне дома",
            value: { stringValue: "away" },
          },
        ],
      },
    },
  );
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(structuredClone(request.params));
      const params = request.params;
      if (
        (params.characteristic?.get &&
          state.behavior.failNextCharacteristicGet) ||
        (params.accessory?.get && state.behavior.failNextAccessoryGet) ||
        (params.window?.get && state.behavior.failNextWindowGet) ||
        (params.scenario?.get && state.behavior.failNextScenarioGet) ||
        (params.logic?.list && state.behavior.failNextLogicList)
      ) {
        state.behavior.failNextCharacteristicGet = false;
        state.behavior.failNextAccessoryGet = false;
        state.behavior.failNextWindowGet = false;
        state.behavior.failNextScenarioGet = false;
        state.behavior.failNextLogicList = false;
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: 500, message: "temporary read failure" },
          }),
        );
        return;
      }
      let result;
      if (params.hub?.list) {
        result = {
          hub: {
            list: {
              hubs: [{ serial, name: "Тестовый дом", online: true }],
            },
          },
        };
      } else if (params.room?.list) {
        if (state.behavior.invalidNextRoomList) {
          state.behavior.invalidNextRoomList = false;
          result = { room: { list: { rooms: {} } } };
        } else {
          result = { room: { list: { rooms: structuredClone(state.rooms) } } };
        }
      } else if (params.room?.get) {
        const room = state.rooms.find(({ id }) => id === params.room.get.id);
        if (
          state.behavior.rejectNextRoomGetAsInternalError ||
          (!room && state.behavior.missingRoomGetAsNotFoundError)
        ) {
          state.behavior.rejectNextRoomGetAsInternalError = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32603,
                message: "Not found: 'Комната уже не существует'",
              },
            }),
          );
          return;
        }
        result = {
          room: {
            get: structuredClone(room) ?? null,
          },
        };
      } else if (params.room?.create) {
        const room = {
          id: Math.max(...state.rooms.map(({ id }) => id), 0) + 1,
          order: state.rooms.length + 1,
          name: params.room.create.name,
          visible: true,
        };
        state.rooms.push(room);
        if (state.behavior.closeAfterRoomCreate) {
          state.behavior.closeAfterRoomCreate = false;
          socket.close();
          return;
        }
        result = { room: { create: structuredClone(room) } };
      } else if (params.room?.delete) {
        const roomIndex = state.rooms.findIndex(
          ({ id }) => id === params.room.delete.id,
        );
        if (roomIndex >= 0) state.rooms.splice(roomIndex, 1);
        result = { room: { delete: {} } };
      } else if (params.characteristic?.get) {
        const selected = state.accessories
          .find(({ id }) => id === params.characteristic.get.aId)
          ?.services.find(({ sId }) => sId === params.characteristic.get.sId)
          ?.characteristics.find(
            ({ cId }) => cId === params.characteristic.get.cId,
          );
        result = {
          characteristic: { get: structuredClone(selected) ?? null },
        };
      } else if (params.window?.get) {
        result = { window: { get: structuredClone(state.window) } };
      } else if (params.window?.update) {
        if (state.behavior.rejectNextWindowUpdate) {
          state.behavior.rejectNextWindowUpdate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "window update rejected" },
            }),
          );
          return;
        }
        if (!state.behavior.dropNextWindowUpdate) {
          for (const update of params.window.update.options) {
            const option = state.window.options.find(
              ({ key }) => key === update.key,
            );
            if (option) option.value = structuredClone(update.value);
          }
        }
        state.behavior.dropNextWindowUpdate = false;
        if (state.behavior.holdNextWindowUpdate) {
          state.behavior.holdNextWindowUpdate = false;
          return;
        }
        if (state.behavior.failWindowGetAfterUpdate) {
          state.behavior.failWindowGetAfterUpdate = false;
          state.behavior.failNextWindowGet = true;
        }
        if (state.behavior.closeAfterWindowUpdate) {
          state.behavior.closeAfterWindowUpdate = false;
          socket.close();
          return;
        }
        result = { window: { update: {} } };
      } else if (params.characteristic?.update) {
        state.characteristic.control.value = structuredClone(
          params.characteristic.update.control.value,
        );
        if (state.behavior.closeAfterCharacteristicUpdate) {
          state.behavior.closeAfterCharacteristicUpdate = false;
          socket.close();
          return;
        }
        result = { characteristic: { update: {} } };
      } else if (params.logic?.types) {
        result = {
          logic: { types: { logicTypes: structuredClone(state.logicTypes) } },
        };
      } else if (params.logic?.list) {
        result = {
          logic: {
            list: {
              logics: state.logics
                .filter(
                  ({ aId, sId }) =>
                    aId === params.logic.list.aId &&
                    sId === params.logic.list.sId,
                )
                .map((logic) => structuredClone(logic)),
            },
          },
        };
      } else if (params.logic?.get) {
        const logic = state.logics.find(
          ({ aId, sId, type }) =>
            aId === params.logic.get.aId &&
            sId === params.logic.get.sId &&
            type === params.logic.get.type,
        );
        if (!logic) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32603, message: "Not found" },
            }),
          );
          return;
        }
        result = { logic: { get: structuredClone(logic) } };
      } else if (params.logic?.getOptions) {
        const logic = state.logics.find(
          ({ aId, sId, type }) =>
            aId === params.logic.getOptions.aId &&
            sId === params.logic.getOptions.sId &&
            type === params.logic.getOptions.type,
        );
        if (!logic) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: -32603, message: "Not found" },
            }),
          );
          return;
        }
        result = {
          logic: {
            getOptions: {
              options: structuredClone(
                state.logicOptions[
                  logicOptionsKey(logic.aId, logic.sId, logic.type)
                ],
              ),
            },
          },
        };
      } else if (params.logic?.create) {
        const created = {
          ...structuredClone(params.logic.create),
          active: false,
          optionsWindow: `Logic/${params.logic.create.type}/34/13`,
        };
        state.logics.push(created);
        if (state.behavior.closeAfterLogicCreate) {
          state.behavior.closeAfterLogicCreate = false;
          socket.close();
          return;
        }
        result = { logic: { create: structuredClone(created) } };
      } else if (params.logic?.setOptions) {
        const options =
          state.logicOptions[
            logicOptionsKey(
              params.logic.setOptions.aId,
              params.logic.setOptions.sId,
              params.logic.setOptions.type,
            )
          ];
        for (const update of params.logic.setOptions.options) {
          const option = options.find(({ key }) => key === update.key);
          if (option) option.value = structuredClone(update.value);
        }
        if (state.behavior.closeAfterLogicSetOptions) {
          state.behavior.closeAfterLogicSetOptions = false;
          socket.close();
          return;
        }
        result = { logic: { setOptions: {} } };
      } else if (params.logic?.update) {
        const logic = state.logics.find(
          ({ aId, sId, type }) =>
            aId === params.logic.update.aId &&
            sId === params.logic.update.sId &&
            type === params.logic.update.type,
        );
        if (logic) logic.active = params.logic.update.active;
        result = { logic: { update: {} } };
      } else if (params.logic?.delete) {
        const index = state.logics.findIndex(
          ({ aId, sId, type }) =>
            aId === params.logic.delete.aId &&
            sId === params.logic.delete.sId &&
            type === params.logic.delete.type,
        );
        if (index >= 0) state.logics.splice(index, 1);
        result = { logic: { delete: {} } };
      } else if (params.accessory?.get) {
        result = {
          accessory: {
            get:
              structuredClone(
                state.accessories.find(
                  ({ id }) => id === params.accessory.get.id,
                ),
              ) ?? null,
          },
        };
      } else if (params.accessory?.list) {
        result = {
          accessory: {
            list: {
              accessories: state.accessories
                .filter(
                  ({ roomId }) =>
                    params.accessory.list.roomId === undefined ||
                    roomId === params.accessory.list.roomId,
                )
                .map((accessory) => structuredClone(accessory)),
            },
          },
        };
      } else if (params.accessory?.update) {
        const accessory = state.accessories.find(
          ({ id }) => id === params.accessory.update.id,
        );
        if (accessory && !state.behavior.dropNextAccessoryUpdate) {
          accessory.name = state.behavior.normalizeNextAccessoryName
            ? params.accessory.update.name.replace(/\s*·\s*/g, " ")
            : params.accessory.update.name;
          accessory.roomId = params.accessory.update.roomId;
        }
        state.behavior.dropNextAccessoryUpdate = false;
        state.behavior.normalizeNextAccessoryName = false;
        if (state.behavior.failAccessoryGetAfterUpdate) {
          state.behavior.failAccessoryGetAfterUpdate = false;
          state.behavior.failNextAccessoryGet = true;
        }
        if (state.behavior.closeAfterAccessoryUpdate) {
          state.behavior.closeAfterAccessoryUpdate = false;
          socket.close();
          return;
        }
        result = { accessory: { update: {} } };
      } else if (params.scenario?.list) {
        if (state.behavior.invalidNextScenarioList) {
          state.behavior.invalidNextScenarioList = false;
          result = { scenario: { list: { scenarios: {} } } };
        } else {
          result = {
            scenario: {
              list: {
                scenarios: state.scenarios.map(({ data: _data, ...scenario }) =>
                  structuredClone(scenario),
                ),
              },
            },
          };
        }
      } else if (params.scenario?.sdk) {
        result = { scenario: { sdk: { sdk: scenarioSdk } } };
      } else if (params.scenario?.get) {
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.get.index,
        );
        if (
          state.behavior.rejectScenarioGetAsInternalError ||
          (!scenario && state.behavior.missingScenarioGetAsNotFoundError)
        ) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32603,
                message: `Not found: 'Scenario ${params.scenario.get.index}'`,
              },
            }),
          );
          return;
        }
        result = {
          scenario: {
            get: structuredClone(scenario) ?? null,
          },
        };
      } else if (params.scenario?.create) {
        if (state.behavior.rejectNextScenarioCreate) {
          state.behavior.rejectNextScenarioCreate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "scenario compilation failed" },
            }),
          );
          return;
        }
        const index = `created-${state.nextScenario++}`;
        const { expand: _expand, ...createFields } = params.scenario.create;
        const created = {
          ...structuredClone(createFields),
          data:
            params.scenario.create.type === "BLOCK"
              ? JSON.stringify(
                  withRuntimeBlockFields(
                    JSON.parse(params.scenario.create.data),
                  ),
                )
              : params.scenario.create.data,
          index,
          predefined: false,
        };
        state.scenarios.push(created);
        if (created.type === "LOGIC") {
          const type = `GeneratedLogicType${state.nextScenario - 1}`;
          state.scenarioLogicTypes[index] = type;
          state.logicTypes.push({
            type,
            name: created.name,
            desc: created.desc,
          });
          state.logicOptions[logicOptionsKey(34, 13, type)] = [];
        }
        if (state.behavior.closeAfterCreate) {
          state.behavior.closeAfterCreate = false;
          socket.close();
          return;
        }
        result = { scenario: { create: structuredClone(created) } };
      } else if (params.scenario?.update) {
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.update.index,
        );
        if (!state.behavior.ignoreNextUpdate) {
          Object.assign(
            scenario,
            structuredClone(
              Object.fromEntries(
                Object.entries(params.scenario.update).filter(
                  ([key]) => key !== "index" && key !== "expand",
                ),
              ),
            ),
          );
          if (scenario.type === "BLOCK") {
            scenario.data = JSON.stringify(
              withRuntimeBlockFields(JSON.parse(params.scenario.update.data)),
            );
          }
        }
        state.behavior.ignoreNextUpdate = false;
        result = {
          scenario: {
            update: {},
          },
        };
      } else if (params.scenario?.delete) {
        const index = state.scenarios.findIndex(
          (scenario) => scenario.index === params.scenario.delete.index,
        );
        if (index >= 0) {
          const [deleted] = state.scenarios.splice(index, 1);
          const logicType = state.scenarioLogicTypes[deleted.index];
          if (logicType) {
            delete state.scenarioLogicTypes[deleted.index];
            state.logicTypes = state.logicTypes.filter(
              ({ type }) => type !== logicType,
            );
          }
        }
        result = { scenario: { delete: {} } };
      } else {
        assert.fail(`unsupported test request: ${JSON.stringify(params)}`);
      }
      for (const [matches, callbackName] of [
        [params.scenario?.create, "afterCreate"],
        [params.scenario?.update, "afterUpdate"],
        [params.scenario?.delete, "afterDelete"],
      ]) {
        if (matches && state.behavior[callbackName]) {
          const callback = state.behavior[callbackName];
          state.behavior[callbackName] = undefined;
          await callback();
        }
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    server,
    state,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

test("a window option applies one native setting and restores its baseline after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.deepEqual(contract.structuredContent.contract, {
    type: "GenericInteger",
    input_type: "LIST",
    kind: "intValue",
    valid_values: [
      { name: "Выключена", value: 0, kind: "intValue" },
      { name: "Включена", value: 1, kind: "intValue" },
      { name: "Предыдущее состояние", value: 255, kind: "intValue" },
    ],
    confirmation: "separate_window_get_readback",
  });

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff, {
    value: { from: 255, to: 0, kind: "intValue" },
  });
  assert.equal(prepared.structuredContent.restore_supported, true);

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(applied.structuredContent.observed_value, {
    value: 0,
    kind: "intValue",
  });
  assert.equal(
    applied.structuredContent.limitations.some((limitation) =>
      limitation.includes("physical power cycle remain unverified"),
    ),
    true,
  );
  assert.equal(hub.state.window.options[1].value.intValue, 1);
  assert.deepEqual(
    hub.requests.filter(({ window }) => window?.update),
    [
      {
        window: {
          update: {
            windowKey: "Controller/zigbee_demo/Child/DEVICE_A/",
            options: [{ key: startupOptionKey, value: { intValue: 0 } }],
          },
        },
      },
    ],
  );
  assert.ok(hub.requests.at(-1).window?.get);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.deepEqual(
    history.structuredContent.changes.map(({ change_ref }) => change_ref),
    [prepared.structuredContent.change_ref],
  );
  const discoveredChangeRef = history.structuredContent.changes[0].change_ref;

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: discoveredChangeRef },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(restored.structuredContent.observed_value, {
    value: 255,
    kind: "intValue",
  });
  assert.equal(hub.state.window.options[1].value.intValue, 1);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);

  const repeated = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: discoveredChangeRef },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) =>
        characteristic?.update ||
        scenario?.create ||
        scenario?.update ||
        scenario?.delete,
    ),
    false,
  );
});

test("an already desired window option creates no owned change or write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.window.options[0].value = { intValue: 0 };
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.deepEqual(prepared.structuredContent, {
    status: "already_desired",
    operation: "window_option",
    target_ref: deviceWindowRef,
    option_key: startupOptionKey,
    observed_value: { value: 0, kind: "intValue" },
    native_write_sent: false,
    owned_change_created: false,
  });
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);
  assert.equal(
    hub.requests.some(({ window }) => window?.update),
    false,
  );
});

test("a lost unexecuted window write can retry without losing the baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.dropNextWindowUpdate = true;
  hub.state.behavior.closeAfterWindowUpdate = true;

  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.deepEqual(uncertain.structuredContent.observed_value, {
    value: 255,
    kind: "intValue",
  });

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const applied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
});

test("a lost executed window write is reconciled without another update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.closeAfterWindowUpdate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.verification.fresh, false);
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a lost apply readback can be restored without a preliminary get", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "apply");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.applied_value_observed, true);
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a baseline read does not discard a delayed window apply", async (t) => {
  for (const readBeforeRestore of [false, true]) {
    await t.test(
      readBeforeRestore ? "after get" : "without get",
      async (scenario) => {
        const { hub, stateDirectory } = await setup(scenario);
        const firstClient = await startClient(scenario, hub, stateDirectory);
        const prepared = await firstClient.callTool({
          name: "prepare_native_change",
          arguments: {
            operation: "window_option",
            target_ref: deviceWindowRef,
            option_key: startupOptionKey,
            value: 0,
            reason: "Не включать лампу после восстановления питания",
          },
        });
        hub.state.behavior.dropNextWindowUpdate = true;

        const applied = await firstClient.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(applied.structuredContent.status, "uncertain");
        assert.equal(applied.structuredContent.write_intent.direction, "apply");
        assert.equal(hub.state.window.options[0].value.intValue, 255);

        if (readBeforeRestore) {
          const observed = await firstClient.callTool({
            name: "get_native_change",
            arguments: { change_ref: prepared.structuredContent.change_ref },
          });
          assert.equal(observed.structuredContent.status, "uncertain");
          assert.equal(
            observed.structuredContent.write_intent.direction,
            "apply",
          );
        }

        const waitingRestore = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(
          waitingRestore.isError,
          undefined,
          waitingRestore.content[0]?.text,
        );
        assert.equal(waitingRestore.structuredContent.status, "uncertain");
        assert.equal(
          waitingRestore.structuredContent.write_intent.direction,
          "apply",
        );
        assert.deepEqual(waitingRestore.structuredContent.observed_value, {
          value: 255,
          kind: "intValue",
        });
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          1,
        );

        hub.state.behavior.failNextWindowGet = true;
        const unreadableRestore = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(
          unreadableRestore.isError,
          undefined,
          unreadableRestore.content[0]?.text,
        );
        assert.equal(unreadableRestore.structuredContent.status, "uncertain");
        assert.equal(
          unreadableRestore.structuredContent.write_intent.direction,
          "apply",
        );
        assert.equal(
          unreadableRestore.structuredContent.verification.fresh,
          false,
        );
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          1,
        );

        hub.state.window.options[0].value = { intValue: 0 };
        await firstClient.close();
        const secondClient = await startClient(scenario, hub, stateDirectory);
        const restored = await secondClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });

        assert.equal(restored.isError, undefined, restored.content[0]?.text);
        assert.equal(restored.structuredContent.status, "restored");
        assert.equal(restored.structuredContent.applied_value_observed, true);
        assert.equal(hub.state.window.options[0].value.intValue, 255);
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          2,
        );
      },
    );
  }
});

test("window option contract rejects controls outside the reversible setting slice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const option = hub.state.window.options[0];
  const unsupported = [
    { type: "GenericInteger", inputType: "BUTTON" },
    { type: "GenericBoolean", inputType: "LIST" },
    { type: "GenericInteger", inputType: "LIST", validValues: undefined },
    { type: "GenericInteger", inputType: "LIST", disabled: true },
  ];

  for (const fields of unsupported) {
    Object.assign(option, {
      type: "GenericInteger",
      inputType: "LIST",
      disabled: false,
      validValues: [
        { name: "Выключена", value: { intValue: 0 } },
        { name: "Предыдущее состояние", value: { intValue: 255 } },
      ],
      ...fields,
    });
    const contract = await client.callTool({
      name: "get_native_change_contract",
      arguments: {
        operation: "window_option",
        target_ref: deviceWindowRef,
        option_key: startupOptionKey,
      },
    });
    assert.equal(contract.isError, true);
    assert.match(
      contract.structuredContent.error.code,
      /unsupported_window_option|insufficient_rights/,
    );
  }
  assert.equal(
    hub.requests.some(({ window }) => window?.update),
    false,
  );
});

test("window option restore preserves a third value chosen after apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  for (const validValue of hub.state.window.options[0].validValues) {
    validValue.name = `Актуально: ${validValue.name}`;
  }
  delete hub.state.window.options[0].validValues.find(
    ({ value }) => value.intValue === 1,
  ).name;
  hub.state.window.options[0].value = { intValue: 1 };

  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.deepEqual(conflict.structuredContent.value_choices, {
    baseline: {
      value: 255,
      kind: "intValue",
      name: "Актуально: Предыдущее состояние",
    },
    requested: {
      value: 0,
      kind: "intValue",
      name: "Актуально: Выключена",
    },
    observed: {
      value: 1,
      kind: "intValue",
    },
  });
  assert.deepEqual(conflict.structuredContent.conflict_resolution, {
    requires_user_decision: true,
    action_if_authorized: "prepare_new_window_option_change",
    effect: {
      replace: {
        value: 1,
        kind: "intValue",
      },
      with: {
        value: 255,
        kind: "intValue",
        name: "Актуально: Предыдущее состояние",
      },
    },
  });
  assert.equal(hub.state.window.options[0].value.intValue, 1);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);
});

test("a prepared window change cannot restore a matching manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.window.options[0].value = { intValue: 0 };
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const observed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(observed.structuredContent.status, "not_owned");
  assert.equal(
    history.structuredContent.changes[0].recorded_status,
    "not_owned",
  );
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 0);
});

test("a rejected window apply never earns the right to restore a matching manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.rejectNextWindowUpdate = true;
  const rejected = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  hub.state.window.options[0].value = { intValue: 0 };
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);
});

test("an uncertain restore cannot be turned back into apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "restore");
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const reconciled = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(reconciled.structuredContent.status, "restored");
  assert.equal(reconciled.structuredContent.write_intent.direction, "restore");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a restore interrupted before readback cannot be turned back into apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.holdNextWindowUpdate = true;
  const interruptedRestore = firstClient
    .callTool({
      name: "restore_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    })
    .catch((error) => error);
  await waitFor(
    () => hub.requests.filter(({ window }) => window?.update).length === 2,
  );
  await firstClient.close();
  await interruptedRestore;
  assert.equal(hub.state.window.options[0].value.intValue, 255);

  const secondClient = await startClient(t, hub, stateDirectory);
  const reconciled = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(reconciled.isError, undefined, reconciled.content[0]?.text);
  assert.equal(reconciled.structuredContent.status, "restored");
  assert.equal(reconciled.structuredContent.write_intent.direction, "restore");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a terminal window restore is explicit that no fresh readback occurred", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const readsBeforeRepeat = hub.requests.filter(
    ({ window }) => window?.get,
  ).length;

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(repeated.structuredContent.verification.fresh, false);
  assert.equal(
    hub.requests.filter(({ window }) => window?.get).length,
    readsBeforeRepeat,
  );
});

async function startClient(t, hub, stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "native-change-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "native-change-test-client",
      SPRUTHUB_TIMEOUT_MS: "1000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "native-change-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-native-change-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function blockStateDirectory(t, stateDirectory) {
  const backupDirectory = `${stateDirectory}-backup`;
  await rename(stateDirectory, backupDirectory);
  await writeFile(stateDirectory, "local state storage unavailable\n");
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await rm(stateDirectory, { force: true });
    await rename(backupDirectory, stateDirectory);
    restored = true;
  };
  t.after(async () => {
    if (!restored) await rm(stateDirectory, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  });
  return restore;
}

test("a characteristic value uses one recoverable native change path", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Включить офисную лампу",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.match(
    prepared.structuredContent.change_ref,
    /^spruthub-change:\/\/native\/[a-f0-9]{24}$/,
  );
  assert.deepEqual(prepared.structuredContent.diff, {
    value: { from: false, to: true, kind: "boolValue" },
  });
  assert.equal(prepared.structuredContent.native_write_sent, false);
  assert.equal(prepared.structuredContent.restore_supported, false);

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.deepEqual(applied.structuredContent.observed_value, {
    value: true,
    kind: "boolValue",
  });
  assert.equal(applied.structuredContent.command_caused_observation, "unknown");
  assert.equal(applied.structuredContent.physical_effect_reversible, false);
  assert.equal(hub.state.characteristic.control.value.boolValue, true);

  const updates = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  );
  assert.deepEqual(updates, [
    {
      characteristic: {
        update: {
          aId: 34,
          sId: 13,
          cId: 15,
          control: { value: { boolValue: true } },
        },
      },
    },
  ]);
  assert.equal(
    hub.requests.at(-1).characteristic?.get?.cId,
    15,
    "a separate readback must follow the native ACK",
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterRestart.isError, undefined, afterRestart.content[0]?.text);
  assert.equal(afterRestart.structuredContent.status, "applied");
  assert.deepEqual(afterRestart.structuredContent.observed_value, {
    value: true,
    kind: "boolValue",
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});

test("a lost characteristic response is reconciled without another command", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Включить лампу",
    },
  });
  hub.state.behavior.closeAfterCharacteristicUpdate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});

test("apply revalidates the current characteristic contract and BLOCK bindings", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const characteristicChange = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 30,
      reason: "Изменить яркость",
    },
  });
  hub.state.accessories[1].services[0].characteristics.find(
    ({ cId }) => cId === 16,
  ).control.maxValue = 25;

  const rejectedCharacteristic = await client.callTool({
    name: "apply_native_change",
    arguments: {
      change_ref: characteristicChange.structuredContent.change_ref,
    },
  });
  assert.equal(rejectedCharacteristic.isError, true);
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );

  const data = blockData();
  delete data.vendorConfiguration;
  const blockChange = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Проверка topology drift",
      description: "Не применять при изменившейся привязке",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить свежую привязку",
    },
  });
  hub.state.accessories[1].services[0].type = "Outlet";

  const rejectedBlock = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: blockChange.structuredContent.change_ref },
  });
  assert.equal(rejectedBlock.isError, true);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create),
    false,
  );
});

test("versioned BLOCK contract prepares different supported compositions", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(contract.structuredContent.status, "ok");
  assert.equal(contract.structuredContent.contract.version, "2026-09-10");
  assert.equal(
    contract.structuredContent.contract.source.frontend_sha256,
    "81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8",
  );
  assert.deepEqual(contract.structuredContent.contract.supported.target_types, [
    "if",
    "service",
    "delay",
  ]);

  const nestedData = blockData({ nested: true });
  delete nestedData.vendorConfiguration;
  nestedData.targets[0].then[1].index = 2;
  const simpleData = blockData();
  delete simpleData.vendorConfiguration;
  for (const [name, data] of [
    ["Вложенное условие", nestedData],
    ["Сброс таймера", simpleData],
  ]) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name,
        description: "Проверенная нативная композиция",
        active: false,
        on_start: false,
        sync: false,
        data,
        reason: "Подготовить BLOCK",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    assert.equal(prepared.structuredContent.status, "prepared");
    assert.equal(prepared.structuredContent.operation, "block_create");
    assert.equal(prepared.structuredContent.native_write_sent, false);
    assert.equal(prepared.structuredContent.diff.configuration.from, null);
    assert.equal(prepared.structuredContent.diff.configuration.to.name, name);
    assert.equal(
      prepared.structuredContent.diff.configuration.to.type,
      "BLOCK",
    );
    assert.deepEqual(
      prepared.structuredContent.diff.configuration.to.data,
      data,
    );
    assert.match(
      prepared.structuredContent.diff.configuration.to.desc,
      /sprut-agent:native:[a-f0-9]{24}/,
    );
  }
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("BLOCK preparation rejects delay index zero before any scenario write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const results = [];

  for (const operation of ["block_create", "block_data_update"]) {
    const data = blockData();
    if (operation === "block_create") delete data.vendorConfiguration;
    data.targets[0].then[1].index = 0;
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation,
        target_ref: operation === "block_create" ? homeRef : scenarioRef,
        ...(operation === "block_create"
          ? {
              name: "BLOCK с неисполняемым таймером",
              description: "Не записывать delay index=0",
              active: false,
              on_start: false,
              sync: false,
            }
          : {}),
        data,
        reason: "Отклонить неисполняемый таймер до записи",
      },
    });
    results.push({
      operation,
      isError: prepared.isError,
      code: prepared.structuredContent?.error?.code,
      message: prepared.structuredContent?.error?.message,
    });
  }

  assert.deepEqual(
    results,
    ["block_create", "block_data_update"].map((operation) => ({
      operation,
      isError: true,
      code: "invalid_block_data",
      message:
        "Unsupported BLOCK data at root.targets[0].then[1]: RESET delay index must be a positive unique integer; time must be a positive integer.",
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.deepEqual(contract.structuredContent.contract.supported.delay_index, {
    type: "integer",
    minimum: 1,
    unique: true,
  });
});

test("BLOCK grammar rejects known nodes in unsupported child slots before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    [
      "set in root.targets",
      (data) => {
        data.targets.push({ type: "set", cId: 15, hc: "On", value: "true" });
      },
    ],
    [
      "characteristic in if.then",
      (data) => {
        data.targets[0].then.unshift(
          characteristicCondition({ trigger: false }),
        );
      },
    ],
    [
      "set in condition.conditions",
      (data) => {
        data.targets[0].if.conditions.push({
          type: "set",
          cId: 15,
          hc: "On",
          value: "true",
        });
      },
    ],
    [
      "characteristic in delay.targets",
      (data) => {
        data.targets[0].then[1].targets.push(
          characteristicCondition({ trigger: false }),
        );
      },
    ],
    [
      "single object in if.then",
      (data) => {
        Reflect.set(data.targets[0], "then", data.targets[0].then[0]);
      },
    ],
  ];
  const results = [];

  for (const [name, mutate] of cases) {
    const data = blockData({ nested: true });
    delete data.vendorConfiguration;
    mutate(data);
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name: `Неверная позиция: ${name}`,
        description: "Не отправлять неподдержанный BLOCK",
        active: false,
        on_start: false,
        sync: false,
        data,
        reason: "Проверить грамматику BLOCK",
      },
    });
    results.push({
      name,
      isError: prepared.isError,
      code: prepared.structuredContent?.error?.code,
    });
    if (!prepared.isError) {
      await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
    }
  }

  assert.deepEqual(
    results,
    cases.map(([name]) => ({
      name,
      isError: true,
      code: "invalid_block_data",
    })),
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("BLOCK create survives a lost response and restores only an unchanged result", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData({ nested: true });
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Вложенный свет",
      description: "Два условия и RESET",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Создать нативный BLOCK",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.closeAfterCreate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  const creates = hub.requests.filter(({ scenario }) => scenario?.create);
  assert.equal(creates.length, 1);
  assert.deepEqual(
    {
      active: creates[0].scenario.create.active,
      onStart: creates[0].scenario.create.onStart,
      sync: creates[0].scenario.create.sync,
      type: creates[0].scenario.create.type,
    },
    { active: false, onStart: false, sync: false, type: "BLOCK" },
  );
  assert.match(
    creates[0].scenario.create.desc,
    /sprut-agent:native:[a-f0-9]{24}/,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );

  const scenario = hub.state.scenarios.find(
    ({ index }) => index === applied.structuredContent.scenario_index,
  );
  const appliedData = scenario.data;
  scenario.data = JSON.stringify({
    ...JSON.parse(scenario.data),
    manual: true,
  });
  const conflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.delete).length,
    0,
  );

  scenario.data = appliedData;
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === applied.structuredContent.scenario_index,
    ),
    false,
  );
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.delete).length,
    1,
  );
});

test("BLOCK create restore confirms real SprutHub not-found after restart without another delete", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с реальным not-found",
      description: "Подтвердить удаление полным каталогом",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить восстановление после рестарта",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const scenarioListsBeforeRestore = hub.requests.filter(
    ({ scenario }) => scenario?.list,
  ).length;
  const unrelatedScenarioReadsBeforeRestore = hub.requests.filter(
    ({ scenario }) => scenario?.get?.index === "existing-block",
  ).length;
  hub.state.behavior.missingScenarioGetAsNotFoundError = true;

  const restored = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  assert.ok(
    hub.requests.filter(({ scenario }) => scenario?.list).length -
      scenarioListsBeforeRestore >=
      2,
    "restore and post-restart observations must use fresh full catalogs",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) => scenario?.get?.index === "existing-block",
    ).length,
    unrelatedScenarioReadsBeforeRestore,
    "marker lookup must not read unrelated scenario configurations",
  );
});

test("scenario get rejection needs a valid catalog absence before it changes lifecycle state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с проверкой каталога",
      description: "Не считать произвольный отказ отсутствием",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить отрицательные исходы чтения",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const writesBeforeReads = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  hub.state.behavior.rejectScenarioGetAsInternalError = true;
  const presentButRejected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.rejectScenarioGetAsInternalError = false;

  const createdIndex = applied.structuredContent.scenario_index;
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== createdIndex,
  );
  hub.state.behavior.missingScenarioGetAsNotFoundError = true;
  hub.state.behavior.invalidNextScenarioList = true;
  const missingWithInvalidCatalog = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  for (const observation of [presentButRejected, missingWithInvalidCatalog]) {
    assert.equal(observation.isError, undefined, observation.content[0]?.text);
    assert.equal(observation.structuredContent.status, "applied");
    assert.equal(observation.structuredContent.verification.fresh, false);
    assert.equal(
      "configuration_matches" in observation.structuredContent,
      false,
    );
  }
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeReads,
  );
});

test("BLOCK data update verifies readback and restores its complete baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const requestedData = blockData({ delay: 45_000 });
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Уменьшить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.diff.data.changed, true);
  assert.deepEqual(prepared.structuredContent.diff.data.from, blockData());
  assert.deepEqual(prepared.structuredContent.diff.data.to, requestedData);
  assert.equal(prepared.structuredContent.restore_supported, true);

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  const updates = hub.requests.filter(({ scenario }) => scenario?.update);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0].scenario.update).sort(), [
    "data",
    "index",
  ]);
  assert.equal(updates[0].scenario.update.index, "existing-block");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].vendorTopLevel, "preserve-me");

  const appliedData = hub.state.scenarios[0].data;
  hub.state.scenarios[0].data = JSON.stringify({
    ...JSON.parse(appliedData),
    manual: "keep",
  });
  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );

  hub.state.scenarios[0].data = appliedData;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  const restoredData = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(restoredData.targets[0].then[1].time, 60_000);
  assert.deepEqual(restoredData.vendorConfiguration, { preserved: true });
});

test("restore preserves unknown vendor blockId and state fields", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const baseline = blockData();
  baseline.vendorConfiguration = {
    type: "if",
    blockId: "vendor-baseline",
    state: "configured",
  };
  hub.state.scenarios[0].data = JSON.stringify(baseline);
  const requested = structuredClone(baseline);
  requested.targets[0].then[1].time = 45_000;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Сохранить vendor configuration",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  manuallyEdited.vendorConfiguration.blockId = "manual-change";
  manuallyEdited.vendorConfiguration.state = "manual-state";
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.configuration_matches, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).vendorConfiguration.blockId,
    "manual-change",
  );
});

test("BLOCK data restore revalidates current bindings before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить topology drift перед restore",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.accessories[1].services[0].type = "Outlet";

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.isError, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("a restored BLOCK change is terminal and recovers a lost final save", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Временный BLOCK",
      description: "Проверить восстановление журнала",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить терминальный restore",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterDelete = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const restoredWithoutSave = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restoredWithoutSave.structuredContent.status, "restored");
  assert.deepEqual(restoredWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  assert.equal(
    restoredWithoutSave.structuredContent.write_intent.direction,
    "restore",
  );
  assert.equal(
    restoredWithoutSave.structuredContent.write_intent.acknowledged,
    true,
  );
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.native_acknowledged, false);
  assert.equal(recovered.structuredContent.write_intent.direction, "restore");
  assert.equal(recovered.structuredContent.write_intent.phase, "reconciled");
  assert.equal(repeatedApply.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("BLOCK create recovers when its applied result cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с потерянным journal save",
      description: "Восстановить результат после рестарта",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить create recovery",
    },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterCreate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutSave.structuredContent.status, "applied");
  assert.deepEqual(appliedWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: appliedWithoutSave.structuredContent.scenario_ref,
    },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.equal(
    history.structuredContent.changes[0].change_ref,
    prepared.structuredContent.change_ref,
  );
  assert.equal(history.structuredContent.changes[0].recorded_status, "applied");
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("BLOCK update recovers when its applied result cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить update recovery",
    },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterUpdate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutSave.structuredContent.status, "applied");
  assert.deepEqual(appliedWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("ACK without the requested BLOCK result stays uncertain and is not resent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 30_000 }),
      reason: "Изменить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.ignoreNextUpdate = true;
  const first = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(first.structuredContent.status, "uncertain");
  assert.equal(
    first.structuredContent.conflict_reason,
    "ack_without_requested_result",
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("a changed BLOCK baseline is preserved before any update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Изменить RESET delay",
    },
  });
  hub.state.scenarios[0].data = JSON.stringify(blockData({ delay: 55_000 }));

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(applied.structuredContent.status, "conflict");
  assert.equal(applied.structuredContent.conflict_reason, "baseline_changed");
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    55_000,
  );
});

test("history discovers changes by home and entity after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Изменить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(history.structuredContent.changes, [
    {
      change_ref: prepared.structuredContent.change_ref,
      operation: "block_data_update",
      recorded_status: "prepared",
      target_refs: [
        scenarioRef,
        `${homeRef}/accessory/32`,
        `${homeRef}/accessory/32/service/13`,
        `${homeRef}/accessory/32/service/13/characteristic/15`,
        `${homeRef}/accessory/34`,
        `${homeRef}/accessory/34/service/13`,
        characteristicRef,
      ],
      created_at: history.structuredContent.changes[0].created_at,
      updated_at: history.structuredContent.changes[0].updated_at,
      next: {
        tool: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      },
    },
  ]);
  assert.equal(history.structuredContent.truncated, false);
});

test("history labels a saved conflict before its next tool verifies current applied state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Отличить сохранённый конфликт от текущего состояния",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const appliedData = hub.state.scenarios[0].data;
  const manuallyEdited = JSON.parse(appliedData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  hub.state.scenarios[0].data = appliedData;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const requestsBeforeHistory = hub.requests.length;
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.equal(history.structuredContent.changes.length, 1);
  const [saved] = history.structuredContent.changes;
  assert.equal(saved.recorded_status, "conflict");
  assert.equal("status" in saved, false);
  assert.equal(typeof saved.updated_at, "string");
  assert.deepEqual(saved.next, {
    tool: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    hub.requests.length,
    requestsBeforeHistory,
    "listing saved history must not poll the live hub",
  );

  const current = await secondClient.callTool({
    name: saved.next.tool,
    arguments: saved.next.arguments,
  });
  assert.equal(current.isError, undefined, current.content[0]?.text);
  assert.equal(current.structuredContent.status, "applied");
  assert.equal(current.structuredContent.configuration_matches, true);
  assert.equal(current.structuredContent.verification.fresh, true);
});

test("history indexes created scenarios and BLOCK bindings before and after update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const create = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Индексируемый BLOCK",
      description: "Найти после рестарта",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить историю",
    },
  });
  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  const requested = blockData();
  requested.targets[0].then[0] = setAction({
    cId: 16,
    hc: "Brightness",
    value: "30",
  });
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Сменить действие",
    },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  for (const [entityRef, expectedChange] of [
    [created.structuredContent.scenario_ref, create],
    [`${homeRef}/accessory/32`, create],
    [characteristicRef, update],
    [`${homeRef}/accessory/34/service/13/characteristic/16`, update],
  ]) {
    const history = await secondClient.callTool({
      name: "list_native_changes",
      arguments: { home_ref: homeRef, entity_ref: entityRef },
    });
    assert.equal(history.isError, undefined, history.content[0]?.text);
    assert.equal(
      history.structuredContent.changes.some(
        ({ change_ref }) =>
          change_ref === expectedChange.structuredContent.change_ref,
      ),
      true,
      entityRef,
    );
  }
});

test("status exposes failed fresh reads and clears stale configuration matches", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const block = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить freshness",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  hub.state.behavior.failNextScenarioGet = true;
  const unavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  assert.equal(unavailable.isError, undefined, unavailable.content[0]?.text);
  assert.equal(unavailable.structuredContent.status, "applied");
  assert.equal(unavailable.structuredContent.verification.fresh, false);
  assert.equal("configuration_matches" in unavailable.structuredContent, false);

  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.configuration_matches, false);
  assert.equal(conflict.structuredContent.verification.fresh, true);

  const characteristic = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Проверить freshness значения",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: characteristic.structuredContent.change_ref },
  });
  hub.state.behavior.failNextCharacteristicGet = true;
  const characteristicUnavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: characteristic.structuredContent.change_ref },
  });
  assert.equal(
    characteristicUnavailable.structuredContent.verification.fresh,
    false,
  );
});

test("fresh BLOCK match recovers from an earlier conflict before restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить возврат к applied snapshot",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const appliedData = hub.state.scenarios[0].data;

  const manuallyEdited = JSON.parse(appliedData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.configuration_matches, false);

  hub.state.scenarios[0].data = appliedData;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const matchedAgain = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(matchedAgain.isError, undefined, matchedAgain.content[0]?.text);
  assert.equal(matchedAgain.structuredContent.status, "applied");
  assert.equal(matchedAgain.structuredContent.configuration_matches, true);
  assert.equal(matchedAgain.structuredContent.verification.fresh, true);
  assert.equal("conflict_reason" in matchedAgain.structuredContent, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
    "get must only observe the returned applied configuration",
  );

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    2,
  );
  assert.deepEqual(
    JSON.parse(hub.state.scenarios[0].data),
    withRuntimeBlockFields(blockData()),
  );
});

test("restored BLOCK observations keep terminal status and consistent snapshot facts", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить наблюдение restored update",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  const restoredUpdate = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(restoredUpdate.structuredContent.status, "restored");
  const restoredData = hub.state.scenarios[0].data;
  const manuallyEdited = JSON.parse(restoredData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const writesBeforeGet = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const driftedUpdate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(driftedUpdate.structuredContent.status, "restored");
  assert.equal(driftedUpdate.structuredContent.configuration_matches, false);
  assert.equal(driftedUpdate.structuredContent.verification.fresh, true);
  assert.equal(
    driftedUpdate.structuredContent.verification.result,
    "baseline_configuration_missing",
  );

  hub.state.scenarios[0].data = restoredData;
  const matchingUpdate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(matchingUpdate.structuredContent.status, "restored");
  assert.equal(matchingUpdate.structuredContent.configuration_matches, true);
  assert.equal(
    matchingUpdate.structuredContent.verification.result,
    "baseline_configuration",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeGet,
  );

  const createData = blockData({ nested: true });
  delete createData.vendorConfiguration;
  const create = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Восстановленный create",
      description: "Проверить повторное появление",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Проверить observation после удаления",
    },
  });
  const appliedCreate = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  const createdScenario = structuredClone(
    hub.state.scenarios.find(
      ({ index }) => index === appliedCreate.structuredContent.scenario_index,
    ),
  );
  const restoredCreate = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(restoredCreate.structuredContent.status, "restored");
  hub.state.scenarios.push(createdScenario);
  const writesBeforeCreateGet = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  const reappearedCreate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(reappearedCreate.structuredContent.status, "restored");
  assert.equal(reappearedCreate.structuredContent.configuration_matches, false);
  assert.equal(reappearedCreate.structuredContent.verification.fresh, true);
  assert.equal(
    reappearedCreate.structuredContent.verification.result,
    "baseline_configuration_missing",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeCreateGet,
  );
});

test("native preparation rejects unsafe targets and values before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const readOnlyRef = `${homeRef}/accessory/34/service/13/characteristic/17`;
  const modeRef = `${homeRef}/accessory/34/service/13/characteristic/18`;

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "characteristic_value", target_ref: brightnessRef },
  });
  assert.deepEqual(contract.structuredContent.contract, {
    type: "Brightness",
    kind: "intValue",
    min: 0,
    max: 100,
    step: 1,
  });

  for (const arguments_ of [
    {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 101,
      reason: "Недопустимый диапазон",
    },
    {
      operation: "characteristic_value",
      target_ref: readOnlyRef,
      value: false,
      reason: "Недоступная запись",
    },
    {
      operation: "characteristic_value",
      target_ref: modeRef,
      value: "vacation",
      reason: "Неизвестное enum-значение",
    },
    {
      operation: "characteristic_value",
      target_ref:
        "spruthub://hub/other-home/accessory/34/service/13/characteristic/15",
      value: true,
      reason: "Чужой дом",
    },
  ]) {
    const rejected = await client.callTool({
      name: "prepare_native_change",
      arguments: arguments_,
    });
    assert.equal(rejected.isError, true);
  }

  const unknownData = blockData();
  delete unknownData.vendorConfiguration;
  unknownData.targets[0].then[0].unsupportedAction = true;
  const unknown = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Неподдержанный BLOCK",
      description: "Не применять",
      active: false,
      on_start: false,
      sync: false,
      data: unknownData,
      reason: "Проверить схему",
    },
  });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, "invalid_block_data");
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) =>
        characteristic?.update || scenario?.create || scenario?.update,
    ),
    false,
  );
});

test("a native logic assignment is configured without a duplicate and restored after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const service = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: serviceRef },
  });
  assert.equal(service.isError, undefined, service.content[0]?.text);
  assert.deepEqual(service.structuredContent.entity.assigned_logics, []);
  assert.deepEqual(service.structuredContent.entity.available_logic_types, [
    {
      ref: smoothLogicRef,
      type: smoothLogicType,
      name: "Плавное изменение яркости",
      description: "Плавно меняет яркость при включении света",
      assigned: false,
    },
  ]);

  const assignment = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатное мягкое включение офисной лампы",
    },
  });
  assert.equal(assignment.isError, undefined, assignment.content[0]?.text);
  assert.equal(assignment.structuredContent.status, "prepared");
  const assigned = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(assigned.isError, undefined, assigned.content[0]?.text);
  assert.equal(assigned.structuredContent.status, "applied");
  assert.equal(hub.state.logics.length, 1);
  assert.equal(hub.state.logics[0].active, false);

  const logic = await firstClient.callTool({
    name: "get_entity",
    arguments: { entity_ref: smoothLogicRef, include: ["options"] },
  });
  assert.equal(logic.isError, undefined, logic.content[0]?.text);
  assert.equal(logic.structuredContent.entity.active, false);
  assert.deepEqual(
    logic.structuredContent.entity.options.map(
      ({ key, type, input_type, value, capabilities }) => ({
        key,
        type,
        input_type,
        value,
        capabilities,
      }),
    ),
    [
      {
        key: "Primary",
        type: "Group",
        input_type: "GROUP",
        value: null,
        capabilities: { read: true, write: false, disabled: false },
      },
      {
        key: smoothOptionKeys.start,
        type: "GenericInteger",
        input_type: "NUMBER",
        value: 1,
        capabilities: { read: true, write: true, disabled: false },
      },
      {
        key: smoothOptionKeys.end,
        type: "GenericInteger",
        input_type: "NUMBER",
        value: 100,
        capabilities: { read: true, write: true, disabled: false },
      },
      {
        key: smoothOptionKeys.duration,
        type: "GenericInteger",
        input_type: "NUMBER",
        value: 900,
        capabilities: { read: true, write: true, disabled: false },
      },
    ],
  );

  const changes = [];
  for (const [optionKey, value] of [
    [smoothOptionKeys.start, 1],
    [smoothOptionKeys.end, 40],
    [smoothOptionKeys.duration, 5],
  ]) {
    const prepared = await firstClient.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "logic_option",
        target_ref: smoothLogicRef,
        option_key: optionKey,
        value,
        reason: "Настроить штатное мягкое включение офисной лампы",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    if (prepared.structuredContent.status === "prepared") {
      const applied = await firstClient.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
      assert.equal(applied.structuredContent.status, "applied");
      changes.push(prepared.structuredContent.change_ref);
    } else {
      assert.equal(prepared.structuredContent.status, "already_desired");
    }
  }
  const activation = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_active",
      target_ref: smoothLogicRef,
      value: true,
      reason: "Активировать настроенное штатное поведение",
    },
  });
  const activated = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: activation.structuredContent.change_ref },
  });
  assert.equal(activated.structuredContent.status, "applied");
  changes.push(activation.structuredContent.change_ref);
  assert.equal(hub.state.logics[0].active, true);
  assert.deepEqual(
    configuredSmoothLogicOptions(hub.state)
      .filter(({ value }) => value)
      .map(({ key, value }) => [key, value.intValue]),
    [
      [smoothOptionKeys.start, 1],
      [smoothOptionKeys.end, 40],
      [smoothOptionKeys.duration, 5],
    ],
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const observedAssignment = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(observedAssignment.structuredContent.status, "applied");
  assert.equal(
    observedAssignment.structuredContent.configuration_matches,
    false,
  );
  assert.equal(
    "conflict_reason" in observedAssignment.structuredContent,
    false,
  );
  assert.deepEqual(
    observedAssignment.structuredContent.configuration_differences,
    {
      active: { created: false, current: true },
      option_keys: [smoothOptionKeys.duration, smoothOptionKeys.end],
    },
  );
  const repeatedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(repeatedApply.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);
  const repeatedAssignment = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Повторить ту же просьбу",
    },
  });
  assert.equal(repeatedAssignment.structuredContent.status, "already_desired");
  assert.equal(
    repeatedAssignment.structuredContent.owned_change_created,
    false,
  );
  const repeatedActivation = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_active",
      target_ref: smoothLogicRef,
      value: true,
      reason: "Повторить ту же просьбу",
    },
  });
  assert.equal(repeatedActivation.structuredContent.status, "already_desired");
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);

  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: smoothLogicRef },
  });
  assert.deepEqual(
    history.structuredContent.changes.map(({ operation }) => operation),
    ["logic_assignment", "logic_active", "logic_option", "logic_option"],
  );
  for (const changeRef of changes.reverse()) {
    const restored = await secondClient.callTool({
      name: "restore_native_change",
      arguments: { change_ref: changeRef },
    });
    assert.equal(restored.structuredContent.status, "restored");
  }
  const removed = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(removed.structuredContent.status, "restored");
  assert.deepEqual(hub.state.logics, []);
  assert.equal(hub.requests.filter(({ logic }) => logic?.delete).length, 1);
  assert.equal(
    hub.requests.some(({ scenario }) =>
      Boolean(scenario?.create || scenario?.update || scenario?.delete),
    ),
    false,
  );
});

test("an existing or manually assigned logic is not claimed for deletion", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic({ active: true }));
  const firstClient = await startClient(t, hub, stateDirectory);
  const existing = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Использовать существующую штатную logic",
    },
  });
  assert.deepEqual(existing.structuredContent, {
    status: "already_desired",
    operation: "logic_assignment",
    target_ref: smoothLogicRef,
    native_write_sent: false,
    owned_change_created: false,
  });

  hub.state.logics.length = 0;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Подготовить назначение",
    },
  });
  hub.state.logics.push(assignedSmoothLogic());
  const refusedApply = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refusedApply.structuredContent.status, "conflict");
  assert.equal(
    refusedApply.structuredContent.conflict_reason,
    "baseline_changed",
  );
  assert.equal(
    hub.requests.some(({ logic }) => logic?.create),
    false,
  );
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(hub.state.logics.length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("a disappeared owned logic assignment is not reclaimed after the owner recreates it", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.logics.length = 0;

  const missing = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(missing.structuredContent.status, "conflict");
  assert.equal(
    missing.structuredContent.conflict_reason,
    "assignment_missing_after_creation",
  );
  assert.equal(missing.structuredContent.assignment_ownership_lost, true);

  hub.state.logics.push(assignedSmoothLogic());
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  for (const tool of [
    "get_native_change",
    "apply_native_change",
    "restore_native_change",
  ]) {
    const result = await secondClient.callTool({
      name: tool,
      arguments: { change_ref: prepared.structuredContent.change_ref },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(result.structuredContent.status, "conflict", tool);
    assert.equal(
      result.structuredContent.conflict_reason,
      "assignment_reappeared_after_ownership_loss",
      tool,
    );
    assert.equal(
      result.structuredContent.assignment_ownership_lost,
      true,
      tool,
    );
  }
  assert.equal(hub.state.logics.length, 1);
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("restoring an absent owned logic stays terminal if another assignment later appears", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.logics.length = 0;

  const restored = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.assignment_ownership_lost, true);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );

  hub.state.logics.push(assignedSmoothLogic());
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const observed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observed.structuredContent.status, "restored");
  assert.equal(observed.structuredContent.configuration_matches, false);
  assert.equal(observed.structuredContent.assignment_ownership_lost, true);
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(hub.state.logics.length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("a failed fresh logic read does not expose saved configuration differences as current", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.logics[0].active = true;
  const changed = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.deepEqual(changed.structuredContent.configuration_differences, {
    active: { created: false, current: true },
  });

  hub.state.logics[0].active = false;
  hub.state.behavior.failNextLogicList = true;
  const unavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(unavailable.isError, undefined, unavailable.content[0]?.text);
  assert.equal(unavailable.structuredContent.verification.fresh, false);
  assert.equal("configuration_matches" in unavailable.structuredContent, false);
  assert.equal(
    "configuration_differences" in unavailable.structuredContent,
    false,
  );
});

test("an uncertain logic create is reconciled once and configuration changes block deletion", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  hub.state.behavior.closeAfterLogicCreate = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(hub.requests.filter(({ logic }) => logic?.create).length, 1);

  hub.state.logics[0].active = true;
  const options = configuredSmoothLogicOptions(hub.state);
  delete options.find(({ key }) => key === smoothOptionKeys.start).value;
  options.find(({ key }) => key === smoothOptionKeys.end).value = {
    intValue: 55,
  };
  options.find(({ key }) => key === smoothOptionKeys.duration).type =
    "GenericDouble";
  options.find(({ key }) => key === "Primary").value = { intValue: 1 };
  options.push({
    key: "AddedOption",
    type: "GenericInteger",
    inputType: "NUMBER",
    read: true,
    write: true,
    value: { intValue: 7 },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "conflict");
  assert.equal(
    restored.structuredContent.conflict_reason,
    "configuration_changed_after_creation",
  );
  assert.deepEqual(restored.structuredContent.configuration_differences, {
    active: { created: false, current: true },
    option_keys: [
      "AddedOption",
      smoothOptionKeys.duration,
      smoothOptionKeys.end,
      "Primary",
      smoothOptionKeys.start,
    ],
  });
  assert.equal(hub.state.logics.length, 1);
  assert.equal(
    hub.requests.some(({ logic }) => logic?.delete),
    false,
  );
});

test("cosmetic logic metadata does not block deletion of an owned assignment", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.end,
  ).value = { intValue: 40 };
  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).value = { intValue: 5 };
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Назначить штатную logic",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(
    configuredSmoothLogicOptions(hub.state)
      .filter(({ key }) =>
        [smoothOptionKeys.end, smoothOptionKeys.duration].includes(key),
      )
      .map(({ key, value }) => [key, value.intValue]),
    [
      [smoothOptionKeys.end, 40],
      [smoothOptionKeys.duration, 5],
    ],
  );

  Object.assign(hub.state.logics[0], {
    name: "Локализованное название",
    desc: "Локализованное описание",
    locale: "ru-RU",
    optionsWindow: "Logic/localized/window",
  });
  for (const option of configuredSmoothLogicOptions(hub.state)) {
    option.name = `Локализовано: ${option.key}`;
    option.desc = "Описание элемента управления";
    option.locale = "ru-RU";
    option.read = !option.read;
    option.write = !option.write;
    option.disabled = !option.disabled;
  }

  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(hub.state.logics, []);
  assert.equal(hub.requests.filter(({ logic }) => logic?.delete).length, 1);
});

test("a lost logic option response keeps its apply direction and restores the baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.logics.push(assignedSmoothLogic());
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
      value: 5,
      reason: "Установить длительность мягкого включения",
    },
  });
  hub.state.behavior.closeAfterLogicSetOptions = true;
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.write_intent.direction, "apply");
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(
    configuredSmoothLogicOptions(hub.state).find(
      ({ key }) => key === smoothOptionKeys.duration,
    ).value.intValue,
    5,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.write_intent.direction, "restore");
  assert.equal(
    configuredSmoothLogicOptions(hub.state).find(
      ({ key }) => key === smoothOptionKeys.duration,
    ).value.intValue,
    900,
  );
  assert.equal(hub.requests.filter(({ logic }) => logic?.setOptions).length, 2);
});

test("logic writes require a catalogued type and a writable GenericInteger NUMBER option", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.state.logicTypes.length = 0;
  const unavailable = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
      reason: "Не создавать вымышленный механизм",
    },
  });
  assert.equal(unavailable.isError, true);
  assert.equal(
    unavailable.structuredContent.error.code,
    "logic_type_unavailable",
  );
  assert.equal(
    hub.requests.some(({ logic }) => logic?.create),
    false,
  );

  hub.state.logicTypes.push({
    type: smoothLogicType,
    name: "Плавное изменение яркости",
    desc: "Плавно меняет яркость при включении света",
  });
  hub.state.logics.push(assignedSmoothLogic());
  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).inputType = "SLIDER";
  const unsupported = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
    },
  });
  assert.equal(unsupported.isError, true);
  assert.equal(
    unsupported.structuredContent.error.code,
    "unsupported_logic_option",
  );

  configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).inputType = "NUMBER";
  delete configuredSmoothLogicOptions(hub.state).find(
    ({ key }) => key === smoothOptionKeys.duration,
  ).disabled;
  hub.state.logicTypes[0].name = "api_token=logic-name-secret";
  hub.state.logicTypes[0].desc =
    "Authorization: Bearer logic-description-secret";
  const supportedWithoutDisabled = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "logic_option",
      target_ref: smoothLogicRef,
      option_key: smoothOptionKeys.duration,
    },
  });
  assert.equal(
    supportedWithoutDisabled.isError,
    undefined,
    supportedWithoutDisabled.content[0]?.text,
  );
  const assignmentContract = await client.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "logic_assignment",
      target_ref: smoothLogicRef,
    },
  });
  assert.equal(
    assignmentContract.structuredContent.contract.name,
    "[REDACTED]",
  );
  assert.equal(
    assignmentContract.structuredContent.contract.description,
    "[REDACTED]",
  );
});

test("an accessory is renamed and moved as one owned change, then restored after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  hub.state.behavior.normalizeNextAccessoryName = true;

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая · лампа",
      reason: "Перенести настольную лампу в мастерскую и переименовать",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff, {
    name: { from: "Лампа", to: "Рабочая · лампа" },
    room: {
      from: { ref: `${homeRef}/room/1`, name: "Офис" },
      to: { ref: workshopRoomRef, name: "Мастерская" },
    },
  });

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.deepEqual(applied.structuredContent.observed, {
    name: "Рабочая лампа",
    room_ref: workshopRoomRef,
    room_name: "Мастерская",
  });
  assert.deepEqual(
    hub.requests.filter(({ accessory }) => accessory?.update),
    [
      {
        accessory: {
          update: { id: 34, name: "Рабочая · лампа", roomId: 2 },
        },
      },
    ],
  );
  assert.deepEqual(
    hub.state.accessories.find(({ id }) => id === 35),
    {
      id: 35,
      roomId: 1,
      name: "Подсветка той же лампы",
      online: true,
      extensionKey: "zigbee_demo",
      deviceId: "DEVICE_A",
      services: [],
    },
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: accessoryRef, limit: 10 },
  });
  assert.equal(history.structuredContent.changes.length, 1);
  assert.equal(
    history.structuredContent.changes[0].change_ref,
    prepared.structuredContent.change_ref,
  );
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.state.accessories.find(({ id }) => id === 34).name, "Лампа");
  assert.equal(hub.state.accessories.find(({ id }) => id === 34).roomId, 1);
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );
});

test("a later manual accessory edit blocks restoration without touching the hub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Упорядочить лампу",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.accessories.find(({ id }) => id === 34).name =
    "Ручное имя владельца";
  const writesBeforeRestore = hub.requests.filter(
    ({ accessory }) => accessory?.update,
  ).length;

  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 34).name,
    "Ручное имя владельца",
  );
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    writesBeforeRestore,
  );
});

test("a created room is reused after restart and removed only after its accessory is restored", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const roomChange = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Лаборатория",
      reason: "Создать отсутствующую комнату для лампы",
    },
  });
  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.room_creation_owned, true);
  const createdRoomRef = created.structuredContent.room.ref;

  const accessoryChange = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: createdRoomRef,
      name: "Рабочая лампа",
      reason: "Разместить лампу в созданной комнате",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: accessoryChange.structuredContent.change_ref },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  const repeatedRoomApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(repeatedRoomApply.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ room }) => room?.create).length, 1);
  const occupied = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(occupied.structuredContent.status, "conflict");
  assert.equal(occupied.structuredContent.conflict_reason, "room_not_empty");
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 0);

  const accessoryRestored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: accessoryChange.structuredContent.change_ref },
  });
  assert.equal(accessoryRestored.structuredContent.status, "restored");
  const roomRestored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: roomChange.structuredContent.change_ref },
  });
  assert.equal(roomRestored.structuredContent.status, "restored");
  assert.equal(
    hub.state.rooms.some(
      ({ id }) => `${homeRef}/room/${id}` === createdRoomRef,
    ),
    false,
  );
});

test("a lost room-create response exposes one candidate and never repeats creation", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Архив",
      reason: "Создать отсутствующую комнату",
    },
  });
  hub.state.behavior.closeAfterRoomCreate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.room_creation_owned, false);
  assert.equal(uncertain.structuredContent.candidate_rooms.length, 1);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(hub.requests.filter(({ room }) => room?.create).length, 1);
  const candidateRoomRef = repeated.structuredContent.candidate_rooms[0].ref;
  const accessoryChange = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: candidateRoomRef,
      name: "Лампа архива",
      reason: "Закончить перенос без повторного создания комнаты",
    },
  });
  const applied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: accessoryChange.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ room }) => room?.create).length, 1);
  const notOwned = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(notOwned.structuredContent.status, "not_owned");
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 0);
});

test("a home-qualified accessory placement rejects the same local id in another home", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const refused = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: "spruthub://hub/other-home/accessory/34",
      room_ref: workshopRoomRef,
      name: "Чужая лампа",
      reason: "Не затрагивать другой дом",
    },
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, "unsupported_home_write");
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.update),
    false,
  );
  const foreignRoom = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: "spruthub://hub/other-home/room/2",
      name: "Чужая лампа",
      reason: "Не затрагивать комнату другого дома",
    },
  });
  assert.equal(foreignRoom.isError, true);
  assert.equal(
    foreignRoom.structuredContent.error.code,
    "unsupported_home_write",
  );
  assert.equal(
    hub.requests.some(({ accessory }) => accessory?.update),
    false,
  );
});

test("a lost accessory response is reconciled without a second update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Перенести лампу",
    },
  });
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  const recovered = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.native_acknowledged, false);
  assert.equal(
    recovered.structuredContent.recovered_after_uncertain_write,
    true,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
});

test("an apply retry never uses a saved accessory snapshot after a fresh read fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Не повторять запись по устаревшему снимку",
    },
  });
  await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  hub.state.behavior.failAccessoryGetAfterUpdate = true;
  const firstAttempt = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    firstAttempt.structuredContent.status,
    "uncertain",
    firstAttempt.content[0]?.text,
  );

  hub.state.behavior.failNextAccessoryGet = true;
  const failedFreshRead = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(failedFreshRead.structuredContent.status, "uncertain");
  assert.equal(failedFreshRead.structuredContent.verification.fresh, false);
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );

  const recovered = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
});

test("a lost rename response reports the unchanged baseline before a safe retry", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: `${homeRef}/room/1`,
      name: "Настольная лампа",
      reason: "Переименовать без смены комнаты",
    },
  });
  hub.state.behavior.dropNextAccessoryUpdate = true;
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  const uncertain = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal("conflict_reason" in uncertain.structuredContent, false);
  assert.equal(
    uncertain.structuredContent.verification.result,
    "requested_values_missing",
  );

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );
});

test("a restore retry preserves a manual edit when its fresh read fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Не затирать ручную правку при повторе возврата",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  hub.state.behavior.failAccessoryGetAfterUpdate = true;
  const firstRestore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    firstRestore.structuredContent.status,
    "uncertain",
    firstRestore.content[0]?.text,
  );

  hub.state.accessories.find(({ id }) => id === 34).name =
    "Ручное имя владельца";
  hub.state.behavior.failNextAccessoryGet = true;
  const failedFreshRead = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(failedFreshRead.structuredContent.status, "uncertain");
  assert.equal(failedFreshRead.structuredContent.verification.fresh, false);
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 34).name,
    "Ручное имя владельца",
  );
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );

  const observedManualEdit = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(observedManualEdit.structuredContent.status, "uncertain");
  assert.equal(
    observedManualEdit.structuredContent.conflict_reason,
    "possible_name_normalization_after_restore",
  );
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 34).name,
    "Ручное имя владельца",
  );
});

test("an exact room ref selects one of two rooms with the same name", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.rooms.push({
    id: 3,
    order: 3,
    name: "Мастерская",
    visible: true,
  });
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: `${homeRef}/room/3`,
      name: "Рабочая лампа",
      reason: "Использовать выбранную мастерскую",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.state.accessories.find(({ id }) => id === 34).roomId, 3);
  assert.deepEqual(
    hub.requests.filter(({ accessory }) => accessory?.update).at(-1).accessory
      .update,
    { id: 34, name: "Рабочая лампа", roomId: 3 },
  );
});

test("a normalized name after a lost accessory response stays uncertain and is not rewritten", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая · лампа",
      reason: "Перенести лампу без догадки о нормализации",
    },
  });
  hub.state.behavior.normalizeNextAccessoryName = true;
  hub.state.behavior.closeAfterAccessoryUpdate = true;
  const uncertain = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    uncertain.structuredContent.conflict_reason,
    "possible_name_normalization_after_lost_response",
  );
  assert.equal(uncertain.structuredContent.observed.name, "Рабочая лампа");

  const repeated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
  const restore = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restore.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    1,
  );
});

test("a normalized baseline name after an acknowledged restore stays uncertain without a rewrite", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.accessories.find(({ id }) => id === 34).name = "Лампа · стол";
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "accessory_placement",
      target_ref: accessoryRef,
      room_ref: workshopRoomRef,
      name: "Рабочая лампа",
      reason: "Вернуть наблюдённое имя без догадки о нормализации",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.normalizeNextAccessoryName = true;
  const uncertain = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    uncertain.structuredContent.conflict_reason,
    "possible_name_normalization_after_restore",
  );
  assert.equal(uncertain.structuredContent.observed.name, "Лампа стол");

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ accessory }) => accessory?.update).length,
    2,
  );
});

test("an existing room name is a no-op without owned creation", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const existing = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Мастерская",
      reason: "Переиспользовать существующую комнату",
    },
  });
  assert.equal(existing.structuredContent.status, "already_desired");
  assert.deepEqual(existing.structuredContent.matching_rooms, [
    { ref: workshopRoomRef, name: "Мастерская" },
  ]);
  assert.equal(existing.structuredContent.owned_change_created, false);
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("room creation trims the name before matching an existing room", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const existing = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "  Мастерская  ",
      reason: "Не создавать почти одинаковую комнату",
    },
  });
  assert.equal(existing.structuredContent.status, "already_desired");
  assert.deepEqual(existing.structuredContent.matching_rooms, [
    { ref: workshopRoomRef, name: "Мастерская" },
  ]);
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("room deletion requires catalog-confirmed absence after native not-found", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Архив",
      reason: "Проверить возврат комнаты по реальному not-found контракту",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  hub.state.behavior.rejectNextRoomGetAsInternalError = true;
  const presentButRejected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(presentButRejected.structuredContent.status, "applied");
  assert.equal(presentButRejected.structuredContent.verification.fresh, false);

  hub.state.behavior.missingRoomGetAsNotFoundError = true;
  hub.state.behavior.invalidNextRoomList = true;
  const uncertain = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.verification.fresh, false);
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 1);

  const recovered = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(hub.requests.filter(({ room }) => room?.delete).length, 1);
});

test("room creation rechecks all current names before writing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Склад",
      reason: "Создать только действительно отсутствующую комнату",
    },
  });
  hub.state.rooms[0].name = "Склад";
  const conflict = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(
    conflict.structuredContent.conflict_reason,
    "matching_room_appeared",
  );
  assert.equal(
    hub.requests.some(({ room }) => room?.create),
    false,
  );
});

test("a native LOGIC source is created, assigned, updated, read back, and restored through public tools", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const sdk = await client.callTool({
    name: "get_scenario_sdk",
    arguments: { home_ref: homeRef },
  });
  assert.equal(sdk.isError, undefined, sdk.content[0]?.text);
  assert.equal(sdk.structuredContent.sdk, scenarioSdk);
  assert.equal(
    sdk.structuredContent.sha256,
    createHash("sha256").update(scenarioSdk).digest("hex"),
  );

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Яркость при включении",
      description: "Установить стартовый уровень один раз",
      active: true,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Проверить нативную JS-логику без постоянного solver",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.diff.source.exact_match, false);

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.isError, undefined, created.content[0]?.text);
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(
    created.structuredContent.native_logic_type,
    "GeneratedLogicType1",
  );
  assert.equal(
    created.structuredContent.logic_ref,
    `${serviceRef}/logic/GeneratedLogicType1`,
  );
  assert.notEqual(
    created.structuredContent.scenario_index,
    "GeneratedLogicType1",
  );
  assert.equal(created.structuredContent.diff.source.exact_match, true);
  const createdScenarioRef = created.structuredContent.scenario_ref;

  const assignment = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_assignment",
      target_ref: created.structuredContent.logic_ref,
      reason: "Назначить созданную логику выбранному свету",
    },
  });
  const assigned = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(assigned.structuredContent.status, "applied");

  const restartedClient = await startClient(t, hub, stateDirectory);
  const history = await restartedClient.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: created.structuredContent.logic_ref,
    },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(
    history.structuredContent.changes.map(({ operation }) => operation).sort(),
    ["logic_assignment", "logic_source_create"],
  );
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.diff.source.exact_match, true);

  const update = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: createdScenarioRef,
      source: secondLogicSource,
      reason: "Уточнить условие перехода без изменения metadata",
    },
  });
  assert.equal(update.isError, undefined, update.content[0]?.text);
  const updated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(updated.structuredContent.status, "applied");
  assert.equal(updated.structuredContent.diff.source.exact_match, true);
  const readback = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: createdScenarioRef, include: ["configuration"] },
  });
  assert.equal(
    readback.structuredContent.entity.configuration.text,
    secondLogicSource,
  );
  assert.deepEqual(
    hub.state.scenarios.find(({ index }) => index === "created-1"),
    {
      name: "Яркость при включении",
      desc: `${"Установить стартовый уровень один раз"}\n\n[${created.structuredContent.ownership_marker}]`,
      active: true,
      onStart: false,
      sync: false,
      type: "LOGIC",
      data: secondLogicSource,
      index: "created-1",
      predefined: false,
    },
  );

  const sourceRestored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(sourceRestored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.find(({ index }) => index === "created-1").data,
    firstLogicSource,
  );
  const assignmentRestored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: assignment.structuredContent.change_ref },
  });
  assert.equal(assignmentRestored.structuredContent.status, "restored");
  const sourceRemoved = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(sourceRemoved.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
  assert.equal(
    hub.state.logicTypes.some(({ type }) => type === "GeneratedLogicType1"),
    false,
  );
});

test("a lost LOGIC create response is reconciled without creating a duplicate", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Однократная яркость",
      description: "Проверить потерянный ответ",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не дублировать уже созданный LOGIC",
    },
  });
  hub.state.behavior.closeAfterCreate = true;
  const recovered = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(
    recovered.structuredContent.recovered_after_uncertain_write,
    true,
  );
  const repeated = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create?.type === "LOGIC")
      .length,
    1,
  );
});

test("an exact owned LOGIC source remains applied when the hub normalizes a create flag", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Нормализованный LOGIC",
      description: "Сохранить подтверждённый source",
      active: true,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не смешивать source ownership с native-нормализацией",
    },
  });
  hub.state.behavior.afterCreate = () => {
    hub.state.scenarios.find(({ index }) => index === "created-1").active =
      false;
  };

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.diff.source.exact_match, true);
  assert.equal(
    created.structuredContent.diff.editable_flags.exact_match,
    false,
  );
  assert.equal(created.structuredContent.diff.editable_flags.to.active, true);
  assert.equal(
    created.structuredContent.diff.editable_flags.observed.active,
    false,
  );

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.diff.source.exact_match, true);
  assert.equal(
    persisted.structuredContent.diff.editable_flags.observed.active,
    false,
  );

  const restored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
});

test("an owned LOGIC source remains editable and restorable while its type mapping is initially missing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Исправляемый LOGIC",
      description: "Сохранить владение отдельно от назначения",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Исправить source, если его тип пока не появился",
    },
  });
  hub.state.behavior.afterCreate = () => {
    hub.state.logicTypes = hub.state.logicTypes.filter(
      ({ type }) => type === smoothLogicType,
    );
  };

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(
    created.structuredContent.scenario_ref,
    `${homeRef}/scenario/created-1`,
  );
  assert.equal(created.structuredContent.diff.source.exact_match, true);
  assert.equal(created.structuredContent.logic_mapping_status, "missing");
  assert.equal(created.structuredContent.logic_assignment_ready, false);
  assert.equal(
    created.structuredContent.logic_mapping_reason,
    "logic_type_not_visible_after_create",
  );
  assert.equal(created.structuredContent.restore_supported, false);

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.logic_mapping_status, "missing");
  assert.equal(
    persisted.structuredContent.logic_mapping_reason,
    "logic_type_not_visible_after_create",
  );

  const blockedRestore = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(blockedRestore.structuredContent.status, "applied");
  assert.equal(blockedRestore.structuredContent.restore_supported, false);
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === "created-1",
    ),
    false,
  );

  const update = await restartedClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: created.structuredContent.scenario_ref,
      source: secondLogicSource,
      reason: "Исправить metadata исходника без нового сценария",
    },
  });
  hub.state.behavior.afterUpdate = () => {
    hub.state.logicTypes.push({
      type: "GeneratedLogicType1",
      name: "Исправляемый LOGIC",
      desc: "Доступен после исправления source",
    });
  };
  const updated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(updated.structuredContent.status, "applied");
  const sourceUpdates = hub.requests.filter(
    ({ scenario }) => scenario?.update?.index === "created-1",
  );
  assert.deepEqual(Object.keys(sourceUpdates.at(-1).scenario.update).sort(), [
    "data",
    "index",
  ]);

  const mappingRecovered = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    mappingRecovered.structuredContent.logic_mapping_status,
    "mapped",
  );
  assert.equal(mappingRecovered.structuredContent.logic_assignment_ready, true);
  assert.equal(
    mappingRecovered.structuredContent.native_logic_type,
    "GeneratedLogicType1",
  );

  const updateRestored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(updateRestored.structuredContent.status, "restored");
  delete hub.state.accessories[2].services;
  const sourceRestored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(sourceRestored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    false,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create?.type === "LOGIC")
      .length,
    1,
  );
});

test("an ambiguous LOGIC type mapping survives restart and can be resolved without recreating the source", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Неоднозначный LOGIC",
      description: "Не терять подтверждённый source",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Разделить source и выбор native type",
    },
  });
  hub.state.behavior.afterCreate = () => {
    hub.state.logicTypes.push({
      type: "ConcurrentLogicType",
      name: "Чужой одновременный LOGIC",
      desc: "Не считать его своим",
    });
  };

  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  assert.equal(created.structuredContent.logic_mapping_status, "ambiguous");
  assert.equal(created.structuredContent.logic_assignment_ready, false);
  assert.equal(
    created.structuredContent.logic_mapping_reason,
    "ambiguous_logic_type",
  );
  assert.deepEqual(created.structuredContent.candidate_logic_types.sort(), [
    "ConcurrentLogicType",
    "GeneratedLogicType1",
  ]);

  const restartedClient = await startClient(t, hub, stateDirectory);
  const persisted = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(persisted.structuredContent.status, "applied");
  assert.equal(persisted.structuredContent.logic_mapping_status, "ambiguous");
  assert.equal(
    persisted.structuredContent.logic_mapping_reason,
    "ambiguous_logic_type",
  );

  hub.state.logicTypes = hub.state.logicTypes.filter(
    ({ type }) => type !== "ConcurrentLogicType",
  );
  const resolved = await restartedClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(resolved.structuredContent.status, "applied");
  assert.equal(resolved.structuredContent.logic_mapping_status, "mapped");
  assert.equal(
    resolved.structuredContent.native_logic_type,
    "GeneratedLogicType1",
  );
  assert.equal(resolved.structuredContent.restore_supported, true);

  const restored = await restartedClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create?.type === "LOGIC")
      .length,
    1,
  );
});

test("LOGIC restoration rejects malformed present services without deleting its source", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Защищённый LOGIC",
      description: "Не удалять source при сломанном каталоге",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Отличить omitted repeated field от malformed",
    },
  });
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(created.structuredContent.status, "applied");
  hub.state.accessories[2].services = {};

  const rejected = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /incompatible_response/);
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    true,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === "created-1",
    ),
    false,
  );
});

test("a rejected LOGIC create remains not applied", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Ошибочный LOGIC",
      description: "Проверить ошибку компиляции",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не считать отклонённый source применённым",
    },
  });
  hub.state.behavior.rejectNextScenarioCreate = true;
  const rejected = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  const status = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(status.structuredContent.status, "not_applied");
  assert.equal(
    hub.state.scenarios.some(({ type }) => type === "LOGIC"),
    false,
  );
});

test("LOGIC restoration preserves a manual source edit and an assigned created type", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.scenarios.push({
    index: "manual-logic",
    name: "Ручной LOGIC",
    desc: "Существующий код",
    active: true,
    onStart: false,
    sync: false,
    type: "LOGIC",
    data: firstLogicSource,
    predefined: false,
  });
  const client = await startClient(t, hub, stateDirectory);
  const update = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_update",
      target_ref: `${homeRef}/scenario/manual-logic`,
      source: secondLogicSource,
      reason: "Проверить сохранение ручной правки",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  hub.state.scenarios.find(({ index }) => index === "manual-logic").data =
    `${secondLogicSource}\n// manual edit`;
  const sourceConflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(sourceConflict.structuredContent.status, "conflict");
  assert.equal(
    sourceConflict.structuredContent.conflict_reason,
    "manual_change",
  );
  assert.match(
    hub.state.scenarios.find(({ index }) => index === "manual-logic").data,
    /manual edit$/,
  );

  const create = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "logic_source_create",
      target_ref: serviceRef,
      name: "Новый LOGIC",
      description: "Проверить чужое назначение",
      active: false,
      on_start: false,
      sync: false,
      source: firstLogicSource,
      reason: "Не удалять используемый LOGIC",
    },
  });
  const created = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  hub.state.logics.push({
    aId: 32,
    sId: 13,
    type: created.structuredContent.native_logic_type,
    name: "Чужое назначение",
    active: true,
  });
  const assignmentConflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(assignmentConflict.structuredContent.status, "conflict");
  assert.equal(
    assignmentConflict.structuredContent.conflict_reason,
    "logic_assignments_present",
  );
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "created-1"),
    true,
  );
  assert.equal(
    hub.requests.some(
      ({ scenario }) => scenario?.delete?.index === "created-1",
    ),
    false,
  );
});
