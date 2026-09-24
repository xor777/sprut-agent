import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The simulator backs agent evaluations. These tests keep it compatible with
// the current client: if the server starts calling a method the simulator
// lacks, or parses a shape it does not return, a public tool fails here.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";

async function setup(t, fixture = "apartment") {
  const hub = await startSimulatedHub(await loadHomeFixture(fixture));
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-simulated-hub-"),
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
  const client = new Client({ name: "simulated-hub-test", version: "1.0.0" });
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

function assertEveryRequestSupported(hub) {
  assert.deepEqual(
    hub.requests
      .filter(({ error }) => error?.code === -32601)
      .map(({ method }) => method),
    [],
  );
}

test("public read tools see the simulated apartment as a native home", async (t) => {
  const { hub, client } = await setup(t);

  const inspected = await call(client, "home_overview", {});
  assert.equal(inspected.home.ref, homeRef);
  assert.deepEqual(
    inspected.rooms.map(({ name }) => name),
    [
      "Прихожая",
      "Коридор",
      "Гостиная",
      "Кухня",
      "Спальня",
      "Детская спальня",
      "Кабинет",
      "Ванная",
      "Балкон",
    ],
  );
  assert.deepEqual(
    { total: inspected.scenarios.total, by_type: inspected.scenarios.by_type },
    {
      total: 9,
      by_type: {
        BLOCK: { active: 7, inactive: 1 },
        LOGIC: { active: 1, inactive: 0 },
      },
    },
  );
  assert.ok(
    inspected.extensions.some(
      ({ ref }) => ref === `${homeRef}/extension/Controller%3Azigbee`,
    ),
  );

  const summary = await call(client, "find_devices", {});
  const technical = new Set(["AccessoryInformation", "BatteryService"]);
  assert.equal(
    summary.services,
    hub.state.accessories
      .flatMap(({ services }) => services)
      .filter(({ type }) => !technical.has(type)).length,
  );

  const bedroom = await call(client, "find_devices", {
    home_ref: homeRef,
    room_ref: `${homeRef}/room/5`,
    kind: "sensor",
  });
  assert.deepEqual(
    bedroom.rooms.flatMap(({ devices }) =>
      devices.flatMap(({ name, services }) =>
        services
          .filter(({ type }) => type === "TemperatureSensor")
          .flatMap(({ values }) =>
            values.map(({ type, value, unit }) => [name, type, value, unit]),
          ),
      ),
    ),
    [["Датчик климата в спальне", "CurrentTemperature", 21.4, "°C"]],
  );

  const room = await call(client, "get_entity", {
    entity_ref: `${homeRef}/room/6`,
  });
  assert.equal(room.entity.name, "Детская спальня");
  assert.ok(
    room.entity.accessories.some(
      ({ name }) => name === "Датчик климата в детской",
    ),
  );

  const lamp = await call(client, "get_entity", {
    entity_ref: `${homeRef}/accessory/16`,
  });
  assert.equal(lamp.entity.name, "Торшер");
  assert.equal(lamp.entity.room_ref, `${homeRef}/room/3`);

  const night = await call(client, "get_entity", {
    entity_ref: `${homeRef}/scenario/5`,
    include: ["configuration"],
  });
  assert.equal(night.entity.configuration.format, "json");
  const [rule] = night.entity.configuration.value.targets;
  assert.equal(rule.if.conditions[0].type, "interval");
  assert.deepEqual(
    rule.then.map(({ aId }) => aId),
    [15, 14],
  );

  const code = await call(client, "get_entity", {
    entity_ref: `${homeRef}/scenario/9`,
    include: ["configuration"],
  });
  assert.equal(code.entity.configuration.format, "code");
  assert.match(code.entity.configuration.value, /HS\.LeakSensor/);

  const logic = await call(client, "get_entity", {
    entity_ref: `${homeRef}/accessory/23/service/13`,
  });
  assert.deepEqual(
    logic.entity.assigned_logics.map(({ type, active }) => [type, active]),
    [["9", true]],
  );

  assertEveryRequestSupported(hub);
  assert.deepEqual(hub.writes(), []);
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});

test("the house fixture keeps the apartment and serves a double-scale home to the shipped reads", async (t) => {
  const { hub, client } = await setup(t, "house");
  const houseRef = "spruthub://hub/sim-house-01";
  const apartment = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => apartment.close());
  const apartmentSnapshot = apartment.snapshot();
  const houseSnapshot = hub.snapshot();
  assert.deepEqual(
    Object.keys(apartmentSnapshot).filter(
      (key) =>
        !key.startsWith("window/") &&
        JSON.stringify(apartmentSnapshot[key]) !==
          JSON.stringify(houseSnapshot[key]),
    ),
    [],
  );

  const services = hub.state.accessories.flatMap(({ services: list }) => list);
  assert.ok(hub.state.rooms.length >= 20);
  assert.ok(hub.state.accessories.length >= 160);
  assert.ok(services.length >= 500);
  assert.ok(hub.state.scenarios.length >= 40);

  let pages = 0;
  let bytes = 0;
  const seen = new Set();
  let page = await call(client, "find_devices", {
    home_ref: houseRef,
    state: "off",
  });
  for (;;) {
    pages += 1;
    bytes += JSON.stringify(page).length;
    for (const room of page.rooms) {
      for (const device of room.devices) seen.add(device.ref);
    }
    if (!page.next) break;
    page = await call(client, page.next.tool, page.next.arguments);
  }
  const offDevices = hub.state.accessories.filter(
    ({ online, services: list }) =>
      online &&
      list.some(({ characteristics }) =>
        characteristics.some(
          ({ control }) =>
            (control.type === "On" && control.value.boolValue === false) ||
            (control.type === "Active" && control.value.intValue === 0) ||
            (control.type === "TargetHeatingCoolingState" &&
              control.value.intValue === 0),
        ),
      ),
  );
  assert.ok(pages > 1);
  assert.equal(seen.size, offDevices.length);
  const inspected = await call(client, "home_overview", { home_ref: houseRef });
  assert.equal(inspected.rooms.length, hub.state.rooms.length);
  assertEveryRequestSupported(hub);
  assert.deepEqual(hub.writes(), []);
  t.diagnostic(`house devices that are off: ${pages} pages, ${bytes} bytes`);
});

