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

class BoundedTestClient extends Client {
  callTool(params, resultSchema, options = {}) {
    return super.callTool(params, resultSchema, {
      timeout: 1_500,
      ...options,
    });
  }
}

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
  const server = new WebSocketServer({ port: 0 });
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
                  accessories: state.accessories?.filter(
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
  server.listen(0, "127.0.0.1");
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
    waitForNoConnections(timeoutMs = 500) {
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
  const server = new WebSocketServer({ port: 0 });
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
      SPRUTHUB_TIMEOUT_MS: "250",
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

function findReading(room, ref) {
  return room.devices
    .flatMap(({ services }) => services)
    .flatMap(({ readings }) => readings)
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
      "list_homes",
      "inspect_home",
      "get_entity",
      "list_rooms",
      "preview_boolean_automation",
      "apply_automation_change",
      "get_scenario_sdk",
      "get_native_change_contract",
      "prepare_native_change",
      "restore_native_change",
      "list_native_changes",
      "apply_native_change",
      "get_native_change",
      "get_automation_change",
      "rollback_automation_change",
      "start_native_observation",
      "get_native_observation",
      "stop_native_observation",
      "read_services",
      "read_room",
    ],
  );
  for (const tool of tools.tools.filter(({ name }) =>
    [
      "list_homes",
      "inspect_home",
      "get_entity",
      "list_rooms",
      "get_automation_change",
      "read_services",
      "read_room",
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
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(catalog.isError, undefined);
  assert.deepEqual(catalog.structuredContent.rooms, [
    { ref: "spruthub://hub/test-hub/room/10", name: " Кухня " },
    { ref: "spruthub://hub/test-hub/room/20", name: "Гостиная" },
    { ref: "spruthub://hub/test-hub/room/30", name: "Office" },
    { ref: "spruthub://hub/test-hub/room/31", name: "1 - Офис" },
    { ref: "spruthub://hub/test-hub/room/40", name: "Кладовая" },
    { ref: "spruthub://hub/test-hub/room/41", name: "Кладовая" },
  ]);

  const result = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(
    result.isError,
    undefined,
    `expected a room reading, got: ${result.content[0]?.text}`,
  );

  const reading = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), reading);
  assert.equal(reading.status, "ok");
  assert.deepEqual(reading.room, {
    ref: "spruthub://hub/test-hub/room/10",
    name: " Кухня ",
  });
  assert.equal(reading.devices.length, 3);

  const lamp = reading.devices.find(
    ({ ref }) => ref === "spruthub://hub/test-hub/accessory/100",
  );
  assert.equal(lamp.name, "Лампа");
  assert.equal(lamp.available, true);
  assert.deepEqual(
    lamp.services[0].ref,
    "spruthub://hub/test-hub/accessory/100/service/1",
  );
  assert.deepEqual(lamp.services[0].readings[0], {
    ref: "spruthub://hub/test-hub/accessory/100/service/1/characteristic/1",
    name: "Включена",
    type: "On",
    value: false,
    unit: "boolean",
    measuredAt: null,
  });

  const thermometer = reading.devices.find(
    ({ ref }) => ref === "spruthub://hub/test-hub/accessory/101",
  );
  assert.deepEqual(thermometer.services[0].readings[0].value, 23.5);
  assert.deepEqual(thermometer.services[0].readings[0].unit, "°C");
  assert.equal(thermometer.services[0].readings[0].type, "CurrentTemperature");
  assert.deepEqual(thermometer.services[0].readings[3], {
    ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/4",
    name: "Уставка температуры",
    type: "TargetTemperature",
    value: 22,
    unit: "°C",
    measuredAt: null,
  });
  assert.deepEqual(thermometer.services[0].readings[4], {
    redacted: true,
    reason: "sensitive_native_data",
  });
  assert.doesNotMatch(result.content[0].text, /legacy-secret-must-not-leak/);
  assert.deepEqual(thermometer.services[1].readings, []);
  assert.deepEqual(
    reading.devices.find(
      ({ ref }) => ref === "spruthub://hub/test-hub/accessory/102",
    ).services,
    [],
  );
  assert.equal(
    reading.devices.some(
      ({ ref }) => ref === "spruthub://hub/test-hub/accessory/200",
    ),
    false,
  );
  assert.equal(reading.freshness.measurementAt, null);
  assert.match(reading.freshness.hubResponseReceivedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(hub.requests, [
    {
      id: 1,
      token: "synthetic-test-token",
      serial: "test-hub",
      cid: "sprut-agent-test",
      params: { room: { list: {} } },
    },
    {
      id: 2,
      token: "synthetic-test-token",
      serial: "test-hub",
      cid: "sprut-agent-test",
      params: { room: { get: { id: 10 } } },
    },
    {
      id: 3,
      token: "synthetic-test-token",
      serial: "test-hub",
      cid: "sprut-agent-test",
      params: {
        accessory: {
          list: { roomId: 10, expand: "services,characteristics" },
        },
      },
    },
  ]);
});

test("read_services returns one complete mixed-room view without per-service reads", async (t) => {
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
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      max_bytes: 32_768,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const view = result.structuredContent;
  assert.equal(view.status, "ok");
  assert.deepEqual(view.scope, {
    home_ref: "spruthub://hub/test-hub",
    room: { ref: "spruthub://hub/test-hub/room/10", name: " Кухня " },
  });
  assert.equal(view.scope_status, "non_empty");
  assert.equal(view.match_status, "not_filtered");
  assert.deepEqual(view.observed_service_types, [
    "Lightbulb",
    "TemperatureSensor",
    "Diagnostics",
    "Thermostat",
  ]);
  assert.equal(
    view.services.filter(({ type }) => type === "Thermostat").length,
    2,
  );
  const radiator = view.services.find(
    ({ accessory }) => accessory.name === "Терморегулятор для радиатора",
  );
  assert.deepEqual(radiator.room, view.scope.room);
  assert.equal(radiator.accessory.available, false);
  assert.deepEqual(
    radiator.readings.map(
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
        value_status: "known",
        unit: null,
        enum: { key: "HEAT", name: "Нагрев" },
      },
      {
        type: "CurrentTemperature",
        value: 21,
        value_status: "known",
        unit: "°C",
        enum: undefined,
      },
      {
        type: "TargetTemperature",
        value: 30,
        value_status: "known",
        unit: "°C",
        enum: undefined,
      },
    ],
  );

  const readingByType = (type) =>
    view.services
      .flatMap(({ readings = [] }) => readings)
      .find((reading) => reading.type === type);
  assert.deepEqual(
    {
      off: readingByType("On"),
      zero: readingByType("CurrentHumidity"),
      unknown: readingByType("AirQuality"),
    },
    {
      off: {
        ref: "spruthub://hub/test-hub/accessory/100/service/1/characteristic/1",
        name: "Включена",
        type: "On",
        value: false,
        value_status: "known",
        unit: "boolean",
        measured_at: null,
      },
      zero: {
        ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/2",
        name: "Влажность",
        type: "CurrentHumidity",
        value: 0,
        value_status: "known",
        unit: "%",
        measured_at: null,
      },
      unknown: {
        ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/3",
        name: "Качество воздуха",
        type: "AirQuality",
        value: null,
        value_status: "unknown",
        unit: null,
        measured_at: null,
      },
    },
  );
  assert.deepEqual(
    view.services
      .flatMap(({ readings = [] }) => readings)
      .find(({ redacted }) => redacted),
    { redacted: true, reason: "sensitive_native_data" },
  );
  assert.equal(
    Buffer.byteLength(result.content[0].text),
    view.page.serialized_bytes,
  );
  assert(view.page.serialized_bytes <= view.page.max_bytes);
  assert.equal(view.page.snapshot, false);
  assert.equal(view.page.next_cursor, null);
  assert.doesNotMatch(result.content[0].text, /legacy-secret-must-not-leak/);
  assert.deepEqual(
    hub.requests.map(({ params }) => params),
    [
      { room: { get: { id: 10 } } },
      {
        accessory: {
          list: { roomId: 10, expand: "services,characteristics" },
        },
      },
    ],
  );
});

