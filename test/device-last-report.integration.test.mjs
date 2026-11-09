import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { collectEvidence, startCaseHub } from "../research/eval-agent.mjs";
import { CASES, gradeCase } from "../research/eval-agent-cases.mjs";
import { LABELS } from "../research/eval-judge-labels.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Когда последний раз срабатывал датчик движения?», «почему вчера вечером
// выключился свет в гостиной?»: accessory.get gives lastUpdate, the last
// report the hub got from the device, and accessory.list does not
// (research/protocol/2026-11-07-history-app.md). So reading it costs one
// accessory.get per device, only when the agent asks.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const accessory = (id) => `${homeRef}/accessory/${id}`;
const LIVING_ROOM = `${homeRef}/room/3`;
const HALLWAY = `${homeRef}/room/1`;
// The living room's devices.
const CHANDELIER = 15;
const FLOOR_LAMP = 16;
const LED_STRIP = 17;
const CURTAINS = 18;
const AIR_CONDITIONER = 19;
const TV_SOCKET = 20;

const at = (text) => Date.parse(text);
// Three lamps went within four seconds of each other, a device reported
// alone a minute before, another much later.
const LIVING_ROOM_REPORTS = {
  [CHANDELIER]: at("2026-11-06T21:47:03.120+03:00"),
  [FLOOR_LAMP]: at("2026-11-06T21:47:03.480+03:00"),
  [LED_STRIP]: at("2026-11-06T21:47:06.900+03:00"),
  [CURTAINS]: at("2026-11-06T21:46:02.000+03:00"),
  [AIR_CONDITIONER]: at("2026-11-07T09:12:00.000+03:00"),
  [TV_SOCKET]: at("2026-10-01T08:00:00.000+03:00"),
};

