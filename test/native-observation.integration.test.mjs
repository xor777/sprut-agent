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
const otherHomeRef = "spruthub://hub/home%2FB";
const characteristicRef = `${homeRef}/accessory/34/service/13/characteristic/15`;
const scenarioRef = `${homeRef}/scenario/23`;

async function startHub({ subscribeDelayMs = 0 } = {}) {
  const requests = [];
  const connections = [];
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    const connectionId = connections.length + 1;
    connections.push({ id: connectionId, socket });
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push({ ...request, connectionId });
      let result;
      if (request.params?.hub?.list) {
        result = {
          hub: {
            list: {
              hubs: [
                { serial: "home/A", name: "Дом A", online: true },
                { serial: "home/B", name: "Дом B", online: true },
              ],
            },
          },
        };
      } else if (request.params?.accessory?.get) {
        result = {
          accessory: {
            get:
              request.params.accessory.get.id === 34
                ? {
                    id: 34,
                    roomId: 1,
                    name: `Датчик ${request.serial}`,
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
                  }
                : null,
          },
        };
      } else if (request.params?.room?.get) {
        result = {
          room: {
            get: {
              id: request.params.room.get.id,
              name: `Комната ${request.serial}`,
            },
          },
        };
      } else if (request.params?.room?.list) {
        result = {
          room: { list: { rooms: [{ id: 1, name: "Комната" }] } },
        };
      } else if (request.params?.accessory?.list) {
        result = { accessory: { list: { accessories: [] } } };
      } else if (request.params?.scenario?.list) {
        result = { scenario: { list: { scenarios: [] } } };
      } else if (request.params?.extension?.list) {
        result = { extension: { list: { extensions: [] } } };
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
      const respond = () => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ id: request.id, result }));
        }
      };
      if (request.params?.scenario?.subscribe && subscribeDelayMs > 0) {
        setTimeout(respond, subscribeDelayMs);
      } else {
        respond();
      }
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    connections,
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

async function startClient(t, hub, { serial = "home/A" } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "observation-secret-must-not-leak",
      ...(serial === null ? {} : { SPRUTHUB_SERIAL: serial }),
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

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("timed out waiting for test event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

test("ordinary reads stay available without changing an active observation home", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub, { serial: null });
  const started = await startObservation(client, { duration_seconds: 2 });

  const homes = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.deepEqual(
    homes.structuredContent.homes.map(({ ref }) => ref),
    [homeRef, otherHomeRef],
  );

  for (const request of [
    {
      name: "get_entity",
      arguments: { entity_ref: characteristicRef },
    },
    { name: "inspect_home", arguments: { home_ref: homeRef } },
    {
      name: "read_room",
      arguments: { room_ref: `${homeRef}/room/1` },
    },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, undefined, result.content[0]?.text);
  }

  const otherCharacteristicRef = `${otherHomeRef}/accessory/34/service/13/characteristic/15`;
  const other = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: otherCharacteristicRef },
  });
  assert.equal(other.isError, undefined, other.content[0]?.text);
  assert.equal(other.structuredContent.entity.ref, otherCharacteristicRef);

  const subscriptionRequest = hub.requests.find(
    ({ params }) => params.scenario?.subscribe,
  );
  const otherHomeRead = hub.requests.find(
    ({ params, serial }) => params.accessory?.get && serial === "home/B",
  );
  assert.notEqual(subscriptionRequest.connectionId, otherHomeRead.connectionId);

  hub.send({ event: { scenario: { index: "23", type: "FIRE", blockId: 9 } } });
  const completed = await getObservation(client, started.observation_ref, 3);
  assert.equal(completed.status, "completed");
  assert.deepEqual(
    completed.events.map(({ ref }) => ref),
    [scenarioRef],
  );
});

test("stop during subscription startup cannot resurrect the observation", async (t) => {
  const hub = await startHub({ subscribeDelayMs: 150 });
  const client = await startClient(t, hub);
  const startPromise = client.callTool({
    name: "start_native_observation",
    arguments: {
      home_ref: homeRef,
      characteristic_refs: [characteristicRef],
      scenario_ref: scenarioRef,
      duration_seconds: 10,
      max_events: 20,
    },
  });
  await waitFor(() =>
    hub.requests.some(({ params }) => params.scenario?.subscribe),
  );

  const duplicate = await client.callTool({
    name: "start_native_observation",
    arguments: {
      home_ref: homeRef,
      characteristic_refs: [characteristicRef],
      scenario_ref: scenarioRef,
      duration_seconds: 10,
      max_events: 20,
    },
  });
  assert.equal(duplicate.isError, true);
  assert.equal(
    duplicate.structuredContent.error.code,
    "observation_in_progress",
  );

  const stopped = await client.callTool({
    name: "stop_native_observation",
    arguments: { observation_ref: duplicate.structuredContent.observation_ref },
  });
  const started = await startPromise;
  assert.equal(stopped.isError, undefined, stopped.content[0]?.text);
  assert.equal(stopped.structuredContent.status, "canceled");
  assert.equal(started.structuredContent.status, "canceled");
  assert.equal(
    hub.requests.filter(({ params }) => params.scenario?.unsubscribe).length,
    1,
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  const retained = await getObservation(
    client,
    duplicate.structuredContent.observation_ref,
  );
  assert.equal(retained.status, "canceled");
});

test("a failed new start preserves the previous completed evidence", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const started = await startObservation(client);
  const completed = await getObservation(client, started.observation_ref, 2);
  assert.equal(completed.status, "completed");

  const failed = await client.callTool({
    name: "start_native_observation",
    arguments: {
      home_ref: homeRef,
      characteristic_refs: [
        `${homeRef}/accessory/999/service/13/characteristic/15`,
      ],
      scenario_ref: scenarioRef,
      duration_seconds: 1,
      max_events: 20,
    },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, "entity_not_found");

  const retained = await getObservation(client, started.observation_ref);
  assert.equal(retained.status, "completed");
  assert.equal(retained.observation_ref, started.observation_ref);
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
