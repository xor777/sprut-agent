import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  diffHomeSnapshots,
  evaluateRulesOnChange,
  homeSnapshot,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// Virtual switches, buttons and sensors the owner asks for by voice:
// «Сделай виртуальный выключатель „Режим гостей“ в гостиной», «Добавь
// виртуальный датчик протечки в ванную … сымитируй протечку», «Удали кнопку
// Десерт». The hub's behaviour the simulator follows is in
// research/protocol/2026-10-23-virtual-devices.md.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const LIVING_ROOM = 3;
const BATHROOM = 8;
const roomRef = (id) => `${homeRef}/room/${id}`;
const accessoryRef = (id) => `${homeRef}/accessory/${id}`;
// «Десерт»: a virtual scene button of the owner's kind that starts one
// BLOCK, exported to Alice.
const DESSERT = 40;
const DESSERT_SCENE = "20";
// A virtual switch with nothing referring to it.
const GUEST_MODE = 41;

function withVirtualDevices(fixture) {
  fixture.accessories.push(
    {
      id: DESSERT,
      roomId: LIVING_ROOM,
      name: "Десерт",
      virtual: true,
      services: [
        {
          sId: 13,
          type: "StatelessProgrammableSwitch",
          name: "Десерт",
          characteristics: [
            { cId: 14, type: "Name", value: "Десерт" },
            { cId: 15, type: "ProgrammableSwitchEvent", value: 0 },
          ],
        },
      ],
    },
    {
      id: GUEST_MODE,
      roomId: LIVING_ROOM,
      name: "Режим гостей",
      virtual: true,
      services: [
        {
          sId: 13,
          type: "Switch",
          name: "Режим гостей",
          characteristics: [
            { cId: 14, type: "Name", value: "Режим гостей" },
            { cId: 15, type: "On", value: false },
          ],
        },
      ],
    },
  );
  fixture.scenarios.push({
    index: DESSERT_SCENE,
    name: "Сцена Десерт",
    desc: "",
    type: "BLOCK",
    active: true,
    data: {
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
                aId: DESSERT,
                sId: 13,
                cId: 15,
                hs: "StatelessProgrammableSwitch",
                hc: "ProgrammableSwitchEvent",
                cond: "=",
                value: "0",
                trigger: true,
                time: 0,
                timeCond: "",
              },
            ],
          },
          // biome-ignore lint/suspicious/noThenProperty: native SprutHub BLOCK key.
          then: [
            {
              type: "service",
              aId: 16,
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
    },
  });
  const alice = fixture.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:yandex",
  );
  alice.exported[String(DESSERT)] = [13];
  return fixture;
}

