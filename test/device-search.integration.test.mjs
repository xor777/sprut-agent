import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

async function setup(t, fixture, hubOptions = {}) {
  const hub = await startSimulatedHub(fixture, hubOptions);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-device-search-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "device-search-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
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
// close the owner's network, and a new start watches the owner's run
// under a new ref.
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

  const stale = await call(client, "stop_device_search", {
    search_ref: ours.search_ref,
  });
  assert.equal(stale.stop_sent, false);
  assert.equal(stale.active, false);
  assert.equal(stale.ended, "expired");
  assert.equal(running(), true);

  const owners = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(owners.status, "already_running");
  assert.notEqual(owners.search_ref, ours.search_ref);
  assert.equal(owners.active, true);
  assert(owners.seconds_left > 50, owners);
  const old = await call(client, "get_device_search", {
    search_ref: ours.search_ref,
    wait_seconds: 0,
  });
  assert.equal(old.ended, "expired");
  assert.equal(old.active, false);
  assert.equal(searchActions(hub).length, 1);
  assert.equal(running(), true);
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
  assert.match(ended.hint, /joined before/);
  assert.match(ended.hint, /changed_devices/);
  assert.deepEqual(searchActions(hub), []);
});

// A device the hub cannot add joins and never gets an accessory. Right
// after the end the hub may still finish it, so the report asks to read
// again; once the hub has had its time, the report says the device was not
// added, with its status and error, and stops asking to wait.
test("a new device that gets no accessory is reported not added some time after the search ends", async (t) => {
  const { client } = await setup(
    t,
    await apartment({
      discoveryTimeMs: 1_500,
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
  assert.deepEqual(report.next, read);

  const begun = Date.now();
  const notAdded = await waitForResult(
    client,
    started.search_ref,
    ["not_added"],
    20,
    3,
  );
  assert(Date.now() - begun < 30_000, "the outcome comes without the agent");
  assert.equal(notAdded.status, "ended");
  assert.equal(notAdded.ended, "expired");
  assert.deepEqual(
    notAdded.new_devices.map(
      ({ ref, status, error, accessory_status, accessories }) => ({
        ref,
        status,
        error,
        accessory_status,
        accessories,
      }),
    ),
    [
      {
        ref: sensorChildRef,
        status: "Ошибка подключения",
        error: "Модель не поддерживается",
        accessory_status: "pending",
        accessories: [],
      },
    ],
  );
  assert.equal(notAdded.next, null);
  assert.equal(notAdded.stop, undefined);
  assert.equal(typeof notAdded.hint, "string");
});

// The hub may add a device just after it closes the network, when the
// watch has already said nothing joined. The restart that answer offers
// keeps counting from the earlier start, so that device is reported rather
// than taken for one that was there before.
test("a restart after a search that listed nothing reports a device the hub added after its end", async (t) => {
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

  const again = await call(client, "start_device_search", {
    extension_ref: zigbeeRef,
  });
  assert.equal(again.status, "started");
  assert.notEqual(again.search_ref, first.search_ref);
  assert.equal(again.devices_before, first.devices_before);
  const report = await call(client, "get_device_search", {
    search_ref: again.search_ref,
    wait_seconds: 0,
  });
  assert.equal(report.result, "joined");
  assert.deepEqual(
    report.new_devices.map(({ ref, accessories }) => ({
      ref,
      accessories: accessories.map(({ ref: accessory }) => accessory),
    })),
    [{ ref: sensorChildRef, accessories: [sensorRef] }],
  );
  assert.equal(searchActions(hub).length, 2);
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
