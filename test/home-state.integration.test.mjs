import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer } from "ws";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// Names, rooms and current values answer from a home kept warm in the MCP
// process: read whole once, then kept current by the events the hub pushes,
// instead of the whole-home accessory.list (504 KB, 245 ms on the owner's
// hub, 2026-10-13-voice-latency-baseline) on every overview, state answer
// and first read after a write. Where the events may have missed something,
// the next answer reads the home again rather than answer from memory.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// One connection to two homes, as the SprutHub cloud serves an account with
// several: a request goes to the home its serial names (one without a
// serial to the first, whose home list gains the second home), and both
// homes push their events down it.
async function startTwoHomeRelay(first, second) {
  const secondListed = second.request({ hub: { list: {} } }).result.hub.list
    .hubs;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has("json-rpc") ? "json-rpc" : false,
  });
  await once(server, "listening");
  server.on("connection", (client) => {
    const homeLists = new Set();
    const upstreams = new Map(
      [first, second].map((hub) => {
        const socket = new WebSocket(hub.url, "json-rpc");
        const queued = [];
        socket.on("open", () => {
          for (const data of queued.splice(0)) socket.send(data);
        });
        socket.on("message", (data) => {
          let text = data.toString();
          const frame = JSON.parse(text);
          if (homeLists.delete(frame.id) && frame.result?.hub?.list?.hubs) {
            frame.result.hub.list.hubs.push(...secondListed);
            text = JSON.stringify(frame);
          }
          if (client.readyState === WebSocket.OPEN) client.send(text);
        });
        socket.on("close", () => client.terminate());
        return [hub.serial, { socket, queued }];
      }),
    );
    client.on("message", (data) => {
      const text = data.toString();
      const request = JSON.parse(text);
      if (request.params?.hub?.list) homeLists.add(request.id);
      const upstream =
        upstreams.get(request.serial) ?? upstreams.get(first.serial);
      if (upstream.socket.readyState === WebSocket.OPEN) {
        upstream.socket.send(text);
      } else {
        upstream.queued.push(text);
      }
    });
    client.on("close", () => {
      for (const { socket } of upstreams.values()) socket.terminate();
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// With clockStepMs the server runs with test/support/shifted-clock.mjs and
// shiftClock moves its clock that far forward. With secondHome the server
// reaches both homes over one connection (startTwoHomeRelay).
async function setup(
  t,
  fixture,
  { eventEveryMs, timeoutMs = 3000, clockStepMs, secondHome } = {},
) {
  const hub = await startSimulatedHub(fixture, { eventEveryMs });
  const second = secondHome ? await startSimulatedHub(secondHome) : null;
  const relay = second ? await startTwoHomeRelay(hub, second) : null;
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-home-state-"),
  );
  const clockModule = pathToFileURL(
    path.join(projectRoot, "test/support/shifted-clock.mjs"),
  ).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(clockStepMs ? ["--import", clockModule] : []), "src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      ...(relay ? { SPRUTHUB_URL: relay.url } : {}),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      ...(clockStepMs ? { SPRUT_TEST_CLOCK_STEP_MS: String(clockStepMs) } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "home-state-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await relay?.close();
    await second?.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const before = hub.requests.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return {
      body: result.structuredContent,
      native: hub.requests.slice(before),
    };
  };
  const callError = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, result.content[0]?.text);
    return result.structuredContent;
  };
  const shiftClock = async () => {
    const shifted = new Promise((resolve) => {
      const onData = (chunk) => {
        if (!String(chunk).includes("clock shifted")) return;
        transport.stderr.off("data", onData);
        resolve();
      };
      transport.stderr.on("data", onData);
    });
    process.kill(transport.pid, "SIGUSR2");
    await shifted;
  };
  const home = `spruthub://hub/${encodeURIComponent(hub.serial)}`;
  return { hub, second, call, callError, home, shiftClock };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Long enough for a pushed frame to reach the MCP process over loopback.
const settle = () => sleep(150);

function methods(native) {
  return native.map(({ method }) => method);
}

// Resolves once the hub has handled a request of this method among those
// after the first `from`: what it answers is fixed, even if the reply is
// delayed.
async function handled(hub, method, from) {
  while (!hub.requests.slice(from).some((request) => request.method === method))
    await sleep(5);
}

// The owner switches the floor lamp off, on and off again by hand.
function flickerFloorLampOff(hub) {
  for (const boolValue of [false, true, false]) {
    hub.changeByHand({ ...floorLampOn, value: { boolValue } });
  }
}

function listed(body) {
  return body.rooms.flatMap((room) =>
    room.devices.flatMap((device) =>
      device.services.map((service) => ({ room, device, service })),
    ),
  );
}

function onValue(service) {
  return service.values.find(({ type }) => type === "On")?.value;
}

// Independent of the product: the services the simulator holds as on.
function servicesOnInState(state, home) {
  return state.accessories
    .flatMap((accessory) =>
      accessory.services
        .filter((service) =>
          service.characteristics.some(
            ({ control }) =>
              (control.type === "On" && control.value.boolValue === true) ||
              (control.type === "Active" && control.value.intValue === 1) ||
              (control.type === "TargetHeatingCoolingState" &&
                control.value.intValue !== 0),
          ),
        )
        .map(
          (service) =>
            `${home}/accessory/${accessory.id}/service/${service.sId}`,
        ),
    )
    .sort();
}

function onRefs(body) {
  return listed(body)
    .map(({ service }) => service.ref)
    .sort();
}

const floorLampOn = { aId: 16, sId: 13, cId: 14 };

// A lamp added in the SprutHub app: a copy of the desk lamp (on) under a
// new id, name and room.
function addLampInHub(hub, id, roomId, name) {
  const lamp = structuredClone(
    hub.state.accessories.find((accessory) => accessory.id === 32),
  );
  lamp.id = id;
  lamp.roomId = roomId;
  lamp.name = name;
  for (const service of lamp.services) {
    service.aId = id;
    for (const characteristic of service.characteristics) {
      characteristic.aId = id;
    }
  }
  hub.state.accessories.push(lamp);
  return lamp;
}

test("repeated overviews and state answers come from the warm home, not from new whole-home reads", async (t) => {
  // Events at rest, characteristic and room updates, as on the owner's hub.
  const { hub, call, home } = await setup(t, await loadHomeFixture("house"), {
    eventEveryMs: 20,
  });

  const first = await call("home_overview", {});
  assert.deepEqual(
    methods(first.native)
      .filter((method) => ["room.list", "accessory.list"].includes(method))
      .sort(),
    ["accessory.list", "room.list"],
  );
  const on = await call("find_devices", { state: "on" });
  assert.deepEqual(on.native, []);
  assert.deepEqual(onRefs(on.body), servicesOnInState(hub.state, home));

  await sleep(300);
  const again = await call("home_overview", {});
  assert.deepEqual(
    methods(again.native).filter((method) =>
      ["room.list", "accessory.list", "accessory.get"].includes(method),
    ),
    [],
  );
  assert.deepEqual(again.body.rooms, first.body.rooms);
  const onAgain = await call("find_devices", { state: "on" });
  assert.deepEqual(onAgain.native, []);
  assert.deepEqual(onRefs(onAgain.body), servicesOnInState(hub.state, home));
  assert.equal(onAgain.body.catalog_observed_at, on.body.catalog_observed_at);
  const lights = await call("find_devices", {
    room_ref: `${home}/room/3`,
    kind: "light",
  });
  assert.deepEqual(lights.native, []);
  assert(listed(lights.body).length >= 3);
});

test("a value the hub pushes shows in the next answer without a read", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  const before = await call("find_devices", { query: "торшер" });
  assert.equal(onValue(listed(before.body)[0].service), true);

  hub.changeByHand({ ...floorLampOn, value: { boolValue: false } });
  const changedAt = hub.state.handChanges.at(-1).at;
  await settle();

  const after = await call("find_devices", { query: "торшер" });
  assert.deepEqual(after.native, []);
  assert.equal(onValue(listed(after.body)[0].service), false);
  assert(after.body.observed_at >= changedAt, after.body.observed_at);
  const on = await call("find_devices", { state: "on" });
  assert.deepEqual(on.native, []);
  assert.deepEqual(onRefs(on.body), servicesOnInState(hub.state, home));
  assert(!onRefs(on.body).includes(`${home}/accessory/16/service/13`));
});