async function setup(t, { patch = (fixture) => fixture, faults } = {}) {
  const hub = await startSimulatedHub(
    patch(withVirtualDevices(await loadHomeFixture("apartment"))),
    { faults },
  );
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-virtual-devices-"),
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
  const client = new Client({ name: "virtual-devices-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, before: homeSnapshot(hub.state) };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function refused(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

function prepareDevice(client, { room = LIVING_ROOM, name, type }) {
  return call(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: roomRef(room),
    name,
    value: type,
    reason: "Просьба владельца",
  });
}

async function createDevice(client, input) {
  const prepared = await prepareDevice(client, input);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.next?.tool, "apply_native_change");
  return call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
}

function writes(hub, method) {
  return hub.requests.filter((request) => request.method === method);
}

function created(hub, before) {
  const known = new Set(
    Object.keys(before)
      .filter((key) => key.startsWith("accessory/"))
      .map((key) => Number(key.split("/")[1])),
  );
  return hub.state.accessories.filter(({ id }) => !known.has(id));
}

function ownServices(accessory) {
  return accessory.services.filter(
    ({ type }) => type !== "AccessoryInformation",
  );
}

function readingOf(hub, { aId, sId, cId }) {
  const characteristic = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find((service) => service.sId === sId)
    .characteristics.find((entry) => entry.cId === cId);
  return Object.values(characteristic.control.value)[0];
}

test("«Сделай виртуальный выключатель „Режим гостей“ в гостиной» creates one virtual switch there, even when the hub answers slowly", async (t) => {
  const { hub, client, before } = await setup(t, {
    // No switch of that name yet; the hub takes longer to create than to
    // answer an ordinary request (4-9 s live).
    patch: (fixture) => {
      fixture.accessories = fixture.accessories.filter(
        ({ id }) => id !== GUEST_MODE,
      );
      return fixture;
    },
  });
  hub.delayReplies("accessory.create", 3_000);
  const applied = await createDevice(client, {
    name: "Режим гостей",
    type: "Switch",
  });
  assert.equal(applied.status, "applied");
  const [device, ...others] = created(hub, before);
  assert.deepEqual(others, []);
  assert.equal(device.name, "Режим гостей");
  assert.equal(device.roomId, LIVING_ROOM);
  assert.equal(device.virtual, true);
  assert.deepEqual(
    ownServices(device).map(({ type, name }) => ({ type, name })),
    [{ type: "Switch", name: "Режим гостей" }],
  );
  assert.equal(applied.device.ref, accessoryRef(device.id));
  assert.equal(applied.device.room.name, "Гостиная");
  assert.equal(writes(hub, "accessory.create").length, 1);

  const page = await call(client, "find_devices", {
    home_ref: homeRef,
    room_ref: roomRef(LIVING_ROOM),
  });
  const names = page.rooms.flatMap((room) =>
    room.devices.map(({ name }) => name),
  );
  assert.equal(names.filter((name) => name === "Режим гостей").length, 1);
  // Nothing of the owner's changed.
  assert.deepEqual(
    diffHomeSnapshots(before, homeSnapshot(hub.state)).filter(
      ({ key }) =>
        !key.includes(`/${device.id}`) && !key.includes(`${device.id}.`),
    ),
    [],
  );
});

test("a name too long, a type not offered or a missing room is refused before any write", async (t) => {
  const { hub, client } = await setup(t);
  const tooLong = await refused(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: roomRef(LIVING_ROOM),
    name: "Очень длинное имя виртуального выключателя",
    value: "Switch",
    reason: "Просьба владельца",
  });
  assert.equal(tooLong.error.code, "name_too_long");
  const thermostat = await refused(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: roomRef(LIVING_ROOM),
    name: "Термостат",
    value: "Thermostat",
    reason: "Просьба владельца",
  });
  assert.equal(thermostat.error.code, "unsupported_virtual_device_type");
  const noRoom = await refused(client, "prepare_native_change", {
    operation: "virtual_device",
    target_ref: homeRef,
    room_ref: roomRef(99),
    name: "Режим",
    value: "Switch",
    reason: "Просьба владельца",
  });
  assert.equal(noRoom.error.code, "room_not_found");
  assert.deepEqual(writes(hub, "accessory.create"), []);
});

test("a virtual device of the same name in the room is named to the owner and not created", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareDevice(client, {
    name: "Режим гостей",
    type: "Switch",
  });
  assert.equal(typeof prepared.tell_owner, "string");
  assert.equal(prepared.next, undefined);
  assert.deepEqual(prepared.matching_devices, [
    { ref: accessoryRef(GUEST_MODE), name: "Режим гостей" },
  ]);
  assert.deepEqual(writes(hub, "accessory.create"), []);
});

test("a lost create reply is unknown with the new device as a candidate, and undo deletes nothing", async (t) => {
  const { hub, client, before } = await setup(t, {
    faults: { droppedReply: [{ method: "accessory.create" }] },
  });
  const prepared = await prepareDevice(client, {
    name: "Ночной режим",
    type: "Switch",
  });
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "uncertain");
  const [device] = created(hub, before);
  assert.deepEqual(applied.candidate_devices, [
    { ref: accessoryRef(device.id), name: "Ночной режим" },
  ]);
  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "not_owned");
  assert.deepEqual(writes(hub, "accessory.delete"), []);
  assert.equal(writes(hub, "accessory.create").length, 1);
});

