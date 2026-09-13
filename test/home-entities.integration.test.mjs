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
    scenarioAssociations: new Map(),
    links: new Map(),
    logics: new Map([
      [
        "32.13",
        [
          {
            type: "MotionDetectedFromCurrentMotionLevel",
            name: "Определение движения",
            active: true,
          },
        ],
      ],
    ]),
    logicTypes: new Map([
      [
        "32.13",
        [
          {
            type: "MotionDetectedFromCurrentMotionLevel",
            name: "Определение движения",
            desc: "Определяет движение по текущему уровню",
          },
        ],
      ],
    ]),
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
    scenarioGetErrors: new Map(),
    missingScenarioGets: new Set(),
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
      const scenarioGetIndex = request.params.scenario?.get?.index;
      const scenarioGetError = behavior.scenarioGetErrors.get(scenarioGetIndex);
      if (scenarioGetError) {
        responseSentAt.push({ request, at: Date.now() });
        socket.send(
          JSON.stringify({
            id: request.id,
            error: scenarioGetError,
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
          logics:
            state.logics.get(
              `${params.logic.list.aId}.${params.logic.list.sId}`,
            ) ?? [],
        },
      },
    };
  }
  if (params.logic?.types) {
    return {
      logic: {
        types: {
          logicTypes:
            state.logicTypes.get(
              `${params.logic.types.aId}.${params.logic.types.sId}`,
            ) ?? [],
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
  if (params.link?.list) {
    const { aId, sId, cId } = params.link.list;
    return {
      link: {
        list: {
          links: state.links.get(`${aId}.${sId}.${cId}`) ?? [],
        },
      },
    };
  }
  if (params.window?.get) return { window: { get: state.window } };
  if (params.scenario?.list) {
    return {
      scenario: {
        list: {
          scenarios:
            params.scenario.list.aId === undefined
              ? state.scenarios
              : (state.scenarioAssociations.get(params.scenario.list.aId) ??
                []),
        },
      },
    };
  }
  if (params.scenario?.get) {
    return {
      scenario: {
        get: behavior.missingScenarioGets.has(params.scenario.get.index)
          ? null
          : (state.scenarios.find(
              ({ index }) => index === params.scenario.get.index,
            ) ?? null),
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
  assert.deepEqual(catalog.structuredContent.selection, {
    required: false,
    default_home_ref: "spruthub://hub/home%2FA",
    options: [
      { home_ref: "spruthub://hub/home%2FA", pin_value: "home/A" },
      { home_ref: "spruthub://hub/home%20B", pin_value: "home B" },
    ],
  });
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

test("home service catalog finds one target before reading only its values and relations", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.rooms = [
    { id: 1, name: "Кухня" },
    { id: 2, name: "Спальня" },
    { id: 3, name: "Кабинет" },
  ];
  const light = (id, roomId, name = `Лампа ${id}`) => ({
    id,
    roomId,
    name: `Светильник ${id}`,
    online: true,
    services: [
      {
        aId: id,
        sId: 1,
        name,
        type: "Lightbulb",
        characteristics: [
          {
            aId: id,
            sId: 1,
            cId: 1,
            control: {
              name: "Включена",
              type: "On",
              read: true,
              write: true,
              value: { boolValue: id % 2 === 0 },
            },
          },
          {
            aId: id,
            sId: 1,
            cId: 2,
            control: {
              name: "Отчёт",
              type: "Report",
              read: true,
              write: false,
              value: { stringValue: `${id}:`.padEnd(1_000, "x") },
            },
          },
        ],
      },
    ],
  });
  state.accessories = Array.from({ length: 53 }, (_, index) => {
    const id = 100 + index;
    const roomId = id === 100 ? 2 : id === 101 ? 3 : (index % 3) + 1;
    const name = id === 100 || id === 101 ? "Димина лампа" : undefined;
    return light(id, roomId, name);
  });
  state.links.set("100.1.1", [
    {
      index: "desk-light-link",
      type: "IN",
      characteristics: [{ aId: 102, sId: 1, cId: 1 }],
    },
  ]);
  const client = await startClient(t, hub);
  const argumentsBase = {
    home_ref: "spruthub://hub/home%2FA",
    service_types: ["Lightbulb"],
    max_bytes: 16_000,
  };

  const readAll = async (representation, afterFirstPage) => {
    const services = [];
    let serializedBytes = 0;
    let firstCursor;
    let next = {
      tool: "read_services",
      arguments: { ...argumentsBase, representation },
    };
    let pages = 0;
    while (next) {
      const result = await client.callTool({
        name: next.tool,
        arguments: next.arguments,
      });
      assert.equal(result.isError, undefined, result.content[0]?.text);
      assert.equal(result.structuredContent.representation, representation);
      assert.equal(
        Buffer.byteLength(result.content[0].text),
        result.structuredContent.page.serialized_bytes,
      );
      services.push(...result.structuredContent.services);
      serializedBytes += result.structuredContent.page.serialized_bytes;
      pages += 1;
      if (pages === 1) {
        firstCursor = result.structuredContent.page.next_cursor;
        afterFirstPage?.();
      }
      next = result.structuredContent.next;
      if (next) assert.equal(next.arguments.representation, representation);
      assert(pages < 20);
    }
    return { services, serializedBytes, pages, firstCursor };
  };

  const catalog = await readAll("catalog", () => {
    state.accessories.push(light(200, 3));
  });
  assert.equal(catalog.services.length, 54);
  assert.equal(
    catalog.services.filter(({ name }) => name === "Димина лампа").length,
    2,
  );
  assert(
    catalog.services.every(
      (service) =>
        service.readings_status === "not_requested" &&
        !Object.hasOwn(service, "readings"),
    ),
  );
  const selected = catalog.services.find(
    ({ name, room }) => name === "Димина лампа" && room.name === "Спальня",
  );
  assert(selected);
  assert.equal(selected.ref, "spruthub://hub/home%2FA/accessory/100/service/1");
  assert.equal(
    catalog.services.at(-1).ref,
    "spruthub://hub/home%2FA/accessory/200/service/1",
  );

  const readings = await readAll("readings");
  t.diagnostic(
    `catalog ${catalog.serializedBytes} bytes/${catalog.pages} pages; readings ${readings.serializedBytes} bytes/${readings.pages} pages`,
  );
  assert.equal(readings.services.length, catalog.services.length);
  assert(catalog.serializedBytes < readings.serializedBytes);
  assert(catalog.pages < readings.pages);

  const wrongRepresentation = await client.callTool({
    name: "read_services",
    arguments: {
      ...argumentsBase,
      representation: "readings",
      cursor: catalog.firstCursor,
    },
  });
  assert.equal(wrongRepresentation.isError, true);
  assert.equal(
    wrongRepresentation.structuredContent.error.code,
    "invalid_cursor",
  );
  assert.deepEqual(wrongRepresentation.structuredContent.next.arguments, {
    ...argumentsBase,
    representation: "readings",
  });

  const detail = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: selected.ref },
  });
  assert.equal(detail.isError, undefined, detail.content[0]?.text);
  const on = detail.structuredContent.entity.characteristics.find(
    ({ type }) => type === "On",
  );
  assert.equal(on.current_value.value, true);

  const relations = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: on.ref, include: ["relations"] },
  });
  assert.equal(relations.isError, undefined, relations.content[0]?.text);
  assert.deepEqual(
    relations.structuredContent.entity.relations.characteristic_links[0]
      .related_characteristic_refs,
    ["spruthub://hub/home%2FA/accessory/102/service/1/characteristic/1"],
  );
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
      native_change: {
        native_write: true,
        supported: false,
        reason: "unsupported_input_type",
      },
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
      role: "service_assignment",
      service_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
    },
  ]);
  assert.match(entity.diagnostics[0].text, /SensorDetectionSeconds.*61/);
  assert.match(entity.diagnostics[0].text, /SensorDetectionSeconds.*31/);
  assert.equal(entity.diagnostics[1].text, "[REDACTED]");
  assert.equal(entity.freshness.source_timestamp, null);
});

