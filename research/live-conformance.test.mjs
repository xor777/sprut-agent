import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
const runFile = promisify(execFile);

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
  const ownedRoom = await createRoom(ctx, `${prefix}-room`);
  const ownedBlock = await createBlock(ctx, `${prefix}-block`, false);
  const activeBlock = await createBlock(ctx, `${prefix}-active`, true);
  const occupiedRoom = await createRoom(ctx, `${prefix}-occupied`);
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
    {
      kind: "room",
      ref: occupiedRoom.ref,
      name: `${prefix}-occupied`,
      outcome: "left",
      reason: "not_empty",
    },
    {
      kind: "room",
      ref: ownedRoom.ref,
      name: `${prefix}-room`,
      outcome: "deleted",
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

test("without the run's journal a probe room is reported, not deleted", async (t) => {
  const ctx = await setup(t);
  const room = await createRoom(ctx, `${prefix}-room`);
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
      name: `${prefix}-room`,
      outcome: "left",
      reason: "journal_unavailable",
    },
  ]);
  assert.deepEqual(sweepWrites(ctx.hub, writesBefore), []);
});

test("--sweep-only removes what a run left and fails a prefix of another kind", async (t) => {
  const ctx = await setup(t);
  const room = await createRoom(ctx, `${prefix}-room`);
  const block = await createBlock(ctx, `${prefix}-block`, false);
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
