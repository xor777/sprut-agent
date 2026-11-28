import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SprutHubClient } from "../src/spruthub-client.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOME_REF = "spruthub://hub/sim-apartment-01";
const LIVING_ROOM_ID = 3;
const LIVING_ROOM_REF = `${HOME_REF}/room/${LIVING_ROOM_ID}`;
const HALLWAY_ROOM_REF = `${HOME_REF}/room/1`;
const STUDY_ROOM_ID = 7;
const STUDY_ROOM_REF = `${HOME_REF}/room/${STUDY_ROOM_ID}`;

const CHANDELIER_REF = `${HOME_REF}/accessory/15/service/13`; // Люстра
const FLOOR_LAMP_REF = `${HOME_REF}/accessory/16/service/13`; // Торшер (Свет)
const LED_STRIP_REF = `${HOME_REF}/accessory/17/service/13`; // Светодиодная лента (Лента)
const CURTAINS_REF = `${HOME_REF}/accessory/18/service/13`; // Шторы
const AC_REF = `${HOME_REF}/accessory/19/service/13`; // Кондиционер
const TV_OUTLET_REF = `${HOME_REF}/accessory/20/service/13`; // Розетка (hidden in setup)
const SYSTEM_SVC_REF = `${HOME_REF}/accessory/15/service/99`; // system: true service
const ACC_INFO_REF = `${HOME_REF}/accessory/15/service/1`; // AccessoryInformation
const OTHER_ROOM_SVC_REF = `${HOME_REF}/accessory/12/service/13`; // Прихожая Lightbulb

function configureLivingRoomTiles(fixture) {
  const byId = new Map(fixture.accessories.map((acc) => [acc.id, acc]));
  // Ordered tiles: Торшер (1, 2x1), Люстра (2, 1x1), Шторы (3, 1x1)
  // Unsorted tiles: Лента (0, 1x1), Кондиционер (0, 1x1)
  // Hidden tile: Розетка (visible: false, order: 4)
  // System service on Люстра: sId 99 (system: true)
  byId.get(15).services[0].grid = { order: 2, width: 1, height: 1 };
  byId.get(15).services.push({
    sId: 99,
    type: "ProtocolInformation",
    name: "Системная служба",
    system: true,
    visible: true,
    grid: { order: 1, width: 1, height: 1 },
    characteristics: [],
  });
  byId.get(16).services[0].grid = { order: 1, width: 2, height: 1 };
  byId.get(17).services[0].grid = { order: 0, width: 1, height: 1 };
  byId.get(18).services[0].grid = { order: 3, width: 1, height: 1 };
  byId.get(19).services[0].grid = { order: 0, width: 1, height: 1 };
  byId.get(20).services[0].visible = false;
  byId.get(20).services[0].grid = { order: 4, width: 1, height: 1 };
}

