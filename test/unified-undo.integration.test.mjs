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
const STRIP_HUE = characteristic(17, 16); // 30°
const CURTAIN_TARGET = characteristic(18, 16); // Шторы в гостиной, open (100)
const AC_MODE = characteristic(19, 15); // Кондиционер, off (0)
const AC_SETPOINT = characteristic(19, 17); // 23 °C, step 0.5
const BREEZER_ACTIVE = characteristic(28, 14); // Бризер, running (1)

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

test("a position the owner changed by hand after the agent's is not overwritten", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [[CURTAIN_TARGET, 50]],
    "Прикрыть шторы наполовину",
  );
  hub.changeByHand({ ...CURTAIN_TARGET, value: { intValue: 45 } });

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
  assert.equal(currentValue(hub, CURTAIN_TARGET), 45);
});

test("«верни как было» puts back a value one step from the one the agent sent", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [
      [BREEZER_ACTIVE, 0],
      [AC_SETPOINT, 23.5],
    ],
    "Выключить бризер и сделать чуть теплее",
  );

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "ok", JSON.stringify(restored.results));
  for (const item of sent.results) {
    const result = itemFor(restored, item.change_ref);
    assert.equal(result.status, "restored");
    assert.equal(result.sent, true);
  }
  assert.deepEqual(valueWritesSince(hub, before), [
    ["19.17", 23],
    ["28.14", 1],
  ]);
  assert.equal(currentValue(hub, BREEZER_ACTIVE), 1);
  assert.equal(currentValue(hub, AC_SETPOINT), 23);
});

test("a value the owner set one step from the agent's is left as the owner set it", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [
      // Heating.
      [AC_MODE, 1],
      [AC_SETPOINT, 24],
      [CURTAIN_TARGET, 50],
    ],
    "Включить обогрев на 24 и прикрыть шторы",
  );
  // Cooling, one press of «+», the curtains one step further open.
  hub.changeByHand({ ...AC_MODE, value: { intValue: 2 } });
  hub.changeByHand({ ...AC_SETPOINT, value: { doubleValue: 24.5 } });
  hub.changeByHand({ ...CURTAIN_TARGET, value: { intValue: 51 } });

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "incomplete");
  for (const [item, observed] of [
    [sent.results[0], 2],
    [sent.results[1], 24.5],
    [sent.results[2], 51],
  ]) {
    const result = itemFor(restored, item.change_ref);
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.reason, "changed_since");
    assert.equal(result.already_previous, false);
    assert.equal(result.observed_value, observed);
  }
  assert.deepEqual(valueWritesSince(hub, before), []);
  assert.equal(currentValue(hub, AC_MODE), 2);
  assert.equal(currentValue(hub, AC_SETPOINT), 24.5);
  assert.equal(currentValue(hub, CURTAIN_TARGET), 51);
});

test("a breezer that acknowledges «выключи» but keeps running is not reported off", async (t) => {
  const { hub, client } = await setup(t, {
    faults: { stuckActuators: [{ aId: 28 }] },
  });
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [{ target_ref: refOf(BREEZER_ACTIVE), value: 0 }],
    reason: "Выключить бризер",
  });
  const [breezer] = sent.results;
  assert.equal(breezer.status, "uncertain", JSON.stringify(breezer));
  assert.equal(breezer.sent, true);
  assert.equal(breezer.observed_value, 1);
  assert.equal(breezer.conflict_reason, "ack_without_requested_result");
  assert.equal(currentValue(hub, BREEZER_ACTIVE), 1);
});

// With «Связь включения и уровня» a level above 0 switches a lamp that is
// off on, and switching a lamp on or off leaves its level as stored
// (2026-10-13-lamp-logic-undo). So undo puts back only a lamp's On and
// never writes its levels.
const LAMP_LOGIC = {
  faults: {
    lampLogic: [
      { aId: 16, sId: 13 },
      { aId: 17, sId: 13 },
    ],
  },
};

function assertLevelLeft(item) {
  assert.equal(item.status, "skipped", JSON.stringify(item));
  assert.equal(item.reason, "lamp_level_not_restored");
  assert.equal(item.sent, false);
  assert.equal(item.next, undefined);
}

