import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import { FAKE_HUB_HOST } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// One request that runs out of time must not cost the other calls on the
// shared connection their answers, and the next call must get through
// (PLAN.md, 12.10.2026). The MCP process reaches the simulated apartment
// through a relay, as it reaches a hub through the SprutHub cloud: the relay
// passes every frame on and can hold the hub's replies back, stop passing
// requests or go quiet without closing the connection. The simulated hub
// pushes events to every connection, as the owner's hub does.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const hallLight = `${homeRef}/accessory/12`;
const floorLamp = `${homeRef}/accessory/16`;
const floorLampOn = `${floorLamp}/service/13/characteristic/14`;
// The request budget of these tests: long enough that a loaded machine
// answers the calls that are not held back, short enough to wait out.
const TIMEOUT_MS = 3_000;
// More often than the owner's hub (about one every 3.4 s), so that an event
// comes over the connection during every request.
const EVENT_EVERY_MS = 250;
// A test that waits for a request or a close that never comes fails instead
// of hanging the run.
const BOUNDED = { timeout: 10 * TIMEOUT_MS };

function methodOf(params) {
  const [domain] = Object.keys(params ?? {});
  const [operation] = Object.keys(params?.[domain] ?? {});
  return `${domain}.${operation}`;
}

const accessoryRead = (id) => (params) => params.accessory?.get?.id === id;

