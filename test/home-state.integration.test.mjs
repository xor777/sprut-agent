import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SprutHubClient } from "../src/spruthub-client.mjs";
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

// With clockStepMs the server runs with test/support/shifted-clock.mjs and
// shiftClock moves its clock that far forward.
async function setup(
  t,
  fixture,
  { eventEveryMs, timeoutMs = 3000, clockStepMs } = {},
) {
  const hub = await startSimulatedHub(fixture, { eventEveryMs });
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
  return { hub, call, callError, home, shiftClock };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Long enough for a pushed frame to reach the MCP process over loopback.
const settle = () => sleep(150);

function methods(native) {
  return native.map(({ method }) => method);
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
      accessories: [{ id: 26, roomId: 3, name: nightLight.name }],
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
    accessory: { event: "EVENT_UPDATE", accessories: [{ id: 26 }] },
  });
  hub.emit({ room: { event: "EVENT_UPDATE", rooms: [{ id: 99 }] } });
  await settle();
  const first = await call("find_devices", { state: "on" });
  assert.deepEqual(methods(first.native), ["accessory.get"]);
  hub.emit({ room: { event: "EVENT_UPDATE", rooms: [{ id: 99 }] } });
  await settle();
  assert.deepEqual((await call("find_devices", { state: "on" })).native, []);
});

// What other modules read without a request, such as a device command
// taking the value before it writes: the value, when the hub reported it,
// and whether the warm home can be trusted for it.
test("the warm home gives a characteristic's value and says when it cannot be trusted", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const env = hub.connectionEnv();
  const client = new SprutHubClient({
    url: env.SPRUTHUB_URL,
    token: env.SPRUTHUB_TOKEN,
    serial: env.SPRUTHUB_SERIAL,
    cid: env.SPRUTHUB_CID,
    timeoutMs: 3000,
  });
  t.after(() => client.close());

  assert.deepEqual(client.liveValue(floorLampOn), {
    trusted: false,
    reason: "not_read",
  });
  await client.homeCatalog(hub.serial, Date.now() + 3000);
  const read = client.liveValue(floorLampOn);
  assert.equal(read.trusted, true);
  assert.deepEqual(read.value, { boolValue: true });
  assert.equal(read.source, "read");
  assert.match(read.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(read.available, true);

  hub.changeByHand({ ...floorLampOn, value: { boolValue: false } });
  await settle();
  const pushed = client.liveValue(floorLampOn);
  assert.equal(pushed.trusted, true);
  assert.deepEqual(pushed.value, { boolValue: false });
  assert.equal(pushed.source, "event");
  assert(pushed.observed_at >= read.observed_at);

  await client.updateCharacteristic({
    ...floorLampOn,
    value: { boolValue: true },
  });
  await settle();
  const written = client.liveValue(floorLampOn);
  assert.equal(written.trusted, true);
  assert.deepEqual(written.value, { boolValue: true });
  assert.equal(written.source, "event");

  assert.deepEqual(client.liveValue({ aId: 16, sId: 13, cId: 99 }), {
    trusted: false,
    reason: "not_found",
  });
  await hub.dropConnections();
  await sleep(300);
  const lost = client.liveValue(floorLampOn);
  assert.equal(lost.trusted, false);
  assert.equal(lost.reason, "connection_lost");
});