test("raw device-window diagnostics preserve text without claiming a device report", async (t) => {
  const hub = await startHub();
  const rawDiagnostic =
    "OnOff: true; binding: OnOff -> hub; Last update: 05:50:37";
  const info = hub.states
    .get("home/A")
    .window.options.find(({ key }) => key === "Info");
  info.value.stringValue = rawDiagnostic;
  const client = await startClient(t, hub);
  const characteristicRef =
    "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15";

  const direct = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: characteristicRef,
      include: ["options", "physical_configuration", "diagnostics"],
    },
  });
  assert.equal(direct.isError, undefined, direct.content[0]?.text);
  assert.deepEqual(direct.structuredContent.entity.current_value, {
    value: false,
    source: "characteristic",
    source_timestamp: null,
  });
  assert.equal(
    direct.structuredContent.entity.options[0].configured_value,
    180,
  );
  const configured =
    direct.structuredContent.entity.physical_configuration.options.find(
      ({ property }) => property === "SensorDetectionSeconds",
    );
  assert.equal(configured.configured_value, 10);
  assert.equal(configured.reported_value, null);
  assert.equal(configured.source_timestamp, null);
  assert.deepEqual(direct.structuredContent.entity.diagnostics, [
    {
      key: "Info",
      text: rawDiagnostic,
      content_origin: "spruthub_device_window_diagnostics",
      semantic_status: "uninterpreted",
      source_timestamp: null,
      direct_device_report: "not_established",
    },
    {
      key: "ConnectionDiagnostics",
      text: "[REDACTED]",
      content_origin: "spruthub_device_window_diagnostics",
      semantic_status: "uninterpreted",
      source_timestamp: null,
      direct_device_report: "not_established",
    },
  ]);

  const service = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
      include: ["diagnostics"],
    },
  });
  assert.equal(service.isError, undefined, service.content[0]?.text);
  const next =
    service.structuredContent.entity.include_resolution.not_applied[0].next;
  assert.deepEqual(next, {
    tool: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/window/window-A",
      include: ["diagnostics"],
    },
  });
  const routed = await client.callTool({
    name: next.tool,
    arguments: next.arguments,
  });
  assert.equal(routed.isError, undefined, routed.content[0]?.text);
  assert.deepEqual(
    routed.structuredContent.entity.diagnostics,
    direct.structuredContent.entity.diagnostics,
  );
  const routedWindowSentAt = hub.responseSentAt.findLast(({ request }) =>
    Boolean(request.params.window?.get),
  ).at;
  const observedAt = Date.parse(
    routed.structuredContent.entity.freshness.observed_at,
  );
  const hubResponseReceivedAt = Date.parse(
    routed.structuredContent.freshness.hubResponseReceivedAt,
  );
  assert.equal(
    routed.structuredContent.entity.freshness.source_timestamp,
    null,
  );
  assert(Number.isFinite(observedAt));
  assert(observedAt >= routedWindowSentAt);
  assert(observedAt <= hubResponseReceivedAt);
});

