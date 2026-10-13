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
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Верни как было» after the agent's own changes: device commands, a
// multi-step task and an automation are put back through
// restore_native_change on the simulated apartment, and what cannot be put
// back is named per item.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const characteristic = (aId, cId) => ({ aId, sId: 13, cId });
// Living room lamps of the apartment fixture.
const CHANDELIER_ON = characteristic(15, 14); // Люстра, on at 80
const CHANDELIER_LEVEL = characteristic(15, 15);
const FLOOR_ON = characteristic(16, 14); // Торшер, on at 55
const FLOOR_LEVEL = characteristic(16, 15);
const STRIP_ON = characteristic(17, 14); // Светодиодная лента, off at 100
const STRIP_LEVEL = characteristic(17, 15);

function refOf({ aId, sId, cId }) {
  return `${homeRef}/accessory/${aId}/service/${sId}/characteristic/${cId}`;
}

async function setup(t, hubOptions = {}) {
  const hub = await startSimulatedHub(
    await loadHomeFixture("apartment"),
    hubOptions,
  );
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-unified-undo-"),
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
  const client = new Client({ name: "unified-undo-test", version: "1.0.0" });
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

async function command(client, commands, reason) {
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: commands.map(([target, value]) => ({
      target_ref: refOf(target),
      value,
    })),
    reason,
  });
  for (const item of sent.results) {
    assert.equal(item.status, "applied", JSON.stringify(item));
  }
  return sent;
}

async function prepareAndApply(client, input) {
  const prepared = await call(client, "prepare_native_change", input);
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  return applied;
}

function currentValue(hub, { aId, sId, cId }) {
  const control = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find((service) => service.sId === sId)
    .characteristics.find((entry) => entry.cId === cId).control;
  return Object.values(control.value)[0];
}

// Value writes sent to the hub after request number `from`, as
// [aId.cId, value] in the order they were sent.
function valueWritesSince(hub, from) {
  return hub.requests
    .slice(from)
    .filter(({ method }) => method === "characteristic.update")
    .map(({ params }) => params.characteristic.update)
    .filter((update) => update.control)
    .map(({ aId, cId, control }) => [
      `${aId}.${cId}`,
      Object.values(control.value)[0],
    ]);
}

function homeChanges(hub) {
  return diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot());
}

function itemFor(restored, changeRef) {
  const item = restored.results.find(
    ({ change_ref: ref }) => ref === changeRef,
  );
  assert.ok(item, `no result for ${changeRef}`);
  return item;
}

test("«верни как было» after «выключи свет в гостиной» turns back on only the lamps the agent switched off", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [
      [CHANDELIER_ON, false],
      [FLOOR_ON, false],
      // Already off: sent anyway, nothing to put back.
      [STRIP_ON, false],
    ],
    "Выключить свет в гостиной",
  );
  assert.match(sent.group_ref, /^spruthub-change:\/\/group\/[a-f0-9]{24}$/);
  assert.deepEqual(
    sent.results.map(({ restore_supported: supported }) => supported),
    [true, true, true],
  );
  const [chandelier, floor, strip] = sent.results;

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "ok");
  assert.deepEqual(restored.summary, {
    total: 3,
    restored: 3,
    skipped: 0,
    failed: 0,
    uncertain: 0,
  });
  for (const [item, name] of [
    [chandelier, "Люстра / Люстра"],
    [floor, "Торшер / Свет"],
  ]) {
    const result = itemFor(restored, item.change_ref);
    assert.equal(result.status, "restored");
    assert.equal(result.sent, true);
    assert.equal(result.name, name);
    assert.deepEqual(result.value, { from: false, to: true });
  }
  const stripResult = itemFor(restored, strip.change_ref);
  assert.equal(stripResult.status, "restored");
  assert.equal(stripResult.sent, false);
  // The last command is undone first.
  assert.deepEqual(valueWritesSince(hub, before), [
    ["16.14", true],
    ["15.14", true],
  ]);
  assert.deepEqual(homeChanges(hub), []);

  // A second «верни как было» writes nothing.
  const again = hub.requests.length;
  const repeated = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(repeated.status, "ok");
  assert.deepEqual(valueWritesSince(hub, again), []);
});

