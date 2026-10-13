import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Выключи свет в гостиной» in a living room with 20 lamps, on the house
// fixture. The simulated hub handles every request about 40 ms after it
// arrives, like a hub about 90 ms away (2026-10-13-voice-latency-baseline),
// and with a different delay per request, so requests in flight together
// are handled and answered out of order, as the owner's hub did
// (2026-10-13-parallel-writes). Every lamp has «Связь включения и уровня»,
// as all the owner's lamps do (2026-10-13-lamp-logic-undo).
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-house-01";
const LIVING_ROOM = 3;
const LATENCY_MS = 40;
const latencyMs = ({ arrival }) => LATENCY_MS + (arrival % 4) * 6;
const characteristic = (aId, cId, sId = 13) => ({ aId, sId, cId });
// Living room of the house fixture.
const CHANDELIER_ON = characteristic(15, 14); // Люстра, on at 80
const CHANDELIER_LEVEL = characteristic(15, 15);
const FLOOR_ON = characteristic(16, 14); // Торшер, on at 55
const FLOOR_LEVEL = characteristic(16, 15);
const STRIP_ON = characteristic(17, 14); // Светодиодная лента, off at 100
const STRIP_LEVEL = characteristic(17, 15);
const CURTAIN_TARGET = characteristic(18, 16); // Шторы, open (100)
const AC_MODE = characteristic(19, 15); // Кондиционер, off (0)
const AC_SETPOINT = characteristic(19, 17); // 23 °C
const GUEST_FLOOR_SETPOINT = characteristic(113, 17); // Тёплый пол, 24 °C
// Spots added to the living room: with the house's own three lamps it has
// 20, as the owner's living room has 20 light services.
const SPOTS = Array.from({ length: 17 }, (_, index) => ({
  id: 901 + index,
  name: `Спот ${index + 1}`,
  on: index % 2 === 0,
  level: 30 + index,
}));

function refOf({ aId, sId, cId }) {
  return `${homeRef}/accessory/${aId}/service/${sId}/characteristic/${cId}`;
}

async function houseWithSpots() {
  const fixture = await loadHomeFixture("house");
  return {
    ...fixture,
    accessories: [
      ...fixture.accessories,
      ...SPOTS.map(({ id, name, on, level }) => ({
        id,
        roomId: LIVING_ROOM,
        name,
        extensionKey: "Controller:zigbee",
        deviceId: `00158d0009${id.toString(16).padStart(6, "0")}`,
        services: [
          {
            sId: 13,
            type: "Lightbulb",
            name: "Свет",
            characteristics: [
              { cId: 14, type: "On", value: on },
              { cId: 15, type: "Brightness", value: level },
            ],
          },
        ],
      })),
    ],
  };
}

async function setup(t, { faults = {}, timeoutMs } = {}) {
  const fixture = await houseWithSpots();
  const lamps = fixture.accessories
    .filter(({ roomId }) => roomId === LIVING_ROOM)
    .flatMap(({ id, services }) =>
      services
        .filter(({ type }) => type === "Lightbulb")
        .map(({ sId }) => ({ aId: id, sId })),
    );
  const hub = await startSimulatedHub(fixture, {
    latencyMs,
    faults: { ...faults, lampLogic: lamps },
  });
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-parallel-commands-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs ?? ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "parallel-commands-test",
    version: "1.0.0",
  });
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

async function send(client, commands, reason) {
  return call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: commands.map(([target, value]) => ({
      target_ref: refOf(target),
      value,
    })),
    reason,
  });
}

// The lamps an agent finds for «свет в гостиной»: every page of
// find_devices for the room and kind light.
async function livingRoomLampRefs(client) {
  const refs = [];
  let next = {
    tool: "find_devices",
    arguments: { room_ref: `${homeRef}/room/${LIVING_ROOM}`, kind: "light" },
  };
  while (next) {
    const page = await call(client, next.tool, next.arguments);
    for (const room of page.rooms) {
      for (const device of room.devices) {
        for (const service of device.services) {
          if (service.type !== "Lightbulb") continue;
          refs.push(service.values.find(({ type }) => type === "On").ref);
        }
      }
    }
    next = page.next;
  }
  return refs;
}

