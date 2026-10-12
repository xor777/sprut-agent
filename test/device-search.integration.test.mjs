import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaledHome } from "./fixtures/homes/scaled.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Добавь новый датчик протечки в ванную»: the agent opens the ZigBee
// network, the owner puts the sensor into pairing mode, the hub reports the
// new device and its accessory, and the agent places and names it. The
// simulated hub follows the live start, restart and stop of the search
// (research/protocol/2026-10-12-device-pairing.md, check 1); how a device
// joins is inferred from the web client and marked so in the simulator.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const home = "spruthub://hub/sim-apartment-01";
const ZIGBEE = "Controller:zigbee";
const zigbeeRef = `${home}/extension/${encodeURIComponent(ZIGBEE)}`;
const tionRef = `${home}/extension/${encodeURIComponent("Controller:tion")}`;
const telegramRef = `${home}/extension/${encodeURIComponent("Notification:telegram")}`;
const SENSOR_DEVICE_ID = "00158d0007c0ffee";
const sensorChildRef = `${zigbeeRef}/child/${SENSOR_DEVICE_ID}`;
const sensorRef = `${home}/accessory/200`;
const HALLWAY = 1;
const BATHROOM = 8;

// A leak sensor the owner holds in pairing mode. The name and room the hub
// gives a new accessory were not observed; the simulator uses these.
function leakSensor({ joinAfterMs = 300, interviewMs = 300, ...rest } = {}) {
  return {
    extensionKey: ZIGBEE,
    joinAfterMs,
    interviewMs,
    childName: "lumi.sensor_wleak.aq1",
    accessory: {
      id: 200,
      name: "lumi.sensor_wleak.aq1",
      roomId: HALLWAY,
      deviceId: SENSOR_DEVICE_ID,
      manufacturer: "Aqara",
      model: "SJCGQ11LM",
      battery: 100,
      services: [
        {
          sId: 13,
          type: "LeakSensor",
          name: "Протечка",
          characteristics: [{ cId: 14, type: "LeakDetected", value: 0 }],
        },
      ],
    },
    ...rest,
  };
}

async function apartment({ pairing = [], discoveryTimeMs } = {}) {
  const fixture = await loadHomeFixture("apartment");
  return {
    ...fixture,
    hub: {
      ...fixture.hub,
      ...(discoveryTimeMs === undefined ? {} : { discoveryTimeMs }),
    },
    pairing,
  };
}

// A simulated hub and an MCP server for it with a temporary state
// directory. connect() starts another server process on the same hub and
// state directory, as a client that starts the server anew each turn.
// With shiftedClock the servers run with test/support/shifted-clock.mjs,
// and shiftClock() moves the clock of the latest one 5 minutes forward.
async function setup(t, fixture, { shiftedClock = false, ...hubOptions } = {}) {
  const hub = await startSimulatedHub(fixture, hubOptions);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-device-search-"),
  );
  const clients = [];
  let latest;
  t.after(async () => {
    for (const client of clients) await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const clockModule = pathToFileURL(
    path.join(projectRoot, "test/support/shifted-clock.mjs"),
  ).href;
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...(shiftedClock ? ["--import", clockModule] : []),
        "src/server.mjs",
      ],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: "2000",
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "device-search-test",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(transport);
    latest = transport;
    return client;
  };
  const shiftClock = async () => {
    const transport = latest;
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
  return {
    hub,
    client: await connect(),
    connect,
    shiftClock,
    stateDirectory,
  };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function callBytes(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return {
    body: result.structuredContent,
    bytes: Buffer.byteLength(result.content[0].text),
  };
}

async function toolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent;
}

// Search actions the MCP server sent (a request the test sends itself has
// no connection).
function searchActions(hub) {
  return hub.requests
    .filter(
      ({ method, connection }) =>
        method === "extension.action" && connection !== null,
    )
    .map(({ params }) => params.extension.action);
}

function zigbeeChildren(hub) {
  return hub.state.accessories.filter(
    ({ extensionKey, virtual }) => extensionKey === ZIGBEE && virtual !== true,
  ).length;
}

// Calls get_device_search until its result is one of results.
async function waitForResult(
  client,
  searchRef,
  results,
  waitSeconds = 10,
  attempts = 8,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const report = await call(client, "get_device_search", {
      search_ref: searchRef,
      wait_seconds: waitSeconds,
    });
    if (results.includes(report.result)) return report;
  }
  assert.fail(`get_device_search did not reach ${results.join(" or ")}`);
}