test("get_entity relations separate proven BLOCK roles from bounded native scopes", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const block = {
    index: "mixed-device-block",
    name: "Датчик управляет лампой",
    type: "BLOCK",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: JSON.stringify({
      blockId: 0,
      targets: [
        { type: "notify", blockId: 90, message: "unsupported sibling" },
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
              {
                type: "characteristic",
                blockId: 6,
                aId: 32,
                sId: 13,
                cId: 15,
                value: "false",
                cond: "=",
                trigger: false,
                hs: "MotionSensor",
                hc: "MotionDetected",
                time: 0,
                timeCond: "",
              },
              {
                type: "code",
                blockId: 7,
                code: "return input.ready === true;",
              },
              {
                type: "condition",
                blockId: 8,
                mode: "OR",
                conditions: [
                  {
                    type: "code",
                    blockId: 9,
                    code: "return state.allowed === true;",
                  },
                  {
                    type: "characteristic",
                    blockId: 10,
                    aId: 32,
                    sId: 13,
                    cId: 15,
                    value: "true",
                    cond: "=",
                    trigger: false,
                    hs: "MotionSensor",
                    hc: "MotionDetected",
                    time: 0,
                    timeCond: "",
                  },
                ],
              },
            ],
          },
          // biome-ignore lint/suspicious/noThenProperty: this is the native SprutHub BLOCK key.
          then: [
            {
              type: "service",
              blockId: 4,
              aId: 48,
              sId: 21,
              hs: "Lightbulb",
              characteristics: [
                {
                  type: "set",
                  blockId: 5,
                  cId: 30,
                  hc: "On",
                  value: "true",
                },
              ],
            },
          ],
          else: [],
          then_delay: 0,
          else_delay: 0,
          mode: "EVERY",
        },
      ],
    }),
  };
  state.scenarios.push(block);
  state.scenarioAssociations.set(32, [block]);
  state.logics.set("32.13", [
    { type: "AssignedSensorLogic", name: "Назначенная logic", active: true },
  ]);
  state.logicTypes.set("32.13", [
    {
      type: "AssignedSensorLogic",
      name: "Назначенная logic",
      desc: "Уже назначена сервису",
    },
    {
      type: "AvailableOnlyLogic",
      name: "Только доступный тип",
      desc: "Не назначена сервису",
    },
  ]);
  state.links.set("32.13.15", [
    {
      type: "SYSTEM",
      index: "native-source/example",
      controller: "zigbee_1",
    },
    {
      type: "OUT",
      index: "Virtual/32.15",
      characteristics: [{ aId: 48, sId: 21, cId: 30 }],
    },
  ]);
  const client = await startClient(t, hub);
  const characteristicRef =
    "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15";

  const result = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: characteristicRef, include: ["relations"] },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const relationRequestSnapshot = [...hub.requests];
  const relations = result.structuredContent.entity.relations;
  assert.deepEqual(relations.scenario_associations, [
    {
      ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      name: "Датчик управляет лампой",
      type: "BLOCK",
      predefined: false,
      active: true,
      on_start: false,
      sync: false,
      meaning: "accessory_index_association",
      direction: "not_established",
    },
  ]);
  assert.deepEqual(relations.scenario_roles, [
    {
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      scenario_active: true,
      runtime_status: "not_observed",
      role: "trigger",
      entity_ref: characteristicRef,
      configuration_pointer: "/configuration/value/targets/1/if/conditions/0",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer: "/configuration/value/targets/1/if/conditions/0",
        },
      },
    },
    {
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      scenario_active: true,
      runtime_status: "not_observed",
      role: "condition",
      entity_ref: characteristicRef,
      configuration_pointer: "/configuration/value/targets/1/if/conditions/1",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer: "/configuration/value/targets/1/if/conditions/1",
        },
      },
    },
    {
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      scenario_active: true,
      runtime_status: "not_observed",
      role: "condition",
      entity_ref: characteristicRef,
      configuration_pointer:
        "/configuration/value/targets/1/if/conditions/3/conditions/1",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer:
            "/configuration/value/targets/1/if/conditions/3/conditions/1",
        },
      },
    },
    {
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      scenario_active: true,
      runtime_status: "not_observed",
      role: "action_target",
      entity_ref:
        "spruthub://hub/home%2FA/accessory/48/service/21/characteristic/30",
      configuration_pointer:
        "/configuration/value/targets/1/then/0/characteristics/0",
      value_source: "literal",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer: "/configuration/value/targets/1/then/0/characteristics/0",
        },
      },
    },
  ]);
  const codeConditions = relations.unresolved_areas.filter(
    ({ area }) => area === "block_code_condition",
  );
  assert.deepEqual(codeConditions, [
    {
      area: "block_code_condition",
      outcome: "not_analyzed",
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      configuration_pointer: "/configuration/value/targets/1/if/conditions/2",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer: "/configuration/value/targets/1/if/conditions/2",
        },
      },
    },
    {
      area: "block_code_condition",
      outcome: "not_analyzed",
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      configuration_pointer:
        "/configuration/value/targets/1/if/conditions/3/conditions/0",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer:
            "/configuration/value/targets/1/if/conditions/3/conditions/0",
        },
      },
    },
  ]);
  for (const evidence of [...relations.scenario_roles, ...codeConditions]) {
    const detail = await client.callTool({
      name: evidence.next.tool,
      arguments: evidence.next.arguments,
    });
    assert.equal(detail.isError, undefined, detail.content[0]?.text);
    assert.equal(
      detail.structuredContent.selection.pointer,
      evidence.configuration_pointer,
    );
    assert.equal(
      detail.structuredContent.selection.value.type,
      evidence.area === "block_code_condition"
        ? "code"
        : evidence.role === "action_target"
          ? "set"
          : "characteristic",
    );
  }
  assert.deepEqual(relations.assigned_logics, [
    {
      ref: "spruthub://hub/home%2FA/accessory/32/service/13/logic/AssignedSensorLogic",
      type: "AssignedSensorLogic",
      name: "Назначенная logic",
      active: true,
      role: "service_assignment",
      service_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
    },
  ]);
  assert.deepEqual(relations.system_links, [
    {
      type: "SYSTEM",
      index: "native-source/example",
      controller: "zigbee_1",
      role: "system",
    },
  ]);
  assert.deepEqual(relations.characteristic_links, [
    {
      type: "OUT",
      index: "Virtual/32.15",
      role: "inter_entity",
      related_characteristic_refs: [
        "spruthub://hub/home%2FA/accessory/48/service/21/characteristic/30",
      ],
    },
  ]);
  assert.deepEqual(
    relations.scopes.map(({ area, outcome, source_ref }) => ({
      area,
      outcome,
      source_ref,
    })),
    [
      {
        area: "scenario_accessory_index",
        outcome: "found",
        source_ref: "spruthub://hub/home%2FA/accessory/32",
      },
      {
        area: "scenario_catalog",
        outcome: "found",
        source_ref: "spruthub://hub/home%2FA",
      },
      {
        area: "block_configuration",
        outcome: "read",
        source_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      },
      {
        area: "logic_assignments",
        outcome: "found",
        source_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
      },
      {
        area: "characteristic_links",
        outcome: "found",
        source_ref: characteristicRef,
      },
    ],
  );
  for (const scope of relations.scopes) {
    assert.match(scope.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(
    relations.unresolved_areas.find(({ area }) => area === "block_node"),
    {
      area: "block_node",
      outcome: "unsupported",
      scenario_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
      configuration_pointer: "/configuration/value/targets/0",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/scenario/mixed-device-block",
          include: ["configuration"],
          pointer: "/configuration/value/targets/0",
        },
      },
      native_type: "notify",
    },
  );
  assert.equal(
    relations.unresolved_areas.some(
      ({ area, outcome }) =>
        area === "runtime_execution" && outcome === "not_observed",
    ),
    true,
  );
  assert.equal(Object.hasOwn(relations, "direct_scenarios"), false);
  assert.equal(Object.hasOwn(relations, "links"), false);

  const service = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/accessory/32/service/13",
    },
  });
  assert.deepEqual(
    service.structuredContent.entity.available_logic_types.map(
      ({ type, assigned }) => ({ type, assigned }),
    ),
    [
      { type: "AssignedSensorLogic", assigned: true },
      { type: "AvailableOnlyLogic", assigned: false },
    ],
  );
  assert.equal(
    relations.assigned_logics.some(({ type }) => type === "AvailableOnlyLogic"),
    false,
  );

  const relationRequests = relationRequestSnapshot.filter(
    ({ params }) =>
      params.scenario?.list ||
      params.scenario?.get ||
      params.logic?.list ||
      params.link?.list,
  );
  assert.equal(
    relationRequests.filter(({ params }) => params.scenario?.get).length,
    1,
  );
  assert.equal(
    relationRequests.some(
      ({ params }) => params.scenario?.get?.index === "global-code",
    ),
    false,
  );
});

