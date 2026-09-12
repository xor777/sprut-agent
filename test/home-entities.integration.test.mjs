import assert from "node:assert/strict";
import { once } from "node:events";
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

const homes = [
  {
    serial: "home/A",
    name: "Одинаковый дом",
    online: true,
    owner: "owner-a@example.invalid",
    model: "Sprut.hub 2",
    version: { current: { version: "3.0.0b", revision: "20131" } },
  },
  {
    serial: "home B",
    name: "Одинаковый дом",
    online: true,
    owner: "owner-b@example.invalid",
    model: "Sprut.hub 2",
    version: { current: { version: "3.0.0b", revision: "20131" } },
  },
];

function homeState(serial) {
  const suffix = serial === "home/A" ? "A" : "B";
  return {
    rooms: [
      {
        id: 1,
        name:
          serial === "home/A"
            ? "Гостиная credential=room-secret-must-not-leak"
            : "Гостиная",
      },
    ],
    accessories: [
      {
        id: 32,
        roomId: 1,
        name: `Датчик ${suffix}`,
        online: true,
        extensionKey: `zigbee-${suffix}`,
        deviceId: `device-${suffix}`,
        deviceWindow: `window-${suffix}`,
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
                hasOptions: true,
                control: {
                  name: "Обнаружено движение",
                  type: "MotionDetected",
                  read: true,
                  write: false,
                  events: true,
                  unit: "boolean",
                  value: { boolValue: false },
                },
              },
              {
                aId: 32,
                sId: 13,
                cId: 16,
                hasOptions: false,
                control: {
                  name: "WiFiPassword",
                  type: "GenericString",
                  read: true,
                  write: false,
                  events: false,
                  value: {
                    stringValue: "characteristic-secret-must-not-leak",
                  },
                  unknownChild: {
                    payload: "nested-characteristic-secret-must-not-leak",
                  },
                },
              },
            ],
          },
        ],
      },
    ],
    scenarios: [
      {
        index: "motion-block",
        name: "Свет по движению",
        type: "BLOCK",
        predefined: false,
        active: true,
        onStart: false,
        sync: false,
        data: JSON.stringify({
          blockId: 0,
          targets: [
            {
              type: "if",
              blockId: 1,
              if: {
                type: "condition",
                blockId: 2,
                mode: "AND",
                conditions: [
                  {
                    type: "characteristic",
                    blockId: 3,
                    aId: 32,
                    sId: 13,
                    cId: 15,
                    value: "true",
                    cond: "=",
                    trigger: true,
                    hs: "MotionSensor",
                    hc: "MotionDetected",
                    time: 0,
                    timeCond: "",
                  },
                ],
              },
              // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK scenarios use this native key.
              then: [],
              else: [],
              then_delay: 0,
              else_delay: 0,
              mode: "EVERY",
            },
          ],
          connection: {
            key: "WiFiPassword/identifier-secret-must-not-leak",
            value: { stringValue: "block-secret-must-not-leak" },
            unknownChild: {
              payload: "nested-block-secret-must-not-leak",
            },
          },
          siblingForms: [
            {
              kind: "object",
              connection: {
                ordinary: "object-connection-secret-must-not-leak",
                unknownChild: {
                  payload: "object-child-secret-must-not-leak",
                },
              },
            },
            {
              kind: "array",
              connection: [
                {
                  ordinary: "array-connection-secret-must-not-leak",
                  unknownChild: {
                    payload: "array-child-secret-must-not-leak",
                  },
                },
              ],
            },
            {
              kind: "scalar",
              connection: "scalar-connection-secret-must-not-leak",
            },
          ],
          neutralConnectionEcho: "opaque-4f9a8b7c",
          opaqueKeyForms: {
            safeNeighbor: "available",
            nested: {
              "prefix-opaque-4f9a8b7c-suffix": "hidden-key-container",
              unknownChild: "key-child-secret-must-not-leak",
            },
            inArray: [
              { safeNeighbor: "available-in-array" },
              {
                "prefix-opaque-4f9a8b7c-suffix": "hidden-array-key-container",
                unknownChild: "array-key-child-secret-must-not-leak",
              },
            ],
          },
          terminalMarker: {
            redacted: true,
            reason: "sensitive_native_data",
            laterPayload: "marker-child-secret-must-not-leak",
          },
        }),
      },
      {
        index: "global-code",
        name: "Глобальный сценарий",
        type: "GLOBAL",
        predefined: false,
        active: true,
        data: 'const clientSecret = "must-not-leak";\nconst auth = "Bearer code-secret-must-not-leak";\nlog.info("ready");',
      },
    ],
    extensions: [
      {
        id: 1,
        extensionKey: "Bridge:yandex_1",
        type: "yandex",
        index: "yandex_1",
        bundleType: "BRIDGE",
        name: "Yandex",
        optionsWindow: "Bridge/yandex_1/",
        enabled: true,
        state: "LOADED",
      },
      {
        id: 2,
        extensionKey: "Bridge:yandex_2",
        type: "yandex",
        index: "yandex_2",
        bundleType: "BRIDGE",
        name: "VK",
        optionsWindow: "Bridge/yandex_2/",
        enabled: true,
        state: "LOADED",
      },
      {
        id: 1,
        extensionKey: `Controller:zigbee_${suffix}`,
        type: "zigbee",
        index: `zigbee_${suffix}`,
        bundleType: "CONTROLLER",
        name: `ZigBee ${suffix}`,
        optionsWindow: `Controller/zigbee_${suffix}/`,
        enabled: true,
        state: "LOADED",
      },
    ],
    window: {
      windowKey: `window-${suffix}`,
      label: { text: "Настройки устройства" },
      options: [
        {
          key: "primary",
          name: "Основное",
          type: "GenericInteger",
          inputType: "GROUP",
          read: true,
          write: true,
          events: true,
          value: { intValue: 0 },
        },
        {
          key: "Remove",
          name: "Удалить",
          type: "GenericBoolean",
          inputType: "BUTTON_DANGER",
          read: true,
          write: true,
          events: true,
          value: { boolValue: true },
        },
        {
          key: "/1/FCC0_ManufacturerSpecific/0102_SensorDetectionSeconds/60",
          name: "Период обнаружения",
          type: "GenericInteger",
          inputType: "NUMBER",
          read: true,
          write: true,
          events: true,
          minValue: 1,
          maxValue: 200,
          minStep: 1,
          value: { intValue: 10 },
        },
        {
          key: "/1/FCC0_ManufacturerSpecific/0202_SensorDetectionSeconds/30",
          name: "Другой период обнаружения",
          type: "GenericInteger",
          inputType: "NUMBER",
          read: true,
          write: true,
          events: true,
          minValue: 1,
          maxValue: 200,
          minStep: 1,
          value: { intValue: 20 },
        },
        {
          key: "WiFiPassword=identifier-secret-must-not-leak",
          name: "Network setting",
          type: "GenericString",
          inputType: "TEXT",
          read: true,
          write: true,
          events: false,
          value: { stringValue: "structured-secret-must-not-leak" },
        },
        {
          key: "opaque-setting",
          name: "Opaque setting",
          type: "GenericString",
          inputType: "PASSWORD",
          read: true,
          write: true,
          events: false,
          value: { stringValue: "password-metadata-secret-must-not-leak" },
        },
        {
          key: "Info",
          name: "",
          type: "GenericString",
          inputType: "HTML",
          read: true,
          write: true,
          events: true,
          value: {
            stringValue:
              serial === "home/A"
                ? "<li>0102_SensorDetectionSeconds (115F): 61 [UNSIGNED_8_BIT_INTEGER]</li>\n<li>0202_SensorDetectionSeconds (225F): 31 [UNSIGNED_8_BIT_INTEGER]</li>"
                : "status=ok",
          },
        },
        {
          key: "ConnectionDiagnostics",
          name: "Connection diagnostics",
          type: "GenericString",
          inputType: "INFO",
          read: true,
          write: false,
          events: true,
          value: {
            stringValue:
              "Authorization: Bearer diagnostic-secret-must-not-leak",
          },
        },
      ],
    },
  };
}