async function setup(t, mutateFixture, hubOptions = {}) {
  const fixture = await loadHomeFixture("apartment");
  configureLivingRoomTiles(fixture);
  if (mutateFixture) mutateFixture(fixture);
  const hub = await startSimulatedHub(fixture, hubOptions);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-room-service-order-"),
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
  const client = new Client({
    name: "room-service-order-test",
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
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function prepareAndApply(client, args) {
  const prepared = await call(client, "prepare_native_change", args);
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.next?.tool, "apply_native_change");
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  return { prepared, applied };
}

test("get_entity(room_ref) returns tile_order in SprutHub display order (1..N then 0) on both small and large rooms without changing presentServiceGrid", async (t) => {
  const { hub, client } = await setup(t, (fixture) => {
    // Expand room 7 (Кабинет) above ROOM_LISTING_SERVICE_LIMIT (20 services).
    const studyLamp = fixture.accessories.find((acc) => acc.id === 32);
    studyLamp.services[0].grid = { order: 2, width: 1, height: 1 };
    const otherStudyAccs = fixture.accessories.filter(
      (acc) => acc.roomId === STUDY_ROOM_ID && acc.id !== 32,
    );
    otherStudyAccs[0].services[0].grid = { order: 1, width: 1, height: 1 };
    for (let id = 201; id <= 210; id += 1) {
      const clone = structuredClone(studyLamp);
      clone.id = id;
      clone.name = `Лампа ${id}`;
      clone.services[0].name = `Свет ${id}`;
      clone.services[0].grid = {
        order: id === 205 ? 3 : 0,
        width: 1,
        height: 1,
      };
      fixture.accessories.push(clone);
    }
  });

  // 1. Small room (<= 20 services): Гостиная
  const living = (
    await call(client, "get_entity", { entity_ref: LIVING_ROOM_REF })
  ).entity;
  assert.deepEqual(living.tile_order, [
    {
      service_ref: FLOOR_LAMP_REF,
      name: "Свет",
      type: "Lightbulb",
      order: 1,
    },
    {
      service_ref: CHANDELIER_REF,
      name: "Люстра",
      type: "Lightbulb",
      order: 2,
    },
    {
      service_ref: CURTAINS_REF,
      name: "Шторы",
      type: "WindowCovering",
      order: 3,
    },
    {
      service_ref: LED_STRIP_REF,
      name: "Лента",
      type: "Lightbulb",
      order: 0,
    },
    {
      service_ref: AC_REF,
      name: "Кондиционер",
      type: "Thermostat",
      order: 0,
    },
  ]);
  // Hidden, system, and AccessoryInformation services must NOT appear in tile_order.
  const livingRefs = living.tile_order.map(({ service_ref }) => service_ref);
  assert.equal(livingRefs.includes(TV_OUTLET_REF), false);
  assert.equal(livingRefs.includes(SYSTEM_SVC_REF), false);
  assert.equal(livingRefs.includes(ACC_INFO_REF), false);

  // 2. Large room (> 20 services): Кабинет returns BOTH next=find_devices AND tile_order!
  const study = (
    await call(client, "get_entity", { entity_ref: STUDY_ROOM_REF })
  ).entity;
  assert.ok(study.service_count > 20);
  assert.equal(study.next?.tool, "find_devices");
  assert.ok(Array.isArray(study.tile_order));
  assert.equal(study.tile_order.length, 14);
  assert.deepEqual(
    study.tile_order.slice(0, 3).map(({ order }) => order),
    [1, 2, 3],
  );
  assert.equal(
    study.tile_order[2].service_ref,
    `${HOME_REF}/accessory/205/service/13`,
  );
  assert.ok(study.tile_order.slice(3).every(({ order }) => order === 0));

  // 3. presentServiceGrid on service entity keeps exact { width, height } shape!
  const floorLamp = (
    await call(client, "get_entity", { entity_ref: FLOOR_LAMP_REF })
  ).entity;
  assert.deepEqual(floorLamp.grid, { width: 2, height: 1 });
  assert.deepEqual(hub.writes(), []);
});

test("tool budget, contract with/without target_ref, and inline contract on invalid args", async (t) => {
  const { hub, client } = await setup(t);

  // Tool count remains 13 and prepare_native_change keeps zero new top-level fields.
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  const prepareTool = tools.find(
    ({ name }) => name === "prepare_native_change",
  );
  assert.ok(prepareTool);
  assert.equal(
    Object.hasOwn(prepareTool.inputSchema.properties, "tile_order"),
    false,
  );
  assert.equal(
    Object.hasOwn(prepareTool.inputSchema.properties, "orders"),
    false,
  );

  // Contract WITHOUT target_ref
  const general = await call(client, "get_native_change_contract", {
    operation: "room_service_order",
  });
  assert.equal(general.status, "ok");
  assert.equal(general.operation, "room_service_order");
  assert.equal(general.contract.restore_supported, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(general.contract), "utf8") < 4_096,
  );

  // Contract WITH valid room target_ref
  const targeted = await call(client, "get_native_change_contract", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
  });
  assert.equal(targeted.status, "ok");
  assert.equal(targeted.target_ref, LIVING_ROOM_REF);
  assert.equal(targeted.contract.restore_supported, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(targeted.contract), "utf8") < 4_096,
  );

  // Contract WITH missing room -> room_not_found
  const missingContract = await callError(
    client,
    "get_native_change_contract",
    {
      operation: "room_service_order",
      target_ref: `${HOME_REF}/room/99999`,
    },
  );
  assert.equal(missingContract.error.code, "room_not_found");

  // Invalid args on prepare_native_change attach compact contract inline
  const badPos = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    position: 99,
    reason: "Неверная позиция",
  });
  assert.equal(badPos.error.code, "invalid_native_value");
  assert.match(badPos.error.message, /0.*4/);
  assert.ok(badPos.contract);
  assert.ok(Buffer.byteLength(JSON.stringify(badPos.contract), "utf8") < 4_096);

  const unexpectedField = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    value: "extra",
    reason: "Лишнее поле",
  });
  assert.equal(unexpectedField.error.code, "invalid_native_change");
  assert.ok(unexpectedField.contract);

  assert.deepEqual(hub.writes(), []);
});

test("partial reorder (default position 0) preserves relative order and 2x1 grid size, and restore brings back exact baseline including order 0", async (t) => {
  const { hub, client } = await setup(t);

  const prepared = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Поставить Ленту первой в гостиной",
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.operation, "room_service_order");
  assert.equal(prepared.room.ref, LIVING_ROOM_REF);
  assert.equal(prepared.room.name, "Гостиная");
  assert.equal(prepared.next?.tool, "apply_native_change");
  assert.deepEqual(
    prepared.before_order.map(({ service_ref, order }) => ({
      service_ref,
      order,
    })),
    [
      { service_ref: FLOOR_LAMP_REF, order: 1 },
      { service_ref: CHANDELIER_REF, order: 2 },
      { service_ref: CURTAINS_REF, order: 3 },
      { service_ref: LED_STRIP_REF, order: 0 },
      { service_ref: AC_REF, order: 0 },
    ],
  );
  assert.deepEqual(
    prepared.after_order.map(({ service_ref, order }) => ({
      service_ref,
      order,
    })),
    [
      { service_ref: LED_STRIP_REF, order: 1 },
      { service_ref: FLOOR_LAMP_REF, order: 2 },
      { service_ref: CHANDELIER_REF, order: 3 },
      { service_ref: CURTAINS_REF, order: 4 },
      { service_ref: AC_REF, order: 5 },
    ],
  );
  assert.equal(prepared.moved_services.length, 1);
  assert.equal(prepared.moved_services[0].service_ref, LED_STRIP_REF);
  assert.deepEqual(hub.writes(), []);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.restore_supported, true);

  // Verify wire request sent ONLY grid.order (no width/height).
  const orderReqs = hub.requests.filter(
    ({ method }) => method === "service.orders",
  );
  assert.equal(orderReqs.length, 1);
  for (const entry of orderReqs[0].params.service.orders.orders) {
    assert.deepEqual(Object.keys(entry.grid), ["order"]);
  }

  // Verify live room tile_order updated AND Торшер kept 2x1 width/height!
  const afterRoom = (
    await call(client, "get_entity", { entity_ref: LIVING_ROOM_REF })
  ).entity;
  assert.deepEqual(
    afterRoom.tile_order.map(({ service_ref, order }) => ({
      service_ref,
      order,
    })),
    [
      { service_ref: LED_STRIP_REF, order: 1 },
      { service_ref: FLOOR_LAMP_REF, order: 2 },
      { service_ref: CHANDELIER_REF, order: 3 },
      { service_ref: CURTAINS_REF, order: 4 },
      { service_ref: AC_REF, order: 5 },
    ],
  );
  const floorLampAfter = (
    await call(client, "get_entity", { entity_ref: FLOOR_LAMP_REF })
  ).entity;
  assert.deepEqual(floorLampAfter.grid, { width: 2, height: 1 });

  // Restore exact baseline including order: 0 on Лента and Кондиционер!
  const restored = await call(client, "restore_native_change", {
    change_ref: applied.change_ref,
  });
  assert.equal(restored.status, "restored");
  const restoredRoom = (
    await call(client, "get_entity", { entity_ref: LIVING_ROOM_REF })
  ).entity;
  assert.deepEqual(
    restoredRoom.tile_order.map(({ service_ref, order }) => ({
      service_ref,
      order,
    })),
    [
      { service_ref: FLOOR_LAMP_REF, order: 1 },
      { service_ref: CHANDELIER_REF, order: 2 },
      { service_ref: CURTAINS_REF, order: 3 },
      { service_ref: LED_STRIP_REF, order: 0 },
      { service_ref: AC_REF, order: 0 },
    ],
  );
  const floorLampRestored = (
    await call(client, "get_entity", { entity_ref: FLOOR_LAMP_REF })
  ).entity;
  assert.deepEqual(floorLampRestored.grid, { width: 2, height: 1 });

  // Calling apply again on a restored change MUST NOT mutate or resend!
  const writesBeforeReapply = hub.writes().length;
  const reapplied = await call(client, "apply_native_change", {
    change_ref: applied.change_ref,
  });
  assert.equal(reapplied.status, "restored");
  assert.equal(hub.writes().length, writesBeforeReapply);
});