test("read_services filters exact native types across the home and distinguishes empty selection", async (t) => {
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

  const found = await client.callTool({
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      service_types: ["ContactSensor", "Thermostat"],
      max_bytes: 32_768,
    },
  });
  assert.equal(found.isError, undefined, found.content[0]?.text);
  assert.equal(found.structuredContent.match_status, "matched");
  assert.deepEqual(
    found.structuredContent.services.map(({ type }) => type).sort(),
    ["ContactSensor", "Thermostat"],
  );
  assert.deepEqual(
    found.structuredContent.services.map(({ room }) => room.ref).sort(),
    ["spruthub://hub/test-hub/room/20", "spruthub://hub/test-hub/room/41"],
  );
  assert.equal(hub.requests.filter(({ params }) => params.room?.get).length, 0);
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).length,
    1,
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.accessory?.list).length,
    1,
  );
  assert.deepEqual(
    hub.requests.find(({ params }) => params.accessory?.list).params,
    {
      accessory: { list: { expand: "services,characteristics" } },
    },
  );

  const noMatch = await client.callTool({
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      service_types: ["NotARealNativeType"],
    },
  });
  assert.equal(noMatch.structuredContent.scope_status, "non_empty");
  assert.equal(noMatch.structuredContent.match_status, "no_matches");
  assert.deepEqual(noMatch.structuredContent.services, []);
  assert(
    noMatch.structuredContent.observed_service_types.includes("Lightbulb"),
  );

  const empty = await client.callTool({
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/40",
    },
  });
  assert.equal(empty.structuredContent.scope_status, "empty");
  assert.equal(empty.structuredContent.match_status, "not_filtered");
  assert.deepEqual(empty.structuredContent.observed_service_types, []);
  assert.deepEqual(empty.structuredContent.services, []);
});

