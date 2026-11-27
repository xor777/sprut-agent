import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NATIVE_CHANGE_OPERATIONS } from "../src/change-refs.mjs";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const LIVING_ROOM = 3;
const BEDROOM = 4;
const FLOOR_LAMP = 16;

const COMPLEX_CONTRACT_OPERATIONS = new Set([
  "block_create",
  "block_data_update",
  "logic_source_create",
  "logic_source_update",
]);

function roomRef(id) {
  return `${homeRef}/room/${id}`;
}

function accessoryRef(id) {
  return `${homeRef}/accessory/${id}`;
}

async function setup(t) {
  const fixture = await loadHomeFixture("apartment");
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-systemic-ax-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "systemic-ax-fixes-test",
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

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} failed: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return result.structuredContent;
}

test("accessory_placement allows move-only, rename-only, both, detects already_desired, refuses neither with inline contract, and restores cleanly", async (t) => {
  const { hub, client } = await setup(t);
  const lampRef = accessoryRef(FLOOR_LAMP);
  const original = structuredClone(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP),
  );
  assert.equal(original.roomId, LIVING_ROOM);

  // 1. Neither name nor room_ref -> refused with inline compact contract, 0 writes.
  const neither = await callError(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: lampRef,
    reason: "Не указаны ни имя, ни комната",
  });
  assert.equal(neither.error.code, "invalid_native_change");
  assert.ok(
    neither.contract,
    "accessory_placement without name/room_ref must return inline contract",
  );
  assert.equal(neither.contract.current.name, original.name);
  assert.equal(neither.contract.current.room_id, LIVING_ROOM);
  assert.ok(
    Buffer.byteLength(JSON.stringify(neither.contract), "utf8") <= 4_096,
  );

  // 2. Whitespace-only name with room_ref is still refused.
  const blankName = await callError(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: lampRef,
    room_ref: roomRef(BEDROOM),
    name: "   ",
    reason: "Пустое имя при переносе",
  });
  assert.equal(blankName.error.code, "name_required");
  assert.deepEqual(hub.writes(), []);

  // 3. Move-only (room_ref without name) preserves original name and restores cleanly.
  const movePrepared = await callOk(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: lampRef,
    room_ref: roomRef(BEDROOM),
    reason: "Перенести торшер в спальню без переименования",
  });
  assert.equal(movePrepared.status, "prepared");
  assert.equal(movePrepared.diff.name.from, original.name);
  assert.equal(movePrepared.diff.name.to, original.name);
  assert.equal(movePrepared.diff.room.from.ref, roomRef(LIVING_ROOM));
  assert.equal(movePrepared.diff.room.to.ref, roomRef(BEDROOM));

  const moveApplied = await callOk(client, "apply_native_change", {
    change_ref: movePrepared.change_ref,
  });
  assert.equal(moveApplied.status, "applied");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).name,
    original.name,
  );
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).roomId,
    BEDROOM,
  );

  // Move-only to current room -> already_desired without writing.
  const alreadyRoom = await callOk(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: lampRef,
    room_ref: roomRef(BEDROOM),
    reason: "Уже в спальне",
  });
  assert.equal(alreadyRoom.status, "already_desired");

  const moveRestored = await callOk(client, "restore_native_change", {
    change_ref: movePrepared.change_ref,
  });
  assert.equal(moveRestored.status, "restored");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).roomId,
    LIVING_ROOM,
  );

  // 4. Rename-only (name without room_ref) preserves current room and restores cleanly.
  const renamePrepared = await callOk(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: lampRef,
    name: "Торшер у кресла",
    reason: "Переименовать торшер в той же комнате",
  });
  assert.equal(renamePrepared.status, "prepared");
  assert.equal(renamePrepared.diff.name.from, original.name);
  assert.equal(renamePrepared.diff.name.to, "Торшер у кресла");
  assert.equal(renamePrepared.diff.room.from.ref, roomRef(LIVING_ROOM));
  assert.equal(renamePrepared.diff.room.to.ref, roomRef(LIVING_ROOM));

  const renameApplied = await callOk(client, "apply_native_change", {
    change_ref: renamePrepared.change_ref,
  });
  assert.equal(renameApplied.status, "applied");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).name,
    "Торшер у кресла",
  );
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).roomId,
    LIVING_ROOM,
  );

  // Rename-only to current name -> already_desired.
  const alreadyName = await callOk(client, "prepare_native_change", {
    operation: "accessory_placement",
    target_ref: lampRef,
    name: "Торшер у кресла",
    reason: "Имя уже совпадает",
  });
  assert.equal(alreadyName.status, "already_desired");

  const renameRestored = await callOk(client, "restore_native_change", {
    change_ref: renamePrepared.change_ref,
  });
  assert.equal(renameRestored.status, "restored");
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).name,
    original.name,
  );
  assert.equal(
    hub.state.accessories.find(({ id }) => id === FLOOR_LAMP).roomId,
    LIVING_ROOM,
  );
});