test("multi-tile block with explicit position, full room reorder, and already_desired (0 writes)", async (t) => {
  const { hub, client } = await setup(t);

  // 1. Multi-tile block [AC, CURTAINS] inserted at position 1 (after FLOOR_LAMP)
  const { applied: blockMove } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [AC_REF, CURTAINS_REF],
    position: 1,
    reason: "Поставить климат и шторы после торшера",
  });
  let room = (await call(client, "get_entity", { entity_ref: LIVING_ROOM_REF }))
    .entity;
  assert.deepEqual(
    room.tile_order.map(({ service_ref, order }) => ({ service_ref, order })),
    [
      { service_ref: FLOOR_LAMP_REF, order: 1 },
      { service_ref: AC_REF, order: 2 },
      { service_ref: CURTAINS_REF, order: 3 },
      { service_ref: CHANDELIER_REF, order: 4 },
      { service_ref: LED_STRIP_REF, order: 5 },
    ],
  );

  // 2. already_desired when current orders already match target 1..N (0 writes!)
  const writesBeforeAlready = hub.writes().length;
  const already = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [AC_REF, CURTAINS_REF],
    position: 1,
    reason: "Уже в нужном порядке",
  });
  assert.equal(already.status, "already_desired");
  assert.equal(already.operation, "room_service_order");
  assert.equal(already.native_write_sent, false);
  assert.equal(hub.writes().length, writesBeforeAlready);

  // 3. Full room reorder (all 5 visible tiles; remaining.length === 0, position 0)
  const { applied: fullReorder } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [
      CHANDELIER_REF,
      FLOOR_LAMP_REF,
      LED_STRIP_REF,
      AC_REF,
      CURTAINS_REF,
    ],
    reason: "Выстроить в гостиной свет, климат, шторы",
  });
  room = (await call(client, "get_entity", { entity_ref: LIVING_ROOM_REF }))
    .entity;
  assert.deepEqual(
    room.tile_order.map(({ service_ref, order }) => ({ service_ref, order })),
    [
      { service_ref: CHANDELIER_REF, order: 1 },
      { service_ref: FLOOR_LAMP_REF, order: 2 },
      { service_ref: LED_STRIP_REF, order: 3 },
      { service_ref: AC_REF, order: 4 },
      { service_ref: CURTAINS_REF, order: 5 },
    ],
  );

  // Restore both in one batch call (newest first!)
  const batchRestore = await call(client, "restore_native_change", {
    change_refs: [blockMove.change_ref, fullReorder.change_ref],
  });
  assert.equal(batchRestore.status, "ok");
  assert.equal(batchRestore.summary.restored, 2);
  room = (await call(client, "get_entity", { entity_ref: LIVING_ROOM_REF }))
    .entity;
  assert.deepEqual(
    room.tile_order.map(({ service_ref, order }) => ({ service_ref, order })),
    [
      { service_ref: FLOOR_LAMP_REF, order: 1 },
      { service_ref: CHANDELIER_REF, order: 2 },
      { service_ref: CURTAINS_REF, order: 3 },
      { service_ref: LED_STRIP_REF, order: 0 },
      { service_ref: AC_REF, order: 0 },
    ],
  );
});

