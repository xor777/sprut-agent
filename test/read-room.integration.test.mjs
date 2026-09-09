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
const diagnosticsByClient = new WeakMap();

const hubState = {
  rooms: [
    { id: 10, order: 1, name: " Кухня ", visible: true },
    { id: 20, order: 2, name: "Гостиная", visible: true },
    { id: 30, order: 3, name: null, visible: true },
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
                key: "air-quality",
                name: "Качество воздуха",
                type: "AirQuality",
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
  ],
};

async function startHub() {
  const state = structuredClone(hubState);
  const requests = [];
  const metrics = { connections: 0 };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");

  server.on("connection", (socket) => {
    metrics.connections += 1;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);

      if (state.closeOnRequest) {
        state.closeOnRequest = false;
        socket.close();
        return;
      }
      if (state.ignoreRequests) return;

      if (state.authorizationError) {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: state.authorizationError,
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

      if (request.params?.accessory?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              accessory: { list: { accessories: state.accessories } },
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
  const client = new Client({ name: "sprut-agent-test", version: "1.0.0" });
  const diagnostics = [];
  transport.stderr?.on("data", (chunk) => diagnostics.push(chunk.toString()));
  diagnosticsByClient.set(client, diagnostics);

  t.after(async () => {
    await client.close();
    for (const socket of hub.server.clients) socket.terminate();
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

test("MCP room tool returns only the requested room with stable object references", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name),
    ["read_room"],
  );
  assert.deepEqual(tools.tools[0].annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

  const result = await client.callTool({
    name: "read_room",
    arguments: { room: "  кухня  " },
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
    ref: "spruthub://room/10",
    name: "Кухня",
  });
  assert.equal(reading.devices.length, 3);

  const lamp = reading.devices.find(
    ({ ref }) => ref === "spruthub://accessory/100",
  );
  assert.equal(lamp.name, "Лампа");
  assert.equal(lamp.available, true);
  assert.deepEqual(lamp.services[0].ref, "spruthub://accessory/100/service/1");
  assert.deepEqual(lamp.services[0].readings[0], {
    ref: "spruthub://accessory/100/service/1/characteristic/1",
    name: "Включена",
    type: "On",
    value: false,
    unit: "boolean",
    measuredAt: null,
  });

  const thermometer = reading.devices.find(
    ({ ref }) => ref === "spruthub://accessory/101",
  );
  assert.deepEqual(thermometer.services[0].readings[0].value, 23.5);
  assert.deepEqual(thermometer.services[0].readings[0].unit, "°C");
  assert.equal(thermometer.services[0].readings[0].type, "CurrentTemperature");
  assert.deepEqual(thermometer.services[1].readings, []);
  assert.deepEqual(
    reading.devices.find(({ ref }) => ref === "spruthub://accessory/102")
      .services,
    [],
  );
  assert.equal(
    reading.devices.some(({ ref }) => ref === "spruthub://accessory/200"),
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
      params: {
        accessory: { list: { expand: "services,characteristics" } },
      },
    },
  ]);
});

test("repeated MCP reads return the latest hub values without losing false, zero, or unknown", async (t) => {
  const hub = await startHub();
  const client = await startMcpClient(t, hub);
  const temperatureRef = "spruthub://accessory/101/service/1/characteristic/1";

  const firstResult = await client.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
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
    arguments: { room: "Кухня" },
  });
  assert.equal(secondResult.isError, undefined);
  const secondRoom = secondResult.structuredContent;
  const secondTemperature = findReading(secondRoom, temperatureRef);
  assert.equal(secondTemperature.ref, firstTemperature.ref);
  assert.equal(secondTemperature.value, 24.75);

  assert.equal(
    findReading(
      secondRoom,
      "spruthub://accessory/100/service/1/characteristic/1",
    ).value,
    false,
  );
  assert.equal(
    findReading(
      secondRoom,
      "spruthub://accessory/101/service/1/characteristic/2",
    ).value,
    0,
  );
  assert.deepEqual(
    findReading(
      secondRoom,
      "spruthub://accessory/101/service/1/characteristic/3",
    ),
    {
      ref: "spruthub://accessory/101/service/1/characteristic/3",
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

test("ambiguous room names return stable choices that can be read explicitly", async (t) => {
  const hub = await startHub();
  hub.state.rooms.push(
    { id: 40, order: 4, name: " Кладовая ", visible: true },
    { id: 41, order: 5, name: " Кладовая ", visible: true },
  );
  hub.state.accessories.push({
    id: 410,
    online: true,
    name: "Датчик двери",
    roomId: 41,
    services: [],
  });
  const client = await startMcpClient(t, hub);

  const ambiguous = await client.callTool({
    name: "read_room",
    arguments: { room: "Кладовая" },
  });
  assert.equal(ambiguous.isError, undefined);
  assert.deepEqual(ambiguous.structuredContent, {
    status: "ambiguous",
    query: "Кладовая",
    candidates: [
      { ref: "spruthub://room/40", name: "Кладовая" },
      { ref: "spruthub://room/41", name: "Кладовая" },
    ],
  });

  const selected = await client.callTool({
    name: "read_room",
    arguments: { room: "spruthub://room/41" },
  });
  assert.equal(selected.isError, undefined);
  assert.deepEqual(selected.structuredContent.room, {
    ref: "spruthub://room/41",
    name: "Кладовая",
  });
  assert.deepEqual(
    selected.structuredContent.devices.map(({ ref }) => ref),
    ["spruthub://accessory/410"],
  );

  for (const invalidRef of [
    "prefixspruthub://room/41",
    "spruthub://room/41/suffix",
  ]) {
    const invalid = await client.callTool({
      name: "read_room",
      arguments: { room: invalidRef },
    });
    assert.equal(invalid.isError, true);
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
    arguments: { room: "Пустая" },
  });
  assert.equal(empty.isError, undefined);
  assert.equal(empty.structuredContent.status, "ok");
  assert.deepEqual(empty.structuredContent.devices, []);

  const missing = await client.callTool({
    name: "read_room",
    arguments: { room: "Чердак" },
  });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent, {
    status: "error",
    error: {
      code: "room_not_found",
      message: 'Room "Чердак" was not found.',
      retryable: false,
    },
  });
  assert.deepEqual(
    JSON.parse(missing.content[0].text),
    missing.structuredContent,
  );

  const kitchen = await client.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
  });
  const unavailable = kitchen.structuredContent.devices.find(
    ({ ref }) => ref === "spruthub://accessory/103",
  );
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.services[0].readings[0].value, false);

  hub.state.accessories = null;
  const incompatible = await client.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
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
    arguments: { room: "Кухня" },
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

test("authorization failures identify credential repair without leaking the rejected secret", async (t) => {
  const hub = await startHub();
  hub.state.authorizationError = {
    code: 401,
    message: "invalid synthetic-test-token",
  };
  const client = await startMcpClient(t, hub);

  const result = await client.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    status: "error",
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
    arguments: { room: "Кухня" },
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
    arguments: { room: "Кухня" },
  });
  assert(performance.now() - unavailableStartedAt < 1_000);
  assert.deepEqual(unavailable.structuredContent, {
    status: "error",
    error: {
      code: "connection_failed",
      message: "Could not connect to SprutHub.",
      retryable: true,
      action: "retry",
    },
  });

  const silentHub = await startHub();
  silentHub.state.ignoreRequests = true;
  const silentClient = await startMcpClient(t, silentHub);
  const timeoutStartedAt = performance.now();
  const timeout = await silentClient.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
  });
  assert(performance.now() - timeoutStartedAt < 1_000);
  assert.deepEqual(timeout.structuredContent, {
    status: "error",
    error: {
      code: "timeout",
      message: "SprutHub did not respond within the request budget.",
      retryable: true,
      action: "retry",
    },
  });

  const recoveringHub = await startHub();
  const recoveringClient = await startMcpClient(t, recoveringHub);
  const first = await recoveringClient.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
  });
  assert.equal(first.isError, undefined);
  const temperatureRef = "spruthub://accessory/101/service/1/characteristic/1";
  assert.equal(
    findReading(first.structuredContent, temperatureRef).value,
    23.5,
  );

  recoveringHub.state.closeOnRequest = true;
  const interrupted = await recoveringClient.callTool({
    name: "read_room",
    arguments: { room: "Кухня" },
  });
  assert.deepEqual(interrupted.structuredContent, {
    status: "error",
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
    arguments: { room: "Кухня" },
  });
  assert.equal(recovered.isError, undefined);
  assert.equal(
    findReading(recovered.structuredContent, temperatureRef).value,
    26.25,
  );
  assert.equal(recoveringHub.metrics.connections, 2);
});