test("a device command of this process leaves the home warm; a configuration write reads it again", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});

  const sent = await call("send_device_commands", {
    home_ref: home,
    commands: [
      {
        target_ref: `${home}/accessory/16/service/13/characteristic/14`,
        value: false,
      },
    ],
    reason: "Выключить торшер",
  });
  assert.equal(sent.body.results[0].status, "applied");

  const lamp = await call("find_devices", { query: "торшер" });
  assert.deepEqual(lamp.native, []);
  assert.equal(onValue(listed(lamp.body)[0].service), false);
  const on = await call("find_devices", { state: "on" });
  assert.deepEqual(on.native, []);
  assert.deepEqual(onRefs(on.body), servicesOnInState(hub.state, home));

  // A rename is a configuration write: what it changes besides the name is
  // not a value the events are known to carry, so the home is read again.
  const prepared = await call("prepare_native_change", {
    operation: "service_name",
    target_ref: `${home}/accessory/17/service/13`,
    value: "Лента над диваном",
    reason: "Переименовать ленту",
  });
  await call("apply_native_change", { change_ref: prepared.body.change_ref });
  const renamed = await call("find_devices", { query: "лента" });
  assert.deepEqual(
    methods(renamed.native)
      .filter((method) => ["room.list", "accessory.list"].includes(method))
      .sort(),
    ["accessory.list", "room.list"],
  );
  assert.deepEqual(
    listed(renamed.body).map(({ service }) => service.name),
    ["Лента над диваном"],
  );
});

