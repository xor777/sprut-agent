import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
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
const diagnosticsByClient = new WeakMap();
const observedRoomReading = JSON.parse(
  await readFile(
    new URL(
      "../research/protocol/2026-09-09-room-reading.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const observedMotionReading = JSON.parse(
  await readFile(
    new URL(
      "../research/protocol/2026-09-09-motion-reading.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// Fails a hung MCP call well before the SDK's 60 s default, but only after the
// hub budget, so the product's own `timeout` result arrives first.
class BoundedTestClient extends Client {
  callTool(params, resultSchema, options = {}) {
    return super.callTool(params, resultSchema, {
      timeout: ORDINARY_HUB_TIMEOUT_MS + 5_000,
      ...options,
    });
  }
}

// Deliberate stalls below use this budget; the fake delays and the elapsed
// time bounds in those tests are calibrated against it.
const STALL_HUB_TIMEOUT = { SPRUTHUB_TIMEOUT_MS: "250" };

const hubState = {
  rooms: [
    { id: 10, order: 1, name: " Кухня ", visible: true },
    { id: 20, order: 2, name: "Гостиная", visible: true },
    { id: 30, order: 3, name: "Office", visible: true },
    { id: 31, order: 4, name: "1 - Офис", visible: true },
    { id: 40, order: 5, name: "Кладовая", visible: true },
    { id: 41, order: 6, name: "Кладовая", visible: true },
  ],
  accessories: [
    {
      id: 100,
      online: true,
      name: "Лампа",
      roomId: 10,
      services: [
        {
          aId: 100,
          sId: 1,
          name: "Основной свет",
          type: "Lightbulb",
          characteristics: [
            {
              aId: 100,
              sId: 1,
              cId: 1,
              control: {
                read: true,
                key: "On",
                name: "Включена",
                type: "On",
                unit: "boolean",
                value: { boolValue: false },
              },
            },
          ],
        },
      ],
    },
    {
      id: 101,
      online: true,
      name: "Термометр",
      roomId: 10,
      services: [
        {
          aId: 101,
          sId: 1,
          name: "Температура",
          type: "TemperatureSensor",
          characteristics: [
            {
              aId: 101,
              sId: 1,
              cId: 1,
              control: {
                read: true,
                key: "current-temperature",
                name: "Температура",
                type: "CurrentTemperature",
                unit: "°C",
                value: { doubleValue: 23.5 },
              },
            },
            {
              aId: 101,
              sId: 1,
              cId: 2,
              control: {
                read: true,
                key: "current-humidity",
                name: "Влажность",
                type: "CurrentHumidity",
                unit: "%",
                value: { intValue: 0 },
              },
            },
            {
              aId: 101,
              sId: 1,
              cId: 3,
              control: {
                read: true,
                key: "air-quality",
                name: "Качество воздуха",
                type: "AirQuality",
              },
            },
            {
              aId: 101,
              sId: 1,
              cId: 4,
              control: {
                read: true,
                key: "target-temperature",
                name: "Уставка температуры",
                type: "TargetTemperature",
                unit: "°C",
                value: { doubleValue: 22 },
              },
            },
            {
              aId: 101,
              sId: 1,
              cId: 5,
              control: {
                read: true,
                key: "WiFiPassword",
                name: "WiFiPassword",
                type: "GenericString",
                value: { stringValue: "legacy-secret-must-not-leak" },
              },
            },
          ],
        },
        {
          aId: 101,
          sId: 2,
          name: "Диагностика",
          type: "Diagnostics",
        },
      ],
    },
    {
      id: 102,
      online: true,
      name: "Шлюз",
      roomId: 10,
    },
    {
      id: 200,
      online: false,
      name: "Лампа",
      roomId: 20,
      services: [],
    },
    {
      id: 410,
      online: true,
      name: "Датчик двери",
      roomId: 41,
      services: [],
    },
  ],
};

async function startHub(initialState = hubState) {
  const state = structuredClone(initialState);
  const requests = [];
  const metrics = { connections: 0 };
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");

  server.on("connection", (socket) => {
    metrics.connections += 1;
    const connectionNumber = metrics.connections;
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);

      if (state.invalidFrameOnRequest) {
        state.invalidFrameOnRequest = false;
        socket._socket.write(Buffer.from([0x83, 0x00]));
        return;
      }

      const responseDelayMs = state.responseDelays?.shift();
      if (responseDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      }

      if (state.closeOnRequest) {
        state.closeOnRequest = false;
        socket.close();
        return;
      }
      if (
        state.ignoreRequests ||
        (state.ignoreFirstConnection && connectionNumber === 1)
      ) {
        return;
      }

      if (state.authorizationError) {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: state.authorizationError,
          }),
        );
        return;
      }

      if (request.params?.hub?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              hub: {
                list: {
                  hubs: state.homes ?? [
                    { serial: "test-hub", name: "Test home", online: true },
                  ],
                },
              },
            },
          }),
        );
        return;
      }

      if (request.params?.room?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { room: { list: { rooms: state.rooms } } },
          }),
        );
        return;
      }

      if (request.params?.room?.get) {
        const room = Object.hasOwn(state, "roomGetResponse")
          ? state.roomGetResponse
          : (state.rooms.find(({ id }) => id === request.params.room.get.id) ??
            null);
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { room: { get: room } },
          }),
        );
        return;
      }

      if (request.params?.accessory?.list) {
        const roomId = request.params.accessory.list.roomId;
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              accessory: {
                list: {
                  // null stays in the reply: an omitted list is an empty one.
                  accessories:
                    state.accessories === null
                      ? null
                      : state.accessories?.filter(
                          (accessory) =>
                            state.ignoreRoomFilter ||
                            roomId === undefined ||
                            accessory.roomId === roomId,
                        ),
                },
              },
            },
          }),
        );
        return;
      }

      if (request.params?.accessory?.get) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              accessory: {
                get:
                  state.accessories?.find(
                    ({ id }) => id === request.params.accessory.get.id,
                  ) ?? null,
              },
            },
          }),
        );
        return;
      }

      if (request.params?.scenario?.list || request.params?.extension?.list) {
        const [domain] = Object.keys(request.params);
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { [domain]: { list: {} } },
          }),
        );
        return;
      }

      socket.send(
        JSON.stringify({
          id: request.id,
          error: { code: -32601, message: "Unsupported test operation" },
        }),
      );
    });
  });

  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    state,
    metrics,
    requests,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