test("read_services byte-bounded cursors return every complete service without substitution", async (t) => {
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
    service_types: ["Thermostat"],
    max_bytes: 5_000,
  };
  const services = [];
  let cursor;
  let pageCount = 0;
  do {
    const page = await client.callTool({
      name: "read_services",
      arguments: { ...argumentsBase, ...(cursor ? { cursor } : {}) },
    });
    assert.equal(page.isError, undefined, page.content[0]?.text);
    assert(Buffer.byteLength(page.content[0].text) <= argumentsBase.max_bytes);
    assert.equal(page.content[0].text, JSON.stringify(page.structuredContent));
    assert.equal(
      Buffer.byteLength(page.content[0].text),
      page.structuredContent.page.serialized_bytes,
    );
    services.push(...page.structuredContent.services);
    cursor = page.structuredContent.page.next_cursor;
    if (pageCount === 0) {
      const removedAccessoryRef =
        page.structuredContent.services[0].accessory.ref;
      hub.state.accessories = hub.state.accessories
        .filter(
          ({ id }) =>
            `spruthub://hub/test-hub/accessory/${id}` !== removedAccessoryRef,
        )
        .reverse();
    }
    if (cursor) {
      assert.deepEqual(page.structuredContent.next, {
        tool: "read_services",
        arguments: { ...argumentsBase, cursor },
      });
    } else {
      assert.equal(page.structuredContent.next, null);
    }
    pageCount += 1;
    assert(pageCount < 20);
  } while (cursor);

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
      ({ readings }) =>
        readings.find(({ type }) => type === "CurrentTemperature").value,
    ),
    Array.from({ length: 8 }, (_, index) => 20 + index),
  );
});