test("prepare refusals cover missing room, foreign room service, duplicates, system/AccessoryInformation, hidden service, out-of-range position, and unexpected fields", async (t) => {
  const { hub, client } = await setup(t);

  // Missing room -> room_not_found WITHOUT inline contract
  const missingRoom = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: `${HOME_REF}/room/99999`,
    member_service_refs: [FLOOR_LAMP_REF],
    reason: "Несуществующая комната",
  });
  assert.equal(missingRoom.error.code, "room_not_found");
  assert.equal(missingRoom.contract, undefined);

  // Service from another room
  const foreignService = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [OTHER_ROOM_SVC_REF],
    reason: "Сервис из другой комнаты",
  });
  assert.equal(foreignService.error.code, "invalid_native_value");
  assert.ok(foreignService.contract);

  // Missing service on existing accessory
  const missingService = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [`${HOME_REF}/accessory/15/service/777`],
    reason: "Несуществующий сервис",
  });
  assert.equal(missingService.error.code, "invalid_native_value");

  // Duplicate refs
  const duplicate = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [FLOOR_LAMP_REF, FLOOR_LAMP_REF],
    reason: "Дубликат",
  });
  assert.equal(duplicate.error.code, "invalid_native_value");

  // AccessoryInformation
  const accInfo = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [ACC_INFO_REF],
    reason: "AccessoryInformation",
  });
  assert.equal(accInfo.error.code, "invalid_native_value");

  // System service (system: true)
  const systemSvc = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [SYSTEM_SVC_REF],
    reason: "Системный сервис",
  });
  assert.equal(systemSvc.error.code, "invalid_native_value");

  // Hidden service (visible: false) -> mentions service_visible
  const hiddenSvc = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [TV_OUTLET_REF],
    reason: "Скрытый сервис",
  });
  assert.equal(hiddenSvc.error.code, "invalid_native_value");
  assert.match(hiddenSvc.error.message, /service_visible/);

  // Out-of-range position when ordering all 5 tiles (remaining.length === 0)
  const fullBadPos = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [
      CHANDELIER_REF,
      FLOOR_LAMP_REF,
      LED_STRIP_REF,
      AC_REF,
      CURTAINS_REF,
    ],
    position: 1,
    reason: "Позиция 1 при перестановке всех плиток",
  });
  assert.equal(fullBadPos.error.code, "invalid_native_value");
  assert.match(fullBadPos.error.message, /0/);

  // Missing member_service_refs
  const missingMembers = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    reason: "Без списка плиток",
  });
  assert.equal(missingMembers.error.code, "invalid_native_value");
  assert.ok(missingMembers.contract);

  // Unexpected field
  const unexpected = await callError(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    name: "Лишнее имя",
    reason: "Лишнее поле name",
  });
  assert.equal(unexpected.error.code, "invalid_native_change");
  assert.ok(unexpected.contract);

  assert.deepEqual(hub.writes(), []);
});

test("conflicts (room_layout_changed_since, manual_change, later_owned_change), read-only get_native_change, and history filtering", async (t) => {
  const { hub, client } = await setup(t);

  // 1. room_layout_changed_since between prepare and apply (0 writes!)
  const pDrift = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Проверка конфликта раскладки до apply",
  });
  hub.request({
    service: {
      orders: {
        orders: [
          { aId: 15, sId: 13, grid: { order: 1 } },
          { aId: 16, sId: 13, grid: { order: 2 } },
        ],
      },
    },
  });
  const writesBeforeDrift = hub.writes().length;
  const aDrift = await call(client, "apply_native_change", {
    change_ref: pDrift.change_ref,
  });
  assert.equal(aDrift.status, "conflict");
  assert.equal(aDrift.conflict_reason, "room_layout_changed_since");
  assert.equal(hub.writes().length, writesBeforeDrift);

  // Restoring a pre-write conflict returns not_owned with 0 writes.
  const rDrift = await call(client, "restore_native_change", {
    change_ref: pDrift.change_ref,
  });
  assert.equal(rDrift.status, "not_owned");
  assert.equal(rDrift.conflict_reason, "change_was_not_applied");
  assert.equal(hub.writes().length, writesBeforeDrift);

  // 2. later_owned_change between two room_service_order changes on the same room
  const { applied: c1 } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Поднять ленту первой",
  });
  const { applied: c2 } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [AC_REF],
    reason: "Поднять кондиционер первым",
  });

  // History lists room_service_order and filters by room_ref, moved service, and accessory (not unrelated room).
  const roomHist = await call(client, "get_native_change", {
    entity_ref: LIVING_ROOM_REF,
    limit: 20,
  });
  const c1EntryBefore = roomHist.changes.find(
    ({ change_ref }) => change_ref === c1.change_ref,
  );
  assert.ok(c1EntryBefore);
  assert.equal(c1EntryBefore.operation, "room_service_order");
  assert.equal(c1EntryBefore.name, "Гостиная");
  assert.equal(c1EntryBefore.restore_supported, true);
  assert.ok(c1EntryBefore.value?.from && c1EntryBefore.value?.to);

  for (const filterRef of [LED_STRIP_REF, `${HOME_REF}/accessory/17`]) {
    const filtered = await call(client, "get_native_change", {
      entity_ref: filterRef,
      limit: 20,
    });
    assert.ok(
      filtered.changes.some(({ change_ref }) => change_ref === c1.change_ref),
      `history filter ${filterRef} must match c1`,
    );
  }
  const unrelatedHist = await call(client, "get_native_change", {
    entity_ref: HALLWAY_ROOM_REF,
    limit: 20,
  });
  assert.equal(
    unrelatedHist.changes.some(
      ({ change_ref }) => change_ref === c1.change_ref,
    ),
    false,
  );

  // Read-only get_native_change sends 0 writes and does not bump updated_at.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const writesBeforeGet = hub.writes().length;
  const inspectedC1 = await call(client, "get_native_change", {
    change_ref: c1.change_ref,
  });
  assert.equal(inspectedC1.status, "applied");
  assert.equal(hub.writes().length, writesBeforeGet);
  const roomHistAfter = await call(client, "get_native_change", {
    entity_ref: LIVING_ROOM_REF,
    limit: 20,
  });
  const c1EntryAfter = roomHistAfter.changes.find(
    ({ change_ref }) => change_ref === c1.change_ref,
  );
  assert.equal(c1EntryAfter.updated_at, c1EntryBefore.updated_at);

  // Restoring c1 before c2 refuses with later_owned_change naming c2!
  const writesBeforeLater = hub.writes().length;
  const refuseC1 = await call(client, "restore_native_change", {
    change_ref: c1.change_ref,
  });
  assert.equal(refuseC1.status, "conflict");
  assert.equal(refuseC1.conflict_reason, "later_owned_change");
  assert.equal(refuseC1.restore_first_change_ref, c2.change_ref);
  assert.equal(hub.writes().length, writesBeforeLater);

  // Restore c2 first, then c1 succeeds!
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: c2.change_ref,
      })
    ).status,
    "restored",
  );
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: c1.change_ref,
      })
    ).status,
    "restored",
  );

  // 3. manual_change before restore (0 writes!)
  const { applied: cManual } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [CURTAINS_REF],
    reason: "Поднять шторы первыми",
  });
  hub.request({
    service: {
      orders: {
        orders: [
          { aId: 19, sId: 13, grid: { order: 1 } },
          { aId: 18, sId: 13, grid: { order: 2 } },
        ],
      },
    },
  });
  const writesBeforeManual = hub.writes().length;
  const rManual = await call(client, "restore_native_change", {
    change_ref: cManual.change_ref,
  });
  assert.equal(rManual.status, "conflict");
  assert.equal(rManual.conflict_reason, "manual_change");
  assert.equal(hub.writes().length, writesBeforeManual);
});