test("get_entity relations preserve an inactive BLOCK state", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const block = {
    index: "inactive-device-block",
    name: "Выключенное правило датчика",
    type: "BLOCK",
    predefined: false,
    active: false,
    onStart: false,
    sync: false,
    data: JSON.stringify({
      blockId: 0,
      targets: [
        {
          type: "if",
          blockId: 1,
          if: {
            type: "characteristic",
            blockId: 2,
            aId: 32,
            sId: 13,
            cId: 15,
            value: "false",
            cond: "=",
            trigger: false,
            hs: "MotionSensor",
            hc: "MotionDetected",
            time: 0,
            timeCond: "",
          },
          // biome-ignore lint/suspicious/noThenProperty: this is the native SprutHub BLOCK key.
          then: [],
          else: [],
          then_delay: 0,
          else_delay: 0,
          mode: "EVERY",
        },
      ],
    }),
  };
  state.scenarios.push(block);
  state.scenarioAssociations.set(32, [block]);
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      include: ["relations"],
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(
    result.structuredContent.entity.relations.scenario_roles.length,
    1,
  );
  const [role] = result.structuredContent.entity.relations.scenario_roles;
  assert.deepEqual(
    {
      scenario_active: role.scenario_active,
      role: role.role,
      configuration_pointer: role.configuration_pointer,
    },
    {
      scenario_active: false,
      role: "condition",
      configuration_pointer: "/configuration/value/targets/0/if",
    },
  );
  const detail = await client.callTool({
    name: role.next.tool,
    arguments: role.next.arguments,
  });
  assert.equal(detail.isError, undefined, detail.content[0]?.text);
  assert.equal(detail.structuredContent.selection.value.type, "characteristic");
});