// Resolves once the simulated hub has made accessory id.
async function accessoryCreated(hub, id) {
  for (let waited = 0; waited < 8_000; waited += 50) {
    if (hub.state.accessories.some((accessory) => accessory.id === id)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`accessory ${id} was not created`);
}

function startNatively(hub, state = true) {
  return hub.request({
    extension: {
      action: { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state },
    },
  });
}

test("an extension shows its search actions and the overview marks the controller that can search", async (t) => {
  const { hub, client } = await setup(t, await apartment());

  const idle = (await call(client, "get_entity", { entity_ref: zigbeeRef }))
    .entity;
  assert.deepEqual(
    idle.spaces.map(({ key, child_count, actions }) => ({
      key,
      child_count,
      actions,
    })),
    [
      {
        key: "main",
        child_count: zigbeeChildren(hub),
        actions: [
          { id: 1, label: "Поиск", type: "ACTION_DISCOVERY", active: false },
        ],
      },
      {
        key: "discovery",
        child_count: 0,
        actions: [
          {
            id: 1,
            label: "ZLL поиск",
            type: "ACTION_DISCOVERY",
            active: false,
          },
        ],
      },
    ],
  );
  // A controller without actions shows its spaces and counts only.
  const tion = (await call(client, "get_entity", { entity_ref: tionRef }))
    .entity;
  assert.deepEqual(
    tion.spaces.map(({ key, child_count, actions }) => ({
      key,
      child_count,
      actions,
    })),
    [{ key: "main", child_count: 1, actions: undefined }],
  );

  const listed = await call(client, "home_overview", { list: "extensions" });
  assert.deepEqual(
    listed.extensions
      .filter(({ device_search }) => device_search !== undefined)
      .map(({ ref, device_search }) => ({ ref, device_search })),
    [{ ref: zigbeeRef, device_search: { active: false } }],
  );

  // Started in the SprutHub app: every action shows the end, only the
  // started one runs (P2).
  startNatively(hub);
  const running = (await call(client, "get_entity", { entity_ref: zigbeeRef }))
    .entity;
  const [search] = running.spaces[0].actions;
  assert.equal(search.active, true);
  assert.match(
    search.ends_at,
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+03:00$/,
  );
  assert(search.seconds_left > 50 && search.seconds_left <= 60, search);
  assert.deepEqual(running.spaces[1].actions, [
    { id: 1, label: "ZLL поиск", type: "ACTION_DISCOVERY", active: false },
  ]);
  const overview = await call(client, "home_overview", {});
  assert.deepEqual(
    overview.extensions.find(({ ref }) => ref === zigbeeRef).device_search,
    {
      active: true,
      ends_at: search.ends_at,
      seconds_left: overview.extensions.find(({ ref }) => ref === zigbeeRef)
        .device_search.seconds_left,
    },
  );
  assert.deepEqual(searchActions(hub), []);
});

// An action the client cannot read (here without a numeric id) is left out
// and flagged; the controller, its other actions and its search stay
// usable.
test("an action the client cannot read leaves the controller and its search usable", async (t) => {
  const fixture = await apartment();
  const zigbee = fixture.extensions.find(
    ({ extensionKey }) => extensionKey === ZIGBEE,
  );
  zigbee.spaces[0].actions.push({
    id: "reset",
    button: "Сброс",
    type: "ACTION_BUTTON",
  });
  const { hub, client } = await setup(t, fixture);

  const entity = (await call(client, "get_entity", { entity_ref: zigbeeRef }))
    .entity;
  assert.deepEqual(entity.spaces[0].actions, [
    { id: 1, label: "Поиск", type: "ACTION_DISCOVERY", active: false },
  ]);
  assert.equal(entity.spaces[0].actions_unreadable, true);
  assert.equal(entity.spaces[1].actions_unreadable, undefined);

  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(started.status, "started");
  const report = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  assert.equal(report.active, true);
  const stopped = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stopped.stop_sent, true);
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: false },
  ]);
});

