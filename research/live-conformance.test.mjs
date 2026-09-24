import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AutomationStore } from "../src/automation-store.mjs";
import { SprutHubConnection } from "../src/spruthub-connection.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "../test/support/simulated-hub.mjs";
import * as conformance from "./live-conformance.mjs";

// The sweep is the last line of the live probe: it removes what the product
// created in the run but could not restore. These tests leave such objects
// on the simulated hub through the product itself and check that the sweep
// deletes only an inert object that the product provably owns.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(repoRoot, "research", "live-conformance.mjs");
const prefix = "zz-sprut-agent-probe-20260924T121158Z";
// Rooms carry the run's short name: SprutHub keeps 30 characters of a room
// name, and the product refuses a longer one.
const roomName = "zz-probe-20260924T121158Z";
const runFile = promisify(execFile);

// No test here may reach a real hub: a connection built from this process's
// environment, as the probe builds one, finds no credentials.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("SPRUTHUB_")) delete process.env[name];
}
const noCredentials = await mkdtemp(
  path.join(tmpdir(), "sprut-agent-no-credentials-"),
);
process.env.XDG_CONFIG_HOME = noCredentials;
after(() => rm(noCredentials, { recursive: true, force: true }));

async function setup(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-sweep-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "5000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const mcp = new Client({ name: "sweep-test", version: "1.0.0" });
  await mcp.connect(transport);
  t.after(async () => {
    await mcp.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, mcp, stateDirectory, homeRef: `spruthub://hub/${hub.serial}` };
}

async function productClient(t, hub) {
  const client = await new SprutHubConnection({
    env: { ...hub.connectionEnv(), SPRUTHUB_TIMEOUT_MS: "5000" },
  }).getClient();
  t.after(() => client.close());
  return client;
}

async function journal(client, stateDirectory) {
  return new AutomationStore({
    directory: stateDirectory,
    hubUrl: client.url,
    hubSerial: client.serial,
  }).list();
}

async function applied(mcp, input) {
  const prepared = await mcp.callTool({
    name: "prepare_native_change",
    arguments: { reason: "Проверка уборки", ...input },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  const result = await mcp.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(result.structuredContent.status, "applied");
  return result.structuredContent;
}

async function createRoom(ctx, name) {
  const result = await applied(ctx.mcp, {
    operation: "room_create",
    target_ref: ctx.homeRef,
    name,
  });
  return {
    ref: result.room.ref,
    id: Number(result.room.ref.split("/").at(-1)),
  };
}

async function createBlock(ctx, name, active) {
  const result = await applied(ctx.mcp, {
    operation: "block_create",
    target_ref: ctx.homeRef,
    name,
    description: "Проба соответствия",
    active,
    on_start: false,
    sync: false,
    data: bathroomLightOnMotion(),
  });
  return {
    ref: result.scenario_ref,
    index: result.scenario_ref.split("/").at(-1),
  };
}

function bathroomLightOnMotion() {
  return {
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
}

function sweepWrites(hub, before) {
  return hub
    .writes()
    .slice(before)
    .map(({ method, params }) => ({ method, params }));
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}

test("the sweep deletes only inert probe objects that the product owns", async (t) => {
  const ctx = await setup(t);
  const { hub } = ctx;
  const ownedRoom = await createRoom(ctx, `${roomName}-r`);
  const ownedBlock = await createBlock(ctx, `${prefix}-block`, false);
  const activeBlock = await createBlock(ctx, `${prefix}-active`, true);
  const occupiedRoom = await createRoom(ctx, `${roomName}-o`);
  hub.state.accessories.find(({ id }) => id === 36).roomId = occupiedRoom.id;
  // The owner replaced the description, and with it the ownership marker.
  const editedBlock = await createBlock(ctx, `${prefix}-edited`, false);
  hub.state.scenarios.find(({ index }) => index === editedBlock.index).desc =
    "Описание владельца";
  // A room with the probe name that the product did not create.
  hub.state.rooms.push({
    id: 900,
    name: `${prefix}-foreign`,
    order: 99,
    visible: true,
  });
  const ownersBlock = await createBlock(ctx, "Свет в ванной", false);

  const client = await productClient(t, hub);
  const writesBefore = hub.writes().length;
  const entries = await conformance.sweepProbeObjects({
    client,
    prefix,
    changes: await journal(client, ctx.stateDirectory),
  });

  assert.deepEqual(entries.sort(byName), [
    {
      kind: "room",
      ref: occupiedRoom.ref,
      name: `${roomName}-o`,
      outcome: "left",
      reason: "not_empty",
    },
    {
      kind: "room",
      ref: ownedRoom.ref,
      name: `${roomName}-r`,
      outcome: "deleted",
    },
    {
      kind: "scenario",
      ref: activeBlock.ref,
      name: `${prefix}-active`,
      outcome: "left",
      reason: "active",
    },
    {
      kind: "scenario",
      ref: ownedBlock.ref,
      name: `${prefix}-block`,
      outcome: "deleted",
    },
    {
      kind: "scenario",
      ref: editedBlock.ref,
      name: `${prefix}-edited`,
      outcome: "left",
      reason: "no_ownership_marker",
    },
    {
      kind: "room",
      ref: `${ctx.homeRef}/room/900`,
      name: `${prefix}-foreign`,
      outcome: "left",
      reason: "no_ownership_marker",
    },
  ]);
  assert.deepEqual(
    sweepWrites(hub, writesBefore).sort((a, b) =>
      a.method.localeCompare(b.method),
    ),
    [
      {
        method: "room.delete",
        params: { room: { delete: { id: ownedRoom.id } } },
      },
      {
        method: "scenario.delete",
        params: { scenario: { delete: { index: ownedBlock.index } } },
      },
    ],
  );
  const indexes = hub.state.scenarios.map(({ index }) => index);
  assert.equal(indexes.includes(ownedBlock.index), false);
  for (const kept of [activeBlock, editedBlock, ownersBlock]) {
    assert.equal(indexes.includes(kept.index), true);
  }
  const roomIds = hub.state.rooms.map(({ id }) => id);
  assert.equal(roomIds.includes(ownedRoom.id), false);
  assert.equal(roomIds.includes(occupiedRoom.id), true);
  assert.equal(roomIds.includes(900), true);
});

// The live probe names its virtual accessory within the hub's 30-character
// accessory name limit and records the created id in the state directory.
const accessoryName = "zz-probe-20260924T121158Z";

async function createVirtual(client, roomId) {
  return client.createAccessory({
    name: accessoryName,
    roomId,
    services: [
      { name: accessoryName, type: "Lightbulb", optional: ["Brightness"] },
    ],
  });
}

async function recordAccessories(stateDirectory, ids) {
  await writeFile(
    path.join(stateDirectory, "probe-accessories.json"),
    `${JSON.stringify({ accessory_ids: ids })}\n`,
  );
}

test("the sweep deletes a recorded, unlinked virtual accessory before its room", async (t) => {
  const ctx = await setup(t);
  const { hub } = ctx;
  const room = await createRoom(ctx, `${roomName}-v`);
  const client = await productClient(t, hub);
  const otherRoomId = hub.state.rooms[0].id;
  const owned = await createVirtual(client, room.id);
  // Same name, but the run has no record of creating it.
  const foreign = await createVirtual(client, otherRoomId);
  // Recorded, but linked to a real lamp: deleting it would change that lamp.
  const linked = await createVirtual(client, otherRoomId);
  const on = linked.services[0].characteristics.find(
    ({ control }) => control.type === "On",
  );
  await client.addVirtualLink({
    aId: linked.id,
    sId: linked.services[0].sId,
    cId: on.cId,
    tAId: 35,
    tSId: 13,
    tCId: 14,
  });

  const writesBefore = hub.writes().length;
  const entries = await conformance.sweepProbeObjects({
    client,
    prefix,
    changes: await journal(client, ctx.stateDirectory),
    accessoryIds: [owned.id, linked.id],
  });

  assert.deepEqual(
    entries.sort((a, b) => a.ref.localeCompare(b.ref)),
    [
      {
        kind: "accessory",
        ref: `${ctx.homeRef}/accessory/${owned.id}`,
        name: accessoryName,
        outcome: "deleted",
      },
      {
        kind: "accessory",
        ref: `${ctx.homeRef}/accessory/${foreign.id}`,
        name: accessoryName,
        outcome: "left",
        reason: "no_ownership_marker",
      },
      {
        kind: "accessory",
        ref: `${ctx.homeRef}/accessory/${linked.id}`,
        name: accessoryName,
        outcome: "left",
        reason: "has_links",
      },
      {
        kind: "room",
        ref: room.ref,
        name: `${roomName}-v`,
        outcome: "deleted",
      },
    ].sort((a, b) => a.ref.localeCompare(b.ref)),
  );
  assert.deepEqual(sweepWrites(hub, writesBefore), [
    {
      method: "accessory.delete",
      params: { accessory: { delete: { id: owned.id } } },
    },
    {
      method: "room.delete",
      params: { room: { delete: { id: room.id } } },
    },
  ]);
  const ids = hub.state.accessories.map(({ id }) => id);
  assert.equal(ids.includes(owned.id), false);
  assert.equal(ids.includes(foreign.id), true);
  assert.equal(ids.includes(linked.id), true);
});

// SprutHub 3.0.0 cut a 42-character room name to 30 characters on
// 2026-09-24, so the probe names its rooms with the short run name.
test("the sweep finds a probe room by the run's short name", async (t) => {
  const ctx = await setup(t);
  const room = await createRoom(ctx, `${accessoryName}-v`);
  const client = await productClient(t, ctx.hub);
  const writesBefore = ctx.hub.writes().length;

  const entries = await conformance.sweepProbeObjects({
    client,
    prefix,
    changes: await journal(client, ctx.stateDirectory),
  });

  assert.deepEqual(entries, [
    {
      kind: "room",
      ref: room.ref,
      name: `${accessoryName}-v`,
      outcome: "deleted",
    },
  ]);
  assert.deepEqual(sweepWrites(ctx.hub, writesBefore), [
    {
      method: "room.delete",
      params: { room: { delete: { id: room.id } } },
    },
  ]);
});

test("without the run's journal a probe room is reported, not deleted", async (t) => {
  const ctx = await setup(t);
  const room = await createRoom(ctx, `${roomName}-r`);
  const client = await productClient(t, ctx.hub);
  const writesBefore = ctx.hub.writes().length;

  const entries = await conformance.sweepProbeObjects({
    client,
    prefix,
    changes: null,
  });

  assert.deepEqual(entries, [
    {
      kind: "room",
      ref: room.ref,
      name: `${roomName}-r`,
      outcome: "left",
      reason: "journal_unavailable",
    },
  ]);
  assert.deepEqual(sweepWrites(ctx.hub, writesBefore), []);
});

test("--sweep-only removes what a run left and fails a prefix of another kind", async (t) => {
  const ctx = await setup(t);
  const room = await createRoom(ctx, `${roomName}-r`);
  const block = await createBlock(ctx, `${prefix}-block`, false);
  // The room can go only after the run's recorded accessory in it.
  const client = await productClient(t, ctx.hub);
  const accessory = await createVirtual(client, room.id);
  await recordAccessories(ctx.stateDirectory, [accessory.id]);
  const env = {
    PATH: process.env.PATH,
    ...ctx.hub.connectionEnv(),
    SPRUTHUB_TIMEOUT_MS: "5000",
  };

  const writesBefore = ctx.hub.writes().length;
  const refused = await runFile(
    process.execPath,
    [
      script,
      "--sweep-only",
      "zz-sprut-agent",
      "--state-dir",
      ctx.stateDirectory,
    ],
    { cwd: repoRoot, env },
  ).catch((error) => error);
  assert.equal(refused.code, 2, refused.stderr);
  assert.deepEqual(sweepWrites(ctx.hub, writesBefore), []);

  const swept = await runFile(
    process.execPath,
    [script, "--sweep-only", prefix, "--state-dir", ctx.stateDirectory],
    { cwd: repoRoot, env },
  );
  assert.match(swept.stdout, /room\/\d+ .*deleted/);
  assert.match(swept.stdout, /scenario\/\d+ .*deleted/);
  assert.match(swept.stdout, /accessory\/\d+ .*deleted/);
  assert.equal(
    ctx.hub.state.accessories.some(({ id }) => id === accessory.id),
    false,
  );
  assert.equal(
    ctx.hub.state.rooms.some(
      ({ id }) => `${ctx.homeRef}/room/${id}` === room.ref,
    ),
    false,
  );
  assert.equal(
    ctx.hub.state.scenarios.some(({ index }) => index === block.index),
    false,
  );
});

// --- the guard of the live probe ---------------------------------------------
//
// Every write of the live probe goes through GuardedHub (MCP) or ProbeClient
// (product client). These tests drive the guard against the simulated hub and
// check what reaches the hub, not what the probe reports.

async function guardSetup(t, options) {
  const ctx = await setup(t);
  const client = await productClient(t, ctx.hub);
  const guard = new conformance.GuardedHub(ctx.mcp, prefix, {
    ...options,
    productClient: client,
  });
  guard.homeRef = ctx.homeRef;
  const probe = new conformance.ProbeClient(client, guard, ctx.stateDirectory);
  return { ...ctx, guard, probe, client };
}

async function guardApply(guard, input) {
  const prepared = await guard.prepare(input);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const applied = await guard.apply(prepared.change_ref);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  return { changeRef: prepared.change_ref, applied };
}

// The run's room and its unlinked virtual Lightbulb, as step V makes them.
async function runVirtual(g) {
  const room = await guardApply(g.guard, {
    operation: "room_create",
    target_ref: g.homeRef,
    name: `${roomName}-v`,
  });
  const roomRef = room.applied.room.ref;
  const accessory = await g.probe.createVirtualAccessory(roomRef, [
    "Brightness",
  ]);
  const service = accessory.services.find(({ type }) => type === "Lightbulb");
  const on = service.characteristics.find(
    ({ control }) => control?.type === "On",
  );
  return {
    roomRef,
    aId: accessory.id,
    sId: service.sId,
    onCId: on.cId,
    serviceRef: `${g.homeRef}/accessory/${accessory.id}/service/${service.sId}`,
  };
}

function timedOn(target, cron) {
  return {
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [{ type: "cron", mode: "NONE", cron, offset: 0 }],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [
          {
            type: "service",
            aId: target.aId,
            sId: target.sId,
            hs: "Lightbulb",
            characteristics: [
              { type: "set", cId: target.onCId, hc: "On", value: "true" },
            ],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

function probeBlock(homeRef, data) {
  return {
    operation: "block_create",
    target_ref: homeRef,
    name: `${prefix}-fire`,
    description: "Проба соответствия",
    active: false,
    on_start: false,
    sync: false,
    data,
  };
}

// A LOGIC source of the probe's form: an info object and an empty trigger.
function inertLogic(name, trigger = "  // Intentionally empty.\n") {
  return `info = {
  name: ${JSON.stringify(name)},
  description: "Проба соответствия",
  version: "1.0",
  author: "sprut-agent",
  onStart: false,
  sourceServices: [HS.Lightbulb],
  sourceCharacteristics: [HC.On],
  options: {}
};

function trigger(source, value, variables, options, context) {
${trigger}}`;
}

test("the guard lets a run BLOCK fire at a daily time only on the run's virtual accessory and turns on only run BLOCKs", async (t) => {
  const g = await guardSetup(t);
  const virtual = await runVirtual(g);
  const lamp = { aId: 35, sId: 13, onCId: 14 };
  const before = g.hub.writes().length;

  await assert.rejects(
    g.guard.prepare(probeBlock(g.homeRef, timedOn(lamp, "0 5 12 ? * * *"))),
    conformance.GuardError,
  );
  // Every five minutes would repeat all day, not fire once.
  await assert.rejects(
    g.guard.prepare(probeBlock(g.homeRef, timedOn(virtual, "0 0/5 * ? * * *"))),
    conformance.GuardError,
  );
  // The owner's turned-off BLOCK stays off.
  await assert.rejects(
    g.guard.prepare({
      operation: "scenario_active",
      target_ref: `${g.homeRef}/scenario/7`,
      value: true,
    }),
    conformance.GuardError,
  );
  assert.deepEqual(sweepWrites(g.hub, before), []);

  const created = await guardApply(
    g.guard,
    probeBlock(g.homeRef, timedOn(virtual, "0 5 12 ? * * *")),
  );
  await guardApply(g.guard, {
    operation: "scenario_active",
    target_ref: created.applied.scenario_ref,
    value: true,
  });
  const index = created.applied.scenario_ref.split("/").at(-1);
  const scenario = (i) => g.hub.state.scenarios.find((s) => s.index === i);
  assert.equal(scenario(index).active, true);
  assert.equal(scenario("7").active, false);
});

test("the guard turns a probe LOGIC on only while unassigned and assigns it only to the run's virtual accessory while it is off", async (t) => {
  const g = await guardSetup(t);
  const virtual = await runVirtual(g);
  const name = `${prefix}-logic`;
  const logicInput = (active, source) => ({
    operation: "logic_source_create",
    target_ref: virtual.serviceRef,
    name,
    description: "Проба соответствия",
    active,
    on_start: false,
    sync: false,
    source,
  });
  const created = await guardApply(
    g.guard,
    logicInput(false, inertLogic(name)),
  );
  const logicRef = created.applied.scenario_ref;
  const type = created.applied.native_logic_type;
  const assign = (serviceRef, logicType) => ({
    operation: "logic_assignment",
    target_ref: `${serviceRef}/logic/${encodeURIComponent(logicType)}`,
  });
  const turnOn = {
    operation: "scenario_active",
    target_ref: logicRef,
    value: true,
  };
  const before = g.hub.writes().length;

  // Only the run's LOGIC, only on the run's virtual accessory.
  await assert.rejects(
    g.guard.prepare(assign(`${g.homeRef}/accessory/15/service/13`, type)),
    conformance.GuardError,
  );
  await assert.rejects(
    g.guard.prepare(assign(virtual.serviceRef, "AdaptiveLighting")),
    conformance.GuardError,
  );
  // A LOGIC created on must run nothing.
  await assert.rejects(
    g.guard.prepare(
      logicInput(
        true,
        inertLogic(name, "  Hub.getAccessory(35).getService(13);\n"),
      ),
    ),
    conformance.GuardError,
  );
  assert.deepEqual(sweepWrites(g.hub, before), []);

  const assignment = await guardApply(
    g.guard,
    assign(virtual.serviceRef, type),
  );
  await assert.rejects(g.guard.prepare(turnOn), conformance.GuardError);
  assert.equal(
    (await g.guard.restore(assignment.changeRef)).status,
    "restored",
  );

  // Whether a LOGIC has an options window with Active is not observed; the
  // simulated LOGIC gets one here so that it can be switched.
  const logic = g.hub.state.scenarios.find(
    ({ index }) => index === logicRef.split("/").at(-1),
  );
  logic.optionsWindow = "scenario-options-probe-logic";
  g.hub.state.windows[logic.optionsWindow] = {
    windowKey: logic.optionsWindow,
    label: { text: "Настройки сценария" },
    options: [
      {
        key: "Active",
        name: "Активен",
        type: "GenericBoolean",
        inputType: "CHECKBOX",
        read: true,
        write: true,
        disabled: false,
        value: { boolValue: false },
      },
    ],
  };
  await guardApply(g.guard, turnOn);
  assert.equal(logic.active, true);
  const whileOn = g.hub.writes().length;
  await assert.rejects(
    g.guard.prepare(assign(virtual.serviceRef, type)),
    conformance.GuardError,
  );
  assert.deepEqual(sweepWrites(g.hub, whileOn), []);
  assert.equal(
    g.hub.state.logics.some((item) => item.type === type),
    false,
  );
});

test("the probe sends one direct room.create under the run's short name and the sweep removes that room", async (t) => {
  const g = await guardSetup(t);
  const before = g.hub.writes().length;
  await assert.rejects(
    g.probe.createRoomDirect("Гостиная у окна"),
    conformance.GuardError,
  );
  assert.deepEqual(sweepWrites(g.hub, before), []);

  // 31 characters: the product refuses it, so only a direct write shows
  // what the hub keeps of a Cyrillic name.
  const room = await g.probe.createRoomDirect(`${roomName}абвгде`);
  await assert.rejects(
    g.probe.createRoomDirect(`${roomName}-2`),
    conformance.GuardError,
  );
  await assert.rejects(
    g.probe.deleteDirectRoom(`${g.homeRef}/room/1`),
    conformance.GuardError,
  );
  assert.deepEqual(
    sweepWrites(g.hub, before).map(({ method }) => method),
    ["room.create"],
  );

  await runFile(
    process.execPath,
    [script, "--sweep-only", prefix, "--state-dir", g.stateDirectory],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        ...g.hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: "5000",
      },
    },
  );
  assert.equal(
    g.hub.state.rooms.some(({ id }) => id === room.id),
    false,
  );
  assert.equal(
    g.hub.state.rooms.some(({ id }) => id === 1),
    true,
  );
});

test("virtual_light_group is only prepared, for the run's virtual accessory name and room", async (t) => {
  const g = await guardSetup(t);
  const virtual = await runVirtual(g);
  const group = (name, roomRef) => ({
    operation: "virtual_light_group",
    target_ref: g.homeRef,
    name,
    room_ref: roomRef,
    member_service_refs: [
      `${g.homeRef}/accessory/15/service/13`,
      `${g.homeRef}/accessory/16/service/13`,
    ],
    characteristic_types: ["On", "Brightness"],
  });
  const before = g.hub.writes().length;
  await assert.rejects(
    g.guard.prepare(group("Свет в гостиной", virtual.roomRef)),
    conformance.GuardError,
  );
  await assert.rejects(
    g.guard.prepare(group(accessoryName, `${g.homeRef}/room/3`)),
    conformance.GuardError,
  );
  const duplicate = await g.guard.prepare(
    group(accessoryName, virtual.roomRef),
  );
  assert.equal(duplicate.conflict_reason, "matching_virtual_accessory_exists");
  assert.deepEqual(sweepWrites(g.hub, before), []);

  // Without its accessory the same group is prepared, and never applied.
  await g.probe.deleteVirtualAccessory(virtual.aId);
  const prepared = await g.guard.prepare(group(accessoryName, virtual.roomRef));
  assert.equal(prepared.status, "prepared");
  const afterDelete = g.hub.writes().length;
  await assert.rejects(
    g.guard.apply(prepared.change_ref),
    conformance.GuardError,
  );
  assert.deepEqual(sweepWrites(g.hub, afterDelete), []);
});

test("a read-only probe refuses every write before it reaches the product", async (t) => {
  const g = await guardSetup(t, { readOnly: true });
  const before = g.hub.writes().length;
  await assert.rejects(
    g.guard.prepare({
      operation: "room_create",
      target_ref: g.homeRef,
      name: `${roomName}-r`,
    }),
    conformance.GuardError,
  );
  await assert.rejects(
    g.probe.createRoomDirect(`${roomName}-r`),
    conformance.GuardError,
  );
  assert.deepEqual(sweepWrites(g.hub, before), []);
  assert.deepEqual(await journal(g.client, g.stateDirectory), []);
});

// The owner allows a read-only pass before any live write: every read step
// runs through the shipped server and nothing but reads reaches the hub.
test("--read-only runs the read steps and sends the hub no write", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-agent-read-only-"));
  t.after(async () => {
    await hub.close();
    await rm(scratch, { recursive: true, force: true });
  });
  const result = await runFile(process.execPath, [script, "--read-only"], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: scratch,
      TMPDIR: scratch,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "5000",
    },
  }).catch((error) => error);
  assert.equal(result.code ?? 0, 0, result.stdout);
  // history.list is a read the simulator does not know.
  assert.deepEqual(
    [...new Set(hub.writes().map(({ method }) => method))],
    ["history.list"],
  );
});