test("read_services reports a stale cursor when its last returned service disappeared", async (t) => {
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
    service_types: ["Thermostat"],
    max_bytes: 5_000,
  };
  const first = await client.callTool({
    name: "read_services",
    arguments: argumentsBase,
  });
  assert(first.structuredContent.page.next_cursor);
  const anchor = first.structuredContent.services.at(-1);
  hub.state.accessories = hub.state.accessories.filter(
    ({ id }) =>
      `spruthub://hub/test-hub/accessory/${id}` !== anchor.accessory.ref,
  );

  const next = await client.callTool({
    name: "read_services",
    arguments: {
      ...argumentsBase,
      cursor: first.structuredContent.page.next_cursor,
    },
  });

  assert.equal(next.isError, true);
  assert.equal(next.structuredContent.error.code, "stale_cursor");
  assert.deepEqual(next.structuredContent.next, {
    tool: "read_services",
    arguments: argumentsBase,
  });
});

test("read_services keeps the selected home and services whose room metadata is missing", async (t) => {
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
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/neighbor-home",
      service_types: ["Thermostat"],
      max_bytes: 32_768,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.scope_status, "non_empty");
  assert.equal(result.structuredContent.match_status, "matched");
  assert.deepEqual(result.structuredContent.services[0].room, {
    ref: "spruthub://hub/neighbor-home/room/999",
    name: null,
    metadata_status: "missing",
  });
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

test("read_services points oversized detail to its exact entity instead of truncating a value", async (t) => {
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
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/test-hub/room/10",
      max_bytes: 2_048,
    },
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert(Buffer.byteLength(result.content[0].text) <= 2_048);
  assert.equal(result.content[0].text.includes(hugeValue), false);
  assert.deepEqual(result.structuredContent.services[0], {
    ref: "spruthub://hub/test-hub/accessory/100/service/1",
    name: "Диагностика",
    type: "Diagnostics",
    room: {
      ref: "spruthub://hub/test-hub/room/10",
      name: "Офис",
    },
    accessory: {
      ref: "spruthub://hub/test-hub/accessory/100",
      name: "Большой сервис",
      available: true,
    },
    observed_at: result.structuredContent.services[0].observed_at,
    readings_status: "not_included",
    reason: "service_exceeds_page_limit",
    next: {
      tool: "get_entity",
      arguments: {
        entity_ref: "spruthub://hub/test-hub/accessory/100/service/1",
      },
    },
  });
  assert.equal(result.structuredContent.page.next_cursor, null);
});