test("a gap in the hub's events makes the next answer read the home again", async (t) => {
  const { hub, call, callError, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
    { timeoutMs: 1500 },
  );
  await call("home_overview", {});
  const warm = await call("find_devices", { state: "on" });
  assert.deepEqual(warm.native, []);

  // The connection is cut; the lamp is switched off before the MCP process
  // reconnects, so no event of it can arrive.
  await hub.dropConnections();
  // The MCP process sees the close.
  await sleep(300);
  hub.changeByHand({ ...floorLampOn, value: { boolValue: false } });
  const afterLoss = await call("find_devices", { state: "on" });
  assert(methods(afterLoss.native).includes("accessory.list"));
  assert.deepEqual(onRefs(afterLoss.body), servicesOnInState(hub.state, home));
  const warmAgain = await call("find_devices", { state: "on" });
  assert.deepEqual(warmAgain.native, []);

  // A read runs out of time: its connection takes no new requests and is
  // closed once nothing waits on it, events included.
  hub.delayReplies("accessory.get", 3000);
  const timedOut = await callError("get_entity", {
    entity_ref: `${home}/accessory/12`,
  });
  assert.equal(timedOut.error.code, "timeout");
  hub.delayReplies("accessory.get", 0);
  hub.changeByHand({ ...floorLampOn, value: { boolValue: true } });
  const afterTimeout = await call("find_devices", { state: "on" });
  assert(methods(afterTimeout.native).includes("accessory.list"));
  assert.deepEqual(
    onRefs(afterTimeout.body),
    servicesOnInState(hub.state, home),
  );
  assert(onRefs(afterTimeout.body).includes(`${home}/accessory/16/service/13`));
});

// A connection gone without a close (a network drop, a sleeping laptop)
// carries no frames; nor would the events of an edit this state cannot
// follow announce themselves. The clock is moved instead of waited for.
test("the warm home is read whole again after a quiet minute on its connection and five minutes after the last whole read", async (t) => {
  const quiet = await setup(t, await loadHomeFixture("apartment"), {
    clockStepMs: 90_000,
  });
  await quiet.call("home_overview", {});
  assert.deepEqual(
    (await quiet.call("find_devices", { state: "on" })).native,
    [],
  );
  await quiet.shiftClock();
  const afterQuiet = await quiet.call("find_devices", { state: "on" });
  assert(methods(afterQuiet.native).includes("accessory.list"));
  assert.deepEqual(
    (await quiet.call("find_devices", { state: "on" })).native,
    [],
  );

  // The hub's events keep the connection busy, yet five minutes after the
  // last whole read the home is read whole again.
  const busy = await setup(t, await loadHomeFixture("apartment"), {
    clockStepMs: 90_000,
    eventEveryMs: 20,
  });
  await busy.call("home_overview", {});
  await busy.shiftClock();
  await settle();
  assert.deepEqual(
    (await busy.call("find_devices", { state: "on" })).native,
    [],
  );
  for (let step = 0; step < 3; step += 1) await busy.shiftClock();
  await settle();
  const afterMaxAge = await busy.call("find_devices", { state: "on" });
  assert(methods(afterMaxAge.native).includes("accessory.list"));
});

// Replies to this process's requests show that the connection answers,
// not that the hub still pushes events down it.
test("a connection that answers requests but pushed no event for a minute has the home read whole again", async (t) => {
  const { call, shiftClock } = await setup(
    t,
    await loadHomeFixture("apartment"),
    { clockStepMs: 90_000 },
  );
  await call("home_overview", {});
  await shiftClock();
  const scenarios = await call("home_overview", { list: "scenarios" });
  assert(methods(scenarios.native).includes("scenario.list"));

  const after = await call("find_devices", { state: "on" });
  assert(methods(after.native).includes("accessory.list"));
});

test("devices added, moved and removed in the SprutHub app follow the hub's events", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  const bedroomLights = { room_ref: `${home}/room/5`, kind: "light" };
  const livingLights = { room_ref: `${home}/room/3`, kind: "light" };
  const names = (body) => listed(body).map(({ device }) => device.name);

  const lamp = addLampInHub(hub, 60, 5, "Лампа у кровати");
  hub.emit({
    accessory: { event: "EVENT_ADD", accessories: [structuredClone(lamp)] },
  });
  await settle();
  const added = await call("find_devices", bedroomLights);
  assert(names(added.body).includes("Лампа у кровати"));
  assert.deepEqual(methods(added.native), ["accessory.get"]);
  assert.deepEqual((await call("find_devices", bedroomLights)).native, []);

  const nightLight = hub.state.accessories.find(({ id }) => id === 26);
  nightLight.roomId = 3;
  hub.emit({
    accessory: {
      event: "EVENT_UPDATE",
      accessories: [{ id: 26, roomId: 3 }],
    },
  });
  await settle();
  const moved = await call("find_devices", livingLights);
  assert(names(moved.body).includes(nightLight.name));
  assert.deepEqual(methods(moved.native), ["accessory.get"]);

  hub.state.accessories = hub.state.accessories.filter(({ id }) => id !== 16);
  hub.emit({ accessory: { event: "EVENT_REMOVE", accessories: [{ id: 16 }] } });
  await settle();
  const removed = await call("find_devices", livingLights);
  assert(!names(removed.body).includes("Торшер"));
  assert.deepEqual(removed.native, []);
});