test("a new leak sensor joins during the search, is placed in the bathroom and read", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ pairing: [leakSensor({ interviewMs: 1_500 })] }),
  );
  const childrenBefore = zigbeeChildren(hub);

  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(started.status, "started");
  assert.equal(started.active, true);
  assert.match(started.ends_at, /\+03:00$/);
  assert(started.seconds_left > 50 && started.seconds_left <= 60, started);
  assert.equal(started.devices_before, childrenBefore);
  assert.equal(typeof started.owner_step, "string");
  assert.deepEqual(started.next, {
    tool: "get_device_search",
    arguments: { search_ref: started.search_ref },
  });
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
  ]);

  // The device shows while it joins, before the hub has made its accessory;
  // the wait returns at that change rather than at the end of wait_seconds.
  const begun = Date.now();
  const joining = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 15,
  });
  assert(Date.now() - begun < 5_000, "the wait returns when a device joins");
  assert.equal(joining.result, "joining");
  assert.equal(joining.changed, true);
  assert.deepEqual(
    joining.new_devices.map(
      ({ ref, online, status, progress, error, accessory_status }) => ({
        ref,
        online,
        status,
        progress,
        error,
        accessory_status,
      }),
    ),
    [
      {
        ref: sensorChildRef,
        online: true,
        status: "Подключение",
        progress: 10,
        error: null,
        accessory_status: "pending",
      },
    ],
  );

  const joined = await waitForResult(client, started.search_ref, ["joined"]);
  assert.equal(joined.status, "searching");
  assert.equal(joined.active, true);
  assert.deepEqual(joined.changed_devices, []);
  assert.equal(joined.new_devices.length, 1);
  const [device] = joined.new_devices;
  assert.equal(device.ref, sensorChildRef);
  assert.equal(device.space_key, "main");
  assert.equal(device.online, true);
  assert.equal(device.accessory_status, "found");
  assert.deepEqual(device.accessories, [
    {
      ref: sensorRef,
      name: "lumi.sensor_wleak.aq1",
      room_ref: `${home}/room/${HALLWAY}`,
      room: "Прихожая",
      services: [
        {
          ref: `${sensorRef}/service/13`,
          name: "Протечка",
          type: "LeakSensor",
          kind: "sensor",
        },
        {
          ref: `${sensorRef}/service/90`,
          name: "Батарея",
          type: "BatteryService",
          kind: "technical",
        },
      ],
    },
  ]);

  const prepared = await call(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: sensorRef,
    room_ref: `${home}/room/${BATHROOM}`,
    name: "Датчик протечки у ванны",
    reason: "Владелец добавил новый датчик протечки в ванную",
  });
  await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  const placed = hub.state.accessories.find(({ id }) => id === 200);
  assert.equal(placed.roomId, BATHROOM);
  assert.equal(placed.name, "Датчик протечки у ванны");

  const read = await call(client, "find_devices", {
    room_ref: `${home}/room/${BATHROOM}`,
    query: "протечки у ванны",
  });
  const sensor = read.rooms
    .flatMap((room) => room.devices)
    .find(({ ref }) => ref === sensorRef);
  assert.equal(
    sensor.services[0].values.find(({ type }) => type === "LeakDetected").value,
    0,
  );

  // The network is still open: stopping closes it once, a repeat sends
  // nothing.
  const stopped = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stopped.stop_sent, true);
  assert.equal(stopped.active, false);
  assert.equal(stopped.ended, "stopped");
  assert.equal(stopped.new_devices[0].accessories[0].ref, sensorRef);
  const again = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(again.stop_sent, false);
  assert.equal(again.ended, "stopped");
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: false },
  ]);
  assert.deepEqual(
    hub
      .writes()
      .filter(({ connection }) => connection !== null)
      .map(({ method }) => method),
    ["extension.action", "accessory.update", "extension.action"],
  );
});

test("a search that already runs is returned without a resend that would extend it", async (t) => {
  const { hub, client } = await setup(t, await apartment());

  const first = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(first.status, "started");
  const second = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(second.status, "already_running");
  assert.equal(second.search_ref, first.search_ref);
  assert.equal(second.ends_at, first.ends_at);
  assert.equal(searchActions(hub).length, 1);

  await call(client, "stop_device_search", { search_ref: first.search_ref });
  assert.equal(searchActions(hub).length, 2);

  // Started in the SprutHub app: the agent waits on it, sends nothing.
  startNatively(hub);
  const elsewhere = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(elsewhere.status, "already_running");
  assert.notEqual(elsewhere.search_ref, first.search_ref);
  assert.equal(elsewhere.active, true);
  assert.equal(searchActions(hub).length, 2);
});

test("a search that ends with nothing new says so and offers a new start", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert(started.seconds_left <= 2, started);

  const begun = Date.now();
  const ended = await waitForResult(client, started.search_ref, [
    "no_new_device",
  ]);
  assert(Date.now() - begun < 8_000, "the end is reported when it comes");
  assert.equal(ended.status, "ended");
  assert.equal(ended.active, false);
  assert.equal(ended.ended, "expired");
  assert.deepEqual(ended.new_devices, []);
  assert.deepEqual(ended.next, {
    tool: "start_device_search",
    arguments: { extension_ref: zigbeeRef },
  });
  // The timer closed the network; the agent sent only the start.
  assert.equal(searchActions(hub).length, 1);
  const stop = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stop.stop_sent, false);
  assert.equal(searchActions(hub).length, 1);
});

// An agent whose messages reach the owner only after its turn ends starts
// the search, ends the turn and reads it when the owner replies, after the
// network has closed: the device that joined meanwhile is still reported.
test("a device that joined while nobody read the search is reported after it ended", async (t) => {
  const { client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500, pairing: [leakSensor()] }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  const report = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  assert.equal(report.status, "ended");
  assert.equal(report.ended, "expired");
  assert.equal(report.result, "joined");
  assert.equal(report.new_devices[0].ref, sensorChildRef);
  assert.equal(report.new_devices[0].accessories[0].ref, sensorRef);
});