// Independent of the product: each lamp's name and On as the hub holds them.
function lampsInState(hub, refs) {
  return refs.map((ref) => {
    const [, aId, sId] = /\/accessory\/(\d+)\/service\/(\d+)\//
      .exec(ref)
      .map(Number);
    const accessory = hub.state.accessories.find(({ id }) => id === aId);
    const service = accessory.services.find((entry) => entry.sId === sId);
    const on = service.characteristics.find(
      ({ control }) => control.type === "On",
    );
    return {
      ref,
      aId,
      name: `${accessory.name} / ${service.name}`,
      on: on.control.value.boolValue,
    };
  });
}

function currentValue(hub, { aId, sId, cId }) {
  const control = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find((service) => service.sId === sId)
    .characteristics.find((entry) => entry.cId === cId).control;
  return Object.values(control.value)[0];
}

function valueWrites(requests) {
  return requests.filter(
    ({ method, params }) =>
      method === "characteristic.update" &&
      params.characteristic.update.control,
  );
}

function writeOf({ params }) {
  const { aId, cId, control } = params.characteristic.update;
  return [`${aId}.${cId}`, Object.values(control.value)[0]];
}

function itemOutcome({
  target_ref,
  name,
  type,
  requested,
  status,
  sent,
  previous_value,
  observed_value,
  restore_supported,
}) {
  return {
    target_ref,
    name,
    type,
    requested,
    status,
    sent,
    previous_value,
    observed_value,
    restore_supported,
  };
}

const lampSwitchedOff = ({ ref, name, on }) => ({
  target_ref: ref,
  name,
  type: "On",
  requested: false,
  status: "applied",
  sent: true,
  previous_value: on,
  observed_value: false,
  restore_supported: true,
});

// Each write to one device is sent only after the hub answered the one
// before it: two writes to one lamp in flight together may be applied in
// either order (2026-10-13-parallel-writes, 2).
function assertOneAfterAnother(writes) {
  for (const [index, write] of writes.slice(1).entries()) {
    assert.ok(
      write.received_ms >= writes[index].answered_ms,
      `write ${index + 1} to ${writeOf(write)[0]} reached the hub before the one before it was answered`,
    );
  }
}

test("«выключи свет в гостиной» with 20 lamps reaches the hub together and reports every lamp as before", async (t) => {
  const { hub, client } = await setup(t);
  const refs = await livingRoomLampRefs(client);
  assert.equal(refs.length, 20);
  const lamps = lampsInState(hub, refs);
  const homeBefore = hub.snapshot();

  const from = hub.requests.length;
  const startedAt = performance.now();
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: refs.map((ref) => ({ target_ref: ref, value: false })),
    reason: "Выключи свет в гостиной",
  });
  const elapsedMs = performance.now() - startedAt;
  const requests = hub.requests.slice(from);
  t.diagnostic(
    `20 lamps: ${requests.length} hub requests, ${Math.round(elapsedMs)} ms`,
  );

  assert.equal(sent.status, "ok");
  assert.deepEqual(sent.results.map(itemOutcome), lamps.map(lampSwitchedOff));
  assert.equal(
    new Set(sent.results.map(({ change_ref: ref }) => ref)).size,
    20,
  );
  assert.match(sent.group_ref, /^spruthub-change:\/\/group\/[a-f0-9]{24}$/);
  assert.deepEqual(
    diffHomeSnapshots(homeBefore, hub.snapshot()),
    lamps
      .filter(({ on }) => on)
      .map(({ ref }) => ({
        key: `characteristic/${/accessory\/(\d+)/.exec(ref)[1]}.13.14/On`,
        before: true,
        after: false,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );

  // One by one, each lamp took five requests in a row: about 100 round
  // trips, at least 4 s at this latency. Now a read of every lamp, the
  // writes and a read back go out together.
  const writes = valueWrites(requests);
  assert.equal(writes.length, 20);
  assert.ok(
    requests.length <= 3 * 20,
    `${requests.length} hub requests: ${requests.map(({ method }) => method).join(", ")}`,
  );
  assert.ok(
    elapsedMs < 25 * LATENCY_MS,
    `the call took ${Math.round(elapsedMs)} ms`,
  );
  // The hub answered the writes in another order than they reached it
  // (records follow the answers); each result is still its own lamp's
  // (checked above).
  const received = [...writes].sort(
    (left, right) => left.received_ms - right.received_ms,
  );
  assert.notDeepEqual(
    received.map(({ seq }) => seq),
    writes.map(({ seq }) => seq),
  );
});

test("«верни как было» after the 20 lamps puts back every lamp the call switched off", async (t) => {
  const { hub, client } = await setup(t);
  const refs = await livingRoomLampRefs(client);
  const lamps = lampsInState(hub, refs);
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: refs.map((ref) => ({ target_ref: ref, value: false })),
    reason: "Выключи свет в гостиной",
  });
  assert.equal(sent.status, "ok");

  const from = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  assert.equal(restored.summary.restored, 20);
  assert.deepEqual(
    valueWrites(hub.requests.slice(from)).map(writeOf).sort(),
    lamps
      .filter(({ on }) => on)
      .map(({ aId }) => [`${aId}.14`, true])
      .sort(),
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});