test("a room renamed in the SprutHub app is renamed by its event", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});

  const bedroom = hub.state.rooms.find(({ id }) => id === 5);
  bedroom.name = "Спальня родителей";
  hub.emit({
    room: {
      event: "EVENT_UPDATE",
      rooms: [{ id: 5, name: bedroom.name, visible: true }],
    },
  });
  await settle();

  const overview = await call("home_overview", {});
  assert.equal(
    overview.body.rooms.find(({ ref }) => ref === `${home}/room/5`).name,
    "Спальня родителей",
  );
  assert.deepEqual(
    methods(overview.native).filter((method) =>
      ["room.list", "accessory.list"].includes(method),
    ),
    [],
  );
  const found = await call("find_devices", { query: "родителей" });
  assert.deepEqual(found.native, []);
  assert(listed(found.body).length > 0);
  assert(
    listed(found.body).every(({ room }) => room.name === "Спальня родителей"),
  );
});

// A device may sit in a room the room list lacks; its events and its room's
// must not have the room list read before every answer.
test("a room the room list lacks is not asked for again on each event", async (t) => {
  const fixture = await loadHomeFixture("apartment");
  fixture.accessories.find(({ id }) => id === 26).roomId = 99;
  const { hub, call, home } = await setup(t, fixture);
  const overview = await call("home_overview", {});
  assert(overview.body.rooms.some(({ ref }) => ref === `${home}/room/99`));

  hub.emit({
    accessory: {
      event: "EVENT_UPDATE",
      accessories: [{ id: 26, name: "Ночник" }],
    },
  });
  hub.emit({ room: { event: "EVENT_UPDATE", rooms: [{ id: 99 }] } });
  await settle();
  const first = await call("find_devices", { state: "on" });
  assert.deepEqual(methods(first.native), ["accessory.get"]);
  hub.emit({ room: { event: "EVENT_UPDATE", rooms: [{ id: 99 }] } });
  await settle();
  assert.deepEqual((await call("find_devices", { state: "on" })).native, []);
});

// A read answers with the home as the hub saw it when the request came,
// while the events of changes made since may arrive before its reply
// (accessory.list of the whole home took 245 ms on the owner's hub). The
// events that came during a read are applied again over what it read.
test("a value changed while the whole home is read shows in the answers after the read", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  hub.delayReplies("accessory.list", 400);
  const overview = call("home_overview", {});
  await handled(hub, "accessory.list", 0);
  flickerFloorLampOff(hub);
  await overview;
  hub.delayReplies("accessory.list", 0);

  const lamp = await call("find_devices", { query: "торшер" });
  assert.deepEqual(lamp.native, []);
  assert.equal(onValue(listed(lamp.body)[0].service), false);
});

test("a value changed while one device is read again shows in the answer after the read", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  await call("home_overview", {});
  // The floor lamp renamed in the SprutHub app: the next answer reads it
  // again.
  hub.emit({
    accessory: {
      event: "EVENT_UPDATE",
      accessories: [{ id: 16, name: "Торшер" }],
    },
  });
  await settle();
  hub.delayReplies("accessory.get", 400);
  const from = hub.requests.length;
  const answer = call("find_devices", { query: "торшер" });
  await handled(hub, "accessory.get", from);
  flickerFloorLampOff(hub);

  const lamp = await answer;
  assert.deepEqual(methods(lamp.native), ["accessory.get"]);
  assert.equal(onValue(listed(lamp.body)[0].service), false);
});

test("a room renamed while the room list is read again keeps its new name", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  // A room added in the SprutHub app has the room list read again.
  const veranda = { id: 40, name: "Веранда", order: 40, visible: true };
  hub.state.rooms.push(veranda);
  hub.emit({ room: { event: "EVENT_ADD", rooms: [veranda] } });
  await settle();
  hub.delayReplies("room.list", 400);
  const from = hub.requests.length;
  const overview = call("home_overview", {});
  await handled(hub, "room.list", from);
  const bedroom = hub.state.rooms.find(({ id }) => id === 5);
  bedroom.name = "Спальня родителей";
  hub.emit({
    room: {
      event: "EVENT_UPDATE",
      rooms: [{ id: 5, name: bedroom.name, order: bedroom.order }],
    },
  });

  const answer = await overview;
  assert.deepEqual(
    methods(answer.native).filter((method) =>
      ["room.list", "accessory.list"].includes(method),
    ),
    ["room.list"],
  );
  const names = new Map(answer.body.rooms.map(({ ref, name }) => [ref, name]));
  assert.equal(names.get(`${home}/room/40`), "Веранда");
  assert.equal(names.get(`${home}/room/5`), "Спальня родителей");
});