async function startHub() {
  const states = new Map(
    homes.map(({ serial }) => [serial, homeState(serial)]),
  );
  const requests = [];
  const responseSentAt = [];
  const behavior = {
    delayExtensionMs: 0,
    delayWindowMs: 0,
    unsupportedScenarioGet: false,
    characteristicOptionsResult: null,
    logicOptionsResult: null,
  };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      if (behavior.delayWindowMs > 0 && request.params.window?.get) {
        await new Promise((resolve) =>
          setTimeout(resolve, behavior.delayWindowMs),
        );
      }
      if (behavior.delayExtensionMs > 0 && request.params.extension?.list) {
        await new Promise((resolve) =>
          setTimeout(resolve, behavior.delayExtensionMs),
        );
      }
      if (behavior.unsupportedScenarioGet && request.params.scenario?.get) {
        responseSentAt.push({ request, at: Date.now() });
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }
      const result = respond(states, request, behavior);
      responseSentAt.push({ request, at: Date.now() });
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    states,
    requests,
    responseSentAt,
    behavior,
    server,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(states, request, behavior) {
  if (request.params.hub?.list) return { hub: { list: { hubs: homes } } };
  const state = states.get(request.serial);
  assert(state, `unexpected home serial: ${request.serial}`);
  const params = request.params;
  if (params.room?.list) return { room: { list: { rooms: state.rooms } } };
  if (params.room?.get)
    return {
      room: {
        get: state.rooms.find(({ id }) => id === params.room.get.id) ?? null,
      },
    };
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
  if (params.characteristic?.getOptions) {
    if (behavior.characteristicOptionsResult !== null) {
      return behavior.characteristicOptionsResult;
    }
    if (params.characteristic.getOptions.cId === 17) {
      return { characteristic: { getOptions: { options: [] } } };
    }
    if (params.characteristic.getOptions.cId === 16) {
      return {
        characteristic: {
          getOptions: {
            options: [
              {
                key: "opaque-setting",
                name: "Opaque setting",
                type: "GenericString",
                inputType: "TEXT",
                read: true,
                write: false,
                events: false,
                value: {
                  stringValue: "parent-sensitive-secret-must-not-leak",
                },
              },
            ],
          },
        },
      };
    }
    return {
      characteristic: {
        getOptions: {
          options: [
            {
              key: "SwitchOffTime",
              name: "Выключить через (сек.)",
              type: "GenericDouble",
              unit: "s",
              read: true,
              write: true,
              events: true,
              value: { doubleValue: 180 },
            },
            {
              key: "clientSecret",
              name: "Client secret",
              type: "GenericString",
              inputType: "PASSWORD",
              read: true,
              write: true,
              events: false,
              value: { stringValue: "option-secret-must-not-leak" },
            },
          ],
        },
      },
    };
  }
  if (params.logic?.list) {
    return {
      logic: {
        list: {
          logics: [
            {
              type: "MotionDetectedFromCurrentMotionLevel",
              name: "Определение движения",
              active: true,
            },
          ],
        },
      },
    };
  }
  if (params.logic?.types) {
    return {
      logic: {
        types: {
          logicTypes: [
            {
              type: "MotionDetectedFromCurrentMotionLevel",
              name: "Определение движения",
              desc: "Определяет движение по текущему уровню",
            },
          ],
        },
      },
    };
  }
  if (params.logic?.get) {
    return {
      logic: {
        get: {
          aId: params.logic.get.aId,
          sId: params.logic.get.sId,
          type: params.logic.get.type,
          name: "Определение движения",
          active: true,
        },
      },
    };
  }
  if (params.logic?.getOptions) {
    if (behavior.logicOptionsResult !== null) {
      return behavior.logicOptionsResult;
    }
    return { logic: { getOptions: { options: [] } } };
  }
  if (params.link?.list) return { link: { list: {} } };
  if (params.window?.get) return { window: { get: state.window } };
  if (params.scenario?.list) {
    return {
      scenario: {
        list: {
          scenarios:
            params.scenario.list.aId === undefined ? state.scenarios : [],
        },
      },
    };
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
  if (params.extension?.list)
    return { extension: { list: { extensions: state.extensions } } };
  assert.fail(`unsupported test request: ${JSON.stringify(params)}`);
}

async function startClient(t, hub) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "opaque-4f9a8b7c",
      SPRUTHUB_SERIAL: "home/A",
      SPRUTHUB_CID: "home-entity-test",
      SPRUTHUB_TIMEOUT_MS: "500",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "home-entity-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
  });
  await client.connect(transport);
  return client;
}

test("home-qualified discovery keeps matching local IDs in different homes separate", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(
    catalog.structuredContent.homes.map(({ ref, name }) => ({ ref, name })),
    [
      { ref: "spruthub://hub/home%2FA", name: "Одинаковый дом" },
      { ref: "spruthub://hub/home%20B", name: "Одинаковый дом" },
    ],
  );
  assert.equal(catalog.structuredContent.selection.required, true);
  assert.equal(catalog.structuredContent.homes[0].access.ownership, "unknown");
  assert.equal(
    catalog.structuredContent.homes[0].access.native_owner,
    "owner-a@example.invalid",
  );

  const overview = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: "spruthub://hub/home%20B" },
  });
  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  assert.equal(overview.structuredContent.home.ref, "spruthub://hub/home%20B");
  assert.deepEqual(overview.structuredContent.entities.rooms, [
    { ref: "spruthub://hub/home%20B/room/1", name: "Гостиная" },
  ]);
  const room = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: "spruthub://hub/home%20B/room/1" },
  });
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.deepEqual(room.structuredContent.entity.accessories, [
    {
      ref: "spruthub://hub/home%20B/accessory/32",
      name: "Датчик B",
      available: true,
      services: [
        {
          ref: "spruthub://hub/home%20B/accessory/32/service/13",
          name: "Движение",
          type: "MotionSensor",
        },
      ],
    },
  ]);
  for (const request of hub.requests.filter(
    ({ params }) => !params.hub?.list,
  )) {
    assert.equal(request.serial, "home B");
  }
  for (const request of hub.requests.filter(({ params }) => params.hub?.list)) {
    assert.equal("serial" in request, false);
  }
});

test("compact room catalog preserves named services without reading their values", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.accessories = [
    {
      id: 70,
      roomId: 1,
      name: "Настенный контроллер",
      online: true,
      services: [
        {
          aId: 70,
          sId: 21,
          name: "Лампа письменного стола",
          type: "Lightbulb",
          characteristics: [
            {
              aId: 70,
              sId: 21,
              cId: 15,
              control: {
                name: "Включена",
                type: "On",
                read: true,
                write: true,
                value: { boolValue: false },
              },
            },
          ],
        },
        {
          aId: 70,
          sId: 22,
          name: "Вентилятор",
          type: "Fan",
          characteristics: [],
        },
      ],
    },
    {
      id: 81,
      roomId: 1,
      name: "Лампа у окна",
      online: true,
      services: [
        {
          aId: 81,
          sId: 4,
          name: "Основной свет",
          type: "Lightbulb",
          characteristics: [],
        },
      ],
    },
  ];
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: "spruthub://hub/home%2FA/room/1" },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(result.structuredContent.entity.accessories, [
    {
      ref: "spruthub://hub/home%2FA/accessory/70",
      name: "Настенный контроллер",
      available: true,
      services: [
        {
          ref: "spruthub://hub/home%2FA/accessory/70/service/21",
          name: "Лампа письменного стола",
          type: "Lightbulb",
        },
        {
          ref: "spruthub://hub/home%2FA/accessory/70/service/22",
          name: "Вентилятор",
          type: "Fan",
        },
      ],
    },
    {
      ref: "spruthub://hub/home%2FA/accessory/81",
      name: "Лампа у окна",
      available: true,
      services: [
        {
          ref: "spruthub://hub/home%2FA/accessory/81/service/4",
          name: "Основной свет",
          type: "Lightbulb",
        },
      ],
    },
  ]);
  const compact = JSON.stringify(result.structuredContent.entity.accessories);
  assert.doesNotMatch(compact, /characteristics|readings|current_value/);
});