test("a prepared characteristic value changes only that simulated characteristic", async (t) => {
  const { hub, client } = await setup(t);

  const prepared = await call(client, "prepare_native_change", {
    operation: "characteristic_value",
    target_ref: `${homeRef}/accessory/16/service/13/characteristic/15`,
    value: 30,
    reason: "Приглушить торшер",
  });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(hub.writes(), []);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.observed_value, { value: 30, kind: "intValue" });
  assert.deepEqual(diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()), [
    { key: "characteristic/16.13.15/Brightness", before: 55, after: 30 },
  ]);
  assert.deepEqual(
    hub.writes().map(({ method, params }) => [method, params]),
    [
      [
        "characteristic.update",
        {
          characteristic: {
            update: {
              aId: 16,
              sId: 13,
              cId: 15,
              control: { value: { intValue: 30 } },
            },
          },
        },
      ],
    ],
  );
  assertEveryRequestSupported(hub);
});

test("a BLOCK created through prepare and apply is stored natively and restored away", async (t) => {
  const { hub, client } = await setup(t);
  const data = {
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              aId: 38,
              sId: 13,
              cId: 14,
              hs: "MotionSensor",
              hc: "MotionDetected",
              cond: "=",
              value: "true",
              trigger: true,
              time: 0,
              timeCond: "",
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [
          {
            type: "service",
            aId: 35,
            sId: 13,
            hs: "Lightbulb",
            characteristics: [
              { type: "set", cId: 14, hc: "On", value: "true" },
            ],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };

  const prepared = await call(client, "prepare_native_change", {
    operation: "block_create",
    target_ref: homeRef,
    name: "Свет в ванной по движению",
    description: "Включает свет в ванной при движении",
    active: true,
    on_start: false,
    sync: false,
    data,
    reason: "Включать свет в ванной при движении",
  });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(hub.writes(), []);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  const created = hub.state.scenarios.at(-1);
  assert.equal(applied.scenario_ref, `${homeRef}/scenario/${created.index}`);
  assert.equal(created.name, "Свет в ванной по движению");
  assert.equal(created.active, true);
  const snapshot = hub.snapshot();
  assert.deepEqual(
    JSON.parse(snapshot[`scenario/${created.index}/data`]),
    data,
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), snapshot).filter(
      ({ key }) => !key.startsWith(`scenario/${created.index}/`),
    ),
    [],
  );
  assert.deepEqual(
    hub
      .writes()
      .map(({ method }) => method)
      .filter((method) => method === "scenario.create"),
    ["scenario.create"],
  );

  const readBack = await call(client, "get_entity", {
    entity_ref: applied.scenario_ref,
    include: ["configuration"],
  });
  assert.equal(readBack.entity.name, "Свет в ванной по движению");
  assert.equal(readBack.entity.configuration.value.targets[0].then[0].aId, 35);

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored");
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
  assertEveryRequestSupported(hub);
});