async function startRelay(hub) {
  const rules = [];
  const ruleFor = (params) =>
    rules.find(({ match, released }) => !released && match(params));
  const connections = [];
  const handshake = { delayMs: 0, started: () => {} };
  const server = new WebSocketServer({
    host: FAKE_HUB_HOST,
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has("json-rpc") ? "json-rpc" : false,
    verifyClient: (_info, accept) => {
      handshake.started(Date.now());
      setTimeout(() => accept(true), handshake.delayMs);
    },
  });
  await once(server, "listening");
  server.on("connection", (client) => {
    const connection = {
      requests: [],
      // When each of the hub's events was passed on.
      events: [],
      silent: false,
      stalled: false,
      closedAt: null,
      closed: new Promise((resolve) => client.once("close", resolve)),
    };
    connections.push(connection);
    const upstream = new WebSocket(hub.url, "json-rpc");
    const queued = [];
    const paramsById = new Map();
    upstream.on("open", () => {
      for (const data of queued.splice(0)) upstream.send(data);
    });
    client.on("message", (data) => {
      const request = JSON.parse(data.toString());
      connection.requests.push({
        at: Date.now(),
        method: methodOf(request.params),
      });
      if (connection.silent || connection.stalled) return;
      paramsById.set(request.id, request.params);
      const rule = ruleFor(request.params);
      rule?.seen(Date.now());
      if (rule?.swallow) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else queued.push(data);
    });
    upstream.on("message", (data) => {
      if (connection.silent) return;
      const frame = JSON.parse(data.toString());
      const forward = () => {
        if (client.readyState === WebSocket.OPEN) client.send(data.toString());
      };
      // An event answers no request, so no rule holds it.
      if (frame.event !== undefined) {
        connection.events.push(Date.now());
        forward();
        return;
      }
      const rule = ruleFor(paramsById.get(frame.id));
      if (rule) rule.held.push(forward);
      else forward();
    });
    client.on("close", () => {
      connection.closedAt = Date.now();
      upstream.terminate();
    });
    upstream.on("close", () => client.terminate());
  });
  const address = server.address();
  return {
    url: `ws://${FAKE_HUB_HOST}:${address.port}`,
    connections,
    // Holds the hub's replies to matching requests until release(); with
    // swallow the requests never reach the hub. requested resolves with the
    // time the relay first saw a matching request.
    hold(match, { swallow = false } = {}) {
      let seen;
      const requested = new Promise((resolve) => {
        seen = resolve;
      });
      const rule = { match, swallow, released: false, held: [], seen };
      rules.push(rule);
      return {
        requested,
        release() {
          rule.released = true;
          for (const forward of rule.held.splice(0)) forward();
        },
      };
    },
    // New connections take delayMs to open; the promise resolves when the
    // next one starts.
    slowHandshakes(delayMs) {
      handshake.delayMs = delayMs;
      return new Promise((resolve) => {
        handshake.started = (at) => {
          handshake.started = () => {};
          resolve(at);
        };
      });
    },
    // Every open connection stops passing frames either way and stays open,
    // as a connection whose peer is gone without a close.
    silence() {
      for (const connection of connections) connection.silent = true;
    },
    // Every open connection stops passing requests to the hub and stays
    // open while the hub's events still come over it, as from a hub that
    // keeps pushing events but no longer answers there.
    stall() {
      for (const connection of connections) connection.stalled = true;
    },
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function setup(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"), {
    eventEveryMs: EVENT_EVERY_MS,
  });
  const relay = await startRelay(hub);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-hub-connection-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_URL: relay.url,
      SPRUTHUB_TIMEOUT_MS: String(TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "hub-connection-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await relay.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, at: Date.now() };
  };
  return { hub, relay, call };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fails the test with what did not happen when promise takes longer than ms.
async function within(ms, promise, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not happen within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorCode({ result }) {
  return result.isError ? result.structuredContent?.error?.code : "ok";
}

function assertTimedOut(outcome) {
  assert.equal(errorCode(outcome), "timeout", outcome.result.content[0]?.text);
  assert.equal(outcome.result.structuredContent.error.retryable, true);
}

function assertAnswered(outcome) {
  assert.equal(
    outcome.result.isError,
    undefined,
    outcome.result.content[0]?.text,
  );
}

test(
  "a request that runs out of time fails alone and the call beside it gets its own answer",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    const slowRead = relay.hold(accessoryRead(12));
    const besideRead = relay.hold(accessoryRead(16));

    const slow = call("get_entity", { entity_ref: hallLight });
    await sleep(TIMEOUT_MS / 2);
    const beside = call("get_entity", { entity_ref: floorLampOn });
    const besideSentAt = await besideRead.requested;
    const slowOutcome = await slow;
    // The read beside was on the connection when the slow one ran out of time.
    assert(besideSentAt < slowOutcome.at);
    // The slow read's answer comes late over the same connection, ahead of
    // the answer beside, and is dropped.
    assert.equal(relay.connections[0].closedAt, null);
    slowRead.release();
    besideRead.release();
    const besideOutcome = await beside;

    assertTimedOut(slowOutcome);
    assertAnswered(besideOutcome);
    assert.equal(
      besideOutcome.result.structuredContent.entity.ref,
      floorLampOn,
    );
    assert.equal(
      besideOutcome.result.structuredContent.entity.current_value.value,
      true,
    );
    const next = await call("get_entity", { entity_ref: floorLamp });
    assertAnswered(next);
    assert.equal(next.result.structuredContent.entity.ref, floorLamp);
  },
);

test(
  "a sent write that runs out of time reports an unknown outcome and the read beside it gets its answer",
  BOUNDED,
  async (t) => {
    const { hub, relay, call } = await setup(t);
    // The command leaves the MCP process and never reaches the hub, so only
    // its outcome, not the lamp, can tell what happened.
    const write = relay.hold(
      (params) => params.characteristic?.update !== undefined,
      { swallow: true },
    );
    const besideRead = relay.hold(accessoryRead(12));

    const sending = call("send_device_commands", {
      home_ref: homeRef,
      commands: [{ target_ref: floorLampOn, value: false }],
      reason: "Выключить торшер",
    });
    await write.requested;
    await sleep(TIMEOUT_MS / 2);
    const beside = call("get_entity", { entity_ref: hallLight });
    const besideSentAt = await besideRead.requested;
    const sent = await sending;
    assert(besideSentAt < sent.at);
    besideRead.release();
    const besideOutcome = await beside;

    assertAnswered(sent);
    const [item] = sent.result.structuredContent.results;
    assert.equal(item.status, "uncertain", JSON.stringify(item));
    assert.equal(item.sent, true);
    assertAnswered(besideOutcome);
    assert.equal(besideOutcome.result.structuredContent.entity.ref, hallLight);
    const next = await call("get_entity", { entity_ref: floorLamp });
    assertAnswered(next);
    assert.equal(next.result.structuredContent.entity.ref, floorLamp);
    assert.equal(
      hub.writes().filter(({ method }) => method === "characteristic.update")
        .length,
      0,
    );
  },
);

test(
  "a connection on which a request ran out of time takes no new requests and closes once those on it are answered",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    assertAnswered(await call("get_entity", { entity_ref: floorLamp }));
    const quiet = relay.hold(() => true);

    const first = call("get_entity", { entity_ref: hallLight });
    await sleep(TIMEOUT_MS / 2);
    const second = call("get_entity", { entity_ref: floorLampOn });
    const firstOutcome = await first;
    quiet.release();
    const secondOutcome = await second;

    assertTimedOut(firstOutcome);
    assertAnswered(secondOutcome);
    assert.equal(
      secondOutcome.result.structuredContent.entity.ref,
      floorLampOn,
    );
    // The second read's home list was already on the quiet connection and got
    // its answer there; its device read went over a new connection.
    const [old, fresh, ...more] = relay.connections;
    const methods = (requests) => requests.map(({ method }) => method);
    assert.deepEqual(methods(old.requests), [
      "hub.list",
      "accessory.get",
      "hub.list",
      "hub.list",
    ]);
    assert(old.requests.every(({ at }) => at < firstOutcome.at));
    assert.deepEqual(methods(fresh.requests), ["accessory.get"]);
    assert.deepEqual(more, []);
    await within(TIMEOUT_MS, old.closed, "closing after the last answer");
    assert.equal(fresh.closedAt, null);
  },
);