async function startHub(t, adjust = () => {}) {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  for (const device of fixture.accessories) {
    if (device.id in LIVING_ROOM_REPORTS) {
      device.lastUpdate = LIVING_ROOM_REPORTS[device.id];
    }
  }
  adjust(fixture);
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-last-report-"),
  );
  t.after(async () => {
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function startClient(t, { hub, stateDirectory }, timeoutMs = 3000) {
  const client = new Client({ name: "last-report-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    }),
  );
  t.after(() => client.close());
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function deviceReads(hub, from = 0) {
  return hub.requests.slice(from).filter(({ method }) => {
    return method === "accessory.get";
  });
}

const refOf = ({ ref }) => ref;

test("the simulated hub gives lastUpdate in accessory.get only, as the owner's hub does", async (t) => {
  const { hub } = await startHub(t);
  const device = hub.request({ accessory: { get: { id: CHANDELIER } } }).result
    .accessory.get;
  assert.equal(device.lastUpdate, LIVING_ROOM_REPORTS[CHANDELIER]);
  for (const expand of [undefined, "services,characteristics"]) {
    const listed = hub.request({
      accessory: { list: expand ? { expand } : {} },
    }).result.accessory.list.accessories;
    assert.equal(
      listed.filter((item) => Object.hasOwn(item, "lastUpdate")).length,
      0,
    );
  }
});

test("get_entity on a device shows its last report on the hub's clock", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);

  const { entity } = await call(client, "get_entity", {
    entity_ref: accessory(CHANDELIER),
  });

  assert.equal(entity.last_report_at, "2026-11-06T21:47:03.120+03:00");
  assert.equal(entity.time_zone, "Europe/Moscow");
  assert.equal(entity.last_report_status, undefined);
  // The raw number does not sit beside it for the agent to convert.
  assert.equal(JSON.stringify(entity).includes("lastUpdate"), false);
});

test("get_entity keeps the hub's time zone away from a time it cannot read, and says the time is UTC", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  home.hub.refuseNext("window.get", { code: -32000, message: "busy" });

  const { entity } = await call(client, "get_entity", {
    entity_ref: accessory(CHANDELIER),
  });

  assert.equal(entity.last_report_at, "2026-11-06T18:47:03.120Z");
  assert.equal(entity.time_zone, null);
  assert.match(entity.last_report_note, /\bUTC\b/);
});

for (const [label, lastUpdate] of [
  ["missing", null],
  ["zero", 0],
  ["a few seconds after 1970", 5_000],
  ["negative", -1],
  ["not a number", "2026-11-06"],
  ["far future", Date.UTC(2099, 0, 1)],
  ["microseconds instead of milliseconds", 1_793_000_000_000_000],
  ["beyond any date", 9e15],
  ["two days ahead", Date.now() + 2 * 86_400_000],
]) {
  test(`get_entity shows a ${label} lastUpdate as unknown, not as a date`, async (t) => {
    const home = await startHub(t, (fixture) => {
      fixture.accessories.find(({ id }) => id === CHANDELIER).lastUpdate =
        lastUpdate;
    });
    const client = await startClient(t, home);

    const { entity } = await call(client, "get_entity", {
      entity_ref: accessory(CHANDELIER),
    });

    assert.equal(entity.last_report_at, null);
    assert.equal(entity.last_report_status, "unknown");
    assert.doesNotMatch(JSON.stringify(entity), /19[67]\d-/);
    // No zone is needed for a time that is not there.
    assert.equal(
      home.hub.requests.filter(({ method }) => method === "window.get").length,
      0,
    );

    // find_devices treats it the same: not a time, not read, not sorted in.
    const page = await call(client, "find_devices", {
      room_ref: LIVING_ROOM,
      last_report: true,
    });
    assert.deepEqual(page.devices.at(-1).ref, accessory(CHANDELIER));
    assert.equal(page.devices.at(-1).last_report_at, null);
    assert.equal(page.devices.at(-1).last_report_status, "unknown");
    assert.equal(page.reads.unknown, 1);
    assert.equal(page.reads.read, 5);
    assert.equal(page.devices[0].ref, accessory(AIR_CONDITIONER));
  });
}

test("a last report within a day ahead of this machine's clock stays a time: the hub's clock may run ahead", async (t) => {
  const ahead = Date.now() + 3_600_000;
  const home = await startHub(t, (fixture) => {
    fixture.accessories.find(({ id }) => id === CHANDELIER).lastUpdate = ahead;
  });
  const client = await startClient(t, home);

  const { entity } = await call(client, "get_entity", {
    entity_ref: accessory(CHANDELIER),
  });

  assert.equal(entity.last_report_status, undefined);
  assert.equal(Date.parse(entity.last_report_at), ahead);
});

test("a plain find_devices reads no device one by one", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});

  const before = home.hub.requests.length;
  for (const args of [
    {},
    { room_ref: LIVING_ROOM },
    { kind: "light" },
    { query: "торшер", values: false },
    { state: "on" },
  ]) {
    const page = await call(client, "find_devices", args);
    assert.doesNotMatch(JSON.stringify(page), /last_report/);
  }
  assert.deepEqual(deviceReads(home.hub, before), []);
  assert.deepEqual(
    home.hub.requests.slice(before).filter(({ method }) => {
      return method === "window.get";
    }),
    [],
  );
});

test("find_devices with last_report shows a room's devices newest first, one read each", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  const before = home.hub.requests.length;

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });

  assert.equal(page.time_zone, "Europe/Moscow");
  assert.equal(page.next, null);
  assert.deepEqual(
    page.devices.map(({ name, room, last_report_at }) => [
      name,
      room,
      last_report_at,
    ]),
    [
      ["Кондиционер", "Гостиная", "2026-11-07T09:12:00.000+03:00"],
      ["Светодиодная лента", "Гостиная", "2026-11-06T21:47:06.900+03:00"],
      ["Торшер", "Гостиная", "2026-11-06T21:47:03.480+03:00"],
      ["Люстра", "Гостиная", "2026-11-06T21:47:03.120+03:00"],
      ["Шторы в гостиной", "Гостиная", "2026-11-06T21:46:02.000+03:00"],
      ["Розетка телевизора", "Гостиная", "2026-10-01T08:00:00.000+03:00"],
    ],
  );
  assert.equal(page.devices[0].ref, accessory(AIR_CONDITIONER));
  assert.deepEqual(page.reads, {
    devices: 6,
    read: 6,
    unknown: 0,
    failed: 0,
    not_read: 0,
  });
  assert.deepEqual(
    deviceReads(home.hub, before)
      .map(({ params }) => params.accessory.get.id)
      .sort(),
    [15, 16, 17, 18, 19, 20],
  );
});

