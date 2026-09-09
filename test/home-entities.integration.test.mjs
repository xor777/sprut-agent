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
            key: "WiFiPassword",
            value: { stringValue: "block-secret-must-not-leak" },
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
          key: "WiFiPassword",
          name: "Wi-Fi password",
          type: "GenericString",
          inputType: "PASSWORD",
          read: true,
          write: true,
          events: false,
          value: { stringValue: "structured-secret-must-not-leak" },
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
                ? "<li>0102_SensorDetectionSeconds (115F): 61 [UNSIGNED_8_BIT_INTEGER]</li>\nAuthorization: Bearer diagnostic-secret-must-not-leak\nstatus=ok"
                : "status=ok",
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
      const result = respond(states, request);
      responseSentAt.push({ request, at: Date.now() });
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    responseSentAt,
    behavior,
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
    {
      key: "clientSecret",
      name: "Client secret",
      type: "GenericString",
      input_type: "PASSWORD",
      configured_value: "[REDACTED]",
      unit: null,
      read: true,
      write: true,
      events: false,
      sensitive: true,
    },
  ]);
  const detection = entity.physical_configuration.options.find(
    ({ property }) => property === "SensorDetectionSeconds",
  );
  assert.equal(detection.configured_value, 10);
  assert.equal(detection.reported_value, 61);
  assert.equal(detection.reported_source, "window_info_report");
  assert.equal(detection.pending, "unknown");
  assert.equal(detection.source_timestamp, null);
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
  const password = entity.physical_configuration.options.find(
    ({ key }) => key === "WiFiPassword",
  );
  assert.equal(password.configured_value, "[REDACTED]");
  assert.deepEqual(entity.relations.assigned_logics, [
    {
      ref: "spruthub://hub/home%2FA/accessory/32/service/13/logic/MotionDetectedFromCurrentMotionLevel",
      type: "MotionDetectedFromCurrentMotionLevel",
      name: "Определение движения",
      active: true,
    },
  ]);
  assert.match(entity.diagnostics[0].text, /SensorDetectionSeconds.*61/);
  assert.doesNotMatch(entity.diagnostics[0].text, /must-not-leak/);
  assert.equal(entity.freshness.source_timestamp, null);
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
  const visible = JSON.stringify({ characteristic, scenario, block, overview });
  for (const secret of [
    "structured-secret-must-not-leak",
    "option-secret-must-not-leak",
    "diagnostic-secret-must-not-leak",
    "code-secret-must-not-leak",
    "block-secret-must-not-leak",
    "room-secret-must-not-leak",
    "must-not-leak",
  ]) {
    assert.doesNotMatch(visible, new RegExp(secret));
  }
  assert.match(visible, /\[REDACTED\]/);
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
