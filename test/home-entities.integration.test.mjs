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
    owner: true,
    model: "Sprut.hub 2",
    version: { current: { version: "3.0.0b", revision: "20131" } },
  },
  {
    serial: "home B",
    name: "Одинаковый дом",
    online: true,
    owner: true,
    model: "Sprut.hub 2",
    version: { current: { version: "3.0.0b", revision: "20131" } },
  },
];

function homeState(serial) {
  const suffix = serial === "home/A" ? "A" : "B";
  return {
    rooms: [{ id: 1, name: "Гостиная" }],
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
        }),
      },
      {
        index: "global-code",
        name: "Глобальный сценарий",
        type: "GLOBAL",
        predefined: false,
        active: true,
        data: 'const apiToken = "must-not-leak";\nlog.info("ready");',
      },
    ],
    extensions: [
      {
        key: `zigbee-${suffix}`,
        type: "ZigBee",
        bundleType: "CONTROLLER",
        name: `ZigBee ${suffix}`,
        enabled: true,
        state: "LOADED",
      },
    ],
    window: {
      windowKey: `window-${suffix}`,
      label: { text: "Настройки устройства" },
      options: [
        {
          key: "/1/FCC0_ManufacturerSpecific/0102_SensorDetectionSeconds/60",
          name: "Период обнаружения",
          type: "GenericInteger",
          inputType: "NUMBER",
          read: true,
          write: true,
          events: true,
          value: { intValue: 10 },
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
              "SensorDetectionSeconds=60\napiToken=must-not-leak\nstatus=ok",
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
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const result = respond(states, request);
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    server,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(states, request) {
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
      SPRUTHUB_TOKEN: "synthetic-account-token",
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

test("characteristic detail separates value, characteristic options, and physical reports", async (t) => {
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
  ]);
  const detection = entity.physical_configuration.options.find(
    ({ property }) => property === "SensorDetectionSeconds",
  );
  assert.equal(detection.configured_value, 10);
  assert.equal(detection.reported_value, 60);
  assert.equal(detection.pending, "unknown");
  assert.equal(detection.source_timestamp, null);
  assert.deepEqual(entity.relations.assigned_logics, [
    {
      ref: "spruthub://hub/home%2FA/accessory/32/service/13/logic/MotionDetectedFromCurrentMotionLevel",
      type: "MotionDetectedFromCurrentMotionLevel",
      name: "Определение движения",
      active: true,
    },
  ]);
  assert.match(entity.diagnostics[0].text, /SensorDetectionSeconds=60/);
  assert.doesNotMatch(entity.diagnostics[0].text, /must-not-leak/);
  assert.equal(entity.freshness.source_timestamp, null);
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