test("characteristic detail keeps configuration separate from unlinked diagnostics", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      include: [
        "options",
        "physical_configuration",
        "relations",
        "diagnostics",
      ],
    },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const entity = result.structuredContent.entity;

  assert.deepEqual(entity.current_value, {
    value: false,
    source: "characteristic",
    source_timestamp: null,
  });
  assert.deepEqual(entity.options, [
    {
      key: "SwitchOffTime",
      name: "Выключить через (сек.)",
      type: "GenericDouble",
      configured_value: 180,
      unit: "s",
      read: true,
      write: true,
      events: true,
    },
    { redacted: true, reason: "sensitive_native_data" },
  ]);
  const detections = entity.physical_configuration.options.filter(
    ({ property }) => property === "SensorDetectionSeconds",
  );
  assert.equal(detections.length, 2);
  const [detection, otherDetection] = detections;
  assert.equal(detection.configured_value, 10);
  assert.equal(detection.reported_value, null);
  assert.equal(detection.reported_source, null);
  assert.equal(detection.pending, "unknown");
  assert.equal(detection.source_timestamp, null);
  assert.equal(otherDetection.configured_value, 20);
  assert.equal(otherDetection.reported_value, null);
  assert.equal(otherDetection.reported_source, null);
  assert.deepEqual(
    {
      min: detection.min,
      max: detection.max,
      step: detection.step,
    },
    { min: 1, max: 200, step: 1 },
  );
  assert.deepEqual(
    entity.physical_configuration.layout.map(({ key }) => key),
    ["primary"],
  );
  assert.deepEqual(
    entity.physical_configuration.commands.map(({ key }) => key),
    ["Remove"],
  );
  assert.equal(
    Object.hasOwn(
      entity.physical_configuration.commands[0],
      "configured_value",
    ),
    false,
  );
  assert.deepEqual(entity.physical_configuration.options.slice(-2), [
    { redacted: true, reason: "sensitive_native_data" },
    { redacted: true, reason: "sensitive_native_data" },
  ]);
  assert.deepEqual(entity.relations.assigned_logics, [
    {
      ref: "spruthub://hub/home%2FA/accessory/32/service/13/logic/MotionDetectedFromCurrentMotionLevel",
      type: "MotionDetectedFromCurrentMotionLevel",
      name: "Определение движения",
      active: true,
    },
  ]);
  assert.match(entity.diagnostics[0].text, /SensorDetectionSeconds.*61/);
  assert.match(entity.diagnostics[0].text, /SensorDetectionSeconds.*31/);
  assert.equal(entity.diagnostics[1].text, "[REDACTED]");
  assert.equal(entity.freshness.source_timestamp, null);
});

test("get_entity distinguishes unread, found, empty, and unapplied option scopes", async (t) => {
  const hub = await startHub();
  const service = hub.states.get("home/A").accessories[0].services[0];
  service.characteristics.push({
    aId: 32,
    sId: 13,
    cId: 17,
    control: {
      name: "Освещённость",
      type: "CurrentAmbientLightLevel",
      read: true,
      write: false,
      events: true,
      unit: "lux",
      value: { doubleValue: 24 },
    },
  });
  const client = await startClient(t, hub);

  const accessoryStart = hub.requests.length;
  const accessory = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/accessory/32",
      include: ["options"],
    },
  });
  assert.equal(accessory.isError, undefined, accessory.content[0]?.text);
  const nested = accessory.structuredContent.entity.services[0].characteristics;
  assert.deepEqual(nested[0].option_scope, {
    native_has_options: true,
    status: "not_read",
    next: {
      tool: "get_entity",
      arguments: {
        entity_ref:
          "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
        include: ["options"],
      },
    },
  });
  assert.deepEqual(nested[1], {
    redacted: true,
    reason: "sensitive_native_data",
  });
  assert.deepEqual(nested[2].option_scope, {
    native_has_options: null,
    status: "not_read",
    next: {
      tool: "get_entity",
      arguments: {
        entity_ref:
          "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/17",
        include: ["options"],
      },
    },
  });
  assert.deepEqual(accessory.structuredContent.entity.include_resolution, {
    requested: ["options"],
    applied: [],
    not_applied: [
      {
        include: "options",
        reason: "characteristic_scoped",
        next: {
          tool: "get_entity",
          candidates: [
            {
              entity_ref:
                "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
              include: ["options"],
              native_has_options: true,
            },
            {
              entity_ref:
                "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/17",
              include: ["options"],
              native_has_options: null,
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    hub.requests
      .slice(accessoryStart)
      .map(({ params }) => Object.keys(params)[0]),
    ["hub", "accessory"],
  );

  const serviceResult = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
      include: ["options"],
    },
  });
  assert.deepEqual(
    serviceResult.structuredContent.entity.include_resolution,
    accessory.structuredContent.entity.include_resolution,
  );

  const found = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      include: ["options"],
    },
  });
  assert.equal(found.isError, undefined, found.content[0]?.text);
  assert.equal(found.structuredContent.entity.options.length, 2);
  assert.deepEqual(found.structuredContent.entity.option_scope, {
    ...nested[0].option_scope,
    status: "found",
  });
  assert.deepEqual(found.structuredContent.entity.include_resolution, {
    requested: ["options"],
    applied: ["options"],
    not_applied: [],
  });

  const empty = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/17",
      include: ["options"],
    },
  });
  assert.equal(empty.isError, undefined, empty.content[0]?.text);
  assert.deepEqual(empty.structuredContent.entity.options, []);
  assert.deepEqual(empty.structuredContent.entity.option_scope, {
    ...nested[2].option_scope,
    status: "checked_empty",
  });
  assert.deepEqual(empty.structuredContent.entity.include_resolution, {
    requested: ["options"],
    applied: ["options"],
    not_applied: [],
  });
});

test("get_entity rejects incomplete option operations without turning them into checked empty", async (t) => {
  const hub = await startHub();
  const service = hub.states.get("home/A").accessories[0].services[0];
  service.characteristics.push({
    aId: 32,
    sId: 13,
    cId: 17,
    hasOptions: true,
    control: {
      name: "Освещённость",
      type: "CurrentAmbientLightLevel",
      read: true,
      write: false,
      events: true,
      unit: "lux",
      value: { doubleValue: 24 },
    },
  });
  const client = await startClient(t, hub);
  const entity_ref =
    "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15";

  for (const invalidResult of [
    {},
    { characteristic: { getOptions: null } },
    { characteristic: { getOptions: { options: {} } } },
  ]) {
    hub.behavior.characteristicOptionsResult = invalidResult;
    const result = await client.callTool({
      name: "get_entity",
      arguments: { entity_ref, include: ["options"] },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "incompatible_response");
  }

  hub.behavior.characteristicOptionsResult = null;
  const explicitEmpty = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/17",
      include: ["options"],
    },
  });
  assert.equal(
    explicitEmpty.isError,
    undefined,
    explicitEmpty.content[0]?.text,
  );
  assert.deepEqual(explicitEmpty.structuredContent.entity.options, []);
  assert.equal(
    explicitEmpty.structuredContent.entity.option_scope.status,
    "checked_empty",
  );
  assert.deepEqual(explicitEmpty.structuredContent.entity.include_resolution, {
    requested: ["options"],
    applied: ["options"],
    not_applied: [],
  });
});

test("an observed empty logic getOptions keeps the assigned logic readable", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const entityRef =
    "spruthub://hub/home%2FA/accessory/32/service/13/logic/MotionDetectedFromCurrentMotionLevel";

  hub.behavior.logicOptionsResult = { logic: { getOptions: {} } };
  const empty = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: entityRef, include: ["options"] },
  });
  assert.equal(empty.isError, undefined, empty.content[0]?.text);
  assert.equal(empty.structuredContent.entity.kind, "logic");
  assert.deepEqual(empty.structuredContent.entity.options, []);
  assert.deepEqual(empty.structuredContent.entity.include_resolution, {
    requested: ["options"],
    applied: ["options"],
    not_applied: [],
  });

  for (const invalidResult of [
    {},
    { logic: { getOptions: null } },
    { logic: { getOptions: { options: {} } } },
  ]) {
    hub.behavior.logicOptionsResult = invalidResult;
    const invalid = await client.callTool({
      name: "get_entity",
      arguments: { entity_ref: entityRef, include: ["options"] },
    });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.code, "incompatible_response");
  }
});