test("find_devices with last_report marks the devices that reported at about the same moment", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);

  const { devices } = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });

  const together = Object.fromEntries(
    devices.map(({ name, reported_together }) => [name, reported_together]),
  );
  // The three lamps within four seconds; the curtains a minute earlier and
  // the others hours away stand alone.
  assert.deepEqual(together, {
    Кондиционер: undefined,
    "Светодиодная лента": { group: 1, devices: 3 },
    Торшер: { group: 1, devices: 3 },
    Люстра: { group: 1, devices: 3 },
    "Шторы в гостиной": undefined,
    "Розетка телевизора": undefined,
  });
});

// The whole-home answer with these devices' last reports: each listed
// device's moment by id, those without one left out.
async function momentsOf(t, reports) {
  const home = await startHub(t, (fixture) => {
    for (const device of fixture.accessories) delete device.lastUpdate;
    for (const [id, time] of Object.entries(reports)) {
      fixture.accessories.find(
        (device) => device.id === Number(id),
      ).lastUpdate = at(time);
    }
  });
  const client = await startClient(t, home);
  const { devices } = await call(client, "find_devices", {
    last_report: true,
    limit: 100,
  });
  return Object.fromEntries(
    devices
      .filter(({ reported_together: moment }) => moment !== undefined)
      .map(({ ref, reported_together }) => [
        Number(ref.split("/").at(-1)),
        reported_together,
      ]),
  );
}

// One chandelier of the owner's hub, 07.11.2026: seven lamps within 5.6 s,
// the widest gap between neighbours 4.7 s.
test("the lamps of one chandelier with the owner's real spacing are one moment", async (t) => {
  const moment = { group: 1, devices: 7 };
  assert.deepEqual(
    await momentsOf(t, {
      15: "2026-11-06T22:06:05.350+03:00",
      16: "2026-11-06T22:06:05.124+03:00",
      17: "2026-11-06T22:06:04.997+03:00",
      22: "2026-11-06T22:06:04.997+03:00",
      26: "2026-11-06T22:06:04.413+03:00",
      30: "2026-11-06T22:05:59.755+03:00",
      32: "2026-11-06T22:05:59.753+03:00",
    }),
    {
      15: moment,
      16: moment,
      17: moment,
      22: moment,
      26: moment,
      30: moment,
      32: moment,
    },
  );
});

test("a device just ahead of two lamps does not split them", async (t) => {
  const lamps = {
    [CHANDELIER]: "2026-11-06T21:47:03.001+03:00",
    [FLOOR_LAMP]: "2026-11-06T21:47:02.999+03:00",
  };
  const pair = { group: 1, devices: 2 };
  assert.deepEqual(
    await momentsOf(t, {
      ...lamps,
      [AIR_CONDITIONER]: "2026-11-06T21:47:08.100+03:00",
    }),
    { [CHANDELIER]: pair, [FLOOR_LAMP]: pair },
  );
  // Within reach of the nearer lamp it joins them, which the limitation warns
  // of; both lamps stay together.
  const three = { group: 1, devices: 3 };
  assert.deepEqual(
    await momentsOf(t, {
      ...lamps,
      [AIR_CONDITIONER]: "2026-11-06T21:47:08.000+03:00",
    }),
    { [AIR_CONDITIONER]: three, [CHANDELIER]: three, [FLOOR_LAMP]: three },
  );
});

test("devices 5 seconds apart are one moment, a millisecond more are two", async (t) => {
  const together = { group: 1, devices: 2 };
  assert.deepEqual(
    await momentsOf(t, {
      [CHANDELIER]: "2026-11-06T21:47:05.000+03:00",
      [FLOOR_LAMP]: "2026-11-06T21:47:00.000+03:00",
    }),
    { [CHANDELIER]: together, [FLOOR_LAMP]: together },
  );
  assert.deepEqual(
    await momentsOf(t, {
      [CHANDELIER]: "2026-11-06T21:47:05.001+03:00",
      [FLOOR_LAMP]: "2026-11-06T21:47:00.000+03:00",
    }),
    {},
  );
});

test("relations get their time before the hub's time zone is asked for", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  // A slow settings window and relations that need more than is left after
  // waiting for it.
  home.hub.delayReplies("window.get", 2_500);
  home.hub.delayReplies("scenario.list", 1_500);

  const { entity } = await call(client, "get_entity", {
    entity_ref: accessory(CHANDELIER),
    include: ["relations"],
  });

  assert.deepEqual(entity.include_resolution.unread ?? [], []);
  assert(entity.relations.scenario_roles.length > 0);
  // The zone did not come in time: the time stands as UTC and says so.
  assert.equal(entity.last_report_at, "2026-11-06T18:47:03.120Z");
  assert.match(entity.last_report_note, /\bUTC\b/);
});