async function startSilentHandshakeHub() {
  const sockets = new Set();
  const emptyWaiters = new Set();
  let acceptedConnections = 0;
  const server = createServer((socket) => {
    acceptedConnections += 1;
    sockets.add(socket);
    socket.resume();
    socket.once("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) {
        for (const resolve of emptyWaiters) resolve();
        emptyWaiters.clear();
      }
    });
  });
  server.listen(0, FAKE_HUB_HOST);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    server,
    destroyConnections() {
      for (const socket of sockets) socket.destroy();
    },
    get acceptedConnections() {
      return acceptedConnections;
    },
    get openConnections() {
      return sockets.size;
    },
    waitForNoConnections(timeoutMs = ORDINARY_HUB_TIMEOUT_MS) {
      if (sockets.size === 0) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          emptyWaiters.delete(finish);
          reject(
            new Error("Timed out waiting for the handshake socket to close"),
          );
        }, timeoutMs);
        emptyWaiters.add(finish);
      });
    },
    url: `ws://127.0.0.1:${address.port}`,
  };
}

async function getClosedWebSocketUrl() {
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

async function startMcpClient(t, hub, environment = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...(process.env.__STRYKER_ACTIVE_MUTANT__ === undefined
        ? {}
        : {
            __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__,
          }),
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "synthetic-test-token",
      SPRUTHUB_SERIAL: "test-hub",
      SPRUTHUB_CID: "sprut-agent-test",
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      ...environment,
    },
    stderr: "pipe",
  });
  const client = new BoundedTestClient({
    name: "sprut-agent-test",
    version: "1.0.0",
  });
  const diagnostics = [];
  transport.stderr?.on("data", (chunk) => diagnostics.push(chunk.toString()));
  diagnosticsByClient.set(client, diagnostics);

  t.after(async () => {
    await client.close();
    hub.destroyConnections?.();
    for (const socket of hub.server.clients ?? []) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
  });

  await client.connect(transport);
  return client;
}

function readRoomServices(client, roomRef) {
  return client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: roomRef.replace(/\/room\/\d+$/, ""),
      room_ref: roomRef,
      max_bytes: 32_768,
    },
  });
}

function servicesOf(body) {
  return body.rooms.flatMap(({ devices }) =>
    devices.flatMap(({ services }) => services),
  );
}

function findDevice(body, ref) {
  return body.rooms
    .flatMap(({ devices }) => devices)
    .find((device) => device.ref === ref);
}

function findReading(body, ref) {
  return servicesOf(body)
    .flatMap(({ values = [] }) => values)
    .find((reading) => reading.ref === ref);
}

test("MCP discovers every room before reading the selected stable reference", async (t) => {
  const hub = await startHub();
  hub.state.ignoreRoomFilter = true;
  const client = await startMcpClient(t, hub);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name),
    [
      "home_overview",
      "find_devices",
      "get_entity",
      "preview_boolean_automation",
      "apply_automation_change",
      "get_scenario_sdk",
      "send_device_commands",
      "get_native_change_contract",
      "prepare_native_change",
      "restore_native_change",
      "list_native_changes",
      "save_configuration_point",
      "list_configuration_points",
      "get_configuration_point",
      "apply_native_change",
      "get_native_change",
      "get_automation_change",
      "rollback_automation_change",
      "start_native_observation",
      "get_native_observation",
      "stop_native_observation",
      "read_hub_log",
    ],
  );
  for (const tool of tools.tools.filter(({ name }) =>
    [
      "home_overview",
      "find_devices",
      "get_entity",
      "get_automation_change",
    ].includes(name),
  )) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  }

  const catalog = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(
    catalog.structuredContent.rooms.map(({ ref, name }) => ({ ref, name })),
    [
      { ref: "spruthub://hub/test-hub/room/10", name: " Кухня " },
      { ref: "spruthub://hub/test-hub/room/20", name: "Гостиная" },
      { ref: "spruthub://hub/test-hub/room/30", name: "Office" },
      { ref: "spruthub://hub/test-hub/room/31", name: "1 - Офис" },
      { ref: "spruthub://hub/test-hub/room/40", name: "Кладовая" },
      { ref: "spruthub://hub/test-hub/room/41", name: "Кладовая" },
    ],
  );
  const overviewRequests = hub.requests.length;

  const result = await client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      max_bytes: 32_768,
    },
  });
  assert.equal(
    result.isError,
    undefined,
    `expected a room reading, got: ${result.content[0]?.text}`,
  );

  const reading = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), reading);
  assert.equal(reading.status, "ok");
  assert.deepEqual(
    reading.rooms.map(({ ref, name }) => ({ ref, name })),
    [{ ref: "spruthub://hub/test-hub/room/10", name: " Кухня " }],
  );
  const lamp = findDevice(reading, "spruthub://hub/test-hub/accessory/100");
  assert.equal(lamp.name, "Лампа");
  assert.equal(lamp.available, true);
  assert.equal(
    lamp.services[0].ref,
    "spruthub://hub/test-hub/accessory/100/service/1",
  );
  assert.deepEqual(lamp.services[0].values[0], {
    type: "On",
    value: false,
    unit: "boolean",
    ref: "spruthub://hub/test-hub/accessory/100/service/1/characteristic/1",
  });

  const thermometer = findDevice(
    reading,
    "spruthub://hub/test-hub/accessory/101",
  ).services.find(({ type }) => type === "TemperatureSensor");
  assert.equal(thermometer.values[0].value, 23.5);
  assert.equal(thermometer.values[0].unit, "°C");
  assert.equal(thermometer.values[0].type, "CurrentTemperature");
  assert.deepEqual(thermometer.values[3], {
    type: "TargetTemperature",
    value: 22,
    unit: "°C",
    ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/4",
  });
  assert.deepEqual(thermometer.values[4], {
    redacted: true,
    reason: "sensitive_native_data",
  });
  assert.doesNotMatch(result.content[0].text, /legacy-secret-must-not-leak/);
  assert.equal(
    result.content[0].text.includes("spruthub://hub/test-hub/accessory/200"),
    false,
  );
  assert.match(reading.observed_at, /^\d{4}-\d{2}-\d{2}T/);

  // The overview left the home's names in the session catalog, so the room
  // read asks the hub only for the values of its two devices.
  assert.deepEqual(
    hub.requests.slice(0, overviewRequests).map(({ params }) => params),
    [
      { hub: { list: {} } },
      { room: { list: {} } },
      { accessory: { list: { expand: "services,characteristics" } } },
      { scenario: { list: {} } },
      { extension: { list: {} } },
    ],
  );
  assert.deepEqual(
    hub.requests.slice(overviewRequests).map(({ serial, params }) => ({
      serial,
      params,
    })),
    [
      { serial: "test-hub", params: { accessory: { get: { id: 100 } } } },
      { serial: "test-hub", params: { accessory: { get: { id: 101 } } } },
    ],
  );
});