test("undo of a creation deletes only that device, and not while a scenario refers to it", async (t) => {
  const { hub, client, before } = await setup(t);
  const applied = await createDevice(client, {
    room: BATHROOM,
    name: "Тест протечки",
    type: "LeakSensor",
  });
  const [sensor] = created(hub, before);
  // The owner builds a scenario on it in the app.
  const scene = structuredClone(
    hub.state.scenarios.find(({ index }) => index === DESSERT_SCENE),
  );
  const leak = ownServices(sensor)[0].characteristics.find(
    ({ control }) => control.type === "LeakDetected",
  );
  const data = JSON.parse(scene.data);
  Object.assign(data.targets[0].if.conditions[0], {
    aId: sensor.id,
    sId: leak.sId,
    cId: leak.cId,
    hs: "LeakSensor",
    hc: "LeakDetected",
    value: "1",
  });
  hub.state.scenarios.push({
    ...scene,
    index: "21",
    name: "Протечка: свет",
    data: JSON.stringify(data),
  });
  const blocked = await call(client, "restore_native_change", {
    change_ref: applied.change_ref,
  });
  assert.equal(blocked.status, "conflict");
  assert.equal(blocked.conflict_reason, "virtual_device_in_use");
  assert.deepEqual(
    blocked.dependencies.scenarios.map(({ name }) => name),
    ["Протечка: свет"],
  );
  assert.deepEqual(writes(hub, "accessory.delete"), []);

  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== "21",
  );
  const restored = await call(client, "restore_native_change", {
    change_ref: applied.change_ref,
  });
  assert.equal(restored.status, "restored");
  assert.deepEqual(
    writes(hub, "accessory.delete").map(
      ({ params }) => params.accessory.delete.id,
    ),
    [sensor.id],
  );
  assert.deepEqual(diffHomeSnapshots(before, homeSnapshot(hub.state)), []);
});

test("«сымитируй протечку» writes the virtual leak sensor, the reading shows it and an active scenario on it fires", async (t) => {
  const { hub, client, before } = await setup(t);
  await createDevice(client, {
    room: BATHROOM,
    name: "Тест протечки",
    type: "LeakSensor",
  });
  const [sensor] = created(hub, before);
  const service = ownServices(sensor)[0];
  const leak = service.characteristics.find(
    ({ control }) => control.type === "LeakDetected",
  );
  const leakRef = `${accessoryRef(sensor.id)}/service/${service.sId}/characteristic/${leak.cId}`;
  const page = await call(client, "find_devices", {
    home_ref: homeRef,
    room_ref: roomRef(BATHROOM),
    values: true,
  });
  const shown = page.rooms
    .flatMap((room) => room.devices)
    .find(({ name }) => name === "Тест протечки")
    .services[0].characteristics.find(({ type }) => type === "LeakDetected");
  assert.equal(shown.writable, true);

  // The owner's scenario: a leak in the bathroom switches the floor lamp on.
  const block = await call(client, "prepare_native_change", {
    operation: "block_create",
    target_ref: homeRef,
    name: "Протечка: торшер",
    active: true,
    data: {
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
                aId: sensor.id,
                sId: service.sId,
                cId: leak.cId,
                hs: "LeakSensor",
                hc: "LeakDetected",
                cond: "=",
                value: "1",
                trigger: true,
                time: 0,
                timeCond: "",
              },
            ],
          },
          // biome-ignore lint/suspicious/noThenProperty: native SprutHub BLOCK key.
          then: [
            {
              type: "service",
              aId: 16,
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
    },
    reason: "Сценарий на протечку",
  });
  const blockApplied = await call(client, "apply_native_change", {
    change_ref: block.change_ref,
  });
  assert.equal(blockApplied.status, "applied");

  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [{ target_ref: leakRef, value: 1 }],
    reason: "Сымитировать протечку",
  });
  assert.equal(sent.results[0].status, "applied", JSON.stringify(sent));
  assert.equal(sent.results[0].observed_value, 1);
  assert.equal(readingOf(hub, leak), 1);
  const rules = evaluateRulesOnChange(hub.state, {
    preset: [{ ...leak, value: 0 }],
    change: { aId: leak.aId, sId: leak.sId, cId: leak.cId, value: 1 },
  });
  assert.deepEqual(
    rules.fired.map(
      (index) => hub.state.scenarios.find((s) => s.index === index).name,
    ),
    ["Протечка: торшер"],
  );

  // A value the sensor does not have is refused before any write, and a
  // physical sensor's reading is never written.
  const updates = writes(hub, "characteristic.update").length;
  const invalid = await refused(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [{ target_ref: leakRef, value: 7 }],
    reason: "Сымитировать протечку",
  });
  assert.ok(invalid.error);
  const physical = await refused(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${accessoryRef(37)}/service/13/characteristic/14`,
        value: 1,
      },
    ],
    reason: "Сымитировать протечку",
  });
  assert.ok(physical.error);
  assert.equal(writes(hub, "characteristic.update").length, updates);

  // «Верни как было» puts the reading back.
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(readingOf(hub, leak), 0, JSON.stringify(restored));
});

test("pressing a virtual button is sent each time, says it is a press and is not undone", async (t) => {
  const { hub, client } = await setup(t);
  const press = `${accessoryRef(DESSERT)}/service/13/characteristic/15`;
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [{ target_ref: press, value: 0 }],
    reason: "Запустить сцену Десерт",
  });
  const [result] = sent.results;
  assert.equal(result.status, "applied", JSON.stringify(sent));
  assert.equal(result.sent, true);
  assert.equal(result.restore_supported, false);
  assert.match(result.note, /press/);
  assert.equal(writes(hub, "characteristic.update").length, 1);
  // A physical button cannot be pressed from here.
  await refused(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${accessoryRef(39)}/service/13/characteristic/14`,
        value: 0,
      },
    ],
    reason: "Нажать кнопку",
  });
  assert.equal(writes(hub, "characteristic.update").length, 1);
});