test(
  "a connection that stops answering without closing is replaced and the next call succeeds",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    assertAnswered(await call("get_entity", { entity_ref: floorLamp }));
    relay.silence();

    assertTimedOut(await call("get_entity", { entity_ref: hallLight }));
    const retried = await call("get_entity", { entity_ref: hallLight });

    assertAnswered(retried);
    assert.equal(retried.result.structuredContent.entity.ref, hallLight);
    assert.equal(relay.connections.length, 2);
    await relay.connections[0].closed;
    assert.equal(relay.connections[1].closedAt, null);
  },
);

// The owner's hub pushes events to every socket, so a connection that still
// carries frames may no longer answer requests.
test(
  "a connection that keeps carrying hub events but stops answering is replaced after a write runs out of time",
  BOUNDED,
  async (t) => {
    const { hub, relay, call } = await setup(t);
    assertAnswered(await call("get_entity", { entity_ref: floorLamp }));
    const [stalled] = relay.connections;
    const write = relay.hold(
      (params) => params.characteristic?.update !== undefined,
      { swallow: true },
    );

    const sending = call("send_device_commands", {
      home_ref: homeRef,
      commands: [{ target_ref: floorLampOn, value: false }],
      reason: "Выключить торшер",
    });
    const writeSentAt = await write.requested;
    // From the write on, the connection passes no request to the hub.
    relay.stall();
    const sent = await sending;
    const next = await call("get_entity", { entity_ref: hallLight });

    assert(
      stalled.events.some((at) => at > writeSentAt && at < sent.at),
      "the hub's events came over the connection while the write waited",
    );
    assertAnswered(sent);
    const [item] = sent.result.structuredContent.results;
    assert.equal(item.status, "uncertain", JSON.stringify(item));
    assert.equal(item.sent, true);
    assertAnswered(next);
    assert.equal(next.result.structuredContent.entity.ref, hallLight);
    await within(TIMEOUT_MS, stalled.closed, "closing the stalled connection");
    assert.equal(
      hub.writes().filter(({ method }) => method === "characteristic.update")
        .length,
      0,
    );
  },
);

test(
  "a connection that closes after its last request ran out of time leaves the requests on the new one their answers",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    assertAnswered(await call("get_entity", { entity_ref: floorLamp }));
    const [retired] = relay.connections;
    const lampRead = relay.hold(accessoryRead(16));
    relay.stall();

    // Neither read is answered on the stalled connection. The first runs
    // out of time while the second still waits there.
    const first = call("get_entity", { entity_ref: hallLight });
    await sleep(1_000);
    const second = call("get_entity", { entity_ref: hallLight });
    const firstOutcome = await first;
    // The next read goes over a new connection and is held there until the
    // stalled one has closed.
    const third = call("get_entity", { entity_ref: floorLamp });
    await within(
      TIMEOUT_MS,
      lampRead.requested,
      "the next read reaching the hub",
    );
    assert.equal(retired.closedAt, null);
    const secondOutcome = await second;
    await within(
      TIMEOUT_MS,
      retired.closed,
      "closing after the last request ran out of time",
    );
    // The MCP process has handled the close by now.
    await sleep(300);
    lampRead.release();
    const thirdOutcome = await third;

    assertTimedOut(firstOutcome);
    assertTimedOut(secondOutcome);
    assertAnswered(thirdOutcome);
    assert.equal(thirdOutcome.result.structuredContent.entity.ref, floorLamp);
  },
);