test("find_devices returns one complete mixed-room view without per-service reads", async (t) => {
  const state = structuredClone(hubState);
  state.accessories.push(
    thermostatAccessory({
      id: 110,
      name: "Кондиционер",
      currentMode: 2,
      currentTemperature: 25,
      targetTemperature: 23,
    }),
    thermostatAccessory({
      id: 111,
      name: "Терморегулятор для радиатора",
      currentMode: 1,
      currentTemperature: 21,
      targetTemperature: 30,
      online: false,
    }),
  );
  const hub = await startHub(state);
  const client = await startMcpClient(t, hub);

  const result = await client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      max_bytes: 32_768,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const view = result.structuredContent;
  assert.equal(view.status, "ok");
  assert.equal(view.home_ref, "spruthub://hub/test-hub");
  assert.deepEqual(
    view.rooms.map(({ ref, name }) => ({ ref, name })),
    [{ ref: "spruthub://hub/test-hub/room/10", name: " Кухня " }],
  );
  assert.deepEqual(
    [...new Set(servicesOf(view).map(({ type }) => type))],
    ["Lightbulb", "TemperatureSensor", "Diagnostics", "Thermostat"],
  );
  assert.equal(
    servicesOf(view).filter(({ type }) => type === "Thermostat").length,
    2,
  );
  const radiator = findDevice(view, "spruthub://hub/test-hub/accessory/111");
  assert.equal(radiator.name, "Терморегулятор для радиатора");
  assert.equal(radiator.available, false);
  assert.deepEqual(
    radiator.services[0].values.map(
      ({ type, value, value_status, unit, enum: choice }) => ({
        type,
        value,
        value_status,
        unit,
        enum: choice,
      }),
    ),
    [
      {
        type: "CurrentHeatingCoolingState",
        value: 1,
        value_status: undefined,
        unit: undefined,
        enum: { key: "HEAT", name: "Нагрев" },
      },
      {
        type: "CurrentTemperature",
        value: 21,
        value_status: undefined,
        unit: "°C",
        enum: undefined,
      },
      {
        type: "TargetTemperature",
        value: 30,
        value_status: undefined,
        unit: "°C",
        enum: undefined,
      },
    ],
  );

  const readingByType = (type) =>
    servicesOf(view)
      .flatMap(({ values = [] }) => values)
      .find((reading) => reading.type === type);
  assert.deepEqual(
    {
      off: readingByType("On"),
      zero: readingByType("CurrentHumidity"),
      unknown: readingByType("AirQuality"),
    },
    {
      off: {
        type: "On",
        value: false,
        unit: "boolean",
        ref: "spruthub://hub/test-hub/accessory/100/service/1/characteristic/1",
      },
      zero: {
        type: "CurrentHumidity",
        value: 0,
        unit: "%",
        ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/2",
      },
      unknown: {
        type: "AirQuality",
        value: null,
        value_status: "unknown",
        ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/3",
      },
    },
  );
  assert.deepEqual(
    servicesOf(view)
      .flatMap(({ values = [] }) => values)
      .find(({ redacted }) => redacted),
    { redacted: true, reason: "sensitive_native_data" },
  );
  assert(Buffer.byteLength(result.content[0].text) <= 32_768);
  assert.equal(view.next, null);
  assert.doesNotMatch(result.content[0].text, /legacy-secret-must-not-leak/);
  // Names and values come from the same two whole reads; no per-service
  // reads follow.
  assert.deepEqual(
    hub.requests.map(({ params }) => params),
    [
      { room: { list: {} } },
      { accessory: { list: { expand: "services,characteristics" } } },
    ],
  );
});

test("find_devices filters by household kind across the home and keeps empty rooms apart", async (t) => {
  const state = structuredClone(hubState);
  state.accessories.push(
    thermostatAccessory({
      id: 210,
      roomId: 20,
      name: "Гостиный радиатор",
      currentMode: 0,
      currentTemperature: 22,
      targetTemperature: 22,
    }),
    {
      id: 411,
      online: true,
      name: "Геркон",
      roomId: 41,
      services: [
        {
          aId: 411,
          sId: 1,
          name: "Дверь",
          type: "ContactSensor",
          characteristics: [
            {
              aId: 411,
              sId: 1,
              cId: 1,
              control: {
                read: true,
                key: "ContactSensorState",
                name: "Состояние",
                type: "ContactSensorState",
                value: { intValue: 0 },
              },
            },
          ],
        },
      ],
    },
  );
  const hub = await startHub(state);
  const client = await startMcpClient(t, hub);

  const climate = await client.callTool({
    name: "find_devices",
    arguments: { home_ref: "spruthub://hub/test-hub", kind: "climate" },
  });
  assert.equal(climate.isError, undefined, climate.content[0]?.text);
  assert.deepEqual(
    servicesOf(climate.structuredContent).map(({ type }) => type),
    ["Thermostat"],
  );
  assert.deepEqual(
    climate.structuredContent.rooms.map(({ ref }) => ref),
    ["spruthub://hub/test-hub/room/20"],
  );
  const sensors = await client.callTool({
    name: "find_devices",
    arguments: { home_ref: "spruthub://hub/test-hub", kind: "sensor" },
  });
  assert.deepEqual(
    sensors.structuredContent.rooms.map(({ ref }) => ref),
    ["spruthub://hub/test-hub/room/10", "spruthub://hub/test-hub/room/41"],
  );
  assert.equal(hub.requests.filter(({ params }) => params.room?.get).length, 0);
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).length,
    1,
  );
  assert.deepEqual(
    hub.requests.find(({ params }) => params.accessory?.list).params,
    { accessory: { list: { expand: "services,characteristics" } } },
  );

  const noMatch = await client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      kind: "cover",
    },
  });
  assert.equal(noMatch.structuredContent.total, 0);
  assert.deepEqual(noMatch.structuredContent.rooms, []);

  const summary = await client.callTool({
    name: "find_devices",
    arguments: { home_ref: "spruthub://hub/test-hub" },
  });
  const counts = Object.fromEntries(
    summary.structuredContent.rooms.map(({ ref, services }) => [ref, services]),
  );
  assert.equal(counts["spruthub://hub/test-hub/room/40"], 0);
  assert(counts["spruthub://hub/test-hub/room/10"] > 0);
});

