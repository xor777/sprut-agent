import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createSprutHubReader } from "../dist/plugin/dist/read.mjs";
import { createSprutHubReader as createSourceSprutHubReader } from "../src/read-api.mjs";
import { SprutHubError } from "../src/spruthub-client.mjs";

const homeRef = "spruthub://hub/home-1";
const temperatureRef = `${homeRef}/accessory/10/service/20/characteristic/30`;
const lightRef = `${homeRef}/accessory/11/service/21/characteristic/31`;
const failedRef = `${homeRef}/accessory/12/service/22/characteristic/32`;

test("an external Node consumer reads fresh selected values and closes the installed reader", async (t) => {
  const hub = await startReadHub(t);
  const reader = createSprutHubReader({
    env: {
      SPRUTHUB_TOKEN: "local-only-token",
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: "home-1",
      SPRUTHUB_CID: "external-reader-test",
      SPRUTHUB_TIMEOUT_MS: "1000",
    },
  });
  const selection = {
    homeRef,
    readings: [
      { ref: temperatureRef, label: "Температура" },
      { ref: lightRef, label: "Лампа" },
      { ref: failedRef, label: "Недоступный датчик" },
    ],
  };

  const first = await reader.read(selection);
  assert.equal(first.status, "degraded");
  assert.deepEqual(
    first.readings.map(({ label, status, type, value, unit }) => ({
      label,
      status,
      type,
      value,
      unit,
    })),
    [
      {
        label: "Температура",
        status: "ok",
        type: "CurrentTemperature",
        value: 0,
        unit: "celsius",
      },
      {
        label: "Лампа",
        status: "ok",
        type: "On",
        value: false,
        unit: null,
      },
      {
        label: "Недоступный датчик",
        status: "error",
        type: undefined,
        value: undefined,
        unit: undefined,
      },
    ],
  );
  assert.deepEqual(first.readings[0].enum, {
    key: "freezing",
    name: "Ноль",
  });
  assert.equal(first.readings[2].error.code, "request_rejected");
  assert.equal(first.readings[2].error.retryable, false);
  assert.equal(JSON.stringify(first).includes("local-only-token"), false);

  hub.temperature = 21.5;
  const second = await reader.read(selection);
  assert.equal(second.readings[0].value, 21.5);
  assert.equal(second.readings[1].value, false);
  assert.equal(second.readings[2].error.code, "request_rejected");
  assert.deepEqual(
    hub.requests
      .filter(({ params }) => params.accessory?.get)
      .map(({ params }) => params.accessory.get.id),
    [10, 11, 12, 10, 11, 12],
  );

  await reader.close();
  assert.equal(hub.connections(), 0);
});

test("the public reader rejects a mixed-home selection before contacting SprutHub", async () => {
  let connectionRequested = false;
  const reader = createSprutHubReader({
    connection: {
      secrets: [],
      async getClient() {
        connectionRequested = true;
        throw new Error("must not connect");
      },
    },
  });

  await assert.rejects(
    reader.read({
      homeRef,
      readings: [
        {
          ref: "spruthub://hub/other/accessory/1/service/2/characteristic/3",
          label: "Чужой дом",
        },
      ],
    }),
    (error) =>
      error.code === "invalid_selection" &&
      error.action === "fix_read_selection",
  );
  assert.equal(connectionRequested, false);
});

test("the public reader preserves a useful source error without exposing connection secrets", async () => {
  const secret = "local-only-password";
  let closed = false;
  const reader = createSourceSprutHubReader({
    connection: {
      secrets: [secret],
      async getClient() {
        return {
          async getEntity() {
            throw new SprutHubError(
              "connection_closed",
              `Connection failed without exposing ${secret}`,
              "retry",
            );
          },
          async close() {
            closed = true;
          },
        };
      },
    },
  });

  const result = await reader.read({
    homeRef,
    readings: [{ ref: temperatureRef, label: "Температура" }],
  });

  assert.equal(result.status, "error");
  assert.equal(result.readings[0].error.code, "connection_closed");
  assert.equal(result.readings[0].error.retryable, true);
  assert.equal(result.readings[0].error.action, "retry");
  assert.equal(JSON.stringify(result).includes(secret), false);
  await reader.close();
  assert.equal(closed, true);
});

async function startReadHub(t) {
  const requests = [];
  const state = { temperature: 0 };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      assert.equal(request.token, "local-only-token");
      if (request.params.hub?.list) {
        reply(socket, request.id, {
          hub: {
            list: {
              hubs: [
                {
                  serial: "home-1",
                  name: "Дом",
                  online: true,
                  owner: true,
                  model: "Sprut.hub 2",
                  version: { current: { version: "3.0.0", revision: "1" } },
                },
              ],
            },
          },
        });
        return;
      }
      assert.equal(request.serial, "home-1");
      const accessoryId = request.params.accessory?.get?.id;
      if (accessoryId === 12) {
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: 503, message: "selected source unavailable" },
          }),
        );
        return;
      }
      if (accessoryId === 10) {
        reply(
          socket,
          request.id,
          accessoryResult(10, 20, 30, {
            name: "Температура",
            type: "CurrentTemperature",
            read: true,
            write: false,
            events: true,
            unit: "celsius",
            value: { doubleValue: state.temperature },
            validValues: [
              {
                key: "freezing",
                name: "Ноль",
                value: { doubleValue: 0 },
              },
            ],
          }),
        );
        return;
      }
      if (accessoryId === 11) {
        reply(
          socket,
          request.id,
          accessoryResult(11, 21, 31, {
            name: "Лампа",
            type: "On",
            read: true,
            write: false,
            events: true,
            value: { boolValue: false },
          }),
        );
        return;
      }
      assert.fail(
        `unsupported SprutHub request: ${JSON.stringify(request.params)}`,
      );
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    get temperature() {
      return state.temperature;
    },
    set temperature(value) {
      state.temperature = value;
    },
    url: `ws://127.0.0.1:${address.port}`,
    connections: () => server.clients.size,
  };
}

function accessoryResult(accessoryId, serviceId, characteristicId, control) {
  return {
    accessory: {
      get: {
        id: accessoryId,
        roomId: 1,
        name: `Accessory ${accessoryId}`,
        online: true,
        services: [
          {
            aId: accessoryId,
            sId: serviceId,
            name: `Service ${serviceId}`,
            type: "Sensor",
            characteristics: [
              {
                aId: accessoryId,
                sId: serviceId,
                cId: characteristicId,
                control,
              },
            ],
          },
        ],
      },
    },
  };
}

function reply(socket, id, result) {
  socket.send(JSON.stringify({ id, result }));
}