test("lamps, curtains and two thermostats in one call end as asked, a device's own commands one after another", async (t) => {
  const { hub, client } = await setup(t);
  const homeBefore = hub.snapshot();

  const from = hub.requests.length;
  const sent = await send(
    client,
    [
      [CHANDELIER_LEVEL, 30],
      [STRIP_LEVEL, 40],
      [STRIP_ON, true],
      [FLOOR_ON, false],
      [CURTAIN_TARGET, 50],
      // Heating.
      [AC_MODE, 1],
      [AC_SETPOINT, 25],
      [GUEST_FLOOR_SETPOINT, 26],
    ],
    "Приглушить люстру, включить ленту на 40%, выключить торшер, прикрыть шторы и сделать теплее",
  );
  const requests = hub.requests.slice(from);

  assert.equal(sent.status, "ok", JSON.stringify(sent.results));
  assert.deepEqual(
    sent.results.map(({ type, status, previous_value, observed_value }) => [
      type,
      status,
      previous_value,
      observed_value,
    ]),
    [
      ["Brightness", "applied", 80, 30],
      ["Brightness", "applied", 100, 40],
      ["On", "applied", false, true],
      ["On", "applied", true, false],
      ["TargetPosition", "applied", 100, 50],
      ["TargetHeatingCoolingState", "applied", 0, 1],
      ["TargetTemperature", "applied", 23, 25],
      ["TargetTemperature", "applied", 24, 26],
    ],
  );
  assert.deepEqual(
    diffHomeSnapshots(homeBefore, hub.snapshot()).map(
      ({ key, before, after }) => [key, before, after],
    ),
    [
      ["characteristic/113.13.17/TargetTemperature", 24, 26],
      ["characteristic/15.13.15/Brightness", 80, 30],
      ["characteristic/16.13.14/On", true, false],
      ["characteristic/17.13.14/On", false, true],
      ["characteristic/17.13.15/Brightness", 100, 40],
      ["characteristic/18.13.16/TargetPosition", 100, 50],
      ["characteristic/19.13.15/TargetHeatingCoolingState", 0, 1],
      ["characteristic/19.13.17/TargetTemperature", 23, 25],
    ],
  );
  const writes = valueWrites(requests);
  assert.equal(writes.length, 8);
  const writesTo = (aId) =>
    writes.filter(({ params }) => params.characteristic.update.aId === aId);
  assert.deepEqual(writesTo(19).map(writeOf), [
    ["19.15", 1],
    ["19.17", 25],
  ]);
  assertOneAfterAnother(writesTo(19));
  assert.deepEqual(writesTo(17).map(writeOf), [
    ["17.15", 40],
    ["17.14", true],
  ]);
  assertOneAfterAnother(writesTo(17));
});

// The owner's hub acknowledges a value out of range and stores another one
// (Brightness 150 → 100, 2026-10-13-parallel-writes, 5): the product refuses
// it before anything is sent.
test("a level out of range among commands to several devices is refused before any write", async (t) => {
  const { hub, client } = await setup(t);
  const from = hub.requests.length;
  const refused = await client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [
        { target_ref: refOf(FLOOR_ON), value: false },
        { target_ref: refOf(CHANDELIER_LEVEL), value: 150 },
        { target_ref: refOf(CURTAIN_TARGET), value: 50 },
      ],
      reason: "Выключить торшер, люстру на полную и прикрыть шторы",
    },
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, "invalid_device_commands");
  assert.deepEqual(
    refused.structuredContent.invalid_commands.map(({ index, code }) => [
      index,
      code,
    ]),
    [[1, "invalid_native_value"]],
  );
  assert.deepEqual(valueWrites(hub.requests.slice(from)), []);
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});