test("find_devices pages one snapshot within max_bytes without substitution", async (t) => {
  const state = structuredClone(hubState);
  for (let id = 110; id < 118; id += 1) {
    state.accessories.push(
      thermostatAccessory({
        id,
        name: `Регулятор ${id}`,
        currentMode: id % 3,
        currentTemperature: 20 + (id - 110),
        targetTemperature: 25,
      }),
    );
  }
  const hub = await startHub(state);
  const client = await startMcpClient(t, hub);
  const argumentsBase = {
    home_ref: "spruthub://hub/test-hub",
    room_ref: "spruthub://hub/test-hub/room/10",
    kind: "climate",
    max_bytes: 2_500,
  };
  const services = [];
  let next = { tool: "find_devices", arguments: argumentsBase };
  let pageCount = 0;
  while (next) {
    const page = await client.callTool({
      name: next.tool,
      arguments: next.arguments,
    });
    assert.equal(page.isError, undefined, page.content[0]?.text);
    assert(Buffer.byteLength(page.content[0].text) <= argumentsBase.max_bytes);
    assert.equal(page.content[0].text, JSON.stringify(page.structuredContent));
    services.push(...servicesOf(page.structuredContent));
    next = page.structuredContent.next;
    if (pageCount === 0) {
      // The rest comes from the first read's snapshot, whatever the hub
      // does meanwhile.
      hub.state.accessories = hub.state.accessories
        .filter(({ id }) => id !== 110)
        .reverse();
    }
    if (next) {
      assert.deepEqual(
        Object.keys(next.arguments).sort(),
        [...Object.keys(argumentsBase), "cursor"].sort(),
      );
    }
    pageCount += 1;
    assert(pageCount < 20);
  }

  assert(pageCount > 1);
  assert.deepEqual(
    services.map(({ ref }) => ref),
    Array.from(
      { length: 8 },
      (_, index) =>
        `spruthub://hub/test-hub/accessory/${110 + index}/service/1`,
    ),
  );
  assert.deepEqual(
    services.map(
      ({ values }) =>
        values.find(({ type }) => type === "CurrentTemperature").value,
    ),
    Array.from({ length: 8 }, (_, index) => 20 + index),
  );
});

test("a cursor whose snapshot is gone asks for a restart", async (t) => {
  const state = structuredClone(hubState);
  for (let id = 110; id < 118; id += 1) {
    state.accessories.push(
      thermostatAccessory({
        id,
        name: `Регулятор ${id}`,
        currentMode: id % 3,
        currentTemperature: 20 + (id - 110),
        targetTemperature: 25,
      }),
    );
  }
  const hub = await startHub(state);
  const client = await startMcpClient(t, hub);
  const argumentsBase = {
    home_ref: "spruthub://hub/test-hub",
    room_ref: "spruthub://hub/test-hub/room/10",
    kind: "climate",
    limit: 3,
  };
  const first = await client.callTool({
    name: "find_devices",
    arguments: argumentsBase,
  });
  assert(first.structuredContent.next);

  // A new MCP process holds no snapshot of the earlier one.
  const restarted = await startMcpClient(t, hub);
  const next = await restarted.callTool({
    name: "find_devices",
    arguments: first.structuredContent.next.arguments,
  });

  assert.equal(next.isError, true);
  assert.equal(next.structuredContent.error.code, "stale_cursor");
  assert.deepEqual(next.structuredContent.next, {
    tool: "find_devices",
    arguments: argumentsBase,
  });
});

test("find_devices keeps the selected home and services whose room metadata is missing", async (t) => {
  const state = structuredClone(hubState);
  state.homes = [
    { serial: "test-hub", name: "Configured home", online: true },
    { serial: "neighbor-home", name: "Selected home", online: true },
  ];
  state.accessories = [
    thermostatAccessory({
      id: 900,
      roomId: 999,
      name: "Регулятор без комнаты",
      currentMode: 1,
      currentTemperature: 19,
      targetTemperature: 21,
    }),
  ];
  const hub = await startHub(state);
  const client = await startMcpClient(t, hub);

  const result = await client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: "spruthub://hub/neighbor-home",
      kind: "climate",
      max_bytes: 32_768,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.total, 1);
  assert.deepEqual(
    result.structuredContent.rooms.map(({ ref, name, metadata_status }) => ({
      ref,
      name,
      metadata_status,
    })),
    [
      {
        ref: "spruthub://hub/neighbor-home/room/999",
        name: null,
        metadata_status: "missing",
      },
    ],
  );
  assert.deepEqual(
    hub.requests.map(({ serial, params }) => ({
      serial: serial ?? null,
      params,
    })),
    [
      { serial: null, params: { hub: { list: {} } } },
      { serial: "neighbor-home", params: { room: { list: {} } } },
      {
        serial: "neighbor-home",
        params: {
          accessory: { list: { expand: "services,characteristics" } },
        },
      },
    ],
  );
});