test("uncertain/dropped reply recovery and refused write + retry on apply and restore", async (t) => {
  const { hub, client } = await setup(t);

  // 1. Refused apply -> not_applied with rejection, then retry succeeds!
  const pRefused = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Повтор после отказа хаба",
  });
  hub.refuseNext("service.orders", {
    code: -32000,
    message: "service reorder busy",
  });
  const refusedErr = await callError(client, "apply_native_change", {
    change_ref: pRefused.change_ref,
  });
  assert.equal(refusedErr.hub_effect, "not_applied");
  assert.equal(refusedErr.rejection?.protocol_code, -32000);

  const inspectedRefused = await call(client, "get_native_change", {
    change_ref: pRefused.change_ref,
  });
  assert.equal(inspectedRefused.status, "not_applied");

  // Retry apply succeeds and clears rejection.
  const retriedApply = await call(client, "apply_native_change", {
    change_ref: pRefused.change_ref,
  });
  assert.equal(retriedApply.status, "applied");
  assert.equal(retriedApply.write_intent?.rejection, undefined);

  // 2. Refused restore -> stays applied with rejection, then retry restore succeeds!
  hub.refuseNext("service.orders", {
    code: -32001,
    message: "restore busy",
  });
  const refusedRestore = await callError(client, "restore_native_change", {
    change_ref: retriedApply.change_ref,
  });
  assert.equal(refusedRestore.hub_effect, "not_applied");
  assert.equal(refusedRestore.rejection?.protocol_code, -32001);

  const retriedRestore = await call(client, "restore_native_change", {
    change_ref: retriedApply.change_ref,
  });
  assert.equal(retriedRestore.status, "restored");
  assert.equal(retriedRestore.write_intent?.rejection, undefined);

  // 3. Dropped reply on apply (applied on hub, ACK lost) -> recovers via readback without resend!
  const pDropApply = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Потерянный ACK при apply",
  });
  const ordersBeforeDropApply = hub.requests.filter(
    ({ method }) => method === "service.orders",
  ).length;
  hub.state.faults.droppedReply.push({
    method: "service.orders",
    remaining: 1,
  });
  const aDropApply = await call(client, "apply_native_change", {
    change_ref: pDropApply.change_ref,
  });
  assert.equal(aDropApply.status, "applied");
  assert.equal(aDropApply.recovered_after_uncertain_write, true);
  assert.equal(
    hub.requests.filter(({ method }) => method === "service.orders").length,
    ordersBeforeDropApply + 1,
  );

  // 4. Dropped reply on restore (applied on hub, ACK lost) -> recovers to restored without resend!
  const ordersBeforeDropRestore = hub.requests.filter(
    ({ method }) => method === "service.orders",
  ).length;
  hub.state.faults.droppedReply.push({
    method: "service.orders",
    remaining: 1,
  });
  const rDropRestore = await call(client, "restore_native_change", {
    change_ref: aDropApply.change_ref,
  });
  assert.equal(rDropRestore.status, "restored");
  assert.equal(rDropRestore.recovered_after_uncertain_write, true);
  assert.equal(
    hub.requests.filter(({ method }) => method === "service.orders").length,
    ordersBeforeDropRestore + 1,
  );

  // 5. Lost request on apply -> uncertain; get_native_change and restore_native_change do NOT resend!
  //    AND a later uncertain room_service_order blocks restoring an earlier applied one (later_owned_change),
  //    whereas a later pre-write refused (not_applied) one does NOT block restoring an earlier applied one!
  const { applied: cEarlierForGuard } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Раннее изменение для проверки later_owned_change",
  });
  // Later change refused pre-write -> not_applied -> must NOT block restoring cEarlierForGuard later.
  const pLaterRefused = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [AC_REF],
    reason: "Отклонённое более позднее изменение",
  });
  hub.refuseNext("service.orders", {
    code: -32002,
    message: "rejected pre-write",
  });
  const laterRefusedErr = await callError(client, "apply_native_change", {
    change_ref: pLaterRefused.change_ref,
  });
  assert.equal(laterRefusedErr.hub_effect, "not_applied");

  // Restore cEarlierForGuard succeeds despite later not_applied change!
  const restoredPastRefused = await call(client, "restore_native_change", {
    change_ref: cEarlierForGuard.change_ref,
  });
  assert.equal(restoredPastRefused.status, "restored");

  // Now apply cEarlier2, followed by a later uncertain apply (lost request).
  const { applied: cEarlier2 } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [LED_STRIP_REF],
    reason: "Раннее изменение перед uncertain",
  });
  const pLoseApply = await call(client, "prepare_native_change", {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [AC_REF],
    reason: "Потерянный запрос при apply",
  });
  const ordersBeforeLoseApply = hub.requests.filter(
    ({ method }) => method === "service.orders",
  ).length;
  hub.loseNext("service.orders");
  const aLoseApply = await call(client, "apply_native_change", {
    change_ref: pLoseApply.change_ref,
  });
  assert.equal(aLoseApply.status, "uncertain");
  const gLoseApply = await call(client, "get_native_change", {
    change_ref: pLoseApply.change_ref,
  });
  assert.equal(gLoseApply.status, "uncertain");
  const rLoseApply = await call(client, "restore_native_change", {
    change_ref: pLoseApply.change_ref,
  });
  assert.equal(rLoseApply.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ method }) => method === "service.orders").length,
    ordersBeforeLoseApply + 1,
    "lost apply request must never be blindly resent",
  );
  // Restoring cEarlier2 while pLoseApply is still uncertain must refuse with later_owned_change!
  const blockedByUncertain = await call(client, "restore_native_change", {
    change_ref: cEarlier2.change_ref,
  });
  assert.equal(blockedByUncertain.status, "conflict");
  assert.equal(blockedByUncertain.conflict_reason, "later_owned_change");
  assert.equal(
    blockedByUncertain.restore_first_change_ref,
    pLoseApply.change_ref,
  );
  assert.equal(
    hub.requests.filter(({ method }) => method === "service.orders").length,
    ordersBeforeLoseApply + 1,
  );

  // 6. Lost request on restore -> uncertain; get_native_change sends 0 writes; retry restore completes!
  const { applied: cLoseRestore } = await prepareAndApply(client, {
    operation: "room_service_order",
    target_ref: LIVING_ROOM_REF,
    member_service_refs: [CURTAINS_REF],
    reason: "Потерянный запрос при restore",
  });
  const ordersBeforeLoseRestore = hub.requests.filter(
    ({ method }) => method === "service.orders",
  ).length;
  hub.loseNext("service.orders");
  const rLose1 = await call(client, "restore_native_change", {
    change_ref: cLoseRestore.change_ref,
  });
  assert.equal(rLose1.status, "uncertain");
  const gLoseRestore = await call(client, "get_native_change", {
    change_ref: cLoseRestore.change_ref,
  });
  assert.equal(gLoseRestore.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ method }) => method === "service.orders").length,
    ordersBeforeLoseRestore + 1,
    "get_native_change on uncertain restore must send 0 writes",
  );
  const rLose2 = await call(client, "restore_native_change", {
    change_ref: cLoseRestore.change_ref,
  });
  assert.equal(rLose2.status, "restored");
});