test("get_entity resolves every requested include at the common entity boundary", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const cases = [
    {
      kind: "home",
      entity_ref: "spruthub://hub/home%2FA",
      expectedApplied: [],
      expectedNext: {
        tool: "inspect_home",
        arguments: { home_ref: "spruthub://hub/home%2FA" },
      },
    },
    {
      kind: "room",
      entity_ref: "spruthub://hub/home%2FA/room/1",
      expectedApplied: [],
      expectedCandidate: "spruthub://hub/home%2FA/accessory/32",
    },
    {
      kind: "accessory",
      entity_ref: "spruthub://hub/home%2FA/accessory/32",
      expectedApplied: ["physical_configuration", "relations", "diagnostics"],
      expectedCandidate:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
    },
    {
      kind: "service",
      entity_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
      expectedApplied: [],
      expectedCandidate:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
    },
    {
      kind: "characteristic",
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      expectedApplied: [
        "options",
        "physical_configuration",
        "relations",
        "diagnostics",
      ],
    },
    {
      kind: "scenario",
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      expectedApplied: ["configuration"],
    },
    {
      kind: "extension",
      entity_ref: "spruthub://hub/home%2FA/extension/Bridge%3Ayandex_1",
      expectedApplied: [],
      expectedNext: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/window/Bridge%2Fyandex_1%2F",
        },
      },
    },
    {
      kind: "logic",
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/logic/MotionDetectedFromCurrentMotionLevel",
      expectedApplied: ["options"],
    },
    {
      kind: "window",
      entity_ref: "spruthub://hub/home%2FA/window/window-A",
      expectedApplied: ["physical_configuration", "diagnostics"],
    },
  ];
  const includes = [
    "configuration",
    "options",
    "physical_configuration",
    "relations",
    "diagnostics",
  ];

  for (const testCase of cases) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: testCase.entity_ref,
        include: includes,
      },
    });
    assert.equal(
      result.isError,
      undefined,
      `${testCase.kind}: ${result.content[0]?.text}`,
    );
    const resolution = result.structuredContent.entity.include_resolution;
    assert.deepEqual(resolution?.requested, includes, testCase.kind);
    assert.deepEqual(
      [...resolution.applied].sort(),
      [...testCase.expectedApplied].sort(),
      testCase.kind,
    );
    assert.deepEqual(
      resolution.not_applied.map(({ include }) => include).sort(),
      includes
        .filter((include) => !testCase.expectedApplied.includes(include))
        .sort(),
      testCase.kind,
    );
    const outcome = resolution.not_applied.find(
      ({ include }) => include === "options",
    );
    if (!outcome) continue;
    if (testCase.expectedNext) {
      assert.deepEqual(outcome.next, testCase.expectedNext, testCase.kind);
      const followUp = await client.callTool({
        name: outcome.next.tool,
        arguments: outcome.next.arguments,
      });
      assert.equal(
        followUp.isError,
        undefined,
        `${testCase.kind} next: ${followUp.content[0]?.text}`,
      );
    } else if (testCase.expectedCandidate) {
      assert.equal(outcome.next?.tool, "get_entity", testCase.kind);
      const candidate = outcome.next.candidates.find(
        ({ entity_ref }) => entity_ref === testCase.expectedCandidate,
      );
      assert.ok(candidate, testCase.kind);
      const followUp = await client.callTool({
        name: outcome.next.tool,
        arguments: {
          entity_ref: candidate.entity_ref,
          include: candidate.include,
        },
      });
      assert.equal(
        followUp.isError,
        undefined,
        `${testCase.kind} candidate: ${followUp.content[0]?.text}`,
      );
    } else {
      assert.equal(typeof outcome.limitation, "string", testCase.kind);
      assert.equal(Object.hasOwn(outcome, "next"), false, testCase.kind);
    }
  }
});

test("get_entity non-option next reads advance through known safe owner refs", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const cases = [
    {
      kind: "room",
      entity_ref: "spruthub://hub/home%2FA/room/1",
      includes: ["relations", "physical_configuration", "diagnostics"],
      expectedCandidate: "spruthub://hub/home%2FA/accessory/32",
    },
    {
      kind: "service_characteristic",
      entity_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
      includes: ["relations"],
      expectedCandidate:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
    },
    {
      kind: "service_window",
      entity_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
      includes: ["physical_configuration", "diagnostics"],
      expectedNextRef: "spruthub://hub/home%2FA/window/window-A",
    },
    {
      kind: "extension",
      entity_ref: "spruthub://hub/home%2FA/extension/Bridge%3Ayandex_1",
      includes: ["physical_configuration", "diagnostics"],
      expectedNextRef: "spruthub://hub/home%2FA/window/Bridge%2Fyandex_1%2F",
    },
  ];

  for (const testCase of cases) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: testCase.entity_ref,
        include: testCase.includes,
      },
    });
    assert.equal(result.isError, undefined, testCase.kind);
    for (const include of testCase.includes) {
      const outcome =
        result.structuredContent.entity.include_resolution.not_applied.find(
          (candidate) => candidate.include === include,
        );
      assert.ok(outcome?.next, `${testCase.kind}:${include}`);
      let nextArguments = outcome.next.arguments;
      if (testCase.expectedCandidate) {
        const candidate = outcome.next.candidates.find(
          ({ entity_ref }) => entity_ref === testCase.expectedCandidate,
        );
        assert.ok(candidate, `${testCase.kind}:${include}`);
        nextArguments = {
          entity_ref: candidate.entity_ref,
          include: candidate.include,
        };
      } else {
        assert.equal(
          nextArguments.entity_ref,
          testCase.expectedNextRef,
          `${testCase.kind}:${include}`,
        );
      }
      const followUp = await client.callTool({
        name: outcome.next.tool,
        arguments: nextArguments,
      });
      assert.equal(
        followUp.isError,
        undefined,
        `${testCase.kind}:${include} next: ${followUp.content[0]?.text}`,
      );
      assert.ok(
        followUp.structuredContent.entity.include_resolution.applied.includes(
          include,
        ),
        `${testCase.kind}:${include}`,
      );
    }
  }

  const home = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA",
      include: ["configuration"],
    },
  });
  const homeOutcome =
    home.structuredContent.entity.include_resolution.not_applied[0];
  assert.deepEqual(homeOutcome.next, {
    tool: "inspect_home",
    arguments: { home_ref: "spruthub://hub/home%2FA" },
  });
  const catalog = await client.callTool({
    name: homeOutcome.next.tool,
    arguments: homeOutcome.next.arguments,
  });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.ok(catalog.structuredContent.entities.scenarios.length > 0);

  const window = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/window/window-A",
      include: ["physical_configuration"],
    },
  });
  assert.deepEqual(window.structuredContent.entity.include_resolution, {
    requested: ["physical_configuration"],
    applied: ["physical_configuration"],
    not_applied: [],
  });

  const scenario = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      include: ["relations"],
    },
  });
  const unavailable =
    scenario.structuredContent.entity.include_resolution.not_applied[0];
  assert.equal(typeof unavailable.limitation, "string");
  assert.equal(Object.hasOwn(unavailable, "next"), false);
});