test("max_bytes above 32768 is clamped cleanly to 32768 across find_devices, get_entity, read_hub_log, and configuration_point instead of failing with -32602", async (t) => {
  const { client } = await setup(t);

  // 1. find_devices with max_bytes=60000 succeeds cleanly and fits within 32768 bytes.
  const devicesResult = await client.callTool({
    name: "find_devices",
    arguments: { home_ref: homeRef, max_bytes: 60_000 },
  });
  assert.equal(
    devicesResult.isError,
    undefined,
    `find_devices with max_bytes=60000 failed: ${devicesResult.content[0]?.text}`,
  );
  assert.ok(
    Buffer.byteLength(devicesResult.content[0].text, "utf8") <= 32_768,
    "find_devices response must respect clamped 32768 byte cap",
  );

  // 2. get_entity with max_bytes=65536 succeeds cleanly (and clamps page.max_bytes to 32768).
  const entityResult = await client.callTool({
    name: "get_entity",
    arguments: {
      entity_ref: homeRef,
      include: ["sdk"],
      max_bytes: 65_536,
    },
  });
  assert.equal(
    entityResult.isError,
    undefined,
    `get_entity with max_bytes=65536 failed: ${entityResult.content[0]?.text}`,
  );
  assert.ok(Buffer.byteLength(entityResult.content[0].text, "utf8") <= 32_768);
  if (entityResult.structuredContent.page?.max_bytes !== undefined) {
    assert.equal(entityResult.structuredContent.page.max_bytes, 32_768);
  }

  // 3. read_hub_log with max_bytes=100000 succeeds and reports page.max_bytes === 32768.
  const logResult = await callOk(client, "read_hub_log", {
    home_ref: homeRef,
    max_bytes: 100_000,
  });
  assert.equal(logResult.page.max_bytes, 32_768);

  // 4. configuration_point read with max_bytes=60000 succeeds cleanly and stays within 32768 bytes.
  const savedPoint = await callOk(client, "configuration_point", {
    home_ref: homeRef,
    scope: "home",
    note: "Проверка max_bytes",
  });
  const pointResult = await client.callTool({
    name: "configuration_point",
    arguments: {
      point_ref: savedPoint.point_ref,
      max_bytes: 60_000,
    },
  });
  assert.equal(
    pointResult.isError,
    undefined,
    `configuration_point with max_bytes=60000 failed: ${pointResult.content[0]?.text}`,
  );
  assert.ok(Buffer.byteLength(pointResult.content[0].text, "utf8") <= 32_768);
  if (pointResult.structuredContent.page?.max_bytes !== undefined) {
    assert.equal(pointResult.structuredContent.page.max_bytes, 32_768);
  }
});

test("get_native_change_contract succeeds without target_ref for EVERY operation in NATIVE_CHANGE_OPERATIONS and stays < 4096 B for non-BLOCK/code operations", async (t) => {
  const { hub, client } = await setup(t);

  for (const operation of NATIVE_CHANGE_OPERATIONS) {
    const res = await callOk(client, "get_native_change_contract", {
      operation,
    });
    assert.equal(res.status, "ok", operation);
    assert.equal(res.operation, operation);
    assert.equal(
      typeof res.contract,
      "object",
      `${operation} must return a contract object`,
    );
    assert.ok(res.contract !== null, `${operation} contract must not be null`);
    if (!COMPLEX_CONTRACT_OPERATIONS.has(operation)) {
      const bytes = Buffer.byteLength(JSON.stringify(res.contract), "utf8");
      assert.ok(
        bytes < 4_096,
        `${operation} contract must be < 4096 bytes, got ${bytes}`,
      );
    }
  }

  // Entity-specific contract inspection still returns live target details when target_ref is provided.
  const placementWithTarget = await callOk(
    client,
    "get_native_change_contract",
    {
      operation: "accessory_placement",
      target_ref: accessoryRef(FLOOR_LAMP),
    },
  );
  assert.equal(placementWithTarget.target_ref, accessoryRef(FLOOR_LAMP));
  assert.equal(placementWithTarget.contract.current.room_id, LIVING_ROOM);

  assert.deepEqual(hub.writes(), []);
});
