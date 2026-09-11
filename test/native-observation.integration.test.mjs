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
const homeRef = "spruthub://hub/home%2FA";
const characteristicRef = `${homeRef}/accessory/34/service/13/characteristic/15`;
const scenarioRef = `${homeRef}/scenario/23`;

async function startHub() {
  const requests = [];
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      let result;
      if (request.params?.hub?.list) {
        result = {
          hub: {
            list: {
              hubs: [{ serial: "home/A", name: "Дом", online: true }],
            },
          },
        };
      } else if (request.params?.accessory?.get) {
        result = {
          accessory: {
            get: {
              id: 34,
              roomId: 1,
              name: "Датчик",
              online: true,
              services: [
                {
                  aId: 34,
                  sId: 13,
                  name: "Движение",
                  type: "MotionSensor",
                  characteristics: [
                    {
                      aId: 34,
                      sId: 13,
                      cId: 15,
                      control: {
                        name: "Движение",
                        type: "MotionDetected",
                        read: true,
                        write: false,
                        events: true,
                        value: { boolValue: false },
                      },
                    },
                  ],
                },
              ],
            },
          },
        };
      } else if (request.params?.scenario?.get) {
        result = {
          scenario: {
            get: {
              index: "23",
              name: "Свет с паузой",
              type: "BLOCK",
              active: true,
            },
          },
        };
      } else if (request.params?.scenario?.subscribe) {
        result = { scenario: { subscribe: { uuid: "subscription-1" } } };
      } else if (request.params?.scenario?.unsubscribe) {
        result = { scenario: { unsubscribe: {} } };
      } else if (request.params?.server?.ping) {
        result = { server: { ping: {} } };
      } else {
        assert.fail(
          `unsupported test request: ${JSON.stringify(request.params)}`,
        );
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    server,
    url: `ws://127.0.0.1:${address.port}`,
    send(message) {
      for (const socket of server.clients) socket.send(JSON.stringify(message));
    },
    disconnect() {
      for (const socket of server.clients) socket.terminate();
    },
  };
}

async function startClient(t, hub) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "observation-secret-must-not-leak",
      SPRUTHUB_SERIAL: "home/A",
      SPRUTHUB_CID: "native-observation-test",
      SPRUTHUB_TIMEOUT_MS: "500",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "native-observation-test",
    version: "1.0.0",
  });
  t.after(async () => {
    await client.close();
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
  });
  await client.connect(transport);
  return client;
}

async function startObservation(client, overrides = {}) {
  const result = await client.callTool({
    name: "start_native_observation",
    arguments: {
      home_ref: homeRef,
      characteristic_refs: [characteristicRef],
      scenario_ref: scenarioRef,
      duration_seconds: 1,
      max_events: 20,
      ...overrides,
    },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(result.structuredContent.status, "observing");
  return result.structuredContent;
}

async function getObservation(client, observationRef, waitSeconds = 0) {
  const result = await client.callTool({
    name: "get_native_observation",
    arguments: {
      observation_ref: observationRef,
      wait_seconds: waitSeconds,
    },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

test("native observation preserves repeated partial events and filters its selected home entities", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const started = await startObservation(client);

  hub.send({
    event: {
      characteristic: {
        event: "EVENT_UPDATE",
        characteristics: [
          {
            aId: 34,
            sId: 13,
            cId: 15,
            control: { value: { boolValue: false } },
          },
          {
            aId: 99,
            sId: 13,
            cId: 15,
            control: { value: { boolValue: true } },
          },
        ],
      },
    },
  });
  hub.send({
    event: {
      characteristic: {
        event: "EVENT_UPDATE",
        characteristics: [
          {
            aId: 34,
            sId: 13,
            cId: 15,
            control: { value: { boolValue: false } },
          },
        ],
      },
    },
  });
  hub.send({
    event: { scenario: { index: "other", type: "FIRE", blockId: 6 } },
  });
  hub.send({ event: { scenario: { index: "23", type: "FIRE", blockId: 7 } } });

  const completed = await getObservation(client, started.observation_ref, 2);
  assert.equal(completed.status, "completed");
  assert.equal(completed.scope.home_ref, homeRef);
  assert.equal(completed.events.length, 3);
  assert.deepEqual(
    completed.events.map(({ sequence, kind, ref }) => ({
      sequence,
      kind,
      ref,
    })),
    [
      { sequence: 1, kind: "characteristic", ref: characteristicRef },
      { sequence: 2, kind: "characteristic", ref: characteristicRef },
      { sequence: 3, kind: "scenario", ref: scenarioRef },
    ],
  );
  for (const event of completed.events) {
    assert.match(event.received_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(event.source_timestamp, null);
  }
  assert.deepEqual(completed.events[0].value, {
    type: "boolean",
    value: false,
  });
  assert.deepEqual(completed.events[0].native, {
    event_type: "EVENT_UPDATE",
    value_field: "boolValue",
    control_type: null,
    partial: true,
  });
  assert.deepEqual(completed.events[2].native, {
    type: "FIRE",
    block_id: 7,
  });
  assert.equal(completed.truncated, false);
  assert.match(completed.limitations.join(" "), /does not prove causality/i);
  assert.equal(
    JSON.stringify(completed).includes("observation-secret-must-not-leak"),
    false,
  );
  assert.deepEqual(
    hub.requests
      .filter(({ params }) => params.scenario?.unsubscribe)
      .map(({ params }) => params.scenario.unsubscribe),
    [{ uuid: "subscription-1" }],
  );
});

test("connection loss is an explicit terminal observation result", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const started = await startObservation(client, { duration_seconds: 10 });

  hub.disconnect();
  const result = await getObservation(client, started.observation_ref, 2);

  assert.equal(result.status, "connection_lost");
  assert.equal(result.connection.status, "lost");
  assert.match(result.connection.lost_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.truncated, true);
  assert.equal(result.completion_reason, "connection_closed");
});

test("observation rejects characteristic references from another home", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const result = await client.callTool({
    name: "start_native_observation",
    arguments: {
      home_ref: homeRef,
      characteristic_refs: [
        "spruthub://hub/home%20B/accessory/34/service/13/characteristic/15",
      ],
      scenario_ref: scenarioRef,
      duration_seconds: 1,
      max_events: 20,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(
    result.structuredContent.error.code,
    "invalid_observation_scope",
  );
  assert.equal(
    hub.requests.some(({ params }) => params.scenario?.subscribe),
    false,
  );
});

test("explicit stop cancels observation and releases its native subscription", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const started = await startObservation(client, { duration_seconds: 10 });

  const stopped = await client.callTool({
    name: "stop_native_observation",
    arguments: { observation_ref: started.observation_ref },
  });

  assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
  assert.equal(stopped.structuredContent.status, "canceled");
  assert.equal(stopped.structuredContent.completion_reason, "requested_stop");
  assert.equal(stopped.structuredContent.truncated, true);
  assert.deepEqual(
    hub.requests
      .filter(({ params }) => params.scenario?.unsubscribe)
      .map(({ params }) => params.scenario.unsubscribe),
    [{ uuid: "subscription-1" }],
  );
});

test("event limit ends observation as a visibly truncated result", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const started = await startObservation(client, {
    duration_seconds: 10,
    max_events: 1,
  });

  hub.send({ event: { scenario: { index: "23", type: "FIRE", blockId: 8 } } });
  const result = await getObservation(client, started.observation_ref, 2);

  assert.equal(result.status, "truncated");
  assert.equal(result.truncated, true);
  assert.equal(result.completion_reason, "event_limit_reached");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].native.block_id, 8);
});