test("get_entity stops diagnostics routing after the physical owner is checked", async (t) => {
  for (const variant of ["missing_window", "empty_diagnostics"]) {
    await t.test(variant, async (t) => {
      const hub = await startHub();
      const accessory = hub.states.get("home/A").accessories[0];
      if (variant === "missing_window") {
        delete accessory.deviceWindow;
      } else {
        hub.states.get("home/A").window.options = hub.states
          .get("home/A")
          .window.options.filter(
            ({ inputType }) =>
              !["HTML", "INFO", "CLIPBOARD"].includes(inputType),
          );
      }
      const client = await startClient(t, hub);

      const room = await client.callTool({
        name: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/room/1",
          include: ["diagnostics"],
        },
      });
      const roomOutcome =
        room.structuredContent.entity.include_resolution.not_applied[0];
      const accessoryCandidate = roomOutcome.next.candidates[0];
      const owner = await client.callTool({
        name: roomOutcome.next.tool,
        arguments: {
          entity_ref: accessoryCandidate.entity_ref,
          include: accessoryCandidate.include,
        },
      });
      assert.equal(owner.isError, undefined, owner.content[0]?.text);
      const entity = owner.structuredContent.entity;

      if (variant === "missing_window") {
        assert.equal(entity.native.device_window_ref, null);
        assert.equal(entity.physical_configuration, null);
        assert.deepEqual(entity.include_resolution.applied, []);
        assert.equal(entity.include_resolution.not_applied.length, 1);
        const outcome = entity.include_resolution.not_applied[0];
        assert.equal(outcome.include, "diagnostics");
        assert.equal(typeof outcome.limitation, "string");
        assert.equal(Object.hasOwn(outcome, "next"), false);
      } else {
        assert.notEqual(entity.native.device_window_ref, null);
        assert.deepEqual(entity.diagnostics, []);
        assert.deepEqual(entity.include_resolution, {
          requested: ["diagnostics"],
          applied: ["diagnostics"],
          not_applied: [],
        });
      }
    });
  }
});

test("extension refs preserve native instance identity", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const overview = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: "spruthub://hub/home%2FA" },
  });
  const bridgeRefs = overview.structuredContent.entities.extensions
    .filter(({ type }) => type === "yandex")
    .map(({ ref }) => ref);
  assert.deepEqual(bridgeRefs, [
    "spruthub://hub/home%2FA/extension/Bridge%3Ayandex_1",
    "spruthub://hub/home%2FA/extension/Bridge%3Ayandex_2",
  ]);

  const instances = await Promise.all(
    bridgeRefs.map((entity_ref) =>
      client.callTool({ name: "get_entity", arguments: { entity_ref } }),
    ),
  );
  assert.deepEqual(
    instances.map(({ structuredContent }) => structuredContent.entity.name),
    ["Yandex", "VK"],
  );
});

test("extension catalog rejects missing and conflicting native identity", async (t) => {
  for (const { mutate, ref, errorCode } of [
    {
      mutate: (extensions) => delete extensions[0].extensionKey,
      ref: "spruthub://hub/home%2FA/extension/yandex",
      errorCode: "entity_not_found",
    },
    {
      mutate: (extensions) => {
        extensions[1].extensionKey = extensions[0].extensionKey;
      },
      ref: "spruthub://hub/home%2FA/extension/Bridge%3Ayandex_1",
      errorCode: "incompatible_response",
    },
  ]) {
    const hub = await startHub();
    mutate(hub.states.get("home/A").extensions);
    const client = await startClient(t, hub);
    const result = await client.callTool({
      name: "inspect_home",
      arguments: { home_ref: "spruthub://hub/home%2FA" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "incompatible_response");
    assert.doesNotMatch(result.content[0].text, /extension\/yandex/);

    const read = await client.callTool({
      name: "get_entity",
      arguments: { entity_ref: ref },
    });
    assert.equal(read.isError, true);
    assert.equal(read.structuredContent.error.code, errorCode);
  }
});

test("missing independent device report stays unknown", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%20B/accessory/32",
      include: ["physical_configuration", "diagnostics"],
    },
  });
  const detection =
    result.structuredContent.entity.physical_configuration.options.find(
      ({ property }) => property === "SensorDetectionSeconds",
    );
  assert.equal(detection.reported_value, null);
  assert.equal(detection.reported_source, null);
  assert.equal(detection.pending, "unknown");
});

test("native secrets are redacted from structured and text output", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const characteristic = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      include: ["options", "physical_configuration", "diagnostics"],
    },
  });
  const scenario = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/global-code",
      include: ["configuration"],
    },
  });
  const sensitiveCharacteristic = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/16",
    },
  });
  const overview = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: "spruthub://hub/home%2FA" },
  });
  const block = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      include: ["configuration"],
    },
  });
  assert.deepEqual(sensitiveCharacteristic.structuredContent.entity, {
    redacted: true,
    reason: "sensitive_native_data",
  });
  assert.deepEqual(
    block.structuredContent.entity.configuration.value.connection,
    { redacted: true, reason: "sensitive_native_data" },
  );
  assert.deepEqual(
    block.structuredContent.entity.configuration.value.siblingForms.map(
      ({ connection }) => connection,
    ),
    [
      { redacted: true, reason: "sensitive_native_data" },
      { redacted: true, reason: "sensitive_native_data" },
      { redacted: true, reason: "sensitive_native_data" },
    ],
  );
  assert.equal(
    block.structuredContent.entity.configuration.value.neutralConnectionEcho,
    "[REDACTED]",
  );
  const tokenKeys =
    block.structuredContent.entity.configuration.value.opaqueKeyForms;
  assert.equal(tokenKeys.safeNeighbor, "available");
  assert.deepEqual(tokenKeys.nested, {
    redacted: true,
    reason: "sensitive_native_data",
  });
  assert.deepEqual(tokenKeys.inArray, [
    { safeNeighbor: "available-in-array" },
    { redacted: true, reason: "sensitive_native_data" },
  ]);
  assert.deepEqual(
    block.structuredContent.entity.configuration.value.terminalMarker,
    { redacted: true, reason: "sensitive_native_data" },
  );
  const visible = JSON.stringify({
    characteristic,
    sensitiveCharacteristic,
    scenario,
    block,
    overview,
  });
  for (const secret of [
    "structured-secret-must-not-leak",
    "option-secret-must-not-leak",
    "diagnostic-secret-must-not-leak",
    "code-secret-must-not-leak",
    "block-secret-must-not-leak",
    "room-secret-must-not-leak",
    "key-secret-must-not-leak",
    "identifier-secret-must-not-leak",
    "characteristic-secret-must-not-leak",
    "nested-characteristic-secret-must-not-leak",
    "nested-block-secret-must-not-leak",
    "object-connection-secret-must-not-leak",
    "object-child-secret-must-not-leak",
    "array-connection-secret-must-not-leak",
    "array-child-secret-must-not-leak",
    "scalar-connection-secret-must-not-leak",
    "opaque-4f9a8b7c",
    "key-child-secret-must-not-leak",
    "array-key-child-secret-must-not-leak",
    "marker-child-secret-must-not-leak",
    "must-not-leak",
  ]) {
    assert.doesNotMatch(visible, new RegExp(secret));
  }
  assert.match(visible, /\[REDACTED\]/);
});

test("sensitive characteristic marker is terminal for every include", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const includeCases = [
    [],
    ["options"],
    ["relations"],
    ["physical_configuration"],
    ["diagnostics"],
    ["options", "relations", "physical_configuration", "diagnostics"],
  ];

  for (const include of includeCases) {
    const requestStart = hub.requests.length;
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref:
          "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/16",
        include,
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.deepEqual(result.structuredContent.entity, {
      redacted: true,
      reason: "sensitive_native_data",
    });
    assert.doesNotMatch(result.content[0].text, /parent-sensitive-secret/);
    assert.deepEqual(
      hub.requests
        .slice(requestStart)
        .map(({ params }) => Object.keys(params)[0]),
      ["hub", "accessory"],
    );
  }
});

test("freshness belongs to each completed native response", async (t) => {
  const hub = await startHub();
  hub.behavior.delayWindowMs = 50;
  const client = await startClient(t, hub);
  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      include: ["physical_configuration"],
    },
  });
  const windowSentAt = hub.responseSentAt.findLast(({ request }) =>
    Boolean(request.params.window?.get),
  ).at;
  assert(
    Date.parse(result.structuredContent.entity.freshness.observed_at) <
      windowSentAt,
  );
  assert(
    Date.parse(
      result.structuredContent.entity.physical_configuration.freshness
        .observed_at,
    ) >= windowSentAt,
  );
  assert(
    Date.parse(result.structuredContent.freshness.hubResponseReceivedAt) >=
      windowSentAt,
  );
});