test("find_devices points oversized detail to its exact entity instead of truncating a value", async (t) => {
  const hugeValue = "x".repeat(8_000);
  const hub = await startHub({
    rooms: [{ id: 10, name: "Офис" }],
    accessories: [
      {
        id: 100,
        roomId: 10,
        name: "Большой сервис",
        online: true,
        services: [
          {
            aId: 100,
            sId: 1,
            name: "Диагностика",
            type: "Diagnostics",
            characteristics: [
              {
                aId: 100,
                sId: 1,
                cId: 1,
                control: {
                  read: true,
                  key: "Report",
                  name: "Отчёт",
                  type: "Report",
                  value: { stringValue: hugeValue },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  const client = await startMcpClient(t, hub);

  const result = await client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      max_bytes: 2_048,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert(Buffer.byteLength(result.content[0].text) <= 2_048);
  assert.equal(result.content[0].text.includes(hugeValue), false);
  assert.deepEqual(servicesOf(result.structuredContent), [
    {
      ref: "spruthub://hub/test-hub/accessory/100/service/1",
      name: "Диагностика",
      type: "Diagnostics",
      kind: "other",
      values_omitted: "exceeds_max_bytes",
      next: {
        tool: "get_entity",
        arguments: {
          entity_ref: "spruthub://hub/test-hub/accessory/100/service/1",
        },
      },
    },
  ]);
  assert.equal(result.structuredContent.next, null);
});

test("find_devices rejects a foreign room and restarts an invalid cursor without losing services", async (t) => {
  const state = structuredClone(hubState);
  for (let id = 110; id < 118; id += 1) {
    state.accessories.push(
      thermostatAccessory({
        id,
        name: `Регулятор ${id}`,
        currentMode: id % 3,
        currentTemperature: 20 + (id - 110),
        targetTemperature: 25,
      }),
    );
  }
  state.accessories.push(
    lightAccessory({ id: 118, name: "Дашина лампа" }),
    lightAccessory({ id: 119, name: "Свет" }),
  );
  const hub = await startHub(state);
  const client = await startMcpClient(t, hub);

  const crossHome = await client.callTool({
    name: "find_devices",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/neighbor-home/room/10",
    },
  });
  assert.equal(crossHome.isError, true);
  assert.deepEqual(crossHome.structuredContent.error, {
    code: "invalid_room_ref",
    message:
      "room_ref must be a room ref of the selected home from home_overview.",
    retryable: false,
    action: "home_overview",
  });
  assert.equal(hub.requests.length, 0);

  const restartArguments = {
    home_ref: "spruthub://hub/test-hub",
    room_ref: "spruthub://hub/test-hub/room/10",
    kind: "light",
    max_bytes: 2_048,
  };
  const invalidCursor = await client.callTool({
    name: "find_devices",
    arguments: {
      ...restartArguments,
      cursor: "not-a-find-devices-cursor",
    },
  });
  assert.equal(invalidCursor.isError, true);
  assert.deepEqual(invalidCursor.structuredContent, {
    status: "error",
    next: {
      tool: "find_devices",
      arguments: restartArguments,
    },
    error: {
      code: "invalid_cursor",
      message: "Use the cursor returned by find_devices with the same filters.",
      retryable: false,
      action: "restart_find_devices",
    },
  });
  assert.equal(hub.requests.length, 0);

  const services = [];
  let next = invalidCursor.structuredContent.next;
  do {
    const page = await client.callTool({
      name: next.tool,
      arguments: next.arguments,
    });
    assert.equal(page.isError, undefined, page.content[0]?.text);
    assert(
      Buffer.byteLength(page.content[0].text) <= restartArguments.max_bytes,
    );
    services.push(
      ...page.structuredContent.rooms.flatMap(({ devices }) =>
        devices.map(({ name }) => name),
      ),
    );
    next = page.structuredContent.next;
  } while (next);

  assert.deepEqual(services, ["Лампа", "Дашина лампа", "Свет"]);
});

function thermostatAccessory({
  id,
  roomId = 10,
  name,
  currentMode,
  currentTemperature,
  targetTemperature,
  online = true,
}) {
  return {
    id,
    online,
    name,
    roomId,
    services: [
      {
        aId: id,
        sId: 1,
        name: "Термостат",
        type: "Thermostat",
        characteristics: [
          {
            aId: id,
            sId: 1,
            cId: 1,
            control: {
              read: true,
              key: "CurrentHeatingCoolingState",
              name: "Текущий режим",
              type: "CurrentHeatingCoolingState",
              value: { intValue: currentMode },
              validValues: [
                { key: "OFF", name: "Выключен", value: { intValue: 0 } },
                { key: "HEAT", name: "Нагрев", value: { intValue: 1 } },
                { key: "COOL", name: "Охлаждение", value: { intValue: 2 } },
              ],
            },
          },
          {
            aId: id,
            sId: 1,
            cId: 2,
            control: {
              read: true,
              key: "CurrentTemperature",
              name: "Температура",
              type: "CurrentTemperature",
              unit: "°C",
              value: { doubleValue: currentTemperature },
            },
          },
          {
            aId: id,
            sId: 1,
            cId: 3,
            control: {
              read: true,
              key: "TargetTemperature",
              name: "Уставка",
              type: "TargetTemperature",
              unit: "°C",
              value: { doubleValue: targetTemperature },
            },
          },
        ],
      },
    ],
  };
}

function lightAccessory({ id, name }) {
  return {
    id,
    online: true,
    name,
    roomId: 10,
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
              read: true,
              key: "On",
              name: "Включена",
              type: "On",
              unit: "boolean",
              value: { boolValue: false },
            },
          },
        ],
      },
    ],
  };
}

test("observed real-hub projection keeps both temperature service contexts", async (t) => {
  const [roomExchange, accessoryExchange] = observedRoomReading.exchanges;
  const hub = await startHub({
    rooms: roomExchange.result.room.list.rooms,
    accessories: accessoryExchange.result.accessory.list.accessories,
  });
  const client = await startMcpClient(t, hub);
  const roomRef = `spruthub://hub/test-hub/room/${roomExchange.result.room.list.rooms[0].id}`;
  const result = await readRoomServices(client, roomRef);

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const services = servicesOf(result.structuredContent);
  assert.deepEqual(
    services.map(({ name, type, values }) => ({
      name,
      type,
      readingType: values[0].type,
      value: values[0].value,
      unit: values[0].unit,
    })),
    [
      {
        name: "Indoor temperature",
        type: "Thermostat",
        readingType: "CurrentTemperature",
        value: 21.5,
        unit: "°C",
      },
      {
        name: "Outdoor temperature",
        type: "TemperatureSensor",
        readingType: "CurrentTemperature",
        value: 10,
        unit: "°C",
      },
    ],
  );
  assert.notEqual(services[0].values[0].ref, services[1].values[0].ref);
  assert.equal(
    hub.requests[1].params.accessory.list.expand,
    accessoryExchange.params.accessory.list.expand,
  );
});

test("observed multisensor projection keeps readable native enum meaning", async (t) => {
  const [roomExchange, accessoryExchange] = observedMotionReading.exchanges;
  const observedAccessory = structuredClone(
    accessoryExchange.result.accessory.list.accessories[0],
  );
  const motionControl = observedAccessory.services
    .flatMap(({ characteristics = [] }) => characteristics)
    .find(({ control }) => control.type === "MotionDetected").control;
  motionControl.value = { boolValue: false };

  const hub = await startHub({
    rooms: [roomExchange.result.room.get],
    accessories: [observedAccessory],
  });
  const client = await startMcpClient(t, hub);
  const read = async () => {
    const result = await client.callTool({
      name: "find_devices",
      arguments: {
        home_ref: "spruthub://hub/test-hub",
        room_ref: "spruthub://hub/test-hub/room/20",
        include_technical: true,
        max_bytes: 32_768,
      },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return result.structuredContent;
  };
  const readingByType = (view, type) =>
    servicesOf(view)
      .flatMap(({ values }) => values)
      .find((reading) => reading.type === type);
  const ref = (sId, cId) =>
    `spruthub://hub/test-hub/accessory/200/service/${sId}/characteristic/${cId}`;

  const chargingControl = hub.state.accessories[0].services
    .flatMap(({ characteristics = [] }) => characteristics)
    .find(({ control }) => control.type === "ChargingState").control;
  chargingControl.validValues.unshift({
    checked: true,
    value: { doubleValue: 2 },
    key: "WRONG_NUMERIC_TYPE",
    name: "Wrong numeric type",
  });
  const initial = await read();
  chargingControl.value = { intValue: 1 };
  const checkedMismatch = await read();
  chargingControl.type = "FutureChargingState";
  chargingControl.value = { intValue: 99 };
  const unknown = await read();

  const initialReadings = servicesOf(initial).flatMap(({ values }) => values);
  assert.deepEqual(
    {
      services: servicesOf(initial).map(({ ref, type, kind, values }) => ({
        ref,
        type,
        kind,
        values: values.map(({ ref, type, value, unit }) => ({
          ref,
          type,
          value,
          unit,
        })),
      })),
      readingCount: initialReadings.length,
      hasIdentify: initialReadings.some(({ type }) => type === "Identify"),
      batteryPercent: initial.rooms[0].devices[0].battery_percent,
      catalogName: readingByType(initial, "C_CatalogId").name,
      motion: readingByType(initial, "MotionDetected"),
      light: readingByType(initial, "CurrentAmbientLightLevel"),
      lowBattery: readingByType(initial, "StatusLowBattery"),
      charging: readingByType(initial, "ChargingState"),
      checkedMismatch: readingByType(checkedMismatch, "ChargingState"),
      unknown: readingByType(unknown, "FutureChargingState"),
    },
    {
      services: [
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/10",
          type: "AccessoryInformation",
          kind: "technical",
          values: [
            {
              ref: ref(10, 501),
              type: "C_Room",
              value: "Room B",
              unit: undefined,
            },
            {
              ref: ref(10, 503),
              type: "Manufacturer",
              value: "Aqara",
              unit: undefined,
            },
            {
              ref: ref(10, 504),
              type: "Model",
              value: "RTCGQ14LM",
              unit: undefined,
            },
            {
              ref: ref(10, 506),
              type: "SerialNumber",
              value: "example-motion-device",
              unit: undefined,
            },
            {
              ref: ref(10, 507),
              type: "FirmwareRevision",
              value: "11",
              unit: undefined,
            },
            {
              ref: ref(10, 508),
              type: "C_Online",
              value: true,
              unit: undefined,
            },
            {
              ref: ref(10, 509),
              type: "C_CatalogId",
              value: 3987,
              unit: undefined,
            },
          ],
        },
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/20",
          type: "MotionSensor",
          kind: "sensor",
          values: [
            {
              ref: ref(20, 510),
              type: "MotionDetected",
              value: false,
              unit: undefined,
            },
          ],
        },
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/30",
          type: "LightSensor",
          kind: "sensor",
          values: [
            {
              ref: ref(30, 513),
              type: "CurrentAmbientLightLevel",
              value: 100,
              unit: "lux",
            },
          ],
        },
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/40",
          type: "BatteryService",
          kind: "technical",
          values: [
            { ref: ref(40, 515), type: "BatteryLevel", value: 60, unit: "%" },
            {
              ref: ref(40, 516),
              type: "StatusLowBattery",
              value: 0,
              unit: undefined,
            },
            {
              ref: ref(40, 517),
              type: "ChargingState",
              value: 2,
              unit: undefined,
            },
          ],
        },
      ],
      readingCount: 12,
      hasIdentify: false,
      batteryPercent: 60,
      catalogName: "Посмотреть в каталоге",
      motion: { type: "MotionDetected", value: false, ref: ref(20, 510) },
      light: {
        type: "CurrentAmbientLightLevel",
        value: 100,
        unit: "lux",
        ref: ref(30, 513),
      },
      lowBattery: {
        type: "StatusLowBattery",
        value: 0,
        enum: { key: "BATTERY_LEVEL_NORMAL", name: "Нет" },
        ref: ref(40, 516),
      },
      charging: {
        type: "ChargingState",
        value: 2,
        enum: { key: "NOT_CHARGEABLE", name: "Не заряжаемый" },
        ref: ref(40, 517),
      },
      checkedMismatch: {
        type: "ChargingState",
        value: 1,
        enum: { key: "CHARGING", name: "Да" },
        ref: ref(40, 517),
      },
      unknown: {
        type: "FutureChargingState",
        value: 99,
        enum: null,
        ref: ref(40, 517),
      },
    },
  );
});

test("repeated MCP reads return the latest hub values without losing false, zero, or unknown", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);
  const temperatureRef =
    "spruthub://hub/test-hub/accessory/101/service/1/characteristic/1";

  const firstResult = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(firstResult.isError, undefined);
  const firstTemperature = findReading(
    firstResult.structuredContent,
    temperatureRef,
  );
  assert.equal(firstTemperature.value, 23.5);

  hub.state.accessories[1].services[0].characteristics[0].control.value = {
    doubleValue: 24.75,
  };

  const secondResult = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(secondResult.isError, undefined);
  const secondRoom = secondResult.structuredContent;
  const secondTemperature = findReading(secondRoom, temperatureRef);
  assert.equal(secondTemperature.ref, firstTemperature.ref);
  assert.equal(secondTemperature.value, 24.75);

  assert.equal(
    findReading(
      secondRoom,
      "spruthub://hub/test-hub/accessory/100/service/1/characteristic/1",
    ).value,
    false,
  );
  assert.equal(
    findReading(
      secondRoom,
      "spruthub://hub/test-hub/accessory/101/service/1/characteristic/2",
    ).value,
    0,
  );
  assert.deepEqual(
    findReading(
      secondRoom,
      "spruthub://hub/test-hub/accessory/101/service/1/characteristic/3",
    ),
    {
      type: "AirQuality",
      value: null,
      value_status: "unknown",
      ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/3",
    },
  );
  assert.match(secondRoom.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  // The first read takes names and values in two whole reads; the second
  // reads only the room's two devices.
  assert.equal(hub.requests.length, 4);
});