// The hub pushes an event for every value write, after its reply
// (2026-10-13-lamp-logic-undo 4.2, 4.5). Until it comes, or a read sent
// after the reply, the value written is not taken as the device's.
test("a device command whose event never comes has its device read again before the next answer", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  hub.dropEvents((event) =>
    event.characteristic?.characteristics?.some(({ aId }) => aId === 16),
  );
  const sent = await call("send_device_commands", {
    home_ref: home,
    commands: [
      {
        target_ref: `${home}/accessory/16/service/13/characteristic/14`,
        value: false,
      },
    ],
    reason: "Выключить торшер",
  });
  assert.equal(sent.body.results[0].status, "applied");
  hub.dropEvents(null);

  const lamp = await call("find_devices", { query: "торшер" });
  assert.deepEqual(methods(lamp.native), ["accessory.get"]);
  assert.equal(onValue(listed(lamp.body)[0].service), false);
  assert.deepEqual(
    (await call("find_devices", { query: "торшер" })).native,
    [],
  );
});

// Only an event received after a write's reply is that write's own. An
// event from before the write, applied again over a read that was in
// flight, is another change and leaves the write unconfirmed.
test("an event older than a device command does not confirm the command when applied again over a read", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  hub.delayReplies("accessory.list", 600);
  const from = hub.requests.length;
  let readDone = false;
  const reading = call("find_devices", { query: "торшер", refresh: true });
  reading.then(() => {
    readDone = true;
  });
  await handled(hub, "accessory.list", from);
  // The owner switches the floor lamp off; then this process switches it
  // on, and the event of that write is lost.
  hub.changeByHand({ ...floorLampOn, value: { boolValue: false } });
  await settle();
  hub.dropEvents((event) =>
    event.characteristic?.characteristics?.some(({ aId }) => aId === 16),
  );
  const sent = await call("send_device_commands", {
    home_ref: home,
    commands: [
      {
        target_ref: `${home}/accessory/16/service/13/characteristic/14`,
        value: true,
      },
    ],
    reason: "Включить торшер",
  });
  assert.equal(sent.body.results[0].status, "applied");
  hub.dropEvents(null);
  assert.equal(readDone, false, "the command went in while the read waited");

  const during = await reading;
  assert.equal(onValue(listed(during.body)[0].service), true);
  hub.delayReplies("accessory.list", 0);
  const lamp = await call("find_devices", { query: "торшер" });
  assert.equal(onValue(listed(lamp.body)[0].service), true);
});

test("a device command whose reply never comes has the home read again before the next answer", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
    { timeoutMs: 1500 },
  );
  await call("home_overview", {});
  // The hub switches the lamp off at once; its reply and event come after
  // the request has run out of time.
  hub.delayReplies("characteristic.update", 3000);
  await call("send_device_commands", {
    home_ref: home,
    commands: [
      {
        target_ref: `${home}/accessory/16/service/13/characteristic/14`,
        value: false,
      },
    ],
    reason: "Выключить торшер",
  });
  hub.delayReplies("characteristic.update", 0);

  const lamp = await call("find_devices", { query: "торшер" });
  assert(methods(lamp.native).includes("accessory.list"));
  assert.equal(onValue(listed(lamp.body)[0].service), false);
  assert.deepEqual(
    (await call("find_devices", { query: "торшер" })).native,
    [],
  );
});

// A device's availability is a field of its accessory, which only a read
// gives; the hub pushes the value of its information service's C_Online.
test("a device that drops off the network shows as unavailable after its availability event", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  const nightLight = `${home}/accessory/26`;
  const unavailableIn = (body) =>
    body.problems.some(
      ({ kind, ref }) => kind === "device_unavailable" && ref === nightLight,
    );
  assert(!unavailableIn((await call("home_overview", {})).body));

  const accessory = hub.state.accessories.find(({ id }) => id === 26);
  accessory.online = false;
  const online = { aId: 26, sId: 1, cId: 8 };
  accessory.services
    .find(({ sId }) => sId === online.sId)
    .characteristics.find(({ cId }) => cId === online.cId).control.value = {
    boolValue: false,
  };
  hub.emit({
    characteristic: {
      event: "EVENT_UPDATE",
      characteristics: [
        { ...online, control: { value: { boolValue: false } } },
      ],
    },
  });
  await settle();

  const overview = await call("home_overview", {});
  assert.deepEqual(
    methods(overview.native).filter((method) =>
      ["accessory.get", "accessory.list"].includes(method),
    ),
    ["accessory.get"],
  );
  assert(unavailableIn(overview.body), JSON.stringify(overview.body.problems));
  const unavailable = await call("find_devices", { state: "unavailable" });
  assert.deepEqual(unavailable.native, []);
  assert(
    listed(unavailable.body).some(({ device }) => device.ref === nightLight),
  );
});