test("coverage names only observed operations and -32601 is unsupported", async (t) => {
  const hub = await startHub();
  hub.behavior.delayExtensionMs = 50;
  const client = await startClient(t, hub);
  const overview = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: "spruthub://hub/home%2FA" },
  });
  const coverageByOperation = new Map(
    overview.structuredContent.coverage.map((item) => [item.operation, item]),
  );
  const extensionSentAt = hub.responseSentAt.findLast(({ request }) =>
    Boolean(request.params.extension?.list),
  ).at;
  assert(
    Date.parse(coverageByOperation.get("room.list").observed_at) <
      extensionSentAt,
  );
  assert(
    Date.parse(coverageByOperation.get("extension.list").observed_at) >=
      extensionSentAt,
  );
  assert.deepEqual(
    overview.structuredContent.coverage.map(({ operation }) => operation),
    ["hub.list", "room.list", "scenario.list", "extension.list"],
  );
  hub.behavior.unsupportedScenarioGet = true;
  const unsupported = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      include: ["configuration"],
    },
  });
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.structuredContent.error.code, "unsupported");
  assert.equal(unsupported.structuredContent.capability_status, "unsupported");
});

test("scenario detail returns native BLOCK data and redacted code instead of trusting names", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const block = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      include: ["configuration"],
    },
  });
  const code = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/global-code",
      include: ["configuration"],
    },
  });

  assert.equal(block.isError, undefined, block.content[0]?.text);
  assert.equal(code.isError, undefined, code.content[0]?.text);

  assert.equal(block.structuredContent.entity.type, "BLOCK");
  assert.equal(block.structuredContent.entity.configuration.format, "json");
  assert.equal(
    block.structuredContent.entity.configuration.value.targets[0].if
      .conditions[0].trigger,
    true,
  );
  assert.equal(code.structuredContent.entity.type, "GLOBAL");
  assert.equal(code.structuredContent.entity.configuration.format, "code");
  assert.match(
    code.structuredContent.entity.configuration.text,
    /\[REDACTED\]/,
  );
  assert.doesNotMatch(
    code.structuredContent.entity.configuration.text,
    /must-not-leak/,
  );
});

test("scenario configuration keeps one useful value across native formats", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.scenarios.push(
    {
      index: "plain-code",
      name: "Точный код",
      type: "GLOBAL",
      predefined: false,
      active: true,
      data: 'log.info("уют 💡");\n',
    },
    {
      index: "empty-code",
      name: "Пустой код",
      type: "JS",
      predefined: false,
      active: false,
      data: "",
    },
    {
      index: "invalid-block",
      name: "Повреждённый BLOCK",
      type: "BLOCK",
      predefined: false,
      active: false,
      data: "{сломано 💡}",
    },
    ...[
      ["false", false],
      ["0", 0],
      ["null", null],
    ].map(([nativeData, value]) => ({
      index: `primitive-${String(value)}`,
      name: `BLOCK ${nativeData}`,
      type: "BLOCK",
      predefined: false,
      active: false,
      data: nativeData,
    })),
    {
      index: "missing-data",
      name: "Без возвращённой конфигурации",
      type: "GLOBAL",
      predefined: false,
      active: false,
    },
  );
  const client = await startClient(t, hub);

  const cases = [
    ["plain-code", "code", 'log.info("уют 💡");\n'],
    ["empty-code", "code", ""],
    ["invalid-block", "invalid_json", "{сломано 💡}"],
    ["primitive-false", "json", false],
    ["primitive-0", "json", 0],
    ["primitive-null", "json", null],
    ["missing-data", "not_returned", null],
  ];
  const configurations = await Promise.all(
    cases.map(async ([index]) => {
      const result = await client.callTool({
        name: "get_entity",
        arguments: {
          entity_ref: `spruthub://hub/home%2FA/scenario/${index}`,
          include: ["configuration"],
        },
      });
      assert.equal(result.isError, undefined, result.content[0]?.text);
      return result.structuredContent.entity.configuration;
    }),
  );

  assert.deepEqual(
    configurations.map(({ format, value }) => ({ format, value })),
    cases.map(([, format, value]) => ({ format, value })),
  );
  assert.deepEqual(
    configurations.slice(0, 2).map(({ content_origin }) => content_origin),
    ["spruthub_scenario_data", "spruthub_scenario_data"],
  );
});

test("large entity detail stays byte bounded and exposes exact addressable parts", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.scenarios.push({
    index: "large-block",
    name: "Большой сценарий",
    type: "BLOCK",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: JSON.stringify({
      mode: "EVERY",
      "target/a~b": "escaped pointer value",
      settings: Object.fromEntries(
        Array.from({ length: 120 }, (_, index) => [
          `setting-${index}`,
          { enabled: index % 2 === 0, threshold: index },
        ]),
      ),
    }),
  });
  const client = await startClient(t, hub);
  const baseArguments = {
    entity_ref: "spruthub://hub/home%2FA/scenario/large-block",
    include: ["configuration"],
    max_bytes: 2_048,
  };

  const overview = await client.callTool({
    name: "get_entity",
    arguments: baseArguments,
  });
  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  assert(
    Buffer.byteLength(overview.content[0].text) <= baseArguments.max_bytes,
  );
  assert.equal(
    overview.structuredContent.page.serialized_bytes,
    Buffer.byteLength(overview.content[0].text),
  );
  assert.equal(
    overview.structuredContent.representation.entity_complete,
    false,
  );
  assert.equal(
    overview.structuredContent.representation.kind,
    "entity_overview",
  );
  assert.equal(
    overview.structuredContent.representation.selected_complete,
    false,
  );
  assert.equal(
    overview.structuredContent.identity.ref,
    baseArguments.entity_ref,
  );
  assert.equal(Object.hasOwn(overview.structuredContent, "entity"), false);

  let detail = overview;
  for (const pointer of [
    "/configuration",
    "/configuration/value",
    "/configuration/value/mode",
  ]) {
    const part = detail.structuredContent.representation.available_parts.find(
      (candidate) => candidate.pointer === pointer,
    );
    assert(part?.next, `missing issued next for ${pointer}`);
    assert.deepEqual(part.next.arguments.include, ["configuration"]);
    assert.equal(part.next.arguments.entity_ref, baseArguments.entity_ref);
    detail = await client.callTool({
      name: part.next.tool,
      arguments: part.next.arguments,
    });
    assert.equal(detail.isError, undefined, detail.content[0]?.text);
    assert(
      Buffer.byteLength(detail.content[0].text) <= baseArguments.max_bytes,
    );
    assert.equal(
      detail.structuredContent.page.serialized_bytes,
      Buffer.byteLength(detail.content[0].text),
    );
  }
  assert.equal(
    detail.structuredContent.selection.pointer,
    "/configuration/value/mode",
  );
  assert.equal(detail.structuredContent.selection.status, "found");
  assert.equal(detail.structuredContent.selection.value, "EVERY");
  assert.equal(detail.structuredContent.representation.kind, "selected_value");
  assert.equal(detail.structuredContent.representation.entity_complete, false);
  assert.equal(detail.structuredContent.representation.selected_complete, true);
  assert.equal(Object.hasOwn(detail.structuredContent, "entity"), false);

  const valueOverviewNext =
    overview.structuredContent.representation.available_parts.find(
      ({ pointer }) => pointer === "/configuration",
    ).next;
  const configurationOverview = await client.callTool({
    name: valueOverviewNext.tool,
    arguments: valueOverviewNext.arguments,
  });
  const configurationValueNext =
    configurationOverview.structuredContent.representation.available_parts.find(
      ({ pointer }) => pointer === "/configuration/value",
    ).next;
  const valueOverview = await client.callTool({
    name: configurationValueNext.tool,
    arguments: configurationValueNext.arguments,
  });
  const escapedNext =
    valueOverview.structuredContent.representation.available_parts.find(
      ({ pointer }) => pointer === "/configuration/value/target~1a~0b",
    ).next;
  const escaped = await client.callTool({
    name: escapedNext.tool,
    arguments: escapedNext.arguments,
  });
  assert.equal(
    escaped.structuredContent.selection.value,
    "escaped pointer value",
  );

  const settingsNext =
    valueOverview.structuredContent.representation.available_parts.find(
      ({ pointer }) => pointer === "/configuration/value/settings",
    ).next;
  let settingsMap = await client.callTool({
    name: settingsNext.tool,
    arguments: settingsNext.arguments,
  });
  const settingPointers = [];
  while (true) {
    assert.equal(settingsMap.isError, undefined, settingsMap.content[0]?.text);
    assert(Buffer.byteLength(settingsMap.content[0].text) <= 2_048);
    settingPointers.push(
      ...settingsMap.structuredContent.representation.available_parts.map(
        ({ pointer }) => pointer,
      ),
    );
    const next = settingsMap.structuredContent.representation.next;
    if (!next) break;
    settingsMap = await client.callTool({
      name: next.tool,
      arguments: next.arguments,
    });
  }
  assert.equal(settingPointers.length, 120);
  assert.equal(new Set(settingPointers).size, 120);
  assert(settingPointers.includes("/configuration/value/settings/setting-119"));
});