test("room catalog keeps duplicate and prefixed names for agent-side selection", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);

  const catalog = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.deepEqual(catalog.structuredContent.rooms.slice(2), [
    { ref: "spruthub://hub/test-hub/room/30", name: "Office", device_count: 0 },
    {
      ref: "spruthub://hub/test-hub/room/31",
      name: "1 - Офис",
      device_count: 0,
    },
    {
      ref: "spruthub://hub/test-hub/room/40",
      name: "Кладовая",
      device_count: 0,
    },
    {
      ref: "spruthub://hub/test-hub/room/41",
      name: "Кладовая",
      device_count: 1,
    },
  ]);

  const selected = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: "spruthub://hub/test-hub/room/41" },
  });
  assert.equal(selected.isError, undefined);
  assert.equal(
    selected.structuredContent.entity.ref,
    "spruthub://hub/test-hub/room/41",
  );
  assert.equal(selected.structuredContent.entity.name, "Кладовая");
  assert.deepEqual(
    selected.structuredContent.entity.accessories.map(({ ref }) => ref),
    ["spruthub://hub/test-hub/accessory/410"],
  );

  for (const invalidRef of [
    "prefixspruthub://hub/test-hub/room/41",
    "spruthub://hub/test-hub/room/41/suffix",
  ]) {
    const invalid = await readRoomServices(client, invalidRef);
    assert.equal(invalid.isError, true);
    assert.deepEqual(invalid.structuredContent.error, {
      code: "invalid_entity_ref",
      message:
        "Use a home-qualified reference returned by home_overview, find_devices, or get_entity.",
      retryable: false,
      action: "home_overview",
    });
  }
});