test("find_devices with last_report keeps a device the hub gave no time for, and says so", async (t) => {
  const home = await startHub(t, (fixture) => {
    fixture.accessories.find(({ id }) => id === CURTAINS).lastUpdate = 0;
    fixture.accessories.find(({ id }) => id === TV_SOCKET).lastUpdate = null;
  });
  const client = await startClient(t, home);

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });

  assert.deepEqual(
    page.devices
      .slice(-2)
      .map(({ ref, last_report_at, last_report_status }) => [
        ref,
        last_report_at,
        last_report_status,
      ]),
    [
      [accessory(CURTAINS), null, "unknown"],
      [accessory(TV_SOCKET), null, "unknown"],
    ],
  );
  assert.equal(page.reads.unknown, 2);
  assert.equal(page.reads.read, 4);
});

test("a failed read of one device among several is reported, and the others still show their times", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  home.hub.refuseNext("accessory.get", { code: -32000, message: "busy" });

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });

  assert.equal(page.status, "ok");
  assert.equal(page.devices.length, 6);
  const failed = page.devices.filter(
    ({ last_report_status: status }) => status === "read_failed",
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].last_report_at, null);
  assert.equal(failed[0].ref, accessory(CHANDELIER));
  assert.equal(failed[0].read_error, "request_rejected");
  assert.deepEqual(failed[0].next, {
    tool: "get_entity",
    arguments: { entity_ref: failed[0].ref },
  });
  assert.equal(page.devices.at(-1).ref, failed[0].ref);
  assert.deepEqual(page.reads, {
    devices: 6,
    read: 5,
    unknown: 0,
    failed: 1,
    not_read: 0,
  });
  // Its repeat reads it.
  const again = await call(client, "get_entity", failed[0].next.arguments);
  assert.equal(again.entity.last_report_at, "2026-11-06T21:47:03.120+03:00");
});

test("a device the hub no longer has is reported, not left out", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  home.hub.refuseNext("accessory.get", { code: -32603, message: "not found" });

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });

  assert.equal(page.devices.length, 6);
  assert.equal(page.reads.failed, 1);
});

test("last_report pages stay in order within max_bytes and read the hub only for the first page", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  const whole = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });
  const started = home.hub.requests.length;

  const listed = [];
  let args = {
    room_ref: LIVING_ROOM,
    last_report: true,
    limit: 2,
    max_bytes: 2048,
  };
  let firstPageReads = null;
  for (let pages = 0; args; pages++) {
    assert(pages < 10, "the pages never end");
    const result = await client.callTool({
      name: "find_devices",
      arguments: args,
    });
    assert.equal(result.isError, undefined);
    assert(Buffer.byteLength(result.content[0].text) <= 2048);
    const page = result.structuredContent;
    assert.equal(page.max_bytes_exceeded, undefined);
    assert.equal(page.total, 6);
    listed.push(...page.devices);
    firstPageReads ??= deviceReads(home.hub, started).length;
    args = page.next?.arguments;
  }
  assert.equal(firstPageReads, 6);
  assert.equal(deviceReads(home.hub, started).length, 6);
  // Every device once, in the order of the whole answer; a group split by a
  // page still says how many devices it has.
  assert.deepEqual(listed, whole.devices);
});

test("a small max_bytes still holds a page of last reports and the rest follow", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);

  const listed = [];
  let args = { last_report: true, max_bytes: 2048 };
  for (let pages = 0; args; pages++) {
    assert(pages < 40, "the pages never end");
    const result = await client.callTool({
      name: "find_devices",
      arguments: args,
    });
    assert.equal(result.isError, undefined);
    assert(Buffer.byteLength(result.content[0].text) <= 2048);
    assert.equal(result.structuredContent.max_bytes_exceeded, undefined);
    listed.push(...result.structuredContent.devices.map(refOf));
    args = result.structuredContent.next?.arguments;
  }
  assert.equal(listed.length, new Set(listed).size);
  assert(listed.includes(accessory(CHANDELIER)));
  assert(listed.includes(`${homeRef}/accessory/11`));
});