test("long Unicode source resumes exactly and refuses to mix changed versions", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const source = Array.from(
    { length: 700 },
    (_, index) => `// шаг ${index} 💡\nlog.info("значение-${index}");\n`,
  ).join("");
  state.scenarios.push({
    index: "large-code",
    name: "Большой код",
    type: "JS",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: source,
  });
  const client = await startClient(t, hub);
  const entityRef = "spruthub://hub/home%2FA/scenario/large-code";
  let result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      pointer: "/configuration/text",
      max_bytes: 2_048,
    },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert(Buffer.byteLength(result.content[0].text) <= 2_048);
  const firstNext = structuredClone(result.structuredContent.selection.next);
  const chunks = [];
  while (true) {
    const selected = result.structuredContent.selection;
    assert.equal(
      selected.value.start_character,
      Array.from(chunks.join("")).length,
    );
    chunks.push(selected.value.text);
    if (!selected.next) break;
    result = await client.callTool({
      name: selected.next.tool,
      arguments: selected.next.arguments,
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert(Buffer.byteLength(result.content[0].text) <= 2_048);
    assert.equal(
      result.structuredContent.page.serialized_bytes,
      Buffer.byteLength(result.content[0].text),
    );
  }
  assert.equal(chunks.join(""), source);
  assert.equal(result.structuredContent.selection.value.complete, true);
  assert.equal(
    result.structuredContent.representation.selected_complete,
    false,
  );

  state.scenarios.find(({ index }) => index === "large-code").data =
    `// новая версия\n${source}`;
  const stale = await client.callTool({
    name: firstNext.tool,
    arguments: firstNext.arguments,
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, "stale_entity_content");
  assert.equal(stale.structuredContent.next.tool, "get_entity");
  assert.equal(
    stale.structuredContent.next.arguments.pointer,
    "/configuration/text",
  );
  assert.equal(stale.structuredContent.next.arguments.offset, 0);
  assert.notEqual(
    stale.structuredContent.next.arguments.version,
    firstNext.arguments.version,
  );
});

test("entity projection preserves small values and cannot cross redacted nodes", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const characteristicRef =
    "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15";
  const small = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: characteristicRef },
  });
  assert.equal(small.isError, undefined, small.content[0]?.text);
  assert.equal(small.structuredContent.entity.current_value.value, false);
  assert.equal(small.structuredContent.representation.kind, "complete_entity");
  assert.equal(small.structuredContent.representation.entity_complete, true);
  assert.equal(small.structuredContent.representation.selected_complete, true);

  const selectedFalse = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: characteristicRef,
      pointer: "/current_value/value",
    },
  });
  assert.equal(
    selectedFalse.isError,
    undefined,
    selectedFalse.content[0]?.text,
  );
  assert.equal(selectedFalse.structuredContent.selection.status, "found");
  assert.equal(selectedFalse.structuredContent.selection.value, false);

  const selectedNull = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: characteristicRef,
      pointer: "/current_value/source_timestamp",
    },
  });
  assert.equal(selectedNull.isError, undefined, selectedNull.content[0]?.text);
  assert.equal(selectedNull.structuredContent.selection.value, null);

  const selectedZero = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      include: ["configuration"],
      pointer: "/configuration/value/blockId",
    },
  });
  assert.equal(selectedZero.isError, undefined, selectedZero.content[0]?.text);
  assert.equal(selectedZero.structuredContent.selection.value, 0);

  const missing = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: characteristicRef,
      pointer: "/current_value/missing",
    },
  });
  assert.equal(missing.isError, true);
  assert.equal(
    missing.structuredContent.error.code,
    "entity_pointer_not_found",
  );

  const omitted = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/window/window-A",
      pointer: "/commands/0/requires_confirmation",
    },
  });
  assert.equal(omitted.isError, true);
  assert.equal(
    omitted.structuredContent.error.code,
    "entity_pointer_not_found",
  );

  const inherited = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: characteristicRef, pointer: "/constructor/name" },
  });
  assert.equal(inherited.isError, true);
  assert.equal(
    inherited.structuredContent.error.code,
    "entity_pointer_not_found",
  );

  const redacted = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/motion-block",
      include: ["configuration"],
      pointer: "/configuration/value/connection/value",
    },
  });
  assert.equal(redacted.isError, true);
  assert.equal(
    redacted.structuredContent.error.code,
    "entity_pointer_redacted",
  );
  assert.doesNotMatch(redacted.content[0].text, /block-secret-must-not-leak/);
});

test("large native arrays expose identities for addressable selection", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.window.options = Array.from({ length: 57 }, (_, index) => ({
    key: `setting-${index}`,
    name: index === 43 ? "Целевая настройка" : `Настройка ${index}`,
    type: "GenericString",
    inputType: "TEXT",
    read: true,
    write: true,
    events: false,
    value: { stringValue: `значение-${index}-${"x".repeat(220)}` },
  }));
  state.accessories[0].services = Array.from({ length: 60 }, (_, index) => ({
    aId: 32,
    sId: index + 1,
    name: index === 37 ? "Климат" : `Сервис ${index}`,
    type: index === 37 ? "Thermostat" : "Switch",
    characteristics: Array.from({ length: 3 }, (_, characteristicIndex) => ({
      aId: 32,
      sId: index + 1,
      cId: characteristicIndex + 1,
      control: {
        name: `Характеристика ${index}/${characteristicIndex}`,
        type: `GenericValue${characteristicIndex}`,
        read: true,
        write: false,
        events: true,
        value: { intValue: index + characteristicIndex },
      },
    })),
  }));
  const client = await startClient(t, hub);

  const windowOverview = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/window/window-A",
    },
  });
  const optionsPart =
    windowOverview.structuredContent.representation.available_parts.find(
      ({ pointer }) => pointer === "/options",
    );
  assert(optionsPart?.next);
  const optionsMap = await client.callTool({
    name: optionsPart.next.tool,
    arguments: optionsPart.next.arguments,
  });
  const wantedOption =
    optionsMap.structuredContent.representation.available_parts.find(
      ({ identity }) => identity?.key === "setting-43",
    );
  assert.deepEqual(wantedOption.identity, {
    key: "setting-43",
    name: "Целевая настройка",
    type: "GenericString",
  });
  const option = await client.callTool({
    name: wantedOption.next.tool,
    arguments: wantedOption.next.arguments,
  });
  assert.equal(option.structuredContent.selection.value.key, "setting-43");
  assert.equal(
    option.structuredContent.selection.value.configured_value,
    `значение-43-${"x".repeat(220)}`,
  );

  const accessoryOverview = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/accessory/32",
    },
  });
  const servicesPart =
    accessoryOverview.structuredContent.representation.available_parts.find(
      ({ pointer }) => pointer === "/services",
    );
  const servicesMap = await client.callTool({
    name: servicesPart.next.tool,
    arguments: servicesPart.next.arguments,
  });
  const thermostat =
    servicesMap.structuredContent.representation.available_parts.find(
      ({ identity }) => identity?.type === "Thermostat",
    );
  assert.equal(thermostat.identity.name, "Климат");
  assert.equal(
    thermostat.identity.ref,
    "spruthub://hub/home%2FA/accessory/32/service/38",
  );
  const service = await client.callTool({
    name: thermostat.next.tool,
    arguments: thermostat.next.arguments,
  });
  assert.equal(service.structuredContent.selection.value.type, "Thermostat");
});