test("empty accessory scenario index preserves unread code and BLOCK areas", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.scenarioAssociations.set(32, []);
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref:
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
      include: ["relations"],
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const relations = result.structuredContent.entity.relations;
  assert.deepEqual(relations.scenario_associations, []);
  assert.equal(
    relations.scopes.find(({ area }) => area === "scenario_accessory_index")
      .outcome,
    "checked_empty",
  );
  assert.deepEqual(
    relations.unresolved_areas
      .filter(({ area }) =>
        ["scenario_code", "unindexed_block_scenarios"].includes(area),
      )
      .map(({ area, outcome, scenario_count, scenario_types }) => ({
        area,
        outcome,
        scenario_count,
        scenario_types,
      })),
    [
      {
        area: "scenario_code",
        outcome: "not_read",
        scenario_count: 1,
        scenario_types: ["GLOBAL"],
      },
      {
        area: "unindexed_block_scenarios",
        outcome: "not_read",
        scenario_count: 1,
        scenario_types: ["BLOCK"],
      },
    ],
  );
  assert.equal(
    hub.requests.some(({ params }) => params.scenario?.get),
    false,
  );
});

test("accessory relations keep BLOCK evidence and defer recursive link reads", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  state.scenarioAssociations.set(32, [state.scenarios[0]]);
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/accessory/32",
      include: ["relations"],
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const entity = result.structuredContent.entity;
  assert.deepEqual(entity.include_resolution.applied, ["relations"]);
  assert.equal(entity.relations.scenario_roles[0].role, "trigger");
  assert.equal(entity.relations.assigned_logics[0].role, "service_assignment");
  assert.deepEqual(
    entity.relations.scopes.find(({ area }) => area === "characteristic_links"),
    {
      area: "characteristic_links",
      outcome: "not_read",
      source_ref: "spruthub://hub/home%2FA/accessory/32",
      observed_at: null,
    },
  );
  const unresolved = entity.relations.unresolved_areas.find(
    ({ area }) => area === "characteristic_links",
  );
  assert.equal(unresolved.outcome, "not_read");
  assert.equal(unresolved.next.tool, "get_entity");
  assert.equal(
    unresolved.next.candidates[0].entity_ref,
    "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/15",
  );
  assert.equal(
    unresolved.next.candidates.some(
      ({ entity_ref }) =>
        entity_ref ===
        "spruthub://hub/home%2FA/accessory/32/service/13/characteristic/16",
    ),
    false,
  );
  assert.equal(
    hub.requests.some(({ params }) => params.link?.list),
    false,
  );
});

test("relation source failures stay scoped instead of becoming checked empty", async (t) => {
  for (const testCase of [
    {
      name: "missing",
      configure: (hub) => hub.behavior.missingScenarioGets.add("motion-block"),
    },
    {
      name: "unsupported",
      configure: (hub) =>
        hub.behavior.scenarioGetErrors.set("motion-block", {
          code: -32601,
          message: "Method not found",
        }),
    },
    {
      name: "failed",
      configure: (hub) =>
        hub.behavior.scenarioGetErrors.set("motion-block", {
          code: -32000,
          message: "Native failure",
        }),
    },
  ]) {
    await t.test(testCase.name, async (t) => {
      const hub = await startHub();
      const state = hub.states.get("home/A");
      state.scenarioAssociations.set(32, [state.scenarios[0]]);
      testCase.configure(hub);
      const client = await startClient(t, hub);

      const result = await client.callTool({
        name: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/home%2FA/accessory/32",
          include: ["relations"],
        },
      });

      assert.equal(result.isError, undefined, result.content[0]?.text);
      const scope = result.structuredContent.entity.relations.scopes.find(
        ({ area }) => area === "block_configuration",
      );
      assert.equal(scope.outcome, testCase.name);
      assert.notEqual(scope.outcome, "checked_empty");
      assert.equal(
        result.structuredContent.entity.relations.unresolved_areas.some(
          ({ area, scenario_ref, outcome }) =>
            area === "block_configuration" &&
            scenario_ref === "spruthub://hub/home%2FA/scenario/motion-block" &&
            outcome === testCase.name,
        ),
        true,
      );
    });
  }
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

test("native entity names stay data when they resemble JavaScript contexts", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const cases = [
    {
      entityRef: "spruthub://hub/home%2FA/room/1",
      entity: state.rooms[0],
      name: "Комната? password: room-name-secret-must-not-leak",
      secret: "room-name-secret-must-not-leak",
    },
    {
      entityRef: "spruthub://hub/home%2FA/accessory/32",
      entity: state.accessories[0],
      name: "Датчик use case token: accessory-name-secret-must-not-leak",
      secret: "accessory-name-secret-must-not-leak",
    },
    {
      entityRef: "spruthub://hub/home%2FA/scenario/motion-block",
      entity: state.scenarios[0],
      name: "Сценарий? password: scenario-name-secret-must-not-leak",
      secret: "scenario-name-secret-must-not-leak",
    },
  ];
  for (const item of cases) item.entity.name = item.name;
  const client = await startClient(t, hub);

  const results = await Promise.all(
    cases.map(({ entityRef }) =>
      client.callTool({
        name: "get_entity",
        arguments: { entity_ref: entityRef },
      }),
    ),
  );
  for (const result of results) {
    assert.equal(result.isError, undefined, result.content[0]?.text);
  }
  assert.deepEqual(
    results.map(({ structuredContent }) => structuredContent.entity.name),
    cases.map(() => "[REDACTED]"),
  );
  const visible = JSON.stringify(results);
  for (const { secret } of cases) {
    assert.doesNotMatch(visible, new RegExp(secret));
  }
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
    code.structuredContent.entity.configuration.value,
    /\[REDACTED\]/,
  );
  assert.doesNotMatch(
    code.structuredContent.entity.configuration.value,
    /must-not-leak/,
  );
});