// Each frame below comes with an edit the state cannot take from it: the
// floor lamp renamed in the hub without an event the state applies.
test("an event the warm home cannot follow has the next answer read the whole home again", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  const lamp = hub.state.accessories.find(({ id }) => id === 16);
  const frames = {
    "an accessory event whose item has no id": () =>
      hub.emit({
        accessory: {
          event: "EVENT_UPDATE",
          accessories: [{ name: lamp.name }],
        },
      }),
    "a hub event": () => hub.emit({ hub: { event: "EVENT_UPDATE" } }),
    "a frame that is not JSON": () => hub.pushRaw("{"),
  };
  for (const [what, push] of Object.entries(frames)) {
    lamp.name = `Торшер, ${what}`;
    push();
    await settle();
    const lights = await call("find_devices", {
      room_ref: `${home}/room/3`,
      kind: "light",
    });
    assert(methods(lights.native).includes("accessory.list"), what);
    assert(
      listed(lights.body).some(({ device }) => device.name === lamp.name),
      what,
    );
  }
});

test("an event of a device the warm home cannot apply has that device read again", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  await call("home_overview", {});
  const lamp = hub.state.accessories.find(({ id }) => id === 16);
  const service = lamp.services.find(({ sId }) => sId === 13);
  const read = async () => {
    const answer = await call("find_devices", { query: "торшер" });
    return { methods: methods(answer.native), ...listed(answer.body)[0] };
  };

  // A value event of another type than EVENT_UPDATE.
  service.characteristics.find(({ cId }) => cId === 14).control.value = {
    boolValue: false,
  };
  hub.emit({
    characteristic: {
      event: "EVENT_ADD",
      characteristics: [
        { ...floorLampOn, control: { value: { boolValue: false } } },
      ],
    },
  });
  await settle();
  const typed = await read();
  assert.deepEqual(typed.methods, ["accessory.get"]);
  assert.equal(onValue(typed.service), false);

  // A value of a characteristic the device did not have when it was read.
  const temperature = structuredClone(
    hub.state.accessories
      .find(({ id }) => id === 17)
      .services.find(({ sId }) => sId === 13)
      .characteristics.find(({ cId }) => cId === 18),
  );
  Object.assign(temperature, { aId: 16, sId: 13, cId: 16 });
  service.characteristics.push(temperature);
  hub.emit({
    characteristic: {
      event: "EVENT_UPDATE",
      characteristics: [
        {
          aId: 16,
          sId: 13,
          cId: 16,
          control: { value: structuredClone(temperature.control.value) },
        },
      ],
    },
  });
  await settle();
  const added = await read();
  assert.deepEqual(added.methods, ["accessory.get"]);
  assert(added.service.values.some(({ type }) => type === "ColorTemperature"));

  // A service renamed in the SprutHub app.
  service.name = "Торшер у дивана";
  hub.emit({
    service: {
      event: "EVENT_UPDATE",
      services: [{ aId: 16, sId: 13, name: service.name }],
    },
  });
  await settle();
  const renamed = await read();
  assert.deepEqual(renamed.methods, ["accessory.get"]);
  assert.equal(renamed.service.name, "Торшер у дивана");
});

// While a read is in flight its log keeps what came meanwhile; past
// EVENT_LOG_LIMIT entries it cannot say what it missed. Creating 4
// accessories pushed about 360 frames in 2 s on the owner's hub.
test("more events during a read than the home keeps have the next answer read it whole again", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  await call("home_overview", {});
  hub.delayReplies("accessory.list", 400);
  const from = hub.requests.length;
  const refreshed = call("find_devices", { query: "торшер", refresh: true });
  await handled(hub, "accessory.list", from);
  const hall = hub.state.rooms.find(({ id }) => id === 1);
  for (let index = 0; index < 1000; index += 1) {
    hub.emit({
      room: {
        event: "EVENT_UPDATE",
        rooms: [{ id: hall.id, name: hall.name }],
      },
    });
  }
  hub.changeByHand({ ...floorLampOn, value: { boolValue: false } });
  await refreshed;
  hub.delayReplies("accessory.list", 0);

  const lamp = await call("find_devices", { query: "торшер" });
  assert(methods(lamp.native).includes("accessory.list"));
  assert.equal(onValue(listed(lamp.body)[0].service), false);
});