test("empty, missing, incompatible, and unavailable room data remain distinct", async (t) => {
  const hub = await startHub();
  hub.state.rooms.push({
    id: 50,
    order: 6,
    name: "Пустая",
    visible: true,
  });
  hub.state.accessories.push({
    id: 103,
    online: false,
    name: "Недоступный контакт",
    roomId: 10,
    services: [
      {
        aId: 103,
        sId: 1,
        name: "Контакт",
        type: "ContactSensor",
        characteristics: [
          {
            aId: 103,
            sId: 1,
            cId: 1,
            control: {
              read: true,
              key: "contact-state",
              name: "Открыт",
              type: "ContactState",
              unit: "boolean",
              value: { boolValue: false },
            },
          },
        ],
      },
    ],
  });
  const client = await startMcpClient(t, hub);

  const empty = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/50",
  );
  assert.equal(empty.isError, undefined, empty.content[0]?.text);
  assert.equal(empty.structuredContent.status, "ok");
  assert.equal(empty.structuredContent.total, 0);
  assert.deepEqual(empty.structuredContent.rooms, []);

  const missing = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/999",
  );
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent, {
    status: "error",
    next: {
      tool: "home_overview",
      arguments: { home_ref: "spruthub://hub/test-hub" },
    },
    error: {
      code: "room_not_found",
      message: "The selected SprutHub room was not found.",
      retryable: false,
      action: "home_overview",
    },
  });
  assert.deepEqual(
    JSON.parse(missing.content[0].text),
    missing.structuredContent,
  );

  const kitchen = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  const unavailable = findDevice(
    kitchen.structuredContent,
    "spruthub://hub/test-hub/accessory/103",
  );
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.services[0].values[0].value, false);

  const incompatibleClient = await startMcpClient(t, hub);
  hub.state.accessories = null;
  const incompatible = await readRoomServices(
    incompatibleClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(incompatible.isError, true);
  assert.deepEqual(incompatible.structuredContent, {
    status: "error",
    error: {
      code: "incompatible_response",
      message: "SprutHub returned an incompatible entity list.",
      retryable: false,
    },
  });
  assert.deepEqual(
    JSON.parse(incompatible.content[0].text),
    incompatible.structuredContent,
  );

  const invalidClient = await startMcpClient(t, hub, {
    SPRUTHUB_URL: "not-a-websocket-url",
  });
  const internal = await readRoomServices(
    invalidClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(internal.isError, true);
  assert.deepEqual(internal.structuredContent, {
    status: "error",
    error: {
      code: "internal_error",
      message: "Could not read the SprutHub room.",
      retryable: false,
    },
  });
});

test("incomplete room and service identifiers never become stable references", async (t) => {
  const incompatibleCatalogHub = await startHub({
    rooms: null,
    accessories: [],
  });
  const incompatibleCatalogClient = await startMcpClient(
    t,
    incompatibleCatalogHub,
  );
  const incompatibleCatalog = await incompatibleCatalogClient.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.deepEqual(incompatibleCatalog.structuredContent.error, {
    code: "incompatible_response",
    message: "SprutHub returned an incompatible room list.",
    retryable: false,
  });

  const incompleteRoomHub = await startHub({
    rooms: [{ name: "Room without id" }],
    accessories: [],
  });
  const incompleteRoomClient = await startMcpClient(t, incompleteRoomHub);
  const incompleteRoom = await incompleteRoomClient.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.equal(incompleteRoom.isError, true);
  assert.deepEqual(incompleteRoom.structuredContent, {
    status: "error",
    error: {
      code: "incompatible_response",
      message: "SprutHub returned incomplete room data.",
      retryable: false,
    },
  });
  assert.equal(
    JSON.stringify(incompleteRoom).includes("room/undefined"),
    false,
  );

  const incompleteListedRoomHub = await startHub();
  incompleteListedRoomHub.state.rooms.push({ name: "Listed room without id" });
  const incompleteListedRoomClient = await startMcpClient(
    t,
    incompleteListedRoomHub,
  );
  const incompleteListedRoom = await readRoomServices(
    incompleteListedRoomClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(incompleteListedRoom.isError, true);
  assert.deepEqual(incompleteListedRoom.structuredContent.error, {
    code: "incompatible_response",
    message: "SprutHub returned incomplete room data.",
    retryable: false,
  });

  const incompleteServiceHub = await startHub();
  delete incompleteServiceHub.state.accessories[0].services[0].sId;
  const incompleteServiceClient = await startMcpClient(t, incompleteServiceHub);
  const incompleteService = await readRoomServices(
    incompleteServiceClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(incompleteService.isError, true);
  assert.deepEqual(incompleteService.structuredContent, {
    status: "error",
    error: {
      code: "incompatible_response",
      message: "SprutHub returned incomplete accessory data.",
      retryable: false,
    },
  });
  assert.equal(
    JSON.stringify(incompleteService).includes("service/undefined"),
    false,
  );
});

test("authorization failures identify credential repair without leaking the rejected secret", async (t) => {
  const hub = await startHub();
  hub.state.authorizationError = {
    code: 401,
    message: "invalid synthetic-test-token",
  };
  const client = await startMcpClient(t, hub);

  const result = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    status: "error",
    capability_status: "insufficient_access",
    error: {
      code: "authentication_failed",
      message: "SprutHub rejected the configured credentials.",
      retryable: false,
      action: "check_credentials",
    },
  });

  hub.state.authorizationError = {
    code: 500,
    message: "request failed near synthetic-test-token",
  };
  const rejected = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(rejected.isError, true);
  assert.deepEqual(rejected.structuredContent, {
    status: "error",
    error: {
      code: "request_rejected",
      message: "SprutHub rejected the request.",
      retryable: false,
    },
  });

  const visibleOutput = JSON.stringify({
    results: [result, rejected],
    diagnostics: diagnosticsByClient.get(client),
  });
  assert.equal(visibleOutput.includes("synthetic-test-token"), false);
});