test("review return 1: uncertain restore with later owned changes (S0, S2, cyclic S1) always reports later_owned_change via both get and restore with 0 writes", async (t) => {
  const orderedLivingRoom = (fixture) => {
    const byId = new Map(fixture.accessories.map((acc) => [acc.id, acc]));
    byId.get(16).services[0].grid = { order: 1, width: 2, height: 1 };
    byId.get(15).services[0].grid = { order: 2, width: 1, height: 1 };
    byId.get(18).services[0].grid = { order: 3, width: 1, height: 1 };
    byId.get(17).services[0].grid = { order: 4, width: 1, height: 1 };
    byId.get(19).services[0].grid = { order: 5, width: 1, height: 1 };
  };

  // Case A: C1 (S0 -> S1), uncertain restore, then C2 returns room to S0.
  // Check both restore_native_change(C1) first AND get_native_change(C1) first.
  for (const checkFirst of ["restore", "get"]) {
    await t.test(
      `C2 returning to S0 detected via ${checkFirst}_native_change first`,
      async (subT) => {
        const { hub, client } = await setup(subT, orderedLivingRoom);
        const { applied: c1 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [LED_STRIP_REF],
          reason: "C1: S0 -> S1",
        });
        hub.loseNext("service.orders");
        const lostRestore = await call(client, "restore_native_change", {
          change_ref: c1.change_ref,
        });
        assert.equal(lostRestore.status, "uncertain");

        const { applied: c2 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [
            FLOOR_LAMP_REF,
            CHANDELIER_REF,
            CURTAINS_REF,
            LED_STRIP_REF,
            AC_REF,
          ],
          reason: "C2: S1 -> S0",
        });
        const writesBefore = hub.writes().length;

        const firstTool =
          checkFirst === "get" ? "get_native_change" : "restore_native_change";
        const secondTool =
          checkFirst === "get" ? "restore_native_change" : "get_native_change";
        const r1 = await call(client, firstTool, { change_ref: c1.change_ref });
        assert.equal(r1.status, "conflict");
        assert.equal(r1.conflict_reason, "later_owned_change");
        assert.equal(r1.restore_first_change_ref, c2.change_ref);
        assert.equal(r1.recovered_after_uncertain_write, undefined);
        assert.equal(hub.writes().length, writesBefore);

        const r2 = await call(client, secondTool, {
          change_ref: c1.change_ref,
        });
        assert.equal(r2.status, "conflict");
        assert.equal(r2.conflict_reason, "later_owned_change");
        assert.equal(r2.restore_first_change_ref, c2.change_ref);
        assert.equal(hub.writes().length, writesBefore);
      },
    );
  }

  // Case B: C1 (S0 -> S1), uncertain restore, then C2 moves to S2 (neither S0 nor S1).
  for (const checkFirst of ["get", "restore"]) {
    await t.test(
      `C2 moving to S2 detected via ${checkFirst}_native_change first`,
      async (subT) => {
        const { hub, client } = await setup(subT, orderedLivingRoom);
        const { applied: c1 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [LED_STRIP_REF],
          reason: "C1: S0 -> S1",
        });
        hub.loseNext("service.orders");
        assert.equal(
          (
            await call(client, "restore_native_change", {
              change_ref: c1.change_ref,
            })
          ).status,
          "uncertain",
        );

        const { applied: c2 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [AC_REF],
          reason: "C2: S1 -> S2",
        });
        const writesBefore = hub.writes().length;

        const firstTool =
          checkFirst === "get" ? "get_native_change" : "restore_native_change";
        const secondTool =
          checkFirst === "get" ? "restore_native_change" : "get_native_change";
        const r1 = await call(client, firstTool, { change_ref: c1.change_ref });
        assert.equal(r1.status, "conflict");
        assert.equal(r1.conflict_reason, "later_owned_change");
        assert.equal(r1.restore_first_change_ref, c2.change_ref);
        assert.equal(hub.writes().length, writesBefore);

        const r2 = await call(client, secondTool, {
          change_ref: c1.change_ref,
        });
        assert.equal(r2.status, "conflict");
        assert.equal(r2.conflict_reason, "later_owned_change");
        assert.equal(r2.restore_first_change_ref, c2.change_ref);
        assert.equal(hub.writes().length, writesBefore);
      },
    );
  }

  // Case C: C1 (S0 -> S1), uncertain restore, then cyclic C2 (S1 -> S2) -> C3 (S2 -> S1).
  for (const checkFirst of ["get", "restore"]) {
    await t.test(
      `cyclic C2->C3 back to S1 detected via ${checkFirst}_native_change first with 0 writes`,
      async (subT) => {
        const { hub, client } = await setup(subT, orderedLivingRoom);
        const { applied: c1 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [LED_STRIP_REF],
          reason: "C1: S0 -> S1",
        });
        hub.loseNext("service.orders");
        assert.equal(
          (
            await call(client, "restore_native_change", {
              change_ref: c1.change_ref,
            })
          ).status,
          "uncertain",
        );

        const { applied: c2 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [AC_REF],
          reason: "C2: S1 -> S2",
        });
        const { applied: c3 } = await prepareAndApply(client, {
          operation: "room_service_order",
          target_ref: LIVING_ROOM_REF,
          member_service_refs: [
            LED_STRIP_REF,
            FLOOR_LAMP_REF,
            CHANDELIER_REF,
            CURTAINS_REF,
            AC_REF,
          ],
          reason: "C3: S2 -> S1",
        });
        const writesBefore = hub.writes().length;

        const firstTool =
          checkFirst === "get" ? "get_native_change" : "restore_native_change";
        const secondTool =
          checkFirst === "get" ? "restore_native_change" : "get_native_change";
        const r1 = await call(client, firstTool, { change_ref: c1.change_ref });
        assert.equal(r1.status, "conflict");
        assert.equal(r1.conflict_reason, "later_owned_change");
        assert.equal(r1.restore_first_change_ref, c3.change_ref);
        assert.equal(hub.writes().length, writesBefore);

        const r2 = await call(client, secondTool, {
          change_ref: c1.change_ref,
        });
        assert.equal(r2.status, "conflict");
        assert.equal(r2.conflict_reason, "later_owned_change");
        assert.equal(r2.restore_first_change_ref, c3.change_ref);
        assert.equal(hub.writes().length, writesBefore);

        // Unwinding C3 -> C2 -> C1 succeeds cleanly.
        assert.equal(
          (
            await call(client, "restore_native_change", {
              change_ref: c3.change_ref,
            })
          ).status,
          "restored",
        );
        assert.equal(
          (
            await call(client, "restore_native_change", {
              change_ref: c2.change_ref,
            })
          ).status,
          "restored",
        );
        assert.equal(
          (
            await call(client, "restore_native_change", {
              change_ref: c1.change_ref,
            })
          ).status,
          "restored",
        );
      },
    );
  }
});