test("a write to one lamp lost on its way leaves that lamp uncertain and the other 19 reported as before", async (t) => {
  const timeoutMs = 1_500;
  const lost = SPOTS[4];
  const { hub, client } = await setup(t, {
    timeoutMs,
    faults: {
      droppedReply: [
        { method: "characteristic.update", aId: lost.id, applied: false },
      ],
    },
  });
  const refs = await livingRoomLampRefs(client);
  const lamps = lampsInState(hub, refs);

  const startedAt = performance.now();
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: refs.map((ref) => ({ target_ref: ref, value: false })),
    reason: "Выключи свет в гостиной",
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(sent.status, "incomplete");
  assert.equal(sent.summary.applied, 19);
  assert.equal(sent.summary.uncertain, 1);
  for (const [index, lamp] of lamps.entries()) {
    const item = sent.results[index];
    if (lamp.aId !== lost.id) {
      assert.deepEqual(itemOutcome(item), lampSwitchedOff(lamp));
      continue;
    }
    assert.deepEqual(
      {
        status: item.status,
        sent: item.sent,
        observed_value: item.observed_value,
        next: item.next,
      },
      {
        status: "uncertain",
        sent: true,
        observed_value: true,
        next: {
          tool: "get_native_change",
          arguments: { change_ref: item.change_ref },
        },
      },
    );
  }
  for (const lamp of lamps) {
    assert.equal(
      currentValue(hub, characteristic(lamp.aId, 14)),
      lamp.aId === lost.id,
    );
  }
  // The lost write cost its own timeout once, not the other lamps'.
  assert.ok(
    elapsedMs < timeoutMs + 25 * LATENCY_MS,
    `the call took ${Math.round(elapsedMs)} ms`,
  );
});

test("a lamp told «off, then 70 %» ends off at 70 and its commands reach it one after another", async (t) => {
  const { hub, client } = await setup(t);
  const from = hub.requests.length;
  const sent = await send(
    client,
    [
      [FLOOR_ON, false],
      [FLOOR_LEVEL, 70],
      // Off at 100: order does not change the end, so it is kept.
      [STRIP_ON, true],
      [STRIP_LEVEL, 40],
    ],
    "Выключить торшер и поставить ему 70%, включить ленту на 40%",
  );

  assert.equal(sent.status, "ok", JSON.stringify(sent.results));
  assert.deepEqual(
    sent.results.map(({ type, status, previous_value, observed_value }) => [
      type,
      status,
      previous_value,
      observed_value,
    ]),
    [
      ["On", "applied", true, false],
      ["Brightness", "applied", 55, 70],
      ["On", "applied", false, true],
      ["Brightness", "applied", 100, 40],
    ],
  );
  assert.equal(currentValue(hub, FLOOR_ON), false);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 70);
  assert.equal(currentValue(hub, STRIP_ON), true);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
  const writes = valueWrites(hub.requests.slice(from));
  const floor = writes.filter(
    ({ params }) => params.characteristic.update.aId === 16,
  );
  const strip = writes.filter(
    ({ params }) => params.characteristic.update.aId === 17,
  );
  // A level switches the lamp on, so it goes before the off.
  assert.deepEqual(floor.map(writeOf), [
    ["16.15", 70],
    ["16.14", false],
  ]);
  assert.deepEqual(strip.map(writeOf), [
    ["17.14", true],
    ["17.15", 40],
  ]);
  assertOneAfterAnother(floor);
  assertOneAfterAnother(strip);
});