test("motion turning on the corridor light is not duplicated next to the rule that already does it", async (t) => {
  const { hub, client } = await setup(t);
  const corridor = `${homeRef}/room/2`;

  const prepared = await call(client, "preview_boolean_automation", {
    name: "Свет в коридоре по движению",
    reason: "Включать свет в коридоре при движении",
    source_room_ref: corridor,
    source_characteristic_ref: `${homeRef}/accessory/13/service/13/characteristic/14`,
    source_value: true,
    target_room_ref: corridor,
    target_characteristic_ref: `${homeRef}/accessory/14/service/13/characteristic/14`,
    target_value: true,
  });
  assert.deepEqual(
    prepared.existing_rules.map(({ ref, name, relation }) => [
      ref,
      name,
      relation,
    ]),
    [[`${homeRef}/scenario/3`, "Свет в коридоре по движению", "superset"]],
  );

  const applied = await call(client, "apply_automation_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "conflict");
  assert.equal(applied.created, false);
  assert.equal(applied.existing_rule.ref, `${homeRef}/scenario/3`);
  assert.deepEqual(hub.writes(), []);
  assert.deepEqual(
    hub.state.scenarios
      .map(({ name }) => name)
      .filter((name) => name === "Свет в коридоре по движению"),
    ["Свет в коридоре по движению"],
  );
  assertEveryRequestSupported(hub);
});

test("the simulator refuses unknown methods and foreign tokens without touching the home", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const socket = new WebSocket(hub.url, "json-rpc");
  t.after(() => socket.close());
  await once(socket, "open");
  const send = async (message) => {
    socket.send(JSON.stringify(message));
    const [data] = await once(socket, "message");
    return JSON.parse(data.toString());
  };

  const unknown = await send({
    id: 1,
    token: hub.token,
    serial: hub.serial,
    params: { scenario: { export: { index: "5" } } },
  });
  assert.deepEqual(unknown.error, {
    code: -32601,
    message: "unsupported by simulator: scenario.export",
  });

  const foreign = await send({
    id: 2,
    token: "another-token",
    serial: hub.serial,
    params: { characteristic: { update: { aId: 16, sId: 13, cId: 14 } } },
  });
  assert.equal(foreign.error.code, 401);
  // An unknown method may change the home on a live hub, so it counts as a
  // write until it is placed on the read allowlist.
  assert.deepEqual(
    hub.requests.map(({ method, write }) => [method, write]),
    [
      ["scenario.export", true],
      ["characteristic.update", true],
    ],
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});

test("only allowlisted reads are reads, and link settings show in the home diff", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const socket = new WebSocket(hub.url, "json-rpc");
  t.after(() => socket.close());
  await once(socket, "open");
  let id = 0;
  const send = async (params) => {
    id += 1;
    socket.send(
      JSON.stringify({ id, token: hub.token, serial: hub.serial, params }),
    );
    const [data] = await once(socket, "message");
    return JSON.parse(data.toString());
  };

  await send({ room: { list: {} } });
  await send({ room: { update: { id: 7, name: "Офис" } } });
  await send({ service: { update: { aId: 17, sId: 13, visible: false } } });
  await send({ room: { subscribe: {} } });
  await send({
    characteristic: { update: { aId: 16, sId: 13, cId: 14, hasLinks: true } },
  });
  await send({
    characteristic: {
      update: { aId: 15, sId: 13, cId: 14, linkProcessing: "IN_OUT" },
    },
  });

  assert.deepEqual(
    hub.requests.map(({ method, write }) => [method, write]),
    [
      ["room.list", false],
      ["room.update", true],
      ["service.update", true],
      ["room.subscribe", true],
      ["characteristic.update", true],
      ["characteristic.update", true],
    ],
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot())
      .filter(({ key }) => key.startsWith("characteristic/"))
      .map(({ key, after }) => [key, after]),
    [
      ["characteristic/15.13.14/linkProcessing", "IN_OUT"],
      ["characteristic/16.13.14/hasLinks", true],
    ],
  );
});