test("read_services rejects cross-home scope and restarts an invalid bounded room cursor without losing late services", async (t) => {
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
    name: "read_services",
    arguments: {
      home_ref: "spruthub://hub/test-hub",
      room_ref: "spruthub://hub/neighbor-home/room/10",
    },
  });
  assert.equal(crossHome.isError, true);
  assert.deepEqual(crossHome.structuredContent.error, {
    code: "invalid_service_scope",
    message: "room_ref must identify a room in the selected home_ref.",
    retryable: false,
    action: "inspect_home",
  });
  assert.equal(hub.requests.length, 0);

  const restartArguments = {
    home_ref: "spruthub://hub/test-hub",
    room_ref: "spruthub://hub/test-hub/room/10",
    service_types: ["Lightbulb"],
    max_bytes: 2_048,
  };
  const invalidCursor = await client.callTool({
    name: "read_services",
    arguments: {
      ...restartArguments,
      cursor: "not-a-read-services-cursor",
    },
  });
  assert.equal(invalidCursor.isError, true);
  assert.deepEqual(invalidCursor.structuredContent, {
    status: "error",
    next: {
      tool: "read_services",
      arguments: restartArguments,
    },
    error: {
      code: "invalid_cursor",
      message:
        "Use the cursor returned by read_services for the same scope and filters.",
      retryable: false,
      action: "restart_read_services",
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
    assert(Buffer.byteLength(page.content[0].text) <= restartArguments.max_bytes);
    services.push(...page.structuredContent.services);
    next = page.structuredContent.next;
  } while (next);

  assert.deepEqual(
    services.map(({ accessory }) => accessory.name),
    ["Лампа", "Дашина лампа", "Свет"],
  );
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

  const catalog = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  const selectedRef = catalog.structuredContent.rooms[0].ref;
  const result = await client.callTool({
    name: "read_room",
    arguments: { room_ref: selectedRef },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.devices.length, 1);
  const services = result.structuredContent.devices[0].services;
  assert.deepEqual(
    services.map(({ name, type, readings }) => ({
      name,
      type,
      readingType: readings[0].type,
      value: readings[0].value,
      unit: readings[0].unit,
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
  assert.notEqual(services[0].readings[0].ref, services[1].readings[0].ref);
  assert.deepEqual(hub.requests[2].params, accessoryExchange.params);
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
      name: "read_room",
      arguments: { room_ref: "spruthub://hub/test-hub/room/20" },
    });
    assert.equal(result.isError, undefined);
    return result.structuredContent.devices[0];
  };
  const readingByType = (device, type) =>
    device.services
      .flatMap(({ readings }) => readings)
      .find((reading) => reading.type === type);

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

  const initialReadings = initial.services.flatMap(({ readings }) => readings);
  assert.deepEqual(
    {
      services: initial.services.map(({ ref, type, readings }) => ({
        ref,
        type,
        readings: readings.map(({ ref, type, value, unit }) => ({
          ref,
          type,
          value,
          unit,
        })),
      })),
      readingCount: initialReadings.length,
      hasIdentify: initialReadings.some(({ type }) => type === "Identify"),
      motion: readingByType(initial, "MotionDetected"),
      light: readingByType(initial, "CurrentAmbientLightLevel"),
      batteryLevel: readingByType(initial, "BatteryLevel"),
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
          readings: [
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/501",
              type: "C_Room",
              value: "Room B",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/503",
              type: "Manufacturer",
              value: "Aqara",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/504",
              type: "Model",
              value: "RTCGQ14LM",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/505",
              type: "Name",
              value: "Motion device B",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/506",
              type: "SerialNumber",
              value: "example-motion-device",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/507",
              type: "FirmwareRevision",
              value: "11",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/508",
              type: "C_Online",
              value: true,
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/10/characteristic/509",
              type: "C_CatalogId",
              value: 3987,
              unit: null,
            },
          ],
        },
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/20",
          type: "MotionSensor",
          readings: [
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/20/characteristic/510",
              type: "MotionDetected",
              value: false,
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/20/characteristic/511",
              type: "Name",
              value: "Motion sensor",
              unit: null,
            },
          ],
        },
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/30",
          type: "LightSensor",
          readings: [
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/30/characteristic/512",
              type: "Name",
              value: "Датчик освещенности",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/30/characteristic/513",
              type: "CurrentAmbientLightLevel",
              value: 100,
              unit: "lux",
            },
          ],
        },
        {
          ref: "spruthub://hub/test-hub/accessory/200/service/40",
          type: "BatteryService",
          readings: [
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/514",
              type: "Name",
              value: "Батарея",
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/515",
              type: "BatteryLevel",
              value: 60,
              unit: "%",
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/516",
              type: "StatusLowBattery",
              value: 0,
              unit: null,
            },
            {
              ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/517",
              type: "ChargingState",
              value: 2,
              unit: null,
            },
          ],
        },
      ],
      readingCount: 16,
      hasIdentify: false,
      motion: {
        ref: "spruthub://hub/test-hub/accessory/200/service/20/characteristic/510",
        name: "Обнаружено движение",
        type: "MotionDetected",
        value: false,
        unit: null,
        measuredAt: null,
      },
      light: {
        ref: "spruthub://hub/test-hub/accessory/200/service/30/characteristic/513",
        name: "Освещенность",
        type: "CurrentAmbientLightLevel",
        value: 100,
        unit: "lux",
        measuredAt: null,
      },
      batteryLevel: {
        ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/515",
        name: "Уровень заряда",
        type: "BatteryLevel",
        value: 60,
        unit: "%",
        measuredAt: null,
      },
      lowBattery: {
        ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/516",
        name: "Батарея разряжена",
        type: "StatusLowBattery",
        value: 0,
        unit: null,
        enum: { key: "BATTERY_LEVEL_NORMAL", name: "Нет" },
        measuredAt: null,
      },
      charging: {
        ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/517",
        name: "Идет зарядка",
        type: "ChargingState",
        value: 2,
        unit: null,
        enum: { key: "NOT_CHARGEABLE", name: "Не заряжаемый" },
        measuredAt: null,
      },
      checkedMismatch: {
        ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/517",
        name: "Идет зарядка",
        type: "ChargingState",
        value: 1,
        unit: null,
        enum: { key: "CHARGING", name: "Да" },
        measuredAt: null,
      },
      unknown: {
        ref: "spruthub://hub/test-hub/accessory/200/service/40/characteristic/517",
        name: "Идет зарядка",
        type: "FutureChargingState",
        value: 99,
        unit: null,
        enum: null,
        measuredAt: null,
      },
    },
  );
});