test("a lamp the owner switched by hand since the command is reported and left as the owner set it", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [
      [CHANDELIER_ON, false],
      [FLOOR_ON, false],
    ],
    "Выключить свет в гостиной",
  );
  const [chandelier, floor] = sent.results;
  hub.changeByHand({ ...CHANDELIER_ON, value: { boolValue: true } });
  hub.changeByHand({ ...CHANDELIER_LEVEL, value: { intValue: 30 } });

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "incomplete");
  assert.deepEqual(restored.summary, {
    total: 2,
    restored: 1,
    skipped: 1,
    failed: 0,
    uncertain: 0,
  });
  const skipped = itemFor(restored, chandelier.change_ref);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "changed_since");
  assert.equal(skipped.sent, false);
  assert.equal(skipped.observed_value, true);
  assert.equal(skipped.already_previous, true);
  assert.equal(itemFor(restored, floor.change_ref).status, "restored");
  assert.deepEqual(valueWritesSince(hub, before), [["16.14", true]]);
  assert.equal(currentValue(hub, CHANDELIER_ON), true);
  assert.equal(currentValue(hub, CHANDELIER_LEVEL), 30);
});

test("a level the owner changed by hand after a dim is not overwritten", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [[FLOOR_LEVEL, 30]],
    "Поставить торшер на 30%",
  );
  hub.changeByHand({ ...FLOOR_LEVEL, value: { intValue: 45 } });

  const before = hub.requests.length;
  const single = await call(client, "restore_native_change", {
    change_ref: sent.results[0].change_ref,
  });
  assert.equal(single.status, "conflict");
  assert.equal(single.conflict_reason, "manual_change");
  const grouped = await call(client, "restore_native_change", {
    change_refs: [sent.group_ref],
  });
  const item = itemFor(grouped, sent.results[0].change_ref);
  assert.equal(item.status, "skipped");
  assert.equal(item.reason, "changed_since");
  assert.equal(item.observed_value, 45);
  assert.equal(item.already_previous, false);
  assert.deepEqual(valueWritesSince(hub, before), []);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 45);
});

test("a lamp's level is put back before the lamp is switched", async (t) => {
  const { hub, client } = await setup(t);
  // The floor lamp is on at 55: dimmed, then switched off.
  const floor = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [FLOOR_ON, false],
    ],
    "Приглушить и выключить торшер",
  );
  // The strip is off at 100: dimmed while off, then switched on.
  const strip = await command(
    client,
    [
      [STRIP_LEVEL, 40],
      [STRIP_ON, true],
    ],
    "Включить ленту на 40%",
  );

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_refs: [floor.group_ref, strip.group_ref],
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  // The later call first; in each lamp the level before On, so the floor
  // lamp comes on at 55 and the strip goes off last.
  assert.deepEqual(valueWritesSince(hub, before), [
    ["17.15", 100],
    ["17.14", false],
    ["16.15", 55],
    ["16.14", true],
  ]);
  assert.deepEqual(homeChanges(hub), []);
});

test("a lamp whose level switches it on is reported restored, not changed by hand", async (t) => {
  // With «Связь включения и уровня» a level above 0 turns the lamp on, so
  // putting its level back already brings back its On.
  const { hub, client } = await setup(t, {
    faults: { lampLogic: [{ aId: 16, sId: 13 }] },
  });
  const sent = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [FLOOR_ON, false],
    ],
    "Приглушить и выключить торшер",
  );
  assert.equal(currentValue(hub, FLOOR_ON), false);

  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  const on = itemFor(restored, sent.results[1].change_ref);
  assert.equal(on.status, "restored");
  assert.equal(on.sent, false);
  assert.equal(on.reason, undefined);
  assert.equal(currentValue(hub, FLOOR_ON), true);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 55);
});

test("a lamp switched back on by hand stays reported when its level is put back in the same undo", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [FLOOR_ON, false],
    ],
    "Приглушить и выключить торшер",
  );
  hub.changeByHand({ ...FLOOR_ON, value: { boolValue: true } });

  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(itemFor(restored, sent.results[0].change_ref).sent, true);
  const on = itemFor(restored, sent.results[1].change_ref);
  assert.equal(on.status, "skipped");
  assert.equal(on.reason, "changed_since");
  assert.equal(on.already_previous, true);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 55);
});