test("entity continuations restart when strings or container identities change", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const settings = Array.from({ length: 90 }, (_, index) => ({
    key: `setting-${index}`,
    name: `Настройка ${index}`,
    value: index,
  }));
  const scenario = {
    index: "changing-detail",
    name: "Меняющаяся деталь",
    type: "BLOCK",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: JSON.stringify({ settings }),
  };
  state.scenarios.push(scenario);
  const client = await startClient(t, hub);
  const entityRef = "spruthub://hub/home%2FA/scenario/changing-detail";

  const source = "💡 длинная строка ".repeat(500);
  scenario.type = "JS";
  scenario.data = source;
  const firstString = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      pointer: "/configuration/text",
      max_bytes: 2_048,
    },
  });
  const stringNext = firstString.structuredContent.selection.next;
  scenario.data = "коротко";
  const shortened = await client.callTool({
    name: stringNext.tool,
    arguments: stringNext.arguments,
  });
  assert.equal(shortened.isError, true);
  assert.equal(shortened.structuredContent.error.code, "stale_entity_content");
  assert.equal(shortened.structuredContent.next.arguments.offset, 0);
  scenario.data = "";
  const emptied = await client.callTool({
    name: stringNext.tool,
    arguments: stringNext.arguments,
  });
  assert.equal(emptied.isError, true);
  assert.equal(emptied.structuredContent.error.code, "stale_entity_content");
  assert.equal(emptied.structuredContent.next.arguments.offset, 0);
  const unversioned = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      pointer: "/configuration/text",
      max_bytes: 2_048,
      offset: 1,
    },
  });
  assert.equal(unversioned.isError, true);
  assert.equal(
    unversioned.structuredContent.error.code,
    "invalid_entity_projection",
  );
  assert.equal(unversioned.structuredContent.next.arguments.offset, 0);

  scenario.type = "BLOCK";
  scenario.data = JSON.stringify({ settings });
  const firstMap = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      pointer: "/configuration/value/settings",
      max_bytes: 2_048,
    },
  });
  const mapNext = firstMap.structuredContent.representation.next;
  assert(mapNext?.arguments.version);
  settings[20].value = 999;
  scenario.data = JSON.stringify({ settings });
  const valueChanged = await client.callTool({
    name: mapNext.tool,
    arguments: mapNext.arguments,
  });
  assert.equal(valueChanged.isError, undefined, valueChanged.content[0]?.text);
  settings.shift();
  scenario.data = JSON.stringify({ settings });
  const identitiesChanged = await client.callTool({
    name: mapNext.tool,
    arguments: mapNext.arguments,
  });
  assert.equal(identitiesChanged.isError, true);
  assert.equal(
    identitiesChanged.structuredContent.error.code,
    "stale_entity_content",
  );
  assert.equal(identitiesChanged.structuredContent.next.arguments.offset, 0);
});

test("ambiguous container continuations restart without losing current entries", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const targets = Array.from({ length: 24 }, (_, index) => ({
    type: "if",
    blockId: index + 1,
    marker: `target-${index + 1}-${"x".repeat(80)}`,
  }));
  const scenario = {
    index: "ambiguous-detail",
    name: "Неоднозначная карта",
    type: "BLOCK",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: JSON.stringify({ targets }),
  };
  state.scenarios.push(scenario);
  const client = await startClient(t, hub);
  const baseArguments = {
    entity_ref: "spruthub://hub/home%2FA/scenario/ambiguous-detail",
    include: ["configuration"],
    pointer: "/configuration/value/targets",
    max_bytes: 2_048,
  };
  const firstPage = await client.callTool({
    name: "get_entity",
    arguments: baseArguments,
  });
  const replacedContinuation = firstPage.structuredContent.representation.next;
  assert(replacedContinuation?.arguments.version);

  targets.shift();
  targets.push({
    type: "if",
    blockId: 99,
    marker: `replacement-${"y".repeat(80)}`,
  });
  scenario.data = JSON.stringify({ targets });
  const replaced = await client.callTool({
    name: replacedContinuation.tool,
    arguments: replacedContinuation.arguments,
  });
  assert.equal(replaced.isError, true);
  assert.equal(replaced.structuredContent.error.code, "stale_entity_content");
  assert.equal(replaced.structuredContent.next.arguments.offset, 0);

  let restarted = await client.callTool({
    name: replaced.structuredContent.next.tool,
    arguments: replaced.structuredContent.next.arguments,
  });
  const currentParts = [];
  while (true) {
    assert.equal(restarted.isError, undefined, restarted.content[0]?.text);
    currentParts.push(
      ...restarted.structuredContent.representation.available_parts,
    );
    const next = restarted.structuredContent.representation.next;
    if (!next) break;
    restarted = await client.callTool({
      name: next.tool,
      arguments: next.arguments,
    });
  }
  const currentBlockIds = [];
  for (const part of currentParts) {
    const current = await client.callTool({
      name: part.next.tool,
      arguments: part.next.arguments,
    });
    assert.equal(current.isError, undefined, current.content[0]?.text);
    currentBlockIds.push(current.structuredContent.selection.value.blockId);
  }
  assert.deepEqual(
    currentBlockIds,
    targets.map(({ blockId }) => blockId),
  );

  const beforeReorder = await client.callTool({
    name: "get_entity",
    arguments: baseArguments,
  });
  const reorderContinuation =
    beforeReorder.structuredContent.representation.next;
  assert(reorderContinuation?.arguments.version);
  [targets[0], targets[1]] = [targets[1], targets[0]];
  scenario.data = JSON.stringify({ targets });
  const reordered = await client.callTool({
    name: reorderContinuation.tool,
    arguments: reorderContinuation.arguments,
  });
  assert.equal(reordered.isError, true);
  assert.equal(reordered.structuredContent.error.code, "stale_entity_content");

  const anonymous = Array.from({ length: 24 }, (_, index) => ({
    blockId: index + 1,
    marker: `anonymous-${index + 1}-${"z".repeat(80)}`,
  }));
  scenario.data = JSON.stringify({ anonymous });
  const anonymousArguments = {
    ...baseArguments,
    pointer: "/configuration/value/anonymous",
  };
  const beforeAnonymousChange = await client.callTool({
    name: "get_entity",
    arguments: anonymousArguments,
  });
  const anonymousContinuation =
    beforeAnonymousChange.structuredContent.representation.next;
  assert(anonymousContinuation?.arguments.version);
  anonymous.shift();
  anonymous.push({ blockId: 99, marker: `new-anonymous-${"q".repeat(80)}` });
  scenario.data = JSON.stringify({ anonymous });
  const anonymousChanged = await client.callTool({
    name: anonymousContinuation.tool,
    arguments: anonymousContinuation.arguments,
  });
  assert.equal(anonymousChanged.isError, true);
  assert.equal(
    anonymousChanged.structuredContent.error.code,
    "stale_entity_content",
  );
});

test("automation preview rejects foreign-home references before any hub request", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const requestCount = hub.requests.length;

  const result = await client.callTool({
    name: "preview_boolean_automation",
    arguments: {
      name: "Чужой дом",
      reason: "Проверка границы записи",
      source_room_ref: "spruthub://hub/home%2FA/room/1",
      source_characteristic_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      source_value: true,
      target_room_ref: "spruthub://hub/home%20B/room/1",
      target_characteristic_ref:
        "spruthub://hub/home%20B/accessory/32/service/13/characteristic/15",
      target_value: true,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "unsupported_home_write");
  assert.equal(hub.requests.length, requestCount);
});