// The hub zone read that read_hub_log starts keeps going after the log is
// returned in UTC; when it runs out of time, a read started meanwhile still
// gets its answer.
test(
  "a hub time zone read that runs out of time leaves the call beside it its answer",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    const zone = relay.hold((params) => params.window?.get?.windowKey === "");
    const besideRead = relay.hold(accessoryRead(16));

    const log = call("read_hub_log", { home_ref: homeRef });
    const zoneSentAt = await zone.requested;
    const logOutcome = await log;
    const beside = call("get_entity", { entity_ref: floorLampOn });
    await besideRead.requested;
    // Released after the zone read's own timeout, inside the read's; the
    // zone's late answer comes ahead of it and is dropped.
    await sleep(zoneSentAt + TIMEOUT_MS + 1_000 - Date.now());
    zone.release();
    besideRead.release();
    const besideOutcome = await beside;

    assertAnswered(logOutcome);
    assert.equal(logOutcome.result.structuredContent.time_zone, null);
    assertAnswered(besideOutcome);
    assert.equal(
      besideOutcome.result.structuredContent.entity.ref,
      floorLampOn,
    );
    const next = await call("get_entity", { entity_ref: floorLamp });
    assertAnswered(next);
    assert.equal(next.result.structuredContent.entity.ref, floorLamp);
  },
);

test(
  "a home catalog refresh that runs out of time leaves the call beside it its answer",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    const catalog = relay.hold(
      (params) => params.accessory?.list !== undefined,
    );
    const besideRead = relay.hold(accessoryRead(16));

    const refresh = call("find_devices", { home_ref: homeRef, refresh: true });
    await catalog.requested;
    await sleep(TIMEOUT_MS / 2);
    const beside = call("get_entity", { entity_ref: floorLampOn });
    const besideSentAt = await besideRead.requested;
    const refreshOutcome = await refresh;
    assert(besideSentAt < refreshOutcome.at);
    // The catalog's late answer comes ahead of the answer beside.
    catalog.release();
    besideRead.release();
    const besideOutcome = await beside;

    assertTimedOut(refreshOutcome);
    assertAnswered(besideOutcome);
    assert.equal(
      besideOutcome.result.structuredContent.entity.ref,
      floorLampOn,
    );
    const next = await call("find_devices", {
      home_ref: homeRef,
      query: "торшер",
    });
    assertAnswered(next);
    assert.equal(next.result.structuredContent.total, 1);
  },
);

// A call that has to open a new connection with little of its time left
// does not give the attempt up for a call that joined it with time to spare.
test(
  "a new connection is not given up with the time of the call that started it",
  BOUNDED,
  async (t) => {
    const { relay, call } = await setup(t);
    assertAnswered(await call("get_entity", { entity_ref: floorLamp }));
    const quiet = relay.hold(() => true);

    // The first read makes the connection silent through its timeout; the
    // second, started a second later, gets its home list there afterwards
    // and opens a new connection with about a second left.
    const first = call("get_entity", { entity_ref: hallLight });
    await sleep(1_000);
    const late = call("get_entity", { entity_ref: hallLight });
    const firstOutcome = await first;
    const opening = relay.slowHandshakes(2_000);
    quiet.release();
    await within(TIMEOUT_MS, opening, "opening a new connection");
    const joined = call("get_entity", { entity_ref: floorLampOn });
    const lateOutcome = await late;
    const joinedOutcome = await joined;

    assertTimedOut(firstOutcome);
    assertTimedOut(lateOutcome);
    assertAnswered(joinedOutcome);
    assert.equal(
      joinedOutcome.result.structuredContent.entity.ref,
      floorLampOn,
    );
    assert.equal(relay.connections.length, 2);
  },
);