// A client that starts the MCP server anew each turn (Claude Code -p
// --resume, chat bot gateways): the agent starts the search and ends its
// turn with the owner's step; the sensor joins while no server runs; the
// owner's reply reaches a new server process.
test("a search survives an MCP server restart between its start and the owner's reply", async (t) => {
  const { hub, client, connect } = await setup(
    t,
    await apartment({ pairing: [leakSensor({ joinAfterMs: 1_500 })] }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(started.status, "started");
  await client.close();
  await accessoryCreated(hub, 200);

  const nextTurn = await connect();
  const report = await call(nextTurn, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  assert.equal(report.status, "searching");
  assert.equal(report.result, "joined");
  assert.equal(report.ends_at, started.ends_at);
  assert.deepEqual(
    report.new_devices.map(({ ref, accessories }) => ({
      ref,
      accessories: accessories.map(({ ref: accessory }) => accessory),
    })),
    [{ ref: sensorChildRef, accessories: [sensorRef] }],
  );

  // A start in the new process returns the same search without a resend,
  // and its stop closes the network.
  const again = await call(nextTurn, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(again.status, "already_running");
  assert.equal(again.search_ref, started.search_ref);
  assert.equal(again.devices_before, started.devices_before);
  const stopped = await call(nextTurn, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stopped.stop_sent, true);
  assert.equal(stopped.ended, "stopped");
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: false },
  ]);
});

// Two starts of one controller at once (two agent turns, a retry beside
// the first call) open the network once: a second start would restart the
// hub's timer (P3).
test("two starts at once send one start", async (t) => {
  const { hub, client } = await setup(t, await apartment());
  const starts = await Promise.all([
    call(client, "start_device_search", { extension_ref: zigbeeRef }),
    call(client, "start_device_search", { extension_ref: zigbeeRef }),
  ]);
  assert.deepEqual(starts.map(({ status }) => status).sort(), [
    "already_running",
    "started",
  ]);
  assert.equal(starts[0].search_ref, starts[1].search_ref);
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
  ]);
});

// The network closed by its timer while nobody read the search: a stop
// sends nothing, since a stop of a search that does not run would act on
// whatever the controller does next.
test("a stop after the search ended unseen sends nothing", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  const stopped = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stopped.stop_sent, false);
  assert.equal(stopped.active, false);
  assert.equal(stopped.ended, "expired");
  assert.equal(searchActions(hub).length, 1);
});

// The agent's search ended while nobody read it, then the owner started
// another in the SprutHub app. The old watch is over: its stop must not
// close the owner's network, its answer must say that the network is still
// open by that later search, and a new start watches the owner's run under
// a new ref with its own stop.
test("a watch whose search ended unseen does not act on a search started later in the app", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  const ours = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  // The owner's run lasts the usual minute.
  hub.state.discoveryTimeMs = 60_000;
  startNatively(hub);
  const running = () =>
    hub.state.extensions
      .find(({ extensionKey }) => extensionKey === ZIGBEE)
      .spaces[0].actions.find(({ id }) => id === 1).state;
  const startAgain = {
    tool: "start_device_search",
    arguments: { extension_ref: zigbeeRef },
  };

  const stale = await call(client, "stop_device_search", {
    search_ref: ours.search_ref,
  });
  assert.equal(stale.stop_sent, false);
  assert.equal(stale.active, false);
  assert.equal(stale.ended, "expired");
  assert.equal(stale.later_search.active, true);
  assert(stale.later_search.seconds_left > 50, stale);
  assert.equal(typeof stale.hints.search, "string");
  assert.deepEqual(stale.next, startAgain);
  assert.equal(stale.stop, undefined);
  assert.equal(running(), true);

  const owners = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(owners.status, "already_running");
  assert.notEqual(owners.search_ref, ours.search_ref);
  assert.equal(owners.active, true);
  assert(owners.seconds_left > 50, owners);
  assert.deepEqual(owners.stop, {
    tool: "stop_device_search",
    arguments: { search_ref: owners.search_ref },
  });
  const old = await call(client, "get_device_search", {
    search_ref: ours.search_ref,
    wait_seconds: 0,
  });
  assert.equal(old.ended, "expired");
  assert.equal(old.active, false);
  assert.equal(old.later_search.active, true);
  assert.deepEqual(old.next, startAgain);
  assert.equal(searchActions(hub).length, 1);
  assert.equal(running(), true);
});

// The same, with the agent's next start before any read of the old ref: the
// start sees that the old watch's search has ended and watches the owner's
// run under a new ref instead of returning the old one, whose stop would
// close the owner's network.
test("a start after a watch's search ended unseen watches the search started later in the app", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  const ours = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  hub.state.discoveryTimeMs = 60_000;
  startNatively(hub);

  const owners = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(owners.status, "already_running");
  assert.notEqual(owners.search_ref, ours.search_ref);
  assert.equal(owners.active, true);
  assert(owners.seconds_left > 50, owners);

  const old = await call(client, "stop_device_search", {
    search_ref: ours.search_ref,
  });
  assert.equal(old.stop_sent, false);
  assert.equal(old.ended, "expired");
  assert.equal(old.later_search.active, true);
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
  ]);
  assert.equal(
    hub.state.extensions
      .find(({ extensionKey }) => extensionKey === ZIGBEE)
      .spaces[0].actions.find(({ id }) => id === 1).state,
    true,
  );
});

// A watch of a search that already ran does not count devices that joined
// before it, and a device paired again keeps its entry and shows only
// among changed devices: the end with nothing new must not say that no
// device joined.
test("a search that ends with nothing new says what it did not count", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  startNatively(hub);
  const watched = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(watched.status, "already_running");
  const lamp = hub.state.accessories.find(
    ({ extensionKey, online }) => extensionKey === ZIGBEE && online !== false,
  );
  lamp.online = false;

  const ended = await waitForResult(client, watched.search_ref, [
    "no_new_device",
  ]);
  assert.deepEqual(ended.new_devices, []);
  assert.equal(ended.changed_devices.length, 1);
  assert.match(ended.hints.search, /joined before/);
  assert.match(ended.hints.search, /changed_devices/);
  assert.deepEqual(searchActions(hub), []);
});