test("whole-home last_report reads a bounded number of devices and names those it did not read", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("house"));
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-last-report-"),
  );
  t.after(async () => {
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const client = await startClient(t, { hub, stateDirectory }, 5000);

  const listed = [];
  let args = { last_report: true, limit: 100 };
  let reads;
  for (let pages = 0; args; pages++) {
    assert(pages < 20, "the pages never end");
    const page = await call(client, "find_devices", args);
    listed.push(...page.devices);
    reads = page.reads;
    args = page.next?.arguments;
  }

  assert.equal(deviceReads(hub).length, 100);
  assert.equal(listed.length, reads.devices);
  assert(reads.devices > 100, `${reads.devices} devices`);
  assert.equal(reads.read + reads.unknown, 100);
  assert.equal(reads.not_read, reads.devices - 100);
  const notRead = listed.filter(
    ({ last_report_status: status }) => status === "not_read",
  );
  assert.equal(notRead.length, reads.not_read);
  assert.equal(new Set(listed.map(refOf)).size, listed.length);
  // Unrelated devices of the simulator's default do not appear simultaneous.
  assert.deepEqual(
    listed.filter(({ reported_together: moment }) => moment !== undefined),
    [],
  );
  // Those read come first, those not read last.
  assert.equal(listed.at(-1).last_report_status, "not_read");
  assert.equal(listed[0].last_report_status, undefined);
});

test("a hub too slow for all the reads gets no more of them, and the answer says which were not read", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home, 300);
  await call(client, "home_overview", {});
  // 8 at a time, 200 ms each: only some rounds fit twice the timeout.
  home.hub.delayReplies("accessory.get", 200);
  const before = home.hub.requests.length;

  const page = await call(client, "find_devices", {
    last_report: true,
    limit: 100,
  });

  const read = deviceReads(home.hub, before).length;
  assert(read < page.total, `${read} reads of ${page.total}`);
  assert.equal(page.devices.length, page.total);
  assert.equal(page.reads.not_read, page.total - read);
  assert.equal(page.reads.read, read);
});

test("last_report with state lists and reads only the devices in that state", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  const before = home.hub.requests.length;

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    kind: "light",
    state: "on",
    last_report: true,
  });

  // The socket that is on stands beside the lamps, the strip that is off is
  // neither listed nor read.
  assert.deepEqual(page.devices.map(refOf).sort(), [
    accessory(CHANDELIER),
    accessory(FLOOR_LAMP),
    accessory(TV_SOCKET),
  ]);
  assert.equal(deviceReads(home.hub, before).length, 3);
});

test("last_report for lights also covers a room's relays and sockets, which may drive lamps", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    kind: "light",
    last_report: true,
  });

  assert(page.devices.map(refOf).includes(accessory(TV_SOCKET)));
  assert(page.devices.map(refOf).includes(accessory(LED_STRIP)));
});

test("a device of several matched services takes one entry and one read", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  const before = home.hub.requests.length;

  const page = await call(client, "find_devices", {
    query: "датчик движения коридоре",
    last_report: true,
  });

  assert.deepEqual(page.devices.map(refOf), [accessory(13)]);
  assert.deepEqual(page.devices[0].services, ["Движение", "Освещенность"]);
  assert.equal(deviceReads(home.hub, before).length, 1);
});

test("last_report with notify is refused with what to do instead", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);

  const result = await client.callTool({
    name: "find_devices",
    arguments: { room_ref: HALLWAY, last_report: true, notify: true },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "invalid_find_filters");
  assert.deepEqual(deviceReads(home.hub), []);
});

test("find_devices last_report keeps the time UTC and says so when the hub's zone cannot be read", async (t) => {
  const home = await startHub(t);
  const client = await startClient(t, home);
  await call(client, "home_overview", {});
  home.hub.refuseNext("window.get", { code: -32000, message: "busy" });

  const page = await call(client, "find_devices", {
    room_ref: LIVING_ROOM,
    last_report: true,
  });

  assert.equal(page.time_zone, null);
  assert.equal(
    page.devices.find(({ ref }) => ref === accessory(CHANDELIER))
      .last_report_at,
    "2026-11-06T18:47:03.120Z",
  );
  assert(page.limitations.some((line) => /\bUTC\b/.test(line)));
});