test("«приглуши торшер и прикрой шторы», then «верни как было», opens the curtains and leaves the lamp's level", async (t) => {
  const { hub, client } = await setup(t, LAMP_LOGIC);
  const sent = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [CURTAIN_TARGET, 50],
    ],
    "Приглушить торшер до 20% и прикрыть шторы",
  );
  const [level, curtain] = sent.results;

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.status, "incomplete");
  const curtainItem = itemFor(restored, curtain.change_ref);
  assert.equal(curtainItem.status, "restored", JSON.stringify(curtainItem));
  assert.equal(curtainItem.sent, true);
  const levelItem = itemFor(restored, level.change_ref);
  assertLevelLeft(levelItem);
  assert.equal(levelItem.observed_value, 20);
  assert.deepEqual(valueWritesSince(hub, before), [["18.16", 100]]);
  assert.equal(currentValue(hub, CURTAIN_TARGET), 100);
  assert.equal(currentValue(hub, FLOOR_ON), true);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 20);
});

// An agent that reads restore_supported=true would promise the owner the
// brightness can be put back.
test("«приглуши торшер и прикрой шторы» reports the lamp's level as not restorable and the curtains as restorable", async (t) => {
  const { client } = await setup(t, LAMP_LOGIC);
  const sent = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [CURTAIN_TARGET, 50],
    ],
    "Приглушить торшер до 20% и прикрыть шторы",
  );
  const [level, curtain] = sent.results;
  for (const shown of [
    level,
    await call(client, "get_native_change", { change_ref: level.change_ref }),
  ]) {
    assert.equal(shown.restore_supported, false, JSON.stringify(shown));
    assert.equal(shown.restore_limitation?.code, "lamp_level_not_restored");
  }
  for (const shown of [
    curtain,
    await call(client, "get_native_change", {
      change_ref: curtain.change_ref,
    }),
  ]) {
    assert.equal(shown.restore_supported, true, JSON.stringify(shown));
    assert.equal(shown.restore_limitation, undefined);
  }
});

for (const route of ["change_ref", "change_refs"]) {
  test(`«приглуши торшер до 20%» undone by its own ref writes nothing (${route})`, async (t) => {
    const { hub, client } = await setup(t, LAMP_LOGIC);
    const sent = await command(
      client,
      [[FLOOR_LEVEL, 20]],
      "Приглушить торшер до 20%",
    );
    const [level] = sent.results;

    const before = hub.requests.length;
    const restored = await call(
      client,
      "restore_native_change",
      route === "change_ref"
        ? { change_ref: level.change_ref }
        : { change_refs: [level.change_ref] },
    );
    if (route === "change_ref") {
      assert.equal(restored.restore_outcome?.status, "skipped");
      assert.equal(restored.restore_outcome.reason, "lamp_level_not_restored");
    } else {
      assertLevelLeft(itemFor(restored, level.change_ref));
    }
    assert.deepEqual(valueWritesSince(hub, before), []);
    assert.equal(currentValue(hub, FLOOR_ON), true);
    assert.equal(currentValue(hub, FLOOR_LEVEL), 20);
  });
}

// The same promise when the agent goes through the contract and
// prepare_native_change instead of send_device_commands.
test("a lamp's level through prepare_native_change reports it is not restorable and the curtains' position that it is", async (t) => {
  const { client } = await setup(t, LAMP_LOGIC);
  for (const [target, value, restorable] of [
    [FLOOR_LEVEL, 20, false],
    [CURTAIN_TARGET, 50, true],
  ]) {
    const input = {
      operation: "characteristic_value",
      target_ref: refOf(target),
      value,
      reason: "Приглушить торшер до 20% и прикрыть шторы",
    };
    const contract = await call(client, "get_native_change_contract", {
      operation: input.operation,
      target_ref: input.target_ref,
    });
    const prepared = await call(client, "prepare_native_change", input);
    const applied = await call(client, "apply_native_change", {
      change_ref: prepared.change_ref,
    });
    assert.equal(applied.status, "applied", JSON.stringify(applied));
    const shown = await call(client, "get_native_change", {
      change_ref: prepared.change_ref,
    });
    for (const [name, answer] of Object.entries({
      contract,
      prepared,
      applied,
      shown,
    })) {
      const message = `${name}: ${JSON.stringify(answer)}`;
      assert.equal(answer.restore_supported, restorable, message);
      assert.equal(
        answer.restore_limitation?.code,
        restorable ? undefined : "lamp_level_not_restored",
        message,
      );
    }
  }
});