// A device the hub cannot add joins and gets an error instead of an
// accessory. It is reported failed as soon as the hub shows the error,
// with the hub's status and error, and the agent is told to say so.
test("a new device the hub shows an error for is reported failed", async (t) => {
  const { client } = await setup(
    t,
    await apartment({
      discoveryTimeMs: 2_500,
      pairing: [leakSensor({ error: "Модель не поддерживается" })],
    }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  const read = {
    tool: "get_device_search",
    arguments: { search_ref: started.search_ref },
  };

  const failed = await waitForResult(
    client,
    started.search_ref,
    ["failed"],
    5,
    6,
  );
  assert.equal(failed.status, "searching");
  assert.deepEqual(
    failed.new_devices.map(
      ({ ref, status, progress, error, accessory_status, accessories }) => ({
        ref,
        status,
        progress,
        error,
        accessory_status,
        accessories,
      }),
    ),
    [
      {
        ref: sensorChildRef,
        status: "Ошибка подключения",
        progress: null,
        error: "Модель не поддерживается",
        accessory_status: "failed",
        accessories: [],
      },
    ],
  );
  assert.deepEqual(Object.keys(failed.hints), ["failed"]);
  assert.deepEqual(failed.next, read);
  assert.deepEqual(failed.stop, {
    tool: "stop_device_search",
    arguments: { search_ref: started.search_ref },
  });

  let ended = failed;
  for (let attempt = 0; attempt < 4 && ended.status !== "ended"; attempt += 1) {
    ended = await call(client, "get_device_search", {
      search_ref: started.search_ref,
      wait_seconds: 5,
    });
  }
  assert.equal(ended.status, "ended");
  assert.equal(ended.result, "failed");
  assert.deepEqual(Object.keys(ended.hints), ["failed"]);
  assert.equal(ended.next, null);
  assert.equal(ended.stop, undefined);
});

// A device whose interview outlasts the search: the hub shows it joining
// (status and progress, no error) after the network closed. The report
// keeps it pending with no time limit of its own, here also after the
// server's clock moves 5 minutes on, and keeps offering to read again.
test("a device the hub is still adding after the search ended stays pending", async (t) => {
  const { client, shiftClock } = await setup(
    t,
    await apartment({
      discoveryTimeMs: 1_500,
      pairing: [leakSensor({ interviewMs: 120_000 })],
    }),
    { shiftedClock: true },
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  const read = {
    tool: "get_device_search",
    arguments: { search_ref: started.search_ref },
  };
  const pending = (report) =>
    report.new_devices.map(
      ({ ref, status, progress, error, accessory_status }) => ({
        ref,
        status,
        progress,
        error,
        accessory_status,
      }),
    );
  const joining = [
    {
      ref: sensorChildRef,
      status: "Подключение",
      progress: 10,
      error: null,
      accessory_status: "pending",
    },
  ];

  let report;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    report = await call(client, "get_device_search", {
      search_ref: started.search_ref,
      wait_seconds: 5,
    });
    if (report.status === "ended") break;
  }
  assert.equal(report.status, "ended");
  assert.equal(report.result, "joining");
  assert.deepEqual(pending(report), joining);
  assert.deepEqual(report.next, read);

  await shiftClock();
  const later = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  assert.equal(later.status, "ended");
  assert.equal(later.result, "joining");
  assert.deepEqual(pending(later), joining);
  assert.deepEqual(Object.keys(later.hints), ["pending"]);
  assert.deepEqual(later.next, read);
  assert.equal(later.stop, undefined);
});

// Two devices join one search: the hub adds one and shows an error for the
// other. The report says a device joined and tells the agent what to do
// for each: place the one found, tell the owner about the one that failed.
test("new devices with different outcomes are each reported with their own hint", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({
      pairing: [
        leakSensor(),
        {
          extensionKey: ZIGBEE,
          joinAfterMs: 300,
          interviewMs: 300,
          childName: "TS0601",
          error: "Модель не поддерживается",
          accessory: { id: 201, name: "TS0601", deviceId: "a4c138d0deadbeef" },
        },
      ],
    }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await accessoryCreated(hub, 200);
  const outcomes = (report) =>
    Object.fromEntries(
      report.new_devices.map(({ ref, accessory_status }) => [
        ref,
        accessory_status,
      ]),
    );
  const expected = {
    [sensorChildRef]: "found",
    [`${zigbeeRef}/child/a4c138d0deadbeef`]: "failed",
  };

  let running;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    running = await call(client, "get_device_search", {
      search_ref: started.search_ref,
      wait_seconds: 2,
    });
    if (Object.values(outcomes(running)).includes("failed")) break;
  }
  assert.deepEqual(outcomes(running), expected);
  assert.equal(running.result, "joined");
  assert.deepEqual(Object.keys(running.hints).sort(), ["failed", "found"]);
  assert.deepEqual(running.next, {
    tool: "get_device_search",
    arguments: { search_ref: started.search_ref },
  });

  const stopped = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stopped.ended, "stopped");
  assert.deepEqual(outcomes(stopped), expected);
  assert.equal(stopped.result, "joined");
  assert.deepEqual(Object.keys(stopped.hints).sort(), ["failed", "found"]);
  assert.equal(stopped.next, null);
});