test("connection failures stay bounded and recover with a fresh reading in the same MCP session", async (t) => {
  const unavailableHub = await startHub();
  const closedUrl = await getClosedWebSocketUrl();
  const unavailableClient = await startMcpClient(t, unavailableHub, {
    SPRUTHUB_URL: closedUrl,
  });

  const unavailableStartedAt = performance.now();
  const unavailable = await readRoomServices(
    unavailableClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert(performance.now() - unavailableStartedAt < 1_000);
  assert.deepEqual(unavailable.structuredContent, {
    status: "error",
    capability_status: "unknown",
    error: {
      code: "connection_failed",
      message: "Could not connect to SprutHub.",
      retryable: true,
      action: "retry",
    },
  });

  const silentHub = await startHub();
  silentHub.state.ignoreFirstConnection = true;
  const silentClient = await startMcpClient(t, silentHub, STALL_HUB_TIMEOUT);
  const timeoutStartedAt = performance.now();
  const timeout = await readRoomServices(
    silentClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert(performance.now() - timeoutStartedAt < 1_000);
  assert.deepEqual(timeout.structuredContent, {
    status: "error",
    capability_status: "unknown",
    error: {
      code: "timeout",
      message: "SprutHub did not respond within the request budget.",
      retryable: true,
      action: "retry",
    },
  });
  const afterTimeout = await readRoomServices(
    silentClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(afterTimeout.isError, undefined);
  assert.equal(afterTimeout.structuredContent.status, "ok");
  assert.equal(silentHub.metrics.connections, 2);

  const concurrentHub = await startHub();
  const concurrentClient = await startMcpClient(t, concurrentHub);
  const concurrentReads = await Promise.all([
    readRoomServices(concurrentClient, "spruthub://hub/test-hub/room/10"),
    readRoomServices(concurrentClient, "spruthub://hub/test-hub/room/20"),
  ]);
  assert.deepEqual(
    concurrentReads.map(({ structuredContent }) => structuredContent.status),
    ["ok", "ok"],
  );
  assert.equal(concurrentHub.metrics.connections, 1);

  const recoveringHub = await startHub();
  const recoveringClient = await startMcpClient(t, recoveringHub);
  const first = await readRoomServices(
    recoveringClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(first.isError, undefined);
  const temperatureRef =
    "spruthub://hub/test-hub/accessory/101/service/1/characteristic/1";
  assert.equal(
    findReading(first.structuredContent, temperatureRef).value,
    23.5,
  );

  recoveringHub.state.closeOnRequest = true;
  const interrupted = await readRoomServices(
    recoveringClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.deepEqual(interrupted.structuredContent, {
    status: "error",
    capability_status: "unknown",
    error: {
      code: "connection_closed",
      message: "The SprutHub connection closed before the response arrived.",
      retryable: true,
      action: "retry",
    },
  });

  recoveringHub.state.accessories[1].services[0].characteristics[0].control.value =
    {
      doubleValue: 26.25,
    };
  const recovered = await readRoomServices(
    recoveringClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(recovered.isError, undefined);
  assert.equal(
    findReading(recovered.structuredContent, temperatureRef).value,
    26.25,
  );
  assert.equal(recoveringHub.metrics.connections, 2);
});

test("one tool deadline covers the WebSocket handshake and every room RPC", async (t) => {
  const handshakeHub = await startSilentHandshakeHub();
  const handshakeClient = await startMcpClient(
    t,
    handshakeHub,
    STALL_HUB_TIMEOUT,
  );
  const handshakeStartedAt = performance.now();
  const handshakeTimeout = await readRoomServices(
    handshakeClient,
    "spruthub://hub/test-hub/room/10",
  );
  assert(performance.now() - handshakeStartedAt < 1_000);
  assert.deepEqual(handshakeTimeout.structuredContent, {
    status: "error",
    capability_status: "unknown",
    error: {
      code: "timeout",
      message: "SprutHub did not respond within the request budget.",
      retryable: true,
      action: "retry",
    },
  });
  assert.equal(handshakeHub.acceptedConnections, 1);
  await handshakeHub.waitForNoConnections();
  assert.equal(handshakeHub.openConnections, 0);

  // Another home of the account is checked first, so the room reads follow
  // the home list inside the same budget.
  const slowHub = await startHub();
  slowHub.state.homes = [
    { serial: "test-hub", name: "Configured home", online: true },
    { serial: "neighbor-home", name: "Other home", online: true },
  ];
  slowHub.state.responseDelays = [160, 160];
  const slowClient = await startMcpClient(t, slowHub, STALL_HUB_TIMEOUT);
  const slowStartedAt = performance.now();
  const sequenceTimeout = await readRoomServices(
    slowClient,
    "spruthub://hub/neighbor-home/room/10",
  );
  assert(performance.now() - slowStartedAt < 1_000);
  assert.deepEqual(sequenceTimeout.structuredContent, {
    status: "error",
    capability_status: "unknown",
    error: {
      code: "timeout",
      message: "SprutHub did not respond within the request budget.",
      retryable: true,
      action: "retry",
    },
  });
});

test("a post-open WebSocket error is retryable in the same MCP session", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);
  const temperatureRef =
    "spruthub://hub/test-hub/accessory/101/service/1/characteristic/1";

  const first = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(
    findReading(first.structuredContent, temperatureRef).value,
    23.5,
  );

  hub.state.invalidFrameOnRequest = true;
  const interrupted = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.deepEqual(interrupted.structuredContent, {
    status: "error",
    capability_status: "unknown",
    error: {
      code: "connection_closed",
      message: "The SprutHub connection closed before the response arrived.",
      retryable: true,
      action: "retry",
    },
  });

  hub.state.accessories[1].services[0].characteristics[0].control.value = {
    doubleValue: 27.5,
  };
  const recovered = await readRoomServices(
    client,
    "spruthub://hub/test-hub/room/10",
  );
  assert.equal(
    findReading(recovered.structuredContent, temperatureRef).value,
    27.5,
  );
});