test("review return 1: retried not_applied C1 applied after C2/C3 restores without deadlock, restore_supported parity, inline contract on non-service ref, and tile_order name redaction", async (t) => {
  const { hub, client } = await setup(t, (fixture) => {
    const byId = new Map(fixture.accessories.map((acc) => [acc.id, acc]));
    byId.get(16).services[0].grid = { order: 1, width: 2, height: 1 };
    byId.get(15).services[0].grid = { order: 2, width: 1, height: 1 };
    byId.get(18).services[0].grid = { order: 3, width: 1, height: 1 };
    byId.get(17).services[0].grid = { order: 4, width: 1, height: 1 };
    byId.get(19).services[0].grid = { order: 5, width: 1, height: 1 };
  });

  await t.test(
    "P1-2: retried not_applied C1 applied after C2/C3 restores cleanly without deadlock",
    async () => {
      const pC1 = await call(client, "prepare_native_change", {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [LED_STRIP_REF],
        reason: "C1: S0 -> S1 (будет отклонён и повторён позже)",
      });
      hub.refuseNext("service.orders", {
        code: -32000,
        message: "temporary hub busy",
      });
      const c1Refused = await callError(client, "apply_native_change", {
        change_ref: pC1.change_ref,
      });
      assert.equal(c1Refused.hub_effect, "not_applied");

      await new Promise((resolve) => setTimeout(resolve, 10));
      const { applied: c2 } = await prepareAndApply(client, {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [AC_REF],
        reason: "C2: S0 -> S2",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const { applied: c3 } = await prepareAndApply(client, {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [
          FLOOR_LAMP_REF,
          CHANDELIER_REF,
          CURTAINS_REF,
          LED_STRIP_REF,
          AC_REF,
        ],
        reason: "C3: S2 -> S0",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const c1Applied = await call(client, "apply_native_change", {
        change_ref: pC1.change_ref,
      });
      assert.equal(c1Applied.status, "applied");

      const c1Restored = await call(client, "restore_native_change", {
        change_ref: c1Applied.change_ref,
      });
      assert.equal(c1Restored.status, "restored");
      assert.equal(
        (
          await call(client, "restore_native_change", {
            change_ref: c3.change_ref,
          })
        ).status,
        "restored",
      );
      assert.equal(
        (
          await call(client, "restore_native_change", {
            change_ref: c2.change_ref,
          })
        ).status,
        "restored",
      );
    },
  );

  await t.test(
    "P2: restore_supported parity on manual_change (false) vs later_owned_change (true) in detail and history",
    async (subT) => {
      const { hub: p2Hub, client: p2Client } = await setup(subT, (fixture) => {
        const byId = new Map(fixture.accessories.map((acc) => [acc.id, acc]));
        byId.get(16).services[0].grid = { order: 1, width: 2, height: 1 };
        byId.get(15).services[0].grid = { order: 2, width: 1, height: 1 };
        byId.get(18).services[0].grid = { order: 3, width: 1, height: 1 };
        byId.get(17).services[0].grid = { order: 4, width: 1, height: 1 };
        byId.get(19).services[0].grid = { order: 5, width: 1, height: 1 };
      });
      const { applied: cFirst } = await prepareAndApply(p2Client, {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [LED_STRIP_REF],
        reason: "Первое для проверки restore_supported",
      });
      const { applied: cSecond } = await prepareAndApply(p2Client, {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [AC_REF],
        reason: "Второе для проверки restore_supported",
      });
      const laterConflict = await call(p2Client, "restore_native_change", {
        change_ref: cFirst.change_ref,
      });
      assert.equal(laterConflict.status, "conflict");
      assert.equal(laterConflict.conflict_reason, "later_owned_change");
      assert.equal(laterConflict.restore_supported, true);
      const laterDetail = await call(p2Client, "get_native_change", {
        change_ref: cFirst.change_ref,
      });
      assert.equal(laterDetail.restore_supported, true);
      const laterHistory = (
        await call(p2Client, "get_native_change", {
          entity_ref: LIVING_ROOM_REF,
          limit: 20,
        })
      ).changes.find(({ change_ref }) => change_ref === cFirst.change_ref);
      assert.equal(laterHistory?.restore_supported, true);

      p2Hub.request({
        service: {
          orders: {
            orders: [
              { aId: 18, sId: 13, grid: { order: 1 } },
              { aId: 19, sId: 13, grid: { order: 2 } },
            ],
          },
        },
      });
      const manualConflict = await call(p2Client, "restore_native_change", {
        change_ref: cSecond.change_ref,
      });
      assert.equal(manualConflict.status, "conflict");
      assert.equal(manualConflict.conflict_reason, "manual_change");
      assert.equal(manualConflict.restore_supported, false);
      const manualDetail = await call(p2Client, "get_native_change", {
        change_ref: cSecond.change_ref,
      });
      assert.equal(manualDetail.restore_supported, false);
      const manualHistory = (
        await call(p2Client, "get_native_change", {
          entity_ref: LIVING_ROOM_REF,
          limit: 20,
        })
      ).changes.find(({ change_ref }) => change_ref === cSecond.change_ref);
      assert.equal(manualHistory?.restore_supported, false);
    },
  );

  await t.test(
    "P3-1: non-service ref in member_service_refs returns invalid_native_value with inline contract",
    async () => {
      const nonServiceErr = await callError(client, "prepare_native_change", {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [`${HOME_REF}/accessory/15`],
        reason: "Передан accessory_ref вместо service_ref",
      });
      assert.equal(nonServiceErr.error.code, "invalid_native_value");
      assert.ok(nonServiceErr.contract);
      assert.ok(
        Buffer.byteLength(JSON.stringify(nonServiceErr.contract), "utf8") <
          4_096,
      );

      const crossHomeErr = await callError(client, "prepare_native_change", {
        operation: "room_service_order",
        target_ref: LIVING_ROOM_REF,
        member_service_refs: [
          "spruthub://hub/other-home/accessory/15/service/13",
        ],
        reason: "Сервис другого дома",
      });
      assert.equal(crossHomeErr.error.code, "unsupported_home_write");
    },
  );

  await t.test(
    "P3-2: direct SprutHubClient.getEntity(room_ref) redacts secret-shaped text in tile_order[].name",
    async (subT) => {
      const secretToken = "ghp_1234567890abcdef1234567890abcdef1234";
      const chandelier = hub.state.accessories.find(({ id }) => id === 15);
      chandelier.services.find(({ sId }) => sId === 13).name =
        `Люстра ${secretToken}`;
      const env = hub.connectionEnv();
      const rawClient = new SprutHubClient({
        url: env.SPRUTHUB_URL,
        token: env.SPRUTHUB_TOKEN,
        serial: env.SPRUTHUB_SERIAL,
        cid: env.SPRUTHUB_CID,
        timeoutMs: 2_000,
      });
      subT.after(() => rawClient.close());
      const rawRoom = await rawClient.getEntity(LIVING_ROOM_REF, []);
      const chandelierTile = rawRoom.entity.tile_order.find(
        ({ service_ref }) => service_ref === CHANDELIER_REF,
      );
      assert.ok(chandelierTile);
      assert.equal(chandelierTile.name.includes(secretToken), false);
      assert.match(chandelierTile.name, /\[REDACTED\]/);
    },
  );
});