// A level set through prepare_native_change, also when the hub refused the
// device read at prepare, is still a lamp's level at undo: written back,
// 55 would switch on the lamp the owner has since turned off.
for (const deviceRead of ["answered", "refused"]) {
  test(`a lamp's level set through prepare_native_change stays as it is after the owner switched the lamp off (device read ${deviceRead})`, async (t) => {
    const { hub, client } = await setup(t, LAMP_LOGIC);
    if (deviceRead === "refused") hub.refuseNext("accessory.get");
    const applied = await prepareAndApply(client, {
      operation: "characteristic_value",
      target_ref: refOf(FLOOR_LEVEL),
      value: 20,
      reason: "Приглушить торшер до 20%",
    });
    hub.changeByHand({ ...FLOOR_ON, value: { boolValue: false } });

    const before = hub.requests.length;
    const restored = await call(client, "restore_native_change", {
      change_refs: [applied.change_ref],
    });
    assertLevelLeft(itemFor(restored, applied.change_ref));
    assert.deepEqual(valueWritesSince(hub, before), []);
    assert.equal(currentValue(hub, FLOOR_ON), false);
    assert.equal(currentValue(hub, FLOOR_LEVEL), 20);
  });
}

// The review's case: the strip, off at 100, is switched on at 40, and a
// level write of the undo would get no answer. Undo switches it off and
// neither writes its level or color nor offers to, then or on a repeat.
test("a lamp switched on at a level and color is undone to off, with no level written or offered for resend", async (t) => {
  const { hub, client } = await setup(t, LAMP_LOGIC);
  const sent = await command(
    client,
    [
      [STRIP_ON, true],
      [STRIP_LEVEL, 40],
      [STRIP_HUE, 200],
    ],
    "Включить ленту на 40%, синим",
  );
  hub.state.faults.droppedReply.push({
    method: "characteristic.update",
    aId: 17,
    cId: 15,
    remaining: 1,
  });

  const before = hub.requests.length;
  for (const attempt of ["first", "repeat"]) {
    const restored = await call(client, "restore_native_change", {
      change_ref: sent.group_ref,
    });
    const [on, level, hue] = sent.results.map(({ change_ref: ref }) =>
      itemFor(restored, ref),
    );
    assert.equal(on.status, "restored", `${attempt}: ${JSON.stringify(on)}`);
    assert.equal(on.next, undefined);
    assertLevelLeft(level);
    assertLevelLeft(hue);
  }
  assert.deepEqual(valueWritesSince(hub, before), [["17.14", false]]);
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
  assert.equal(currentValue(hub, STRIP_HUE), 200);
});

test("«верни как было» brings a lamp's On back, on or off, and leaves its level", async (t) => {
  const { hub, client } = await setup(t, LAMP_LOGIC);
  // The floor lamp is on at 55: dimmed, then switched off.
  const floor = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [FLOOR_ON, false],
    ],
    "Приглушить и выключить торшер",
  );
  // The strip is off at 100: switched on at 40.
  const strip = await command(
    client,
    [
      [STRIP_ON, true],
      [STRIP_LEVEL, 40],
    ],
    "Включить ленту на 40%",
  );

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_refs: [floor.group_ref, strip.group_ref],
  });
  assert.equal(restored.status, "incomplete");
  for (const item of [floor.results[1], strip.results[0]]) {
    const result = itemFor(restored, item.change_ref);
    assert.equal(result.status, "restored", JSON.stringify(result));
    assert.equal(result.sent, true);
  }
  for (const item of [floor.results[0], strip.results[1]]) {
    assertLevelLeft(itemFor(restored, item.change_ref));
  }
  // The later call first.
  assert.deepEqual(valueWritesSince(hub, before), [
    ["17.14", false],
    ["16.14", true],
  ]);
  assert.equal(currentValue(hub, FLOOR_ON), true);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 20);
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
});