// The hub may add a device just after it closes the network, when the
// watch has already said nothing joined (a join accepted before the end;
// not observed). The search's own ref still reports it.
test("a device the hub adds after the search ended shows on that search", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  const first = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  const nothing = await waitForResult(client, first.search_ref, [
    "no_new_device",
  ]);
  assert.deepEqual(nothing.next, {
    tool: "start_device_search",
    arguments: { extension_ref: zigbeeRef },
  });
  hub.joinNow(leakSensor({ joinAfterMs: 0, interviewMs: 100 }));
  await accessoryCreated(hub, 200);

  const late = await call(client, "get_device_search", {
    search_ref: first.search_ref,
    wait_seconds: 0,
  });
  assert.equal(late.status, "ended");
  assert.equal(late.result, "joined");
  assert.deepEqual(
    late.new_devices.map(({ ref, accessories }) => ({
      ref,
      accessories: accessories.map(({ ref: accessory }) => accessory),
    })),
    [{ ref: sensorChildRef, accessories: [sensorRef] }],
  );
  assert.equal(searchActions(hub).length, 1);
});

// The owner pairs a device in the SprutHub app after the agent's search
// ended with nothing new. A later search counts from its own start: the
// owner's device is not reported as joined, so the agent does not move or
// rename it.
test("a device the owner pairs in the app after a search found nothing is not new to the next search", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ discoveryTimeMs: 1_500 }),
  );
  const first = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await waitForResult(client, first.search_ref, ["no_new_device"]);

  hub.state.pairing.push(leakSensor({ joinAfterMs: 0, interviewMs: 100 }));
  startNatively(hub);
  await accessoryCreated(hub, 200);
  startNatively(hub, false);

  const next = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(next.status, "started");
  assert.equal(next.devices_before, first.devices_before + 1);
  const report = await call(client, "get_device_search", {
    search_ref: next.search_ref,
    wait_seconds: 0,
  });
  assert.equal(report.result, "waiting");
  assert.deepEqual(report.new_devices, []);
});

test("a search is refused for a controller that cannot search, a stopped one and the ZLL search", async (t) => {
  const fixture = await apartment();
  const zigbee = fixture.extensions.find(
    ({ extensionKey }) => extensionKey === ZIGBEE,
  );
  fixture.extensions.push({
    ...structuredClone(zigbee),
    extensionKey: "Controller:zigbee_2",
    index: "zigbee_2",
    name: "ZigBee 2",
    optionsWindow: "Controller/zigbee_2/",
    mainWindow: "Controller/zigbee_2/main",
    state: "FAILED",
  });
  const { hub, client } = await setup(t, fixture);

  const refusals = [
    [{ extension_ref: telegramRef }, "not_a_controller"],
    [{ extension_ref: tionRef }, "no_device_search"],
    [
      {
        extension_ref: `${home}/extension/${encodeURIComponent("Controller:zigbee_2")}`,
      },
      "not_loaded",
    ],
    [
      { extension_ref: zigbeeRef, space_key: "discovery" },
      "nearby_search_not_supported",
    ],
  ];
  for (const [args, reason] of refusals) {
    const refused = await toolError(client, "start_device_search", args);
    assert.equal(refused.error.code, "device_search_unavailable", reason);
    assert.equal(refused.reason, reason);
    assert.deepEqual(refused.next, {
      tool: "get_entity",
      arguments: { entity_ref: args.extension_ref },
    });
  }
  const room = await toolError(client, "start_device_search", {
    extension_ref: `${home}/room/${BATHROOM}`,
  });
  assert.equal(room.error.code, "invalid_entity_ref");
  assert.deepEqual(searchActions(hub), []);
});