test("scenario reads hide quoted credential assignments without hiding ordinary source", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const scenarios = [
    {
      index: "quoted-json-code",
      type: "GLOBAL",
      data: 'const config = {\n  "api_key" : "quoted-code-secret-must-not-leak"\n};',
      format: "code",
      secret: "quoted-code-secret-must-not-leak",
    },
    {
      index: "single-quoted-js-code",
      type: "JS",
      data: "const config = {\n  'password'\n  : 'single-quoted-code-secret-must-not-leak'\n};",
      format: "code",
      secret: "single-quoted-code-secret-must-not-leak",
    },
    {
      index: "escaped-json-code",
      type: "GLOBAL",
      data: 'const payload = "{\\"refresh_token\\" : \\"escaped-code-secret-must-not-leak\\"}";',
      format: "code",
      secret: "escaped-code-secret-must-not-leak",
    },
    {
      index: "quoted-invalid-block",
      type: "BLOCK",
      data: '{\n  "token" : "invalid-block-secret-must-not-leak"',
      format: "invalid_json",
      secret: "invalid-block-secret-must-not-leak",
    },
  ];
  const ordinaryCode =
    'const config = {"theme":"night","retry_count":3};\nlog.info("ready");';
  const ordinaryInvalidBlock = '{\n  "theme": "night"';
  state.scenarios.push(
    ...scenarios.map(({ index, type, data }) => ({
      index,
      name: index,
      type,
      predefined: false,
      active: true,
      data,
    })),
    {
      index: "ordinary-json-code",
      name: "ordinary-json-code",
      type: "GLOBAL",
      predefined: false,
      active: true,
      data: ordinaryCode,
    },
    {
      index: "ordinary-invalid-block",
      name: "ordinary-invalid-block",
      type: "BLOCK",
      predefined: false,
      active: true,
      data: ordinaryInvalidBlock,
    },
  );
  const client = await startClient(t, hub);

  for (const scenario of scenarios) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: `spruthub://hub/home%2FA/scenario/${scenario.index}`,
        include: ["configuration"],
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(
      result.structuredContent.entity.configuration.format,
      scenario.format,
    );
    assert.equal(
      result.structuredContent.entity.configuration.value,
      "[REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(scenario.secret));
  }

  for (const [index, format, source] of [
    ["ordinary-json-code", "code", ordinaryCode],
    ["ordinary-invalid-block", "invalid_json", ordinaryInvalidBlock],
  ]) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: `spruthub://hub/home%2FA/scenario/${index}`,
        include: ["configuration"],
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(result.structuredContent.entity.configuration.format, format);
    assert.equal(result.structuredContent.entity.configuration.value, source);
    assert.match(result.content[0].text, /night/);
  }
});

test("scenario reads hide bracket credential assignments", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const scenarios = [
    {
      index: "double-quoted-bracket-code",
      data: 'const headers = {};\nheaders["X-Api-Key"] = "double-bracket-secret-must-not-leak";',
      secret: "double-bracket-secret-must-not-leak",
    },
    {
      index: "single-quoted-bracket-code",
      data: "const headers = {};\nheaders[\n  'api_token'\n] = 'single-bracket-secret-must-not-leak';",
      secret: "single-bracket-secret-must-not-leak",
    },
  ];
  state.scenarios.push(
    ...scenarios.map(({ index, data }) => ({
      index,
      name: index,
      type: "GLOBAL",
      predefined: false,
      active: true,
      data,
    })),
  );
  const client = await startClient(t, hub);

  for (const scenario of scenarios) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: `spruthub://hub/home%2FA/scenario/${scenario.index}`,
        include: ["configuration"],
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(result.structuredContent.entity.configuration.format, "code");
    assert.equal(
      result.structuredContent.entity.configuration.value,
      "[REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(scenario.secret));
  }
});

test("scenario reads keep sensitive words outside credential assignments", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const source =
    'switch (kind) { case "token": log.info("label"); break; }\n' +
    'const visibility = ok ? "secret" : "public";\n' +
    "const selected = ok ? config.token : fallback;\n" +
    'const secretary = "Anna";\n' +
    "const tokens = [1, 2, 3];\n" +
    "const tokenCount = tokens.length;\n" +
    "const apiKeyCount = 2;\n" +
    'const passwordField = "visible";\n' +
    'const keyboard = "visible";\n' +
    'const endpoint = "http://hub.invalid/api"; // ordinary URL\n' +
    'log.info("Password changed");';
  state.scenarios.push({
    index: "ordinary-sensitive-words",
    name: "ordinary-sensitive-words",
    type: "GLOBAL",
    predefined: false,
    active: true,
    data: source,
  });
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/ordinary-sensitive-words",
      include: ["configuration"],
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.entity.configuration.format, "code");
  assert.equal(result.structuredContent.entity.configuration.value, source);
  assert.match(result.content[0].text, /secretary/);
});

