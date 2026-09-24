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

  const homes = await call(client, "list_homes", {});
  assert.equal(homes.selection.default_home_ref, homeRef);

  const inspected = await call(client, "inspect_home", { home_ref: homeRef });
  assert.deepEqual(
    inspected.entities.rooms.map(({ name }) => name),
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
    inspected.entities.scenarios.map(({ name, type, active }) => [
      name,
      type,
      active,
    ]),
    [
      ["Свет в коридоре по движению", "BLOCK", true],
      ["Ночной режим", "BLOCK", true],
      ["Свет в прихожей при открытии двери", "BLOCK", false],
      ["Выключить свет в кабинете", "BLOCK", true],
      ["Защита от протечки", "LOGIC", true],
      ["Всё выключить", "BLOCK", true],
      ["Кнопка у кровати: ночник", "BLOCK", true],
      ["Кнопка у кровати: спать", "BLOCK", true],
      ["Вечерний свет в гостиной", "BLOCK", true],
    ],
  );
  assert.ok(
    inspected.entities.extensions.some(
      ({ key }) => key === "Controller:zigbee",
    ),
  );

  const catalogAccessories = new Set();
  let page = await call(client, "read_services", {
    home_ref: homeRef,
    representation: "catalog",
  });
  for (;;) {
    for (const service of page.services) {
      catalogAccessories.add(service.accessory.ref);
    }
    if (!page.next) break;
    page = await call(client, page.next.tool, page.next.arguments);
  }
  assert.equal(catalogAccessories.size, hub.state.accessories.length);

  const bedroom = await call(client, "read_services", {
    home_ref: homeRef,
    room_ref: `${homeRef}/room/5`,
    service_types: ["TemperatureSensor"],
  });
  assert.deepEqual(
    bedroom.services.flatMap(({ accessory, readings }) =>
      readings.map(({ type, value, unit }) => [
        accessory.name,
        type,
        value,
        unit,
      ]),
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
    [["UserLogic_9", true]],
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
  let page = await call(client, "read_services", { home_ref: houseRef });
  for (;;) {
    pages += 1;
    bytes += JSON.stringify(page).length;
    for (const service of page.services) seen.add(service.accessory.ref);
    if (!page.next) break;
    page = await call(client, page.next.tool, page.next.arguments);
  }
  assert.ok(pages > 1);
  assert.ok(seen.size >= 160);
  const inspected = await call(client, "inspect_home", { home_ref: houseRef });
  assert.equal(inspected.entities.rooms.length, hub.state.rooms.length);
  assertEveryRequestSupported(hub);
  assert.deepEqual(hub.writes(), []);
  t.diagnostic(`house read_services: ${pages} pages, ${bytes} bytes`);
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
  assert.equal(touched["room.update"], "schema_only");
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
async function rawSession(t, options) {
  const hub = await startSimulatedHub(
    await loadHomeFixture("apartment"),
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