test("a start the hub refuses is a rejection with nothing started", async (t) => {
  const { hub, client } = await setup(t, await apartment());
  hub.refuseNext("extension.action", {
    code: -32603,
    message: "Controller is busy",
  });

  const refused = await toolError(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(refused.error.code, "request_rejected");
  assert.equal(refused.hub_effect, "not_applied");
  assert.equal(refused.rejection.hub_message, "Controller is busy");
  assert.deepEqual(refused.next, {
    tool: "get_entity",
    arguments: { entity_ref: zigbeeRef },
  });
  assert.equal(searchActions(hub).length, 1);

  // The next start is an ordinary start, not a watch of the refused one.
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(started.status, "started");
  assert.equal(searchActions(hub).length, 2);
});

// The watch is written before the start is sent: a search the state
// directory cannot keep would be lost to the owner's reply in the next
// turn, so the network is not opened and the agent learns how to fix it.
test("a start whose watch cannot be saved opens no network and says how to fix the state directory", async (t) => {
  const { hub, client, stateDirectory } = await setup(t, await apartment());
  t.after(() => chmod(stateDirectory, 0o700).catch(() => {}));
  await chmod(stateDirectory, 0o555);

  const refused = await toolError(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(refused.error.code, "state_storage_unavailable");
  assert.equal(refused.error.action, "restore_state_storage_then_retry");
  assert.match(refused.error.message, /SPRUT_AGENT_STATE_DIR/);
  assert(!JSON.stringify(refused).includes(stateDirectory), refused);
  assert.deepEqual(searchActions(hub), []);

  // Once the directory can be written, the same start opens the network.
  await chmod(stateDirectory, 0o700);
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(started.status, "started");
  assert.equal(searchActions(hub).length, 1);
});

test("a start whose reply is lost is unknown with the search state read back", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ pairing: [leakSensor({ joinAfterMs: 2_500 })] }),
    { faults: { droppedReply: [{ method: "extension.action" }] } },
  );

  const unknown = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.active, true);
  assert.match(unknown.ends_at, /\+03:00$/);
  assert.equal(typeof unknown.search_ref, "string");
  assert.deepEqual(unknown.next, {
    tool: "get_device_search",
    arguments: { search_ref: unknown.search_ref },
  });
  assert.equal(searchActions(hub).length, 1);

  // The search goes on and its new device is still reported.
  const joined = await waitForResult(client, unknown.search_ref, ["joined"]);
  assert.equal(joined.new_devices[0].accessories[0].ref, sensorRef);
  assert.equal(searchActions(hub).length, 1);
});

// A read of one new device that the hub does not answer or refuses leaves
// that device unreadable, not the whole report: the search state, the
// stop and the device itself still reach the agent.
test("a new device whose reads fail is reported unreadable beside the search state", async (t) => {
  const { hub, client } = await setup(
    t,
    await apartment({ pairing: [leakSensor()] }),
  );
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await accessoryCreated(hub, 200);
  const readChild = {
    tool: "get_entity",
    arguments: { entity_ref: sensorChildRef },
  };

  // The window that links the device's accessory is not answered in time.
  hub.delayReplies("window.get", 5_000);
  const silent = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  hub.delayReplies("window.get", 0);
  assert.equal(silent.status, "searching");
  assert.equal(silent.active, true);
  assert.equal(silent.ends_at, started.ends_at);
  assert.notEqual(silent.result, "joined");
  assert.deepEqual(
    silent.new_devices.map(({ ref, accessory_status, accessories, next }) => ({
      ref,
      accessory_status,
      accessories,
      next,
    })),
    [
      {
        ref: sensorChildRef,
        accessory_status: "unreadable",
        accessories: [],
        next: readChild,
      },
    ],
  );

  // The hub refuses the accessory read after the stop: the network is
  // closed and said so, the device still listed.
  hub.refuseNext("accessory.get", { code: -32000, message: "Busy" });
  const stopped = await call(client, "stop_device_search", {
    search_ref: started.search_ref,
  });
  assert.equal(stopped.stop_sent, true);
  assert.equal(stopped.active, false);
  assert.equal(stopped.ended, "stopped");
  assert.notEqual(stopped.result, "joined");
  assert.equal(stopped.new_devices[0].accessory_status, "unreadable");
  assert.deepEqual(stopped.new_devices[0].next, readChild);

  // The hub answers the accessory in a form this client cannot read (here
  // without its online flag): that device is unreadable, the report stands.
  const sensor = hub.state.accessories.find(({ id }) => id === 200);
  delete sensor.online;
  const garbled = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  sensor.online = true;
  assert.equal(garbled.status, "ended");
  assert.equal(garbled.ended, "stopped");
  assert.equal(garbled.result, "unreadable");
  assert.deepEqual(
    garbled.new_devices.map(({ ref, accessory_status, read_error, next }) => ({
      ref,
      accessory_status,
      read_error,
      next,
    })),
    [
      {
        ref: sensorChildRef,
        accessory_status: "unreadable",
        read_error: "incompatible_response",
        next: readChild,
      },
    ],
  );
  assert.deepEqual(Object.keys(garbled.hints), ["unreadable"]);
  assert.deepEqual(garbled.next, {
    tool: "get_device_search",
    arguments: { search_ref: started.search_ref },
  });

  // Read again, the device shows its accessory.
  const joined = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 0,
  });
  assert.equal(joined.result, "joined");
  assert.equal(joined.new_devices[0].accessories[0].ref, sensorRef);
  assert.deepEqual(searchActions(hub), [
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: true },
    { extensionKey: ZIGBEE, spaceKey: "main", actionId: 1, state: false },
  ]);
});