test("an offline lamp is reported, not guessed, and restored once it is back", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(client, [[FLOOR_ON, false]], "Выключить торшер");
  const lamp = hub.state.accessories.find(({ id }) => id === 16);
  lamp.online = false;

  const before = hub.requests.length;
  const offline = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  const item = itemFor(offline, sent.results[0].change_ref);
  assert.equal(item.status, "skipped");
  assert.equal(item.reason, "device_unavailable");
  assert.equal(item.sent, false);
  assert.deepEqual(valueWritesSince(hub, before), []);

  lamp.online = true;
  const online = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(online.status, "ok");
  assert.deepEqual(homeChanges(hub), []);
});

test("a multi-step task is undone in one call in reverse order of its steps", async (t) => {
  const { hub, client } = await setup(t);
  const reason = "Сделать террасу и перенести туда торшер";
  const created = await prepareAndApply(client, {
    operation: "room_create",
    target_ref: homeRef,
    name: "Терраса",
    reason,
  });
  const placed = await prepareAndApply(client, {
    operation: "accessory_placement",
    target_ref: `${homeRef}/accessory/16`,
    room_ref: created.room.ref,
    name: "Торшер",
    reason,
  });
  const renamed = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: created.room.ref,
    value: "Веранда",
    reason,
  });

  const restored = await call(client, "restore_native_change", {
    change_refs: [created.change_ref, placed.change_ref, renamed.change_ref],
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  assert.deepEqual(
    restored.results.map(({ change_ref: ref, status }) => [ref, status]),
    [
      [renamed.change_ref, "restored"],
      [placed.change_ref, "restored"],
      [created.change_ref, "restored"],
    ],
  );
  assert.deepEqual(homeChanges(hub), []);
});

test("undo of a created BLOCK names the agent's later edit, and both together are undone", async (t) => {
  const { hub, client } = await setup(t);
  const rule = (value) => ({
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
            characteristics: [{ type: "set", cId: 14, hc: "On", value }],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  });
  const created = await prepareAndApply(client, {
    operation: "block_create",
    target_ref: homeRef,
    name: "Свет в ванной по движению",
    description: "Включает свет в ванной при движении",
    active: true,
    on_start: false,
    sync: false,
    data: rule("true"),
    reason: "Включать свет в ванной при движении",
  });
  const edited = await prepareAndApply(client, {
    operation: "block_data_update",
    target_ref: created.scenario_ref,
    data: rule("false"),
    reason: "Наоборот, выключать",
  });

  const before = hub.requests.length;
  const alone = await call(client, "restore_native_change", {
    change_ref: created.change_ref,
  });
  assert.equal(alone.status, "conflict");
  assert.equal(alone.conflict_reason, "later_owned_change");
  assert.equal(alone.restore_first_change_ref, edited.change_ref);
  assert.deepEqual(
    hub.requests.slice(before).filter(({ write }) => write),
    [],
  );

  const both = await call(client, "restore_native_change", {
    change_refs: [created.change_ref, edited.change_ref],
  });
  assert.equal(both.status, "ok", JSON.stringify(both.results));
  assert.deepEqual(
    both.results.map(({ change_ref: ref, status }) => [ref, status]),
    [
      [edited.change_ref, "restored"],
      [created.change_ref, "restored"],
    ],
  );
  assert.deepEqual(homeChanges(hub), []);
});

test("an earlier command on a lamp the agent changed again names the later command until both are undone", async (t) => {
  const { hub, client } = await setup(t);
  const first = await command(
    client,
    [[FLOOR_LEVEL, 30]],
    "Поставить торшер на 30%",
  );
  const second = await command(client, [[FLOOR_LEVEL, 10]], "Ещё темнее, 10%");
  const firstRef = first.results[0].change_ref;
  const secondRef = second.results[0].change_ref;

  const before = hub.requests.length;
  const alone = await call(client, "restore_native_change", {
    change_ref: firstRef,
  });
  assert.equal(alone.status, "conflict");
  assert.equal(alone.conflict_reason, "later_owned_change");
  assert.equal(alone.restore_first_change_ref, secondRef);
  assert.equal(alone.manual_change_observed, undefined);
  assert.deepEqual(valueWritesSince(hub, before), []);
  // Reading it does not turn the agent's own later command into a manual
  // change either.
  const read = await call(client, "get_native_change", {
    change_ref: firstRef,
  });
  assert.equal(read.conflict_reason, "later_owned_change");
  assert.equal(read.manual_change_observed, undefined);

  const batch = await call(client, "restore_native_change", {
    change_refs: [first.group_ref],
  });
  const blocked = itemFor(batch, firstRef);
  assert.equal(blocked.status, "skipped");
  assert.equal(blocked.reason, "later_change");
  assert.equal(blocked.later_change_ref, secondRef);

  const both = await call(client, "restore_native_change", {
    change_refs: [firstRef, secondRef],
  });
  assert.equal(both.status, "ok", JSON.stringify(both.results));
  assert.deepEqual(valueWritesSince(hub, before), [
    ["16.15", 30],
    ["16.15", 55],
  ]);
  assert.deepEqual(homeChanges(hub), []);
});