test("«Удали кнопку Десерт» names the scenario it starts before anything is deleted; undo brings the button back without its links", async (t) => {
  const { hub, client, before } = await setup(t);
  const prepared = await call(client, "prepare_native_change", {
    operation: "virtual_device_delete",
    target_ref: accessoryRef(DESSERT),
    reason: "Удалить кнопку Десерт",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(typeof prepared.tell_owner, "string");
  assert.equal(prepared.next, undefined);
  assert.deepEqual(
    prepared.dependencies.scenarios.map(({ name }) => name),
    ["Сцена Десерт"],
  );
  assert.deepEqual(
    prepared.dependencies.bridges.map(({ name }) => name),
    ["Яндекс Алиса"],
  );
  assert.deepEqual(writes(hub, "accessory.delete"), []);

  // The owner says yes.
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.equal(
    hub.state.accessories.some(({ id }) => id === DESSERT),
    false,
  );
  assert.ok(hub.state.scenarios.some(({ index }) => index === DESSERT_SCENE));

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  const [again] = created(hub, before);
  assert.notEqual(again.id, DESSERT);
  assert.equal(again.name, "Десерт");
  assert.equal(again.roomId, LIVING_ROOM);
  assert.deepEqual(
    ownServices(again).map(({ type, name }) => ({ type, name })),
    [{ type: "StatelessProgrammableSwitch", name: "Десерт" }],
  );
  assert.equal(restored.recreated_device.ref, accessoryRef(again.id));
  assert.match(JSON.stringify(restored.not_restored), /Сцена Десерт/);
});

test("a virtual device nothing refers to is deleted without asking, and a physical one never", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await call(client, "prepare_native_change", {
    operation: "virtual_device_delete",
    target_ref: accessoryRef(GUEST_MODE),
    reason: "Удалить режим гостей",
  });
  assert.equal(prepared.tell_owner, undefined);
  assert.equal(prepared.next?.tool, "apply_native_change");
  const lamp = await refused(client, "prepare_native_change", {
    operation: "virtual_device_delete",
    target_ref: accessoryRef(16),
    reason: "Удалить торшер",
  });
  assert.equal(lamp.error.code, "not_a_virtual_device");
  assert.deepEqual(writes(hub, "accessory.delete"), []);
});