// Events do not name their home: on a connection that carried two homes'
// serials an event cannot be told to be either's. Both apartments have the
// floor lamp under the same ids.
test("events of a second home on the same connection do not change the first home's answers", async (t) => {
  const secondHome = await loadHomeFixture("apartment");
  secondHome.hub.serial = "sim-apartment-02";
  const { call, second } = await setup(t, await loadHomeFixture("apartment"), {
    secondHome,
  });
  const otherHome = `spruthub://hub/${second.serial}`;
  await call("home_overview", {});
  const other = await call("find_devices", {
    home_ref: otherHome,
    query: "торшер",
  });
  assert.equal(onValue(listed(other.body)[0].service), true);

  second.changeByHand({ ...floorLampOn, value: { boolValue: false } });
  await settle();
  const lamp = await call("find_devices", { query: "торшер" });
  assert.equal(onValue(listed(lamp.body)[0].service), true);
  const otherLamp = await call("find_devices", {
    home_ref: otherHome,
    query: "торшер",
  });
  assert.equal(onValue(listed(otherLamp.body)[0].service), false);
});

// A read the hub answered before a configuration write of this process
// may come back after it.
test("a configuration write while the home is read has the next answer read it again", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  const prepared = await call("prepare_native_change", {
    operation: "service_name",
    target_ref: `${home}/accessory/17/service/13`,
    value: "Лента над диваном",
    reason: "Переименовать ленту",
  });
  hub.delayReplies("accessory.list", 600);
  const from = hub.requests.length;
  let readDone = false;
  const reading = call("find_devices", { query: "лента", refresh: true }).then(
    () => {
      readDone = true;
    },
  );
  await handled(hub, "accessory.list", from);
  await call("apply_native_change", { change_ref: prepared.body.change_ref });
  assert.equal(readDone, false, "the rename went in while the read waited");
  await reading;
  hub.delayReplies("accessory.list", 0);

  const lights = await call("find_devices", {
    room_ref: `${home}/room/3`,
    kind: "light",
  });
  assert(methods(lights.native).includes("accessory.list"));
  assert(
    listed(lights.body).some(
      ({ service }) => service.name === "Лента над диваном",
    ),
  );
});

test("a device moved to a room created without an event, and a room moved in the order, read the room list again", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});

  // The room's EVENT_ADD, which the hub pushes, is lost on the way.
  hub.state.rooms.push({ id: 41, name: "Веранда", order: 41, visible: true });
  hub.state.accessories.find(({ id }) => id === 16).roomId = 41;
  hub.emit({
    accessory: { event: "EVENT_UPDATE", accessories: [{ id: 16, roomId: 41 }] },
  });
  await settle();
  const moved = await call("find_devices", { query: "торшер" });
  assert.deepEqual(methods(moved.native), ["accessory.get", "room.list"]);
  assert.equal(listed(moved.body)[0].room.name, "Веранда");

  // The bedroom moved to the top of the room list in the SprutHub app.
  const bedroom = hub.state.rooms.find(({ id }) => id === 5);
  hub.state.rooms = [
    bedroom,
    ...hub.state.rooms.filter((room) => room !== bedroom),
  ];
  hub.state.rooms.forEach((room, index) => {
    room.order = index + 1;
  });
  hub.emit({
    room: {
      event: "EVENT_UPDATE",
      rooms: [{ id: 5, name: bedroom.name, order: bedroom.order }],
    },
  });
  await settle();
  const overview = await call("home_overview", {});
  assert(methods(overview.native).includes("room.list"));
  assert.equal(overview.body.rooms[0].ref, `${home}/room/5`);
});

// One event as the owner's hub pushes at rest, a room with its own fields
// (about 6 a minute, 2026-10-13-voice-latency-baseline, section 5): it
// shows that the connection pushes events.
async function restEvent(hub) {
  const { id, name, order, visible } = hub.state.rooms[0];
  hub.emit({
    room: { event: "EVENT_UPDATE", rooms: [{ id, name, order, visible }] },
  });
  await settle();
}

const balcony = 30;