test("scenario reads use lexical context for credential-shaped text", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const sensitiveScenarios = [
    {
      index: "credential-after-line-comment",
      type: "GLOBAL",
      data: 'const config = {\n  room: "kitchen", // credentials\n  token: "comment-secret-must-not-leak"\n};',
      secret: "comment-secret-must-not-leak",
      format: "code",
    },
    {
      index: "quoted-credential-after-comment",
      type: "BLOCK",
      data: '{\n  // credentials\n  "api_key": "quoted-comment-secret-must-not-leak"',
      secret: "quoted-comment-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "credential-after-block-comment",
      type: "GLOBAL",
      data: 'const config = { room: "kitchen", /* credentials */ password: "block-comment-secret-must-not-leak" };',
      secret: "block-comment-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-on-later-native-line",
      type: "BLOCK",
      data: "name: kitchen\nAuthorization: Basic later-line-secret-must-not-leak",
      secret: "later-line-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "hyphenated-credential-on-later-native-line",
      type: "BLOCK",
      data: "name: kitchen\napi-key: hyphen-secret-must-not-leak",
      secret: "hyphen-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "credential-inside-string",
      type: "GLOBAL",
      data: 'const header = "Authorization: Basic string-secret-must-not-leak";',
      secret: "string-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-inside-call-string",
      type: "GLOBAL",
      data: 'log.info("api_key: call-string-secret-must-not-leak");',
      secret: "call-string-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-inside-url-query",
      type: "GLOBAL",
      data: 'fetch("https://api.host.invalid/v1/data?x=1&api_key=url-query-secret-must-not-leak");',
      secret: "url-query-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-inside-relative-url",
      type: "GLOBAL",
      data: 'fetch("/api?token=relative-url-secret-must-not-leak");',
      secret: "relative-url-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-inside-template",
      type: "GLOBAL",
      data: "const header = `Authorization: Basic template-secret-must-not-leak`;",
      secret: "template-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-after-question-mark-in-string",
      type: "GLOBAL",
      data: 'log.info("x?token: question-mark-secret-must-not-leak");',
      secret: "question-mark-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-after-case-word-in-string",
      type: "GLOBAL",
      data: 'log.info("use case token: case-word-secret-must-not-leak");',
      secret: "case-word-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-inside-line-comment",
      type: "GLOBAL",
      data: '// old token: line-comment-secret-must-not-leak\nlog.info("ready");',
      secret: "line-comment-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-inside-block-comment",
      type: "GLOBAL",
      data: '/* password: block-body-secret-must-not-leak */\nlog.info("ready");',
      secret: "block-body-secret-must-not-leak",
      format: "code",
    },
    {
      index: "credential-after-native-url",
      type: "BLOCK",
      data: "url: http://hub.invalid/api token: native-url-secret-must-not-leak",
      secret: "native-url-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "credential-after-unclosed-native-comment",
      type: "BLOCK",
      data: "path: /*\ntoken: unclosed-comment-secret-must-not-leak",
      secret: "unclosed-comment-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "collapsed-bare-credential",
      type: "GLOBAL",
      data: 'const apikey = "collapsed-bare-secret-must-not-leak";',
      secret: "collapsed-bare-secret-must-not-leak",
      format: "code",
    },
    {
      index: "collapsed-quoted-credential",
      type: "GLOBAL",
      data: '{ "APIKEY": "collapsed-quoted-secret-must-not-leak" };',
      secret: "collapsed-quoted-secret-must-not-leak",
      format: "code",
    },
    {
      index: "collapsed-bracket-credential",
      type: "GLOBAL",
      data: 'headers["apitoken"] = "collapsed-bracket-secret-must-not-leak";',
      secret: "collapsed-bracket-secret-must-not-leak",
      format: "code",
    },
    {
      index: "collapsed-native-credential",
      type: "BLOCK",
      data: "name: kitchen\naccesstoken: collapsed-native-secret-must-not-leak",
      secret: "collapsed-native-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "collapsed-escaped-credential",
      type: "GLOBAL",
      data: 'const payload = "{\\"clientsecret\\":\\"collapsed-escaped-secret-must-not-leak\\"}";',
      secret: "collapsed-escaped-secret-must-not-leak",
      format: "code",
    },
    ...["refreshtoken", "wifipassword", "privatekey"].map((name, index) => ({
      index: `collapsed-published-credential-${index}`,
      type: "GLOBAL",
      data: `config.${name} = "collapsed-published-${index}-secret-must-not-leak";`,
      secret: `collapsed-published-${index}-secret-must-not-leak`,
      format: "code",
    })),
    ...["secret_key", "secretKey", "SECRET_KEY", "aws_secret_access_key"].map(
      (name, index) => ({
        index: `compound-credential-${index}`,
        type: "GLOBAL",
        data: `const ${name} = "compound-${index}-secret-must-not-leak";`,
        secret: `compound-${index}-secret-must-not-leak`,
        format: "code",
      }),
    ),
  ];
  state.scenarios.push(
    ...sensitiveScenarios.map(({ index, type, data }) => ({
      index,
      name: index,
      type,
      predefined: false,
      active: true,
      data,
    })),
  );
  const client = await startClient(t, hub);

  for (const scenario of sensitiveScenarios) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: `spruthub://hub/home%2FA/scenario/${scenario.index}`,
        include: ["configuration"],
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(
      result.structuredContent.entity.configuration.format,
      scenario.format,
    );
    assert.equal(
      result.structuredContent.entity.configuration.value,
      "[REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(scenario.secret));
  }
});