test("repeated MCP reads return the latest hub values without losing false, zero, or unknown", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);
  const temperatureRef =
    "spruthub://hub/test-hub/accessory/101/service/1/characteristic/1";

  const firstResult = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(firstResult.isError, undefined);
  const firstTemperature = findReading(
    firstResult.structuredContent,
    temperatureRef,
  );
  assert.equal(firstTemperature.value, 23.5);

  hub.state.accessories[1].services[0].characteristics[0].control.value = {
    doubleValue: 24.75,
  };

  const secondResult = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
      ref: "spruthub://hub/test-hub/accessory/101/service/1/characteristic/3",
      name: "Качество воздуха",
      type: "AirQuality",
      value: null,
      unit: null,
      measuredAt: null,
    },
  );
  assert.equal(secondRoom.freshness.measurementAt, null);
  assert.equal(hub.requests.length, 4);
});

test("room catalog keeps duplicate and prefixed names for agent-side selection", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);

  const catalog = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.deepEqual(catalog.structuredContent.rooms.slice(2), [
    { ref: "spruthub://hub/test-hub/room/30", name: "Office" },
    { ref: "spruthub://hub/test-hub/room/31", name: "1 - Офис" },
    { ref: "spruthub://hub/test-hub/room/40", name: "Кладовая" },
    { ref: "spruthub://hub/test-hub/room/41", name: "Кладовая" },
  ]);

  const selected = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/41" },
  });
  assert.equal(selected.isError, undefined);
  assert.deepEqual(selected.structuredContent.room, {
    ref: "spruthub://hub/test-hub/room/41",
    name: "Кладовая",
  });
  assert.deepEqual(
    selected.structuredContent.devices.map(({ ref }) => ref),
    ["spruthub://hub/test-hub/accessory/410"],
  );

  for (const invalidRef of [
    "prefixspruthub://hub/test-hub/room/41",
    "spruthub://hub/test-hub/room/41/suffix",
  ]) {
    const invalid = await client.callTool({
      name: "read_room",
      arguments: { room_ref: invalidRef },
    });
    assert.equal(invalid.isError, true);
    assert.deepEqual(invalid.structuredContent.error, {
      code: "invalid_room_ref",
      message:
        "Use a home-qualified room reference returned by list_rooms or inspect_home.",
      retryable: false,
      action: "inspect_home",
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

  const empty = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/50" },
  });
  assert.equal(empty.isError, undefined);
  assert.equal(empty.structuredContent.status, "ok");
  assert.deepEqual(empty.structuredContent.devices, []);

  const missing = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/999" },
  });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent, {
    status: "error",
    error: {
      code: "room_not_found",
      message: "The selected SprutHub room was not found.",
      retryable: false,
      action: "list_rooms",
    },
  });
  assert.deepEqual(
    JSON.parse(missing.content[0].text),
    missing.structuredContent,
  );

  const kitchen = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  const unavailable = kitchen.structuredContent.devices.find(
    ({ ref }) => ref === "spruthub://hub/test-hub/accessory/103",
  );
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.services[0].readings[0].value, false);

  hub.state.accessories = null;
  const incompatible = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(incompatible.isError, true);
  assert.deepEqual(incompatible.structuredContent, {
    status: "error",
    error: {
      code: "incompatible_response",
      message: "SprutHub returned an incompatible accessory list.",
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
  const internal = await invalidClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
    name: "list_rooms",
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
    name: "list_rooms",
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

  const incompleteSelectedRoomHub = await startHub();
  incompleteSelectedRoomHub.state.roomGetResponse = {
    name: "Selected room without id",
  };
  const incompleteSelectedRoomClient = await startMcpClient(
    t,
    incompleteSelectedRoomHub,
  );
  const incompleteSelectedRoom = await incompleteSelectedRoomClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(incompleteSelectedRoom.isError, true);
  assert.deepEqual(incompleteSelectedRoom.structuredContent.error, {
    code: "incompatible_response",
    message: "SprutHub returned incomplete room data.",
    retryable: false,
  });

  incompleteSelectedRoomHub.state.roomGetResponse = {
    id: 11,
    name: "Different room",
  };
  const mismatchedSelectedRoom = await incompleteSelectedRoomClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.deepEqual(mismatchedSelectedRoom.structuredContent.error, {
    code: "incompatible_response",
    message: "SprutHub returned incomplete room data.",
    retryable: false,
  });

  const incompleteServiceHub = await startHub();
  delete incompleteServiceHub.state.accessories[0].services[0].sId;
  const incompleteServiceClient = await startMcpClient(t, incompleteServiceHub);
  const incompleteService = await incompleteServiceClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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

  const result = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
  const rejected = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
  const unavailable = await unavailableClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
  const silentClient = await startMcpClient(t, silentHub);
  const timeoutStartedAt = performance.now();
  const timeout = await silentClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
  const afterTimeout = await silentClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(afterTimeout.isError, undefined);
  assert.equal(afterTimeout.structuredContent.status, "ok");
  assert.equal(silentHub.metrics.connections, 2);

  const concurrentHub = await startHub();
  const concurrentClient = await startMcpClient(t, concurrentHub);
  const concurrentReads = await Promise.all([
    concurrentClient.callTool({
      name: "read_room",
      arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
    }),
    concurrentClient.callTool({
      name: "read_room",
      arguments: { room_ref: "spruthub://hub/test-hub/room/20" },
    }),
  ]);
  assert.deepEqual(
    concurrentReads.map(({ structuredContent }) => structuredContent.status),
    ["ok", "ok"],
  );
  assert.equal(concurrentHub.metrics.connections, 1);

  const recoveringHub = await startHub();
  const recoveringClient = await startMcpClient(t, recoveringHub);
  const first = await recoveringClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(first.isError, undefined);
  const temperatureRef =
    "spruthub://hub/test-hub/accessory/101/service/1/characteristic/1";
  assert.equal(
    findReading(first.structuredContent, temperatureRef).value,
    23.5,
  );

  recoveringHub.state.closeOnRequest = true;
  const interrupted = await recoveringClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
  const recovered = await recoveringClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(recovered.isError, undefined);
  assert.equal(
    findReading(recovered.structuredContent, temperatureRef).value,
    26.25,
  );
  assert.equal(recoveringHub.metrics.connections, 2);
});

test("one tool deadline covers the WebSocket handshake and every room RPC", async (t) => {
  const handshakeHub = await startSilentHandshakeHub();
  const handshakeClient = await startMcpClient(t, handshakeHub);
  const handshakeStartedAt = performance.now();
  const handshakeTimeout = await handshakeClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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

  const slowHub = await startHub();
  slowHub.state.responseDelays = [160, 160];
  const slowClient = await startMcpClient(t, slowHub);
  const slowStartedAt = performance.now();
  const sequenceTimeout = await slowClient.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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

  const first = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(
    findReading(first.structuredContent, temperatureRef).value,
    23.5,
  );

  hub.state.invalidFrameOnRequest = true;
  const interrupted = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
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
  const recovered = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/test-hub/room/10" },
  });
  assert.equal(
    findReading(recovered.structuredContent, temperatureRef).value,
    27.5,
  );
});