// On the hub's lamps a level write switches an off lamp on, even to the
// level it already has (2026-10-13-lamp-logic-undo, 1 and F9): sent before
// the off, it would light the lamp for a moment.
test("a lamp that is off and told «off, then 70 %» gets no level write and never lights", async (t) => {
  const { hub, client } = await setup(t);
  const spot = SPOTS[1]; // off at 31
  const spotOn = characteristic(spot.id, 14);
  const spotLevel = characteristic(spot.id, 15);
  const homeBefore = hub.snapshot();
  const from = hub.requests.length;
  const sent = await send(
    client,
    [
      [STRIP_ON, false],
      [STRIP_LEVEL, 70],
      [spotOn, false],
      [spotLevel, spot.level],
    ],
    "Выключить ленту и поставить ей 70%, выключить спот на его яркости",
  );

  // An off is still delivered to a lamp that is off; no level is.
  assert.deepEqual(valueWrites(hub.requests.slice(from)).map(writeOf).sort(), [
    ["17.14", false],
    [`${spot.id}.14`, false],
  ]);
  assert.deepEqual(diffHomeSnapshots(homeBefore, hub.snapshot()), []);
  assert.deepEqual(
    sent.results.map(({ type, status, sent: wasSent, observed_value }) => [
      type,
      status,
      wasSent,
      observed_value,
    ]),
    [
      ["On", "applied", true, false],
      ["Brightness", "not_sent", false, undefined],
      ["On", "applied", true, false],
      // The level asked for is the one the lamp already has.
      ["Brightness", "already_desired", false, spot.level],
    ],
  );
  const level = sent.results[1];
  assert.equal(level.change_ref, null);
  assert.equal(level.note?.code, "lamp_level_not_sent", JSON.stringify(level));
  assert.equal(typeof level.note.message, "string");
  assert.equal(level.warning, undefined);
  assert.equal(sent.status, "incomplete");
});

test("brightness 0 on a lamp switches it off, keeps its level and is undone to on", async (t) => {
  const { hub, client } = await setup(t);
  const from = hub.requests.length;
  const sent = await send(
    client,
    [[CHANDELIER_LEVEL, 0]],
    "Убавить люстру до нуля",
  );

  assert.equal(sent.status, "ok", JSON.stringify(sent.results));
  const [item] = sent.results;
  assert.deepEqual(itemOutcome(item), {
    target_ref: refOf(CHANDELIER_LEVEL),
    name: "Люстра / Люстра",
    type: "Brightness",
    requested: 0,
    status: "applied",
    sent: true,
    previous_value: true,
    observed_value: false,
    restore_supported: true,
  });
  assert.deepEqual(item.sent_as, {
    target_ref: refOf(CHANDELIER_ON),
    type: "On",
    value: false,
  });
  assert.equal(item.note?.code, "lamp_level_zero_is_off");
  assert.equal(typeof item.note.message, "string");
  assert.deepEqual(valueWrites(hub.requests.slice(from)).map(writeOf), [
    ["15.14", false],
  ]);
  assert.equal(currentValue(hub, CHANDELIER_ON), false);
  assert.equal(currentValue(hub, CHANDELIER_LEVEL), 80);

  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  assert.equal(currentValue(hub, CHANDELIER_ON), true);
  assert.equal(currentValue(hub, CHANDELIER_LEVEL), 80);
});

test("brightness 0 beside an On command to the same lamp is refused before any write", async (t) => {
  const { hub, client } = await setup(t);
  const refused = await client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [
        { target_ref: refOf(CHANDELIER_ON), value: false },
        { target_ref: refOf(CHANDELIER_LEVEL), value: 0 },
      ],
      reason: "Выключить люстру",
    },
  });
  assert.equal(refused.isError, true);
  assert.deepEqual(
    refused.structuredContent.invalid_commands.map(({ index, code }) => [
      index,
      code,
    ]),
    [[1, "duplicate_target"]],
  );
  assert.deepEqual(valueWrites(hub.requests), []);
});

test("a level alone that switches an off lamp on says so", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await send(
    client,
    [
      [STRIP_LEVEL, 40],
      [CHANDELIER_LEVEL, 30],
    ],
    "Поставить ленту на 40%, люстру на 30%",
  );

  assert.equal(sent.status, "ok", JSON.stringify(sent.results));
  const [strip, chandelier] = sent.results;
  assert.equal(strip.note?.code, "lamp_switched_on", JSON.stringify(strip));
  assert.equal(typeof strip.note.message, "string");
  // The chandelier was already on.
  assert.equal(chandelier.note, undefined, JSON.stringify(chandelier));
  assert.equal(currentValue(hub, STRIP_ON), true);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
});