test("scenario reads hide credential components after separators and leading dollars", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const scenarios = [
    {
      index: "suffixed-bare-credential",
      type: "GLOBAL",
      data: 'my-apikey = "suffixed-bare-secret-must-not-leak";',
      secret: "suffixed-bare-secret-must-not-leak",
      format: "code",
    },
    {
      index: "suffixed-quoted-credential",
      type: "GLOBAL",
      data: '{ "x-apikey": "suffixed-quoted-secret-must-not-leak" };',
      secret: "suffixed-quoted-secret-must-not-leak",
      format: "code",
    },
    {
      index: "suffixed-bracket-credential",
      type: "GLOBAL",
      data: 'headers["X-APIKEY"] = "suffixed-bracket-secret-must-not-leak";',
      secret: "suffixed-bracket-secret-must-not-leak",
      format: "code",
    },
    {
      index: "suffixed-native-credential",
      type: "BLOCK",
      data: "name: kitchen\nx-apikey: suffixed-native-secret-must-not-leak",
      secret: "suffixed-native-secret-must-not-leak",
      format: "invalid_json",
    },
    {
      index: "dollar-prefixed-credential",
      type: "GLOBAL",
      data: 'const $token = "dollar-prefixed-secret-must-not-leak";',
      secret: "dollar-prefixed-secret-must-not-leak",
      format: "code",
    },
  ];
  state.scenarios.push(
    ...scenarios.map(({ index, type, data }) => ({
      index,
      name: index,
      type,
      predefined: false,
      active: true,
      data,
    })),
  );
  const client = await startClient(t, hub);

  for (const scenario of scenarios) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: `spruthub://hub/home%2FA/scenario/${scenario.index}`,
        include: ["configuration"],
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.equal(
      result.structuredContent.entity.configuration.format,
      scenario.format,
    );
    assert.equal(
      result.structuredContent.entity.configuration.value,
      "[REDACTED]",
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(scenario.secret));
  }
});

test("scenario reads treat native JSON strings as data while preserving code context", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const nativeSecrets = [
    "Забыл пароль? password: native-question-secret-must-not-leak",
    "use case token: native-case-secret-must-not-leak",
  ];
  state.scenarios.push(
    ...nativeSecrets.map((note, index) => ({
      index: `native-string-data-${index}`,
      name: `native-string-data-${index}`,
      type: "BLOCK",
      predefined: false,
      active: true,
      data: JSON.stringify({ note, retry: 3 }),
    })),
  );
  const client = await startClient(t, hub);

  for (const [index, note] of nativeSecrets.entries()) {
    const result = await client.callTool({
      name: "get_entity",
      arguments: {
        entity_ref: `spruthub://hub/home%2FA/scenario/native-string-data-${index}`,
        include: ["configuration"],
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.deepEqual(result.structuredContent.entity.configuration, {
      format: "json",
      value: { note: "[REDACTED]", retry: 3 },
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(note));
  }
});

test("scenario reads redact when JavaScript context exceeds the local lookbehind", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const secret = "distant-context-secret-must-not-leak";
  state.scenarios.push({
    index: "distant-javascript-context",
    name: "distant-javascript-context",
    type: "GLOBAL",
    predefined: false,
    active: true,
    data: `condition ? ${"value + ".repeat(2_000)}token: "${secret}"`,
  });
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/distant-javascript-context",
      include: ["configuration"],
      max_bytes: 32_768,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(
    result.structuredContent.entity.configuration.value,
    "[REDACTED]",
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
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

test("only normalized scenario code keeps JavaScript context across presentations", async (t) => {
  const hub = await startHub();
  const state = hub.states.get("home/A");
  const source =
    "const selected = ready ? config.token : fallback;\n" +
    "switch (mode) { case token: log.info(selected); }\n" +
    "// exact source padding 💡\n".repeat(250);
  const nestedSecret = "nested-format-secret-must-not-leak";
  state.scenarios.push(
    {
      index: "contextual-code",
      name: "Контекстный код",
      type: "JS",
      predefined: false,
      active: true,
      data: source,
    },
    {
      index: "nested-code-lookalike",
      name: "Данные с похожим форматом",
      type: "BLOCK",
      predefined: false,
      active: true,
      data: JSON.stringify({
        configuration: {
          format: "code",
          value: `use case token: ${nestedSecret}`,
        },
      }),
    },
  );
  const client = await startClient(t, hub);
  const entityRef = "spruthub://hub/home%2FA/scenario/contextual-code";

  const full = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      max_bytes: 32_768,
    },
  });
  assert.equal(full.isError, undefined, full.content[0]?.text);
  assert.equal(full.structuredContent.entity.configuration.value, source);

  const pointer = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      pointer: "/configuration/value",
      max_bytes: 32_768,
    },
  });
  assert.equal(pointer.isError, undefined, pointer.content[0]?.text);
  assert.equal(pointer.structuredContent.selection.value, source);

  let chunk = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: entityRef,
      include: ["configuration"],
      pointer: "/configuration/value",
      max_bytes: 2_048,
    },
  });
  const chunks = [];
  while (true) {
    assert.equal(chunk.isError, undefined, chunk.content[0]?.text);
    chunks.push(chunk.structuredContent.selection.value.text);
    const next = chunk.structuredContent.selection.next;
    if (!next) break;
    chunk = await client.callTool({
      name: next.tool,
      arguments: next.arguments,
    });
  }
  assert.equal(chunks.join(""), source);

  const native = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: "spruthub://hub/home%2FA/scenario/nested-code-lookalike",
      include: ["configuration"],
    },
  });
  assert.equal(native.isError, undefined, native.content[0]?.text);
  assert.equal(
    native.structuredContent.entity.configuration.value.configuration.value,
    "[REDACTED]",
  );
  assert.doesNotMatch(JSON.stringify(native), new RegExp(nestedSecret));
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
      pointer: "/configuration/value",
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
    "/configuration/value",
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
      pointer: "/configuration/value",
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
      pointer: "/configuration/value",
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