test("devices of another controller are neither reported nor touched", async (t) => {
  const { hub, client } = await setup(t, await apartment());
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });

  // During the search the Tion controller gets a new breather and its
  // existing one goes offline.
  const tion = hub.state.accessories.find(
    ({ extensionKey }) => extensionKey === "Controller:tion",
  );
  tion.online = false;
  hub.state.accessories.push({
    ...structuredClone(tion),
    id: 300,
    name: "Новый бризер",
    deviceId: "tion-new",
    online: true,
  });

  const report = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 2,
  });
  assert.equal(report.result, "waiting");
  assert.deepEqual(report.new_devices, []);
  assert.deepEqual(report.changed_devices, []);
  assert.equal(JSON.stringify(report).includes("tion"), false);
  assert.deepEqual(
    [
      ...new Set(
        hub.requests
          .filter(({ method }) => method === "extensionChild.list")
          .map(({ params }) => params.extensionChild.list.extensionKey),
      ),
    ],
    [ZIGBEE],
  );
  assert.deepEqual(
    searchActions(hub).map(({ extensionKey }) => extensionKey),
    [ZIGBEE],
  );
});

test("an existing device of the controller that changes during the search is reported apart from new ones", async (t) => {
  const { hub, client } = await setup(t, await apartment());
  const started = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  const lamp = hub.state.accessories.find(
    ({ extensionKey, online }) => extensionKey === ZIGBEE && online !== false,
  );
  lamp.online = false;

  const report = await call(client, "get_device_search", {
    search_ref: started.search_ref,
    wait_seconds: 5,
  });
  assert.equal(report.result, "waiting");
  assert.deepEqual(report.new_devices, []);
  assert.deepEqual(report.changed_devices, [
    {
      ref: `${zigbeeRef}/child/${lamp.deviceId}`,
      space_key: "main",
      name: lamp.name,
      online: false,
      status: null,
      progress: null,
      error: null,
      changed: ["online"],
    },
  ]);
});

test("search answers stay the same size in a home with many devices on the controller", async (t) => {
  const sizes = {};
  for (const [label, fixture] of [
    ["apartment", await apartment({ pairing: [leakSensor()] })],
    [
      "scaled",
      {
        ...scaledHome(await loadHomeFixture("apartment"), 400),
        pairing: [leakSensor()],
      },
    ],
  ]) {
    const { hub, client } = await setup(t, fixture);
    const start = await callBytes(client, "start_device_search", {
      extension_ref: `spruthub://hub/${hub.serial}/extension/${encodeURIComponent(ZIGBEE)}`,
    });
    let report;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      report = await callBytes(client, "get_device_search", {
        search_ref: start.body.search_ref,
        wait_seconds: 10,
      });
      if (report.body.result === "joined") break;
    }
    assert.equal(report.body.result, "joined");
    const entity = await callBytes(client, "get_entity", {
      entity_ref: `spruthub://hub/${hub.serial}/extension/${encodeURIComponent(ZIGBEE)}`,
    });
    sizes[label] = {
      children: zigbeeChildren(hub),
      start: start.bytes,
      report: report.bytes,
      entity: entity.bytes,
      accessoryLists: hub.requests.filter(
        ({ method }) => method === "accessory.list",
      ).length,
    };
  }
  assert(sizes.scaled.children > 10 * sizes.apartment.children, sizes);
  for (const part of ["start", "report", "entity"]) {
    // Only the serial in refs differs between the two homes.
    assert(
      Math.abs(sizes.scaled[part] - sizes.apartment[part]) < 200,
      `${part}: ${JSON.stringify(sizes)}`,
    );
  }
  // Waiting for a new device never reads the whole home.
  assert.equal(sizes.scaled.accessoryLists, 0, JSON.stringify(sizes));
});

test("an unknown search ref points at the controller to read again", async (t) => {
  const { client } = await setup(t, await apartment());
  const missing = `${zigbeeRef}/device_search/00000000-0000-4000-8000-000000000000`;
  for (const name of ["get_device_search", "stop_device_search"]) {
    const unknown = await toolError(client, name, { search_ref: missing });
    assert.equal(unknown.error.code, "device_search_not_found");
    assert.deepEqual(unknown.next, {
      tool: "get_entity",
      arguments: { entity_ref: zigbeeRef },
    });
  }
});

// Watches are kept in the state directory only for a few days: a new
// search removes those not written for 3 days, and their refs are then
// unknown.
test("a search not touched for days is removed when a new one starts", async (t) => {
  const { client, stateDirectory } = await setup(t, await apartment());
  const old = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  await call(client, "stop_device_search", { search_ref: old.search_ref });
  const watches = path.join(
    stateDirectory,
    (await readdir(stateDirectory)).find((name) =>
      name.startsWith("device-searches-"),
    ),
  );
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60_000);
  for (const name of await readdir(watches)) {
    await utimes(path.join(watches, name), fourDaysAgo, fourDaysAgo);
  }

  const fresh = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(fresh.status, "started");
  assert.equal((await readdir(watches)).length, 1);
  const unknown = await toolError(client, "get_device_search", {
    search_ref: old.search_ref,
  });
  assert.equal(unknown.error.code, "device_search_not_found");
  const kept = await call(client, "get_device_search", {
    search_ref: fresh.search_ref,
    wait_seconds: 0,
  });
  assert.equal(kept.active, true);
});
