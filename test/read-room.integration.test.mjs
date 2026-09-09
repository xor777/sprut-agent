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
  const requests = [];
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);

      if (request.params?.room?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { room: { list: { rooms: hubState.rooms } } },
          }),
        );
        return;
      }

      if (request.params?.accessory?.list) {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              accessory: { list: { accessories: hubState.accessories } },
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
  return { server, requests, url: `ws://127.0.0.1:${address.port}` };
}

test("MCP room tool returns only the requested room with stable object references", async (t) => {
  const hub = await startHub();
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
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "sprut-agent-test", version: "1.0.0" });

  t.after(async () => {
    await client.close();
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
  });

  await client.connect(transport);
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