test("a lamp the owner switched on and off again after the agent's dim and off stays off", async (t) => {
  const { hub, client } = await setup(t, LAMP_LOGIC);
  const sent = await command(
    client,
    [
      [FLOOR_LEVEL, 20],
      [FLOOR_ON, false],
    ],
    "Приглушить и выключить торшер",
  );
  const [level, on] = sent.results;
  hub.changeByHand({ ...FLOOR_ON, value: { boolValue: true } });
  const read = await call(client, "get_native_change", {
    change_ref: on.change_ref,
  });
  assert.equal(read.manual_change_observed, true, JSON.stringify(read));
  hub.changeByHand({ ...FLOOR_ON, value: { boolValue: false } });

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.deepEqual(valueWritesSince(hub, before), []);
  assert.equal(currentValue(hub, FLOOR_ON), false);
  assert.equal(currentValue(hub, FLOOR_LEVEL), 20);
  const onItem = itemFor(restored, on.change_ref);
  assert.equal(onItem.status, "skipped", JSON.stringify(onItem));
  assert.equal(onItem.reason, "changed_since");
  assert.equal(onItem.already_previous, false);
  assert.equal(onItem.sent, false);
  assertLevelLeft(itemFor(restored, level.change_ref));
});

test("a level for a strip kept off is not sent, and undo leaves the strip off at its level", async (t) => {
  const { hub, client } = await setup(t, LAMP_LOGIC);
  // Off at 100: the level would switch it on before the call's off.
  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      { target_ref: refOf(STRIP_LEVEL), value: 40 },
      { target_ref: refOf(STRIP_ON), value: false },
    ],
    reason: "Поставить ленте 40%, не включая",
  });
  assert.equal(sent.results[0].status, "not_sent", JSON.stringify(sent));
  assert.equal(sent.results[1].status, "applied", JSON.stringify(sent));
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 100);

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.summary.total, 1, JSON.stringify(restored));
  assert.deepEqual(valueWritesSince(hub, before), []);
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 100);
});

test("«включи ленту на 40%» on a lamp with level logic is undone to off, its level left", async (t) => {
  const { hub, client } = await setup(t, {
    faults: { lampLogic: [{ aId: 17, sId: 13 }] },
  });
  const sent = await command(
    client,
    [
      [STRIP_LEVEL, 40],
      [STRIP_ON, true],
    ],
    "Включить ленту на 40%",
  );
  // The level already switched the strip on before its On command.
  assert.equal(sent.results[1].previous_value, false);

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  const on = itemFor(restored, sent.results[1].change_ref);
  assert.equal(on.status, "restored", JSON.stringify(on));
  assert.equal(on.sent, true);
  assertLevelLeft(itemFor(restored, sent.results[0].change_ref));
  assert.deepEqual(valueWritesSince(hub, before), [["17.14", false]]);
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
});

test("a level alone that switched an off lamp on is undone to off, its level left", async (t) => {
  const { hub, client } = await setup(t, {
    faults: { lampLogic: [{ aId: 17, sId: 13 }] },
  });
  const sent = await command(
    client,
    [[STRIP_LEVEL, 40]],
    "Поставить ленту на 40%",
  );
  assert.equal(currentValue(hub, STRIP_ON), true);

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(restored.summary.total, 2);
  assertLevelLeft(itemFor(restored, sent.results[0].change_ref));
  const on = restored.results.find(({ type }) => type === "On");
  assert.equal(on.status, "restored", JSON.stringify(on));
  assert.equal(on.sent, true);
  assert.deepEqual(on.value, { from: true, to: false });
  assert.deepEqual(valueWritesSince(hub, before), [["17.14", false]]);
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
});