test("the shipped hub log, room rename and service hide work on the simulated home", async (t) => {
  const { hub, client } = await setup(t);

  // One read covers the whole 128-entry ring buffer; the newest matches that
  // fit max_bytes are shown, the rest is counted, never paged.
  const logPage = await call(client, "read_hub_log", {
    home_ref: homeRef,
    max_bytes: 32_768,
  });
  const times = logPage.entries.map(({ native_time: time }) => time);
  assert.deepEqual(
    times,
    [...times].sort((left, right) => right - left),
  );
  assert.equal(new Set(times).size, times.length);
  assert.equal(logPage.buffer_entries, 128);
  assert.equal(logPage.page.matched_total, 128);
  assert.equal(logPage.next, undefined);
  // About two and a half hours are kept: yesterday's night run was evicted.
  assert.ok(Date.now() - Date.parse(logPage.oldest_entry_at) < 3 * 3.6e6);
  assert.ok(
    !logPage.entries.some(({ message }) => message.startsWith("Сценарий 5:")),
  );
  assert.ok(
    logPage.entries.some(({ message }) => message.startsWith("Сценарий 3:")),
  );

  const renamed = await call(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${homeRef}/room/7`,
    value: "Офис",
    reason: "Переименовать кабинет",
  });
  assert.equal(
    (
      await call(client, "apply_native_change", {
        change_ref: renamed.change_ref,
      })
    ).status,
    "applied",
  );
  const hidden = await call(client, "prepare_native_change", {
    operation: "service_visible",
    target_ref: `${homeRef}/accessory/17/service/13`,
    value: false,
    reason: "Скрыть ленту",
  });
  assert.equal(
    (
      await call(client, "apply_native_change", {
        change_ref: hidden.change_ref,
      })
    ).status,
    "applied",
  );

  assert.deepEqual(diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()), [
    { key: "room/7/name", before: "Кабинет", after: "Офис" },
    { key: "service/17.13/visible", before: true, after: false },
  ]);
  assert.deepEqual(
    hub.writes().map(({ method, params }) => [method, params]),
    [
      ["room.update", { room: { update: { id: 7, name: "Офис" } } }],
      [
        "service.update",
        { service: { update: { aId: 17, sId: 13, visible: false } } },
      ],
    ],
  );
  assertEveryRequestSupported(hub);
  const touched = Object.fromEntries(
    hub.touchedMethods().map(({ method, level }) => [method, level]),
  );
  assert.equal(touched["room.update"], "observed");
  assert.equal(touched["service.update"], "schema_only");
  assert.equal(touched["accessory.get"], "observed");
});

test("log.list returns the newest entries by count, pages forward from lastTime and keeps a ring buffer", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const socket = new WebSocket(hub.url, "json-rpc");
  t.after(() => socket.close());
  await once(socket, "open");
  let id = 0;
  const list = async (request) => {
    id += 1;
    socket.send(
      JSON.stringify({
        id,
        token: hub.token,
        serial: hub.serial,
        params: { log: { list: request } },
      }),
    );
    const [data] = await once(socket, "message");
    return JSON.parse(data.toString()).result.log.list.log;
  };
  const oldestFirst = hub.state.log.map(({ time }) => time);
  assert.ok(oldestFirst.length >= 10);

  const newest = await list({ count: 3 });
  assert.deepEqual(
    newest.map(({ time }) => time).sort((left, right) => left - right),
    oldestFirst.slice(-3),
  );
  const boundary = oldestFirst.at(-6);
  const newer = await list({ lastTime: boundary, count: 2 });
  assert.deepEqual(
    newer.map(({ time }) => time).sort((left, right) => left - right),
    oldestFirst.slice(-5, -3),
  );

  // The ring buffer keeps its size: a manual run pushes out the oldest line.
  id += 1;
  socket.send(
    JSON.stringify({
      id,
      token: hub.token,
      serial: hub.serial,
      params: { scenario: { run: { index: "11" } } },
    }),
  );
  await once(socket, "message");
  assert.equal(hub.state.log.length, oldestFirst.length);
  assert.equal(hub.state.log[0].time, oldestFirst[1]);
  assert.match(hub.state.log.at(-1).message, /^Сценарий 11:/);
});

// A raw native session for fault tests: replies are matched by id, and a
// reply that never comes resolves to null after waitMs.
async function rawSession(t, options, fixture) {
  const hub = await startSimulatedHub(
    fixture ?? (await loadHomeFixture("apartment")),
    options,
  );
  t.after(() => hub.close());
  const socket = new WebSocket(hub.url, "json-rpc");
  t.after(() => socket.close());
  await once(socket, "open");
  const waiting = new Map();
  socket.on("message", (data) => {
    const reply = JSON.parse(data.toString());
    waiting.get(reply.id)?.(reply);
  });
  let id = 0;
  const send = (params, waitMs = 1_000) => {
    id += 1;
    const current = id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), waitMs);
      waiting.set(current, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      socket.send(
        JSON.stringify({
          id: current,
          token: hub.token,
          serial: hub.serial,
          params,
        }),
      );
    });
  };
  const value = async (aId, cId) =>
    (await send({ characteristic: { get: { aId, sId: 13, cId } } })).result
      .characteristic.get.control.value;
  return { hub, send, value };
}

const setValue = (aId, cId, value) => ({
  characteristic: { update: { aId, sId: 13, cId, control: { value } } },
});

// SprutHub 3.0.0 acknowledged scenario.run of a turned-off BLOCK and ran
// none of its actions; turned on, it ran them (live-conformance-3).
test("a manual run of a turned-off BLOCK is acknowledged and changes nothing", async (t) => {
  const { hub, send } = await rawSession(t);
  const allOff = hub.state.scenarios.find(({ index }) => index === "11");
  allOff.active = false;
  const before = hub.snapshot();

  const reply = await send({ scenario: { run: { index: "11" } } });
  assert.deepEqual(reply.result, { scenario: { run: {} } });
  assert.deepEqual(diffHomeSnapshots(before, hub.snapshot()), []);

  allOff.active = true;
  await send({ scenario: { run: { index: "11" } } });
  assert.notDeepEqual(diffHomeSnapshots(before, hub.snapshot()), []);
});

test("a delayed readback acknowledges a write before its value appears", async (t) => {
  const { hub, send, value } = await rawSession(t, {
    faults: { delayedReadback: [{ aId: 16, sId: 13, cId: 15, ms: 300 }] },
  });
  const reply = await send(setValue(16, 15, { intValue: 30 }));
  assert.deepEqual(reply.result, { characteristic: { update: {} } });
  assert.deepEqual(await value(16, 15), { intValue: 55 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(await value(16, 15), { intValue: 30 });

  await send(setValue(16, 15, { intValue: 40 }));
  assert.deepEqual(await value(16, 15), { intValue: 30 });
  hub.settle();
  assert.deepEqual(await value(16, 15), { intValue: 40 });
  assert.deepEqual(
    hub.faultEvents().map(({ fault, method }) => [fault, method]),
    [
      ["delayed_readback", "characteristic.update"],
      ["delayed_readback", "characteristic.update"],
    ],
  );
});

test("a dropped reply applies the write and never answers it", async (t) => {
  const { hub, send, value } = await rawSession(t, {
    faults: {
      droppedReply: [{ method: "characteristic.update", aId: 36, times: 1 }],
    },
  });
  assert.equal(await send(setValue(36, 14, { boolValue: true }), 300), null);
  assert.deepEqual(await value(36, 14), { boolValue: true });
  const second = await send(setValue(36, 14, { boolValue: false }));
  assert.deepEqual(second.result, { characteristic: { update: {} } });
  assert.deepEqual(
    hub.faultEvents().map(({ fault }) => fault),
    ["dropped_reply"],
  );
});

test("an offline actuator acknowledges a write and keeps its value", async (t) => {
  const { hub, send, value } = await rawSession(t, {
    faults: { stuckActuators: [{ aId: 22 }] },
  });
  const accessory = await send({ accessory: { get: { id: 22 } } });
  assert.equal(accessory.result.accessory.get.online, false);
  const reply = await send(setValue(22, 14, { boolValue: false }));
  assert.deepEqual(reply.result, { characteristic: { update: {} } });
  assert.deepEqual(await value(22, 14), { boolValue: true });
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
  assert.deepEqual(
    hub.faultEvents().map(({ fault }) => fault),
    ["stuck_actuator"],
  );
});

test("an active lamp logic switches the lamp with its brightness", async (t) => {
  const { hub, send, value } = await rawSession(t, {
    faults: { lampLogic: [{ aId: 26, sId: 13 }] },
  });
  const logics = await send({ logic: { list: { aId: 26, sId: 13 } } });
  assert.deepEqual(logics.result.logic.list.logics, [
    {
      type: "LightbulbControl",
      name: "Связь включения и уровня",
      active: true,
    },
  ]);
  await send(setValue(26, 15, { intValue: 30 }));
  assert.deepEqual(await value(26, 14), { boolValue: true });
  await send(setValue(26, 15, { intValue: 0 }));
  assert.deepEqual(await value(26, 14), { boolValue: false });
  assert.deepEqual(
    hub.faultEvents().map(({ fault }) => fault),
    ["lamp_logic", "lamp_logic"],
  );
});

// Owner's hub, 3.0.0, 2026-09-24 (live-conformance-3): a user LOGIC's type,
// its scenario index, is listed and assignable only while the LOGIC is on,
// and assigning a turned-off one answered Not found. An assignment made while
// it was on was still listed by logic.list and logic.get once it was off.
test("the simulator keeps a turned-off LOGIC's assignment listed and refuses a new one", async (t) => {
  const { send } = await rawSession(t);
  const created = (
    await send({
      scenario: {
        create: {
          type: "LOGIC",
          active: true,
          data: 'info = { name: "Свет по уровню", sourceServices: [HS.Lightbulb] };\n\nfunction trigger() {}',
        },
      },
    })
  ).result.scenario.create;
  const type = created.index;
  const types = async (aId) =>
    (
      await send({ logic: { types: { aId, sId: 13 } } })
    ).result.logic.types.logicTypes.map((entry) => entry.type);
  const assigned = async (aId) =>
    (
      (await send({ logic: { list: { aId, sId: 13 } } })).result.logic.list
        .logics ?? []
    ).filter((logic) => logic.type === type);
  assert.ok((await types(16)).includes(type));
  const assign = await send({ logic: { create: { aId: 16, sId: 13, type } } });
  assert.equal(assign.error, undefined);

  await send({
    window: {
      update: {
        windowKey: created.optionsWindow,
        options: [{ key: "Active", value: { boolValue: false } }],
      },
    },
  });
  assert.equal((await types(16)).includes(type), false);
  assert.deepEqual(
    (await assigned(16)).map((logic) => logic.type),
    [type],
  );
  const read = await send({ logic: { get: { aId: 16, sId: 13, type } } });
  assert.equal(read.result.logic.get.type, type);

  const refused = await send({ logic: { create: { aId: 15, sId: 13, type } } });
  assert.equal(refused.error?.code, -32603);
  assert.match(refused.error.message, /^Not found/);
  assert.deepEqual(await assigned(15), []);
});

test("the simulator omits empty native lists and stores BLOCK values as the hub does", async (t) => {
  const { send } = await rawSession(t);
  const list = async (params) => {
    const [domain] = Object.keys(params);
    return (await send(params)).result[domain].list;
  };
  // Observed on the owner's hub (2026-09-24): an empty list is omitted, not [].
  assert.deepEqual(await list({ accessory: { list: { roomId: 30 } } }), {});
  assert.deepEqual(await list({ logic: { list: { aId: 35, sId: 13 } } }), {});
  assert.deepEqual(
    await list({ link: { list: { aId: 38, sId: 13, cId: 14 } } }),
    {},
  );
  assert.deepEqual(
    await list({
      extensionChild: { list: { extensionKey: "Bridge:homekit" } },
    }),
    {},
  );
  assert.deepEqual(await list({ scenario: { list: { aId: 36 } } }), {});
  assert.equal(
    (await list({ accessory: { list: { roomId: 8 } } })).accessories.length,
    4,
  );

  // inc/dec values are stored as numbers, set values stay strings, and every
  // node gets a blockId.
  const created = await send({
    scenario: {
      create: {
        name: "Ярче",
        type: "BLOCK",
        active: false,
        data: JSON.stringify({
          targets: [
            {
              type: "service",
              aId: 16,
              sId: 13,
              hs: "Lightbulb",
              characteristics: [
                { type: "inc", cId: 15, hc: "Brightness", value: "10" },
                { type: "dec", cId: 15, hc: "Brightness", value: "5" },
                { type: "set", cId: 14, hc: "On", value: "true" },
              ],
            },
          ],
        }),
      },
    },
  });
  const stored = JSON.parse(created.result.scenario.create.data);
  const [service] = stored.targets;
  assert.deepEqual(
    service.characteristics.map(({ type, value }) => [type, value]),
    [
      ["inc", 10],
      ["dec", 5],
      ["set", "true"],
    ],
  );
  assert.ok(
    [service, ...service.characteristics].every(({ blockId }) =>
      Number.isInteger(blockId),
    ),
  );
});

// Owner's hub, 3.0.0, 2026-09-24: scenario.update {active} was acknowledged
// and changed nothing, for a BLOCK and a LOGIC; the BLOCK options window had
// an Active CHECKBOX that showed the flag.
test("the simulator switches a BLOCK only through the Active option of its options window", async (t) => {
  const { send } = await rawSession(t);
  const scenario = async (index) =>
    (await send({ scenario: { get: { index } } })).result.scenario.get;
  const windowActive = async (windowKey) =>
    (await send({ window: { get: { windowKey } } })).result.window.get.options
      .filter(({ key }) => key === "Active")
      .map(({ inputType, value }) => [inputType, value]);
  const writeWindow = (windowKey, key, value) =>
    send({ window: { update: { windowKey, options: [{ key, value }] } } });

  const ignored = await send({
    scenario: { update: { index: "5", active: false } },
  });
  assert.deepEqual(ignored.result, { scenario: { update: {} } });
  const night = await scenario("5");
  assert.equal(night.active, true);
  assert.deepEqual(await windowActive(night.optionsWindow), [
    ["CHECKBOX", { boolValue: true }],
  ]);

  await writeWindow(night.optionsWindow, "Active", { boolValue: false });
  assert.equal((await scenario("5")).active, false);
  assert.deepEqual(await windowActive(night.optionsWindow), [
    ["CHECKBOX", { boolValue: false }],
  ]);
  // Another option of the same window leaves the flag as it is.
  await writeWindow(night.optionsWindow, "Name", { stringValue: "Ночь" });
  assert.deepEqual(
    [(await scenario("5")).name, (await scenario("5")).active],
    ["Ночь", false],
  );
  // The motion rule next to it keeps its own flag.
  assert.equal((await scenario("3")).active, true);

  // A LOGIC ignores the flag too.
  await send({ scenario: { update: { index: "9", active: false } } });
  assert.equal((await scenario("9")).active, true);
});

// Owner's hub, 3.0.0, 2026-09-24: scenario.list carried optionsWindow for
// every BLOCK, LOGIC, predefined LOGIC and GLOBAL, and their options windows
// had the same keys and input types, with a writable GenericBoolean Active
// (live-conformance-2 and live-conformance-3-read-only). Writes of the other
// flags and of Remove were never sent live.
test("the simulator gives every scenario type the live options window and refuses its unobserved writes", async (t) => {
  const fixture = await loadHomeFixture("apartment");
  fixture.scenarios.push(
    {
      index: "20",
      name: "Переменные дома",
      type: "GLOBAL",
      active: true,
      onStart: true,
      data: "let away = false;",
    },
    {
      index: "21",
      name: "Встроенная логика",
      type: "LOGIC",
      predefined: true,
      active: false,
      sync: true,
      data: "info = {};",
    },
  );
  const { hub, send } = await rawSession(t, {}, fixture);
  const scenario = async (index) =>
    (await send({ scenario: { get: { index } } })).result.scenario.get;
  const windowOf = async (index) =>
    (
      await send({
        window: { get: { windowKey: (await scenario(index)).optionsWindow } },
      })
    ).result.window.get.options;
  const update = async (index, options) =>
    send({
      window: {
        update: { windowKey: (await scenario(index)).optionsWindow, options },
      },
    });

  const listed = (await send({ scenario: { list: {} } })).result.scenario.list
    .scenarios;
  assert.deepEqual(
    listed.filter(({ optionsWindow }) => typeof optionsWindow !== "string"),
    [],
  );
  assert.equal(
    new Set(listed.map(({ optionsWindow }) => optionsWindow)).size,
    listed.length,
  );

  const kinds = { 5: "BLOCK", 9: "LOGIC", 20: "GLOBAL", 21: "predefined" };
  for (const [index, kind] of Object.entries(kinds)) {
    const options = await windowOf(index);
    assert.deepEqual(
      options.map(({ key, inputType }) => [key, inputType]).sort(),
      [
        ["Active", "CHECKBOX"],
        ["Desc", "TEXT_MULTILINE"],
        ["Name", "TEXT"],
        ["OnStart", "CHECKBOX"],
        ["Remove", "BUTTON_DANGER"],
        ["Sync", "CHECKBOX"],
        ["footer", "GROUP"],
        ["main", "GROUP"],
        ["primary", "GROUP"],
      ],
      kind,
    );
    const active = options.find(({ key }) => key === "Active");
    assert.deepEqual(
      [active.type, active.read, active.write, active.disabled],
      ["GenericBoolean", true, true, false],
      kind,
    );
    // The flags show the scenario's own.
    const stored = await scenario(index);
    assert.deepEqual(
      Object.fromEntries(
        options
          .filter(({ key }) => ["Active", "OnStart", "Sync"].includes(key))
          .map(({ key, value }) => [key, value.boolValue]),
      ),
      { Active: stored.active, OnStart: stored.onStart, Sync: stored.sync },
      kind,
    );
  }
  assert.deepEqual(
    [await scenario("20"), await scenario("21")].map(
      ({ active, onStart, sync }) => [active, onStart, sync],
    ),
    [
      [true, true, false],
      [false, false, true],
    ],
  );

  // Active switches a LOGIC and a GLOBAL as it does a BLOCK.
  const before = hub.snapshot();
  await update("9", [{ key: "Active", value: { boolValue: false } }]);
  await update("20", [{ key: "Active", value: { boolValue: false } }]);
  assert.deepEqual(
    [(await scenario("9")).active, (await scenario("20")).active],
    [false, false],
  );
  assert.equal(
    (await windowOf("9")).find(({ key }) => key === "Active").value.boolValue,
    false,
  );

  // Unobserved writes are refused whole, before anything is stored.
  for (const [index, options] of [
    ["5", [{ key: "OnStart", value: { boolValue: true } }]],
    ["20", [{ key: "Sync", value: { boolValue: true } }]],
    ["9", [{ key: "Remove", value: { boolValue: true } }]],
    ["9", [{ key: "Name", value: { stringValue: "Протечка" } }]],
    ["21", [{ key: "Desc", value: { stringValue: "Своё описание" } }]],
    [
      "21",
      [
        { key: "Active", value: { boolValue: true } },
        { key: "OnStart", value: { boolValue: true } },
      ],
    ],
  ]) {
    const refused = await update(index, options);
    assert.equal(refused.error?.code, -32601, JSON.stringify(options));
  }
  assert.deepEqual(diffHomeSnapshots(before, hub.snapshot()), [
    { key: "scenario/20/active", before: true, after: false },
    { key: "scenario/9/active", before: true, after: false },
  ]);
  assert.deepEqual(
    (await windowOf("21"))
      .filter(({ key }) => ["Active", "OnStart", "Desc"].includes(key))
      .map(({ key, value }) => [key, value]),
    [
      ["Active", { boolValue: false }],
      ["OnStart", { boolValue: false }],
      ["Desc", { stringValue: "" }],
    ],
  );
  // A run reports the refused writes as unsupported, not as observed.
  const levels = Object.fromEntries(
    hub
      .touchedMethods()
      .map(({ method, level, errors }) => [method, [level, errors]]),
  );
  assert.deepEqual(levels["window.update {Active}"], ["observed", 0]);
  assert.deepEqual(levels["window.update {OnStart}"], ["unsupported", 2]);
  for (const key of ["Sync", "Remove", "Name", "Desc"]) {
    assert.deepEqual(levels[`window.update {${key}}`], ["unsupported", 1]);
  }
});

// Owner's hub, 3.0.0, 2026-09-24: accessory.list had no virtual field while
// accessory.get had it, true on the created virtual accessory, and a room
// name was kept as its first 32 characters, without emoji.
test("the simulator lists accessories without virtual, reads it on each accessory and keeps 32 characters of a room name without emoji", async (t) => {
  const { send } = await rawSession(t);
  const created = (
    await send({
      accessory: {
        create: {
          name: "Виртуальная лампа",
          roomId: 3,
          services: [{ type: "Lightbulb" }],
        },
      },
    })
  ).result.accessory.create;
  const listed = (
    await send({
      accessory: { list: { expand: "services,characteristics" } },
    })
  ).result.accessory.list.accessories;
  assert.ok(listed.some(({ id }) => id === created.id));
  assert.deepEqual(
    listed.filter((accessory) => Object.hasOwn(accessory, "virtual")),
    [],
  );
  assert.equal(
    (await send({ accessory: { get: { id: created.id } } })).result.accessory
      .get.virtual,
    true,
  );
  // A physical accessory reads virtual: false rather than omitting it
  // (live-conformance-3-read-only).
  const lamp = (await send({ accessory: { get: { id: 16 } } })).result.accessory
    .get;
  assert.deepEqual(
    [Object.hasOwn(lamp, "virtual"), lamp.virtual],
    [true, false],
  );

  const roomName = async (id) =>
    (await send({ room: { get: { id } } })).result.room.get.name;
  const long = "zz-sprut-agent-probe-20260924T132528Z-room";
  assert.equal(long.length, 42);
  const room = (await send({ room: { create: { name: long } } })).result.room
    .create;
  assert.equal(room.name, "zz-sprut-agent-probe-20260924T13");
  assert.equal(await roomName(room.id), "zz-sprut-agent-probe-20260924T13");
  const emoji = (await send({ room: { create: { name: "Детская🙂" } } })).result
    .room.create;
  assert.equal(await roomName(emoji.id), "Детская");
  await send({
    room: {
      update: { id: 7, name: "Кабинет с видом на старый яблоневый сад" },
    },
  });
  assert.equal(await roomName(7), "Кабинет с видом на старый яблоне");
});