// An eval case's home, in both fixtures, read through the public tools, with
// the deterministic graders of an idle run.
async function caseHome(t, caseName, fixture) {
  const definition = CASES[caseName];
  const hub = await startCaseHub(definition, fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-last-report-"),
  );
  t.after(async () => {
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return {
    home: `spruthub://hub/${hub.serial}`,
    client: await startClient(t, { hub, stateDirectory }),
    grades: (answer) =>
      Object.fromEntries(
        gradeCase(definition, collectEvidence(hub, answer)).map(
          ({ name, pass }) => [name, pass],
        ),
      ),
    judged: () => definition.judge(collectEvidence(hub, "")),
  };
}

// The hub runs on Moscow time.
const hubDate = (daysAgo) =>
  new Date(Date.now() + 3 * 3_600_000 - daysAgo * 86_400_000)
    .toISOString()
    .slice(0, 10);

// Every label a run could earn passes the deterministic graders, so only the
// judge decides it; a raw ref and a missing time do not.
function assertGraders({ grades }, caseName, time) {
  for (const { id, label, answer } of LABELS[caseName]) {
    if (label !== "pass") continue;
    assert.deepEqual(
      grades(answer),
      {
        no_writes: true,
        answer_has_report_time: true,
        answer_has_no_raw_refs: true,
      },
      id,
    );
  }
  assert.equal(
    grades(`В ${time} см. ${accessory(CHANDELIER)}`).answer_has_no_raw_refs,
    false,
  );
  assert.equal(grades("Не знаю.").answer_has_report_time, false);
}

for (const [caseName, time] of [
  ["why-lights-off-yesterday", "21:47"],
  ["why-lights-off-no-scenario", "20:13"],
]) {
  test(`${caseName}: its home shows the moment of the lamps apart from a device that reported seconds ago`, async (t) => {
    for (const fixture of ["apartment", "house"]) {
      const session = await caseHome(t, caseName, fixture);
      const { home, client } = session;
      const { devices } = await call(client, "find_devices", {
        room_ref: `${home}/room/3`,
        last_report: true,
      });
      assert.deepEqual(
        devices
          .filter(({ reported_together: moment }) => moment !== undefined)
          .map(({ ref, last_report_at }) => [ref, last_report_at]),
        [
          [
            `${home}/accessory/${CHANDELIER}`,
            `${hubDate(1)}T${time}:05.350+03:00`,
          ],
          [
            `${home}/accessory/${FLOOR_LAMP}`,
            `${hubDate(1)}T${time}:04.997+03:00`,
          ],
          [
            `${home}/accessory/${LED_STRIP}`,
            `${hubDate(1)}T${time}:00.753+03:00`,
          ],
        ],
        fixture,
      );
      assert.equal(devices[0].ref, `${home}/accessory/${AIR_CONDITIONER}`);
      assert.equal(
        devices[0].last_report_at.slice(0, 19),
        `${hubDate(0)}T11:59:50`,
      );

      const overview = await call(client, "home_overview", {
        query: "Гостиная на ночь",
      });
      assert.equal(
        JSON.stringify(overview.matches).includes("Гостиная на ночь"),
        caseName === "why-lights-off-yesterday",
      );
      assertGraders(session, caseName, time);
      assert(session.judged().criteria.length > 0);
    }
  });
}

test("why-lights-off-yesterday: the scenario that fits shows its time", async (t) => {
  const { home, client } = await caseHome(
    t,
    "why-lights-off-yesterday",
    "apartment",
  );
  const { entity } = await call(client, "get_entity", {
    entity_ref: `${home}/scenario/91`,
  });
  assert.equal(entity.name, "Гостиная на ночь");
  assert.match(JSON.stringify(entity.summary), /21:47/);
});

test("motion-last-report: the sensor shows its last report, which the log does not reach", async (t) => {
  for (const fixture of ["apartment", "house"]) {
    const session = await caseHome(t, "motion-last-report", fixture);
    const { client } = session;
    const { devices } = await call(client, "find_devices", {
      query: "датчик движения ванной",
      last_report: true,
    });
    assert.deepEqual(
      devices.map(({ name, last_report_at }) => [name, last_report_at]),
      [["Датчик движения в ванной", `${hubDate(0)}T09:14:37.000+03:00`]],
      fixture,
    );
    const log = await call(client, "read_hub_log", {
      contains: "Датчик движения в ванной",
    });
    assert.deepEqual(log.entries, []);
    assert(
      log.oldest_entry_at > devices[0].last_report_at,
      log.oldest_entry_at,
    );
    assertGraders(session, "motion-last-report", "09:14");
  }
});