// A lamp is a service with On and a level, whether or not the lamp logic is
// assigned to it.
test("a level stored on an off lamp without lamp logic is not written back", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(
    client,
    [[STRIP_LEVEL, 40]],
    "Поставить ленту на 40%",
  );
  assert.equal(sent.results[0].warning?.code, "device_off_level_stored");

  const before = hub.requests.length;
  const restored = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assertLevelLeft(itemFor(restored, sent.results[0].change_ref));
  assert.deepEqual(valueWritesSince(hub, before), []);
  assert.equal(currentValue(hub, STRIP_ON), false);
  assert.equal(currentValue(hub, STRIP_LEVEL), 40);
});

test("an undo write that never reached the lamp is finished by the resend its item offers", async (t) => {
  const { hub, client } = await setup(t);
  const sent = await command(client, [[FLOOR_ON, false]], "Выключить торшер");
  // The lamp ignores the undo write and the hub never answers it.
  hub.state.faults.stuckActuators.add(16);
  hub.state.faults.droppedReply.push({
    method: "characteristic.update",
    aId: 16,
    cId: 14,
    remaining: 1,
  });
  const first = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  const lost = itemFor(first, sent.results[0].change_ref);
  assert.equal(lost.status, "uncertain");
  assert.equal(lost.reason, "restore_unconfirmed");
  assert.equal(lost.sent, true);
  hub.state.faults.stuckActuators.delete(16);

  // A repeated undo does not resend by itself and offers the resend.
  const before = hub.requests.length;
  const repeated = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  const held = itemFor(repeated, sent.results[0].change_ref);
  assert.equal(held.status, "uncertain");
  assert.equal(held.sent, false);
  assert.deepEqual(valueWritesSince(hub, before), []);
  assert.equal(held.next.tool, "send_device_commands");
  assert.deepEqual(held.next.arguments.commands, [
    { target_ref: refOf(FLOOR_ON), value: true, resend_unconfirmed: true },
  ]);

  const resent = await call(client, held.next.tool, held.next.arguments);
  assert.equal(resent.results[0].status, "applied");
  assert.equal(currentValue(hub, FLOOR_ON), true);
  const finished = await call(client, "restore_native_change", {
    change_ref: sent.group_ref,
  });
  assert.equal(finished.status, "ok", JSON.stringify(finished.results));
  assert.deepEqual(homeChanges(hub), []);
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

test("an earlier command on a device the agent changed again names the later command until both are undone", async (t) => {
  const { hub, client } = await setup(t);
  const first = await command(
    client,
    [[AC_SETPOINT, 24]],
    "Поставить кондиционер на 24",
  );
  const second = await command(client, [[AC_SETPOINT, 25]], "Ещё теплее, 25");
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
    ["19.17", 24],
    ["19.17", 23],
  ]);
  assert.deepEqual(homeChanges(hub), []);
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

  const history = await call(client, "get_native_change", {
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

// «Что ты менял в гостиной?»: a room ref selects changes of the room itself,
// not of the devices in it, so an empty answer says where those are.
test("history of a room says that its devices' changes are found by the device", async (t) => {
  const { client } = await setup(t);
  const sent = await command(
    client,
    [[CHANDELIER_ON, false]],
    "Выключить люстру",
  );

  const room = await call(client, "get_native_change", {
    entity_ref: `${homeRef}/room/3`,
  });
  assert.deepEqual(room.changes, []);
  assert.equal(typeof room.hint, "string");

  const device = await call(client, "get_native_change", {
    entity_ref: `${homeRef}/accessory/15`,
  });
  assert.deepEqual(
    device.changes.map(({ change_ref: ref }) => ref),
    [sent.results[0].change_ref],
  );
  assert.equal(device.hint, undefined);
});

test("history names a prepared device setting by its device", async (t) => {
  const { client } = await setup(t);
  const setpoint = await prepareAndApply(client, {
    operation: "characteristic_value",
    target_ref: refOf(characteristic(19, 17)),
    value: 24,
    reason: "Сделать в гостиной теплее",
  });

  const history = await call(client, "get_native_change", {
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