// The owner deletes the empty balcony in the SprutHub app after the hub
// has answered room.list of a whole read and before it answers
// accessory.list; the hub pushes room EVENT_REMOVE
// (2026-10-13-structure-events).
test("a room deleted while the home is read is not answered from that read, also by a call that joins it", async (t) => {
  const { hub, call, callError, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  hub.delayReplies("accessory.list", 400);
  const overview = call("home_overview", {});
  await handled(hub, "accessory.list", 0);
  hub.delayReplies("accessory.list", 0);
  hub.request({ room: { delete: { id: balcony } } });
  await settle();

  const found = await callError("find_devices", {
    room_ref: `${home}/room/${balcony}`,
  });
  assert.equal(found.error.code, "room_not_found");
  const rooms = (await overview).body.rooms.map(({ ref }) => ref);
  assert(!rooms.includes(`${home}/room/${balcony}`), rooms.join());
});

test("two calls in flight with a whole read both see a room deleted during it", async (t) => {
  const { hub, callError, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  hub.delayReplies("accessory.list", 400);
  const room = { room_ref: `${home}/room/${balcony}` };
  const first = callError("find_devices", room);
  const second = callError("find_devices", room);
  await handled(hub, "accessory.list", 0);
  hub.delayReplies("accessory.list", 0);
  hub.request({ room: { delete: { id: balcony } } });

  for (const answer of await Promise.all([first, second])) {
    assert.equal(answer.error.code, "room_not_found");
  }
});

// A read the hub answered before the agent's own rename, landing after a
// whole read made since: its old service name must not come back, even
// when the rename's own events are lost on the way.
test("a device read answered before the agent's own rename does not bring the old name back", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  const prepared = await call("prepare_native_change", {
    operation: "service_name",
    target_ref: `${home}/accessory/17/service/13`,
    value: "Лента над диваном",
    reason: "Переименовать ленту",
  });
  // The owner renames the strip's device in the SprutHub app: the next
  // answer reads it again.
  hub.request({ accessory: { update: { id: 17, name: "Лента у дивана" } } });
  await settle();
  hub.delayReplies("accessory.get", 1500);
  const from = hub.requests.length;
  const early = call("find_devices", { query: "лента" });
  await handled(hub, "accessory.get", from);
  hub.delayReplies("accessory.get", 0);
  hub.dropEvents((event) =>
    [
      ...(event.service?.services ?? []),
      ...(event.characteristic?.characteristics ?? []),
    ].some(({ aId }) => aId === 17),
  );
  await call("apply_native_change", { change_ref: prepared.body.change_ref });
  hub.dropEvents(null);
  const overview = await call("home_overview", {});
  assert(methods(overview.native).includes("accessory.list"));

  const names = (body) => listed(body).map(({ service }) => service.name);
  const earlyAnswer = await early;
  assert.deepEqual(
    names((await call("find_devices", { query: "лента" })).body),
    ["Лента над диваном"],
  );
  assert.deepEqual(names(earlyAnswer.body), ["Лента над диваном"]);
});

test("a clock moved back has the next answer read the whole home", async (t) => {
  const { hub, call, shiftClock } = await setup(
    t,
    await loadHomeFixture("apartment"),
    { clockStepMs: -10 * 60_000 },
  );
  await call("home_overview", {});
  await restEvent(hub);
  assert.deepEqual((await call("find_devices", { state: "on" })).native, []);

  await shiftClock();
  const after = await call("find_devices", { state: "on" });
  assert(methods(after.native).includes("accessory.list"));
  await restEvent(hub);
  assert.deepEqual((await call("find_devices", { state: "on" })).native, []);
});

// A whole read does not show that the hub pushes events down its
// connection; only a pushed event does.
test("a connection that has pushed no event is not trusted to keep the home warm", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  await call("home_overview", {});

  const silent = await call("find_devices", { state: "on" });
  assert(methods(silent.native).includes("accessory.list"));
  await restEvent(hub);
  assert.deepEqual((await call("find_devices", { state: "on" })).native, []);
});

// The event of a device command reached the writing socket of the owner's
// hub up to 556 ms after its reply (2026-10-13-structure-events): a later
// command to the same characteristic may be answered first.
test("an earlier device command's event coming after a later command's reply does not confirm the later one", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  await restEvent(hub);
  const lampEvent = (event) =>
    event.characteristic?.characteristics?.some(
      ({ aId, sId, cId }) =>
        aId === floorLampOn.aId &&
        sId === floorLampOn.sId &&
        cId === floorLampOn.cId,
    );
  const command = async (value) =>
    (
      await call("send_device_commands", {
        home_ref: home,
        commands: [
          {
            target_ref: `${home}/accessory/16/service/13/characteristic/14`,
            value,
          },
        ],
        reason: value ? "Включить торшер" : "Выключить торшер",
      })
    ).body.results[0].status;

  // The off's event is held past the on's reply, and the on's is lost.
  hub.delayEvents(lampEvent, 800);
  assert.equal(await command(false), "applied");
  hub.delayEvents(null);
  hub.dropEvents(lampEvent);
  assert.equal(await command(true), "applied");
  hub.dropEvents(null);
  await sleep(900);

  const lamp = await call("find_devices", { query: "торшер" });
  assert.equal(onValue(listed(lamp.body)[0].service), true);
});

// Every read the call makes is overlapped by an edit the warm home cannot
// apply (a device renamed over and over in the SprutHub app): rather than
// answer from a read that may have missed it, the call says so.
test("a home that keeps changing during every read is not answered from those reads", async (t) => {
  const { hub, callError } = await setup(t, await loadHomeFixture("apartment"));
  hub.delayReplies("accessory.list", 100);
  hub.delayReplies("accessory.get", 100);
  const renames = setInterval(
    () =>
      hub.emit({
        accessory: {
          event: "EVENT_UPDATE",
          accessories: [{ id: 16, name: "Торшер" }],
        },
      }),
    20,
  );
  t.after(() => clearInterval(renames));

  const answer = await callError("find_devices", { query: "торшер" });
  assert.equal(answer.error.code, "home_changing");
  assert.equal(answer.error.action, "retry");
});