test("an automation from apply_automation_change is undone through restore_native_change", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await call(client, "preview_boolean_automation", {
    name: "Свет в ванной по движению",
    reason: "Включать свет в ванной при движении",
    source_room_ref: `${homeRef}/room/8`,
    source_characteristic_ref: refOf(characteristic(38, 14)),
    source_value: true,
    target_room_ref: `${homeRef}/room/8`,
    target_characteristic_ref: refOf(characteristic(35, 14)),
    target_value: true,
  });
  const applied = await call(client, "apply_automation_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.notDeepEqual(homeChanges(hub), []);

  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  assert.equal(itemFor(restored, prepared.change_ref).status, "restored");
  assert.deepEqual(homeChanges(hub), []);

  const single = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(single.status, "rolled_back");
});

test("a scenario run stays non-restorable with a reason while the rest of the request is undone", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await prepareAndApply(client, {
    operation: "scenario_run",
    target_ref: `${homeRef}/scenario/8`,
    reason: "Выключить свет в кабинете",
  });
  const sent = await command(client, [[FLOOR_ON, false]], "Выключить торшер");

  const restored = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref, sent.group_ref],
  });
  assert.equal(restored.status, "incomplete");
  const runItem = itemFor(restored, prepared.change_ref);
  assert.equal(runItem.status, "skipped");
  assert.equal(runItem.reason, "not_restorable");
  assert.match(runItem.message, /physical/i);
  assert.equal(
    itemFor(restored, sent.results[0].change_ref).status,
    "restored",
  );
  assert.equal(currentValue(hub, FLOOR_ON), true);
});

test("history summaries name what changed, why, when and in which group", async (t) => {
  const { client } = await setup(t);
  const sent = await command(
    client,
    [
      [CHANDELIER_ON, false],
      [FLOOR_ON, false],
    ],
    "Выключить свет в гостиной",
  );
  const created = await prepareAndApply(client, {
    operation: "room_create",
    target_ref: homeRef,
    name: "Терраса",
    reason: "Сделать террасу",
  });

  const history = await call(client, "list_native_changes", {
    home_ref: homeRef,
    limit: 10,
  });
  const byRef = new Map(
    history.changes.map((summary) => [summary.change_ref, summary]),
  );
  for (const [item, name] of [
    [sent.results[0], "Люстра / Люстра"],
    [sent.results[1], "Торшер / Свет"],
  ]) {
    const summary = byRef.get(item.change_ref);
    assert.equal(summary.operation, "characteristic_value");
    assert.equal(summary.reason, "Выключить свет в гостиной");
    assert.equal(summary.name, name);
    assert.equal(summary.group_ref, sent.group_ref);
    assert.deepEqual(summary.value, { from: true, to: false });
    assert.equal(summary.recorded_status, "applied");
    assert.ok(Date.parse(summary.applied_at) > 0);
  }
  const room = byRef.get(created.change_ref);
  assert.equal(room.operation, "room_create");
  assert.equal(room.reason, "Сделать террасу");
  assert.equal(room.name, "Терраса");
  assert.equal(room.group_ref, undefined);
});

test("history names a prepared device setting by its device", async (t) => {
  const { client } = await setup(t);
  const setpoint = await prepareAndApply(client, {
    operation: "characteristic_value",
    target_ref: refOf(characteristic(19, 17)),
    value: 24,
    reason: "Сделать в гостиной теплее",
  });

  const history = await call(client, "list_native_changes", {
    home_ref: homeRef,
    limit: 10,
  });
  const summary = history.changes.find(
    ({ change_ref: ref }) => ref === setpoint.change_ref,
  );
  assert.equal(summary.name, "Кондиционер / Кондиционер");
  assert.deepEqual(summary.value, { from: 23, to: 24 });
  assert.equal(summary.reason, "Сделать в гостиной теплее");
});
