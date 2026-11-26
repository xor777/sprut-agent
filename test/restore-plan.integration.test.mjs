import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { FAKE_HUB_HOST, ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  SIMULATED_HUB_TOKEN,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOME_REF = "spruthub://hub/sim-apartment-01";
const PREDEFINED_INDEX = "201";
const GLOBAL_INDEX = "202";
const SECRET_LOGIC_INDEX = "203";
const HTTP_BLOCK_INDEX = "204";
const SECRET_JS_TOKEN = "js-secret-token-must-never-leak-771";
const SECRET_JS_TOKEN_2 = "js-secret-token-replacement-never-leak-772";
const SECRET_TELEGRAM_TOKEN = "12345678:AABBCCDDeeffgghhiijjkkllmmnn001122";

function roomRef(id) {
  return `${HOME_REF}/room/${id}`;
}

function accessoryRef(id) {
  return `${HOME_REF}/accessory/${id}`;
}

function serviceRef(aId, sId) {
  return `${accessoryRef(aId)}/service/${sId}`;
}

function characteristicRef(aId, sId, cId) {
  return `${serviceRef(aId, sId)}/characteristic/${cId}`;
}

function scenarioRef(index) {
  return `${HOME_REF}/scenario/${encodeURIComponent(index)}`;
}

function windowRef(windowKey) {
  return `${HOME_REF}/window/${encodeURIComponent(windowKey)}`;
}

function logicRef(aId, sId, type) {
  return `${serviceRef(aId, sId)}/logic/${encodeURIComponent(type)}`;
}

async function createExtendedFixture() {
  const fixture = await loadHomeFixture("apartment");
  fixture.scenarios.push(
    {
      index: PREDEFINED_INDEX,
      name: "Плавное включение",
      type: "LOGIC",
      predefined: true,
      active: true,
      onStart: true,
      data: "info = { name: 'Плавное включение' }; function trigger() {}",
    },
    {
      index: GLOBAL_INDEX,
      name: "Общие помощники",
      desc: "Хелперы для дома",
      type: "GLOBAL",
      predefined: false,
      active: true,
      onStart: true,
      sync: false,
      data: "function helper() { return 1; }",
    },
    {
      index: SECRET_LOGIC_INDEX,
      name: "Интеграция с облаком",
      desc: "Внешний API",
      type: "LOGIC",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: `info = { name: "Интеграция с облаком" }; const apiToken = "${SECRET_JS_TOKEN}"; function trigger() {}`,
    },
    {
      index: HTTP_BLOCK_INDEX,
      name: "Уведомление вебхуком",
      desc: "Отправка по HTTP",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: { type: "condition", mode: "AND", conditions: [] },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK scenarios use this native key.
            then: [
              {
                type: "http",
                method: "GET",
                url: `https://api.telegram.org/bot${SECRET_TELEGRAM_TOKEN}/sendMessage?chat_id=1`,
              },
            ],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
  );
  return fixture;
}

async function setup(t, { fixture: customFixture, hubOptions } = {}) {
  const fixture = customFixture ?? (await createExtendedFixture());
  const hub = await startSimulatedHub(fixture, hubOptions);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-restore-plan-"),
  );
  const { client } = await connectServer(t, {
    env: {
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
  });
  t.after(async () => {
    await hub.close().catch(() => {});
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, stateDirectory };
}

async function connectServer(t, { env }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "restore-plan-integration-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return { client };
}

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} unexpectedly failed: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return result.structuredContent;
}

async function applyNative(client, prepareArgs) {
  const prepared = await callOk(client, "prepare_native_change", prepareArgs);
  assert.equal(
    prepared.status,
    "prepared",
    `expected prepared, got ${JSON.stringify(prepared)}`,
  );
  const applied = await callOk(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(
    applied.status,
    "applied",
    `expected applied, got ${JSON.stringify(applied)}`,
  );
  return applied;
}

async function executeRestorePlan(client, restorePlan) {
  for (const batch of restorePlan.undo_agent_changes) {
    assert.equal(batch.tool, "restore_native_change");
    const restored = await callOk(client, batch.tool, batch.arguments);
    assert.equal(
      restored.status,
      "ok",
      `undo batch ${batch.batch_index} failed: ${JSON.stringify(restored)}`,
    );
    assert.equal(
      restored.summary.restored,
      batch.arguments.change_refs.length,
      `undo batch ${batch.batch_index} did not restore all changes: ${JSON.stringify(restored)}`,
    );
  }
  for (const step of restorePlan.reapply_from_point) {
    assert.equal(step.tool, "prepare_native_change");
    const prepared = await callOk(client, step.tool, step.arguments);
    assert.equal(
      prepared.status,
      "prepared",
      `reapply step ${step.entity_ref}/${step.field} failed prepare: ${JSON.stringify(prepared)}`,
    );
    const applied = await callOk(client, "apply_native_change", {
      change_ref: prepared.change_ref,
    });
    assert.equal(
      applied.status,
      "applied",
      `reapply step ${step.entity_ref}/${step.field} failed apply: ${JSON.stringify(applied)}`,
    );
  }
}

async function startMultiHomeAuthHub(t, { login, password, homes }) {
  const requests = [];
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  server.on("connection", (socket) => {
    let step = 0;
    socket.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      requests.push(req);
      const params = req.params ?? {};
      if (params.account?.auth) {
        step = 1;
        socket.send(
          JSON.stringify({
            id: req.id,
            result: {
              account: {
                auth: {
                  status: "ACCOUNT_RESPONSE_SUCCESS",
                  question: { type: "QUESTION_TYPE_EMAIL", delay: 0 },
                },
              },
            },
          }),
        );
        return;
      }
      if (params.account?.answer) {
        if (step === 1 && params.account.answer.data === login) {
          step = 2;
          socket.send(
            JSON.stringify({
              id: req.id,
              result: {
                account: {
                  answer: {
                    status: "ACCOUNT_RESPONSE_SUCCESS",
                    question: { type: "QUESTION_TYPE_PASSWORD", delay: 0 },
                  },
                },
              },
            }),
          );
          return;
        }
        if (step === 2 && params.account.answer.data === password) {
          socket.send(
            JSON.stringify({
              id: req.id,
              result: {
                account: {
                  answer: {
                    status: "ACCOUNT_RESPONSE_SUCCESS",
                    token: "multi-home-session-token",
                  },
                },
              },
            }),
          );
          return;
        }
      }
      if (params.hub?.list) {
        socket.send(
          JSON.stringify({
            id: req.id,
            result: { hub: { list: { hubs: homes } } },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          id: req.id,
          error: { code: -32601, message: "unexpected request" },
        }),
      );
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { url: `ws://127.0.0.1:${address.port}`, requests };
}

test("whole-home plan_restore=true classifies agent undo vs manual reapply vs not_restorable, and executing every planned step restores the home cleanly", async (t) => {
  const { hub, client } = await setup(t);

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Tuesday evening baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  // --- Agent changes (must land in undo_agent_changes) ---
  const agentRoomRename = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(1),
    value: "Холл агента",
    reason: "Переименовать прихожую",
  });
  const agentScenarioActive = await applyNative(client, {
    operation: "scenario_active",
    target_ref: scenarioRef("7"),
    value: true,
    reason: "Включить сценарий прихожей",
  });
  const agentPlacement = await applyNative(client, {
    operation: "accessory_placement",
    target_ref: accessoryRef(12),
    name: "Бра агента",
    room_ref: roomRef(2),
    reason: "Перенести свет в коридор",
  });
  const agentClimate = await applyNative(client, {
    operation: "characteristic_value",
    target_ref: characteristicRef(19, 13, 17),
    value: 20,
    reason: "Понизить уставку кондиционера",
  });
  const scen14Data = JSON.parse(
    hub.state.scenarios.find(({ index }) => index === "14").data,
  );
  scen14Data.targets[0].then_delay = 4_000;
  const agentBlockUpdate = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("14"),
    data: scen14Data,
    reason: "Добавить задержку вечернему свету",
  });
  const agentBridgeExport = await applyNative(client, {
    operation: "window_option",
    target_ref: windowRef("Bridge/yandex/Child/12/"),
    option_key: "s:13",
    value: true,
    reason: "Добавить свет прихожей в Алису",
  });
  const agentVirtualDevice = await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(3),
    name: "Режим гостей",
    value: "Switch",
    reason: "Создать виртуальный выключатель",
  });

  // Agent edit followed by manual overwrite -> agent_and_later_change (must NOT enter undo_agent_changes).
  const agentThenManualRoom = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(4),
    value: "Столовая агента",
    reason: "Переименовать кухню",
  });
  hub.state.rooms.find(({ id }) => id === 4).name = "Кухня ручная";

  // --- Pure manual hub edits (must land in reapply_from_point with manual_override_warning=true) ---
  hub.state.rooms.find(({ id }) => id === 2).name = "Коридор ручной";

  const acc15 = hub.state.accessories.find(({ id }) => id === 15);
  acc15.name = "Люстра ручная";
  acc15.roomId = 4;

  const svc16 = hub.state.accessories
    .find(({ id }) => id === 16)
    .services.find(({ sId }) => sId === 13);
  svc16.name = "Лампа торшера ручная";
  svc16.visible = false;

  const fanSpeedCtrl = hub.state.accessories
    .find(({ id }) => id === 28)
    .services.find(({ sId }) => sId === 13)
    .characteristics.find(({ cId }) => cId === 17).control;
  fanSpeedCtrl.value = { intValue: 6 };

  const scen3 = hub.state.scenarios.find(({ index }) => index === "3");
  const scen3Parsed = JSON.parse(scen3.data);
  scen3Parsed.targets[0].then_delay = 5_000;
  scen3.data = JSON.stringify(scen3Parsed);
  scen3.name = "Коридор ручной";
  scen3.desc = "Изменено вручную";
  scen3.onStart = true;
  scen3.sync = true;

  const scen9 = hub.state.scenarios.find(({ index }) => index === "9");
  scen9.name = "Защита от протечки v2";
  scen9.data = scen9.data.replace(
    'name: "Защита от протечки"',
    'name: "Защита от протечки v2"',
  );

  const globalScen = hub.state.scenarios.find(
    ({ index }) => index === GLOBAL_INDEX,
  );
  globalScen.name = "Помощники v2";
  globalScen.sync = true;
  globalScen.data = "function helper() { return 42; }";

  // --- Non-restorable items ---
  // Deleted physical device (accessory 20).
  hub.state.accessories = hub.state.accessories.filter(({ id }) => id !== 20);
  // Manual edit on BLOCK containing hidden Telegram HTTP URL.
  const httpScen = hub.state.scenarios.find(
    ({ index }) => index === HTTP_BLOCK_INDEX,
  );
  const httpParsed = JSON.parse(httpScen.data);
  httpParsed.targets[0].then_delay = 3_000;
  httpScen.data = JSON.stringify(httpParsed);
  // Manual edit on secret-bearing LOGIC.
  const secretScen = hub.state.scenarios.find(
    ({ index }) => index === SECRET_LOGIC_INDEX,
  );
  secretScen.data = `info = { name: "Интеграция с облаком" }; const apiToken = "${SECRET_JS_TOKEN_2}"; function trigger() { log("edited"); }`;

  const writesBeforePlan = hub.writes().length;
  const planned = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });

  // Strictly read-only: planning sends 0 writes to hub.
  assert.equal(hub.writes().length, writesBeforePlan);
  assert.ok(planned.restore_plan, "expected top-level restore_plan");
  const plan = planned.restore_plan;
  assert.equal(plan.read_only, true);
  assert.equal(plan.point_ref, saved.point_ref);
  assert.equal(plan.coverage, "home");
  assert.equal(plan.has_manual_overrides, true);
  assert.equal(plan.requires_owner_confirmation, true);
  assert.equal(typeof plan.tell_owner, "string");
  assert.ok(plan.tell_owner.length > 0);
  assert.equal(typeof plan.backup_note, "string");
  assert.ok(plan.backup_note.length > 0);

  // Check summary consistency.
  const allUndoRefs = plan.undo_agent_changes.flatMap(
    (batch) => batch.arguments.change_refs,
  );
  assert.equal(plan.summary.undo_agent_changes_count, allUndoRefs.length);
  assert.equal(plan.summary.undo_batches_count, plan.undo_agent_changes.length);
  assert.equal(
    plan.summary.reapply_from_point_count,
    plan.reapply_from_point.length,
  );
  assert.equal(
    plan.summary.manual_override_count,
    plan.reapply_from_point.filter((item) => item.manual_override_warning)
      .length,
  );
  assert.equal(plan.summary.not_restorable_count, plan.not_restorable.length);

  // All 7 clean agent changes must be in undo_agent_changes; overwritten room 4 must NOT.
  const expectedUndoRefs = [
    agentRoomRename.change_ref,
    agentScenarioActive.change_ref,
    agentPlacement.change_ref,
    agentClimate.change_ref,
    agentBlockUpdate.change_ref,
    agentBridgeExport.change_ref,
    agentVirtualDevice.change_ref,
  ];
  assert.equal(allUndoRefs.length, expectedUndoRefs.length);
  for (const ref of expectedUndoRefs) {
    assert.equal(
      allUndoRefs.includes(ref),
      true,
      `missing expected undo change_ref ${ref} in ${JSON.stringify(allUndoRefs)}`,
    );
  }
  assert.equal(allUndoRefs.includes(agentThenManualRoom.change_ref), false);

  // Clean agent items must NOT be duplicated in reapply_from_point or not_restorable.
  for (const undoEntityRef of [
    roomRef(1),
    scenarioRef("7"),
    accessoryRef(12),
    characteristicRef(19, 13, 17),
    scenarioRef("14"),
  ]) {
    assert.equal(
      plan.reapply_from_point.some(
        ({ entity_ref }) => entity_ref === undoEntityRef,
      ),
      false,
      `undoable entity ${undoEntityRef} should not be duplicated in reapply_from_point`,
    );
  }

  // Overwritten room 4 must be in reapply_from_point with manual_override_warning=true.
  const room4Reapply = plan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === roomRef(4),
  );
  assert.ok(room4Reapply);
  assert.equal(room4Reapply.attribution, "agent_and_later_change");
  assert.equal(room4Reapply.manual_override_warning, true);
  assert.equal(room4Reapply.arguments.operation, "room_name");

  // Manual edits must carry manual_override_warning=true and never contain [REDACTED] in arguments.
  assert.ok(plan.reapply_from_point.length >= 10);
  for (const step of plan.reapply_from_point) {
    assert.equal(step.manual_override_warning, true);
    assert.equal(step.tool, "prepare_native_change");
    assert.equal(typeof step.arguments.reason, "string");
    assert.ok(step.arguments.reason.trim().length > 0);
    assert.equal(
      JSON.stringify(step.arguments).includes("[REDACTED]"),
      false,
      `reapply step leaked [REDACTED]: ${JSON.stringify(step)}`,
    );
  }

  // Non-restorable checks.
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === accessoryRef(20) &&
        item.reason === "physical_device_removed",
    ),
    true,
    JSON.stringify(plan.not_restorable),
  );
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === scenarioRef(HTTP_BLOCK_INDEX) &&
        item.reason === "redacted_http_url",
    ),
    true,
    JSON.stringify(plan.not_restorable),
  );
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === scenarioRef(SECRET_LOGIC_INDEX) &&
        item.reason === "redacted_value",
    ),
    true,
    JSON.stringify(plan.not_restorable),
  );

  // Zero secret leaks anywhere in the serialized response.
  const serializedPlan = JSON.stringify(planned);
  for (const secret of [
    SECRET_JS_TOKEN,
    SECRET_JS_TOKEN_2,
    SECRET_TELEGRAM_TOKEN,
    SIMULATED_HUB_TOKEN,
  ]) {
    assert.equal(serializedPlan.includes(secret), false, `leaked ${secret}`);
  }

  // ACTUALLY EXECUTE the entire rollback plan over MCP stdio!
  await executeRestorePlan(client, plan);

  // Re-compare: ZERO diffs on every restorable item; ONLY genuinely not_restorable items remain.
  const after = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    max_bytes: 32_768,
  });
  assert.deepEqual(after.comparison.rooms, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(after.comparison.bridges, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(after.comparison.climate_setpoints, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(after.comparison.accessories.added, []);
  assert.deepEqual(after.comparison.accessories.changed, []);
  assert.deepEqual(
    after.comparison.accessories.removed.map(({ ref }) => ref),
    [accessoryRef(20)],
  );
  assert.deepEqual(after.comparison.scenarios.added, []);
  assert.deepEqual(after.comparison.scenarios.removed, []);
  assert.deepEqual(
    after.comparison.scenarios.changed.map(({ ref }) => ref),
    [scenarioRef(HTTP_BLOCK_INDEX)],
  );
  assert.equal(
    after.comparison.not_compared.some(
      ({ entity_ref, reason }) =>
        entity_ref === scenarioRef(SECRET_LOGIC_INDEX) && reason === "redacted",
    ),
    true,
  );
});

test("safety edge cases: in-window restore, partial placement edits, >5 chained edits, deleted room, predefined/LOGIC metadata, corrupt journal, and 50-change batch splitting", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);

  // Pre-snapshot change on room 7, to be cleanly restored AFTER snapshot (in-window "restore" event).
  const preRoom7 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(7),
    value: "Офис до снимка",
    reason: "До снимка переименовать кабинет",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Safety edge cases baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 1. In-window "restore" event on room 7 -> must NOT enter undo_agent_changes; falls back to reapply_from_point with manual_override_warning=false.
  const restoredRoom7 = await callOk(client, "restore_native_change", {
    change_ref: preRoom7.change_ref,
  });
  assert.equal(restoredRoom7.status, "restored");

  // 2a. Partial manual edit on multi-field accessory_placement (acc 12): agent changes name+room, owner edits name -> NOT in undo_agent_changes.
  const partialPlacementA = await applyNative(client, {
    operation: "accessory_placement",
    target_ref: accessoryRef(12),
    name: "Свет агента",
    room_ref: roomRef(3),
    reason: "Перенести и переименовать",
  });
  hub.state.accessories.find(({ id }) => id === 12).name = "Свет ручной";

  // 2b. Sneaky partial manual revert on multi-field accessory_placement (acc 15): agent changes name+room, owner moves room back -> NOT in undo_agent_changes.
  const partialPlacementB = await applyNative(client, {
    operation: "accessory_placement",
    target_ref: accessoryRef(15),
    name: "Люстра агента",
    room_ref: roomRef(4),
    reason: "Перенести люстру на кухню",
  });
  hub.state.accessories.find(({ id }) => id === 15).roomId = 3;

  // 3. >5 chained agent edits (7 edits) on room 1 -> ALL 7 uncapped in undo_agent_changes newest-first.
  const room1Chain = [];
  for (let index = 1; index <= 7; index += 1) {
    const applied = await applyNative(client, {
      operation: "room_name",
      target_ref: roomRef(1),
      value: `Прихожая ${index}`,
      reason: `Шаг переименования ${index}`,
    });
    room1Chain.push(applied.change_ref);
  }

  // 4. Deleted target room (room 2 deleted, acc 14 moved from room 2 to room 3 and renamed) -> room_ref target_room_missing, name still restorable.
  const acc14 = hub.state.accessories.find(({ id }) => id === 14);
  acc14.roomId = 3;
  acc14.name = "Свет без комнаты 2";
  hub.state.rooms = hub.state.rooms.filter(({ id }) => id !== 2);

  // 5. Predefined scenario active changed -> not_restorable (predefined_scenario).
  hub.state.scenarios.find(({ index }) => index === PREDEFINED_INDEX).active =
    false;

  // 6. LOGIC name-only diff without code edit -> not_restorable (logic_info_in_code).
  hub.state.scenarios.find(({ index }) => index === "9").name =
    "Имя LOGIC только в приложении";

  const planned = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  assert.ok(planned.restore_plan, "expected top-level restore_plan");
  const plan = planned.restore_plan;
  const undoRefs = plan.undo_agent_changes.flatMap(
    (batch) => batch.arguments.change_refs,
  );

  // In-window restore excluded from undo, included in reapply with manual_override_warning=false.
  assert.equal(undoRefs.includes(preRoom7.change_ref), false);
  const room7Reapply = plan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === roomRef(7),
  );
  assert.ok(room7Reapply);
  assert.equal(room7Reapply.attribution, "agent");
  assert.equal(room7Reapply.manual_override_warning, false);
  assert.equal(room7Reapply.arguments.operation, "room_name");
  assert.equal(room7Reapply.arguments.value, "Офис до снимка");

  // Partial placement edits excluded from undo, included in reapply.
  assert.equal(undoRefs.includes(partialPlacementA.change_ref), false);
  assert.equal(undoRefs.includes(partialPlacementB.change_ref), false);
  assert.ok(
    plan.reapply_from_point.find(
      ({ entity_ref, arguments: args }) =>
        entity_ref === accessoryRef(12) &&
        args.operation === "accessory_placement",
    ),
  );
  assert.ok(
    plan.reapply_from_point.find(
      ({ entity_ref, arguments: args }) =>
        entity_ref === accessoryRef(15) &&
        args.operation === "accessory_placement",
    ),
  );

  // All 7 chained edits on room 1 appear uncapped and newest-first.
  assert.equal(
    planned.comparison.rooms.changed.find(({ ref }) => ref === roomRef(1))
      .matching_agent_changes_total,
    7,
  );
  const room1UndoOrder = undoRefs.filter((ref) => room1Chain.includes(ref));
  assert.deepEqual(room1UndoOrder, [...room1Chain].reverse());

  // Execute the room 1 undo batch and confirm it restores cleanly back to "Прихожая".
  await executeRestorePlan(client, {
    undo_agent_changes: plan.undo_agent_changes,
    reapply_from_point: [],
  });
  assert.equal(hub.state.rooms.find(({ id }) => id === 1).name, "Прихожая");

  // Deleted target room: room_ref -> target_room_missing, name -> executable accessory_placement in current room 3.
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === accessoryRef(14) &&
        item.field === "room_ref" &&
        item.reason === "target_room_missing",
    ),
    true,
    JSON.stringify(plan.not_restorable),
  );
  const acc14NameStep = plan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === accessoryRef(14),
  );
  assert.ok(acc14NameStep);
  assert.equal(acc14NameStep.arguments.operation, "accessory_placement");
  assert.equal(acc14NameStep.arguments.name, "Свет в коридоре");
  assert.equal(acc14NameStep.arguments.room_ref, roomRef(3));
  await executeRestorePlan(client, {
    undo_agent_changes: [],
    reapply_from_point: [acc14NameStep],
  });
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 14).name,
    "Свет в коридоре",
  );

  // Predefined scenario and LOGIC name-only diff -> not_restorable, never in reapply_from_point.
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === scenarioRef(PREDEFINED_INDEX) &&
        item.reason === "predefined_scenario",
    ),
    true,
  );
  assert.equal(
    plan.reapply_from_point.some(
      ({ entity_ref }) => entity_ref === scenarioRef(PREDEFINED_INDEX),
    ),
    false,
  );
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === scenarioRef("9") &&
        item.reason === "logic_info_in_code",
    ),
    true,
    JSON.stringify(plan.not_restorable),
  );
  assert.equal(
    plan.reapply_from_point.some(
      ({ entity_ref }) => entity_ref === scenarioRef("9"),
    ),
    false,
  );

  // 7. Batch splitting: 55 chained agent edits chunk into [50, 5] and execute cleanly back to point.
  const batchPoint = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Before 55 room edits",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const fiftyFiveRefs = [];
  for (let index = 1; index <= 55; index += 1) {
    const applied = await applyNative(client, {
      operation: "room_name",
      target_ref: roomRef(8),
      value: `Ванная ${index}`,
      reason: `Batch edit ${index}`,
    });
    fiftyFiveRefs.push(applied.change_ref);
  }
  const batchPlanned = await callOk(client, "configuration_point", {
    point_ref: batchPoint.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  assert.equal(batchPlanned.restore_plan.summary.undo_agent_changes_count, 55);
  assert.equal(batchPlanned.restore_plan.summary.undo_batches_count, 2);
  assert.equal(batchPlanned.restore_plan.undo_agent_changes.length, 2);
  assert.equal(batchPlanned.restore_plan.undo_agent_changes[0].batch_index, 0);
  assert.equal(
    batchPlanned.restore_plan.undo_agent_changes[0].arguments.change_refs
      .length,
    50,
  );
  assert.equal(batchPlanned.restore_plan.undo_agent_changes[1].batch_index, 1);
  assert.equal(
    batchPlanned.restore_plan.undo_agent_changes[1].arguments.change_refs
      .length,
    5,
  );
  const combinedBatchRefs =
    batchPlanned.restore_plan.undo_agent_changes.flatMap(
      (batch) => batch.arguments.change_refs,
    );
  assert.deepEqual(combinedBatchRefs, [...fiftyFiveRefs].reverse());
  await executeRestorePlan(client, {
    undo_agent_changes: batchPlanned.restore_plan.undo_agent_changes,
    reapply_from_point: [],
  });
  assert.equal(hub.state.rooms.find(({ id }) => id === 8).name, "Ванная");

  // 8. Corrupt AutomationStore -> attribution_unavailable=true, undo_agent_changes=[], manual_override_warning=true, requires_owner_confirmation=true.
  const storeFiles = (await readdir(stateDirectory)).filter(
    (name) => name.startsWith("automation-changes-") && name.endsWith(".json"),
  );
  assert.ok(storeFiles.length >= 1);
  await writeFile(
    path.join(stateDirectory, storeFiles[0]),
    "{corrupt-json",
    "utf8",
  );
  const corruptPlanned = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  assert.equal(corruptPlanned.comparison.attribution_unavailable, true);
  assert.deepEqual(corruptPlanned.restore_plan.undo_agent_changes, []);
  assert.equal(corruptPlanned.restore_plan.requires_owner_confirmation, true);
  assert.equal(typeof corruptPlanned.restore_plan.tell_owner, "string");
  assert.ok(corruptPlanned.restore_plan.reapply_from_point.length > 0);
  for (const step of corruptPlanned.restore_plan.reapply_from_point) {
    assert.equal(step.manual_override_warning, true);
  }
});

test("selected_entities plan_restore=true plans and executes rollback across characteristic, window, logic, scenario, and accessory", async (t) => {
  const { hub, client } = await setup(t);

  // Assign SmoothBrightnessChange logic to accessory 15/13 so it has active + Duration option.
  const smoothRef = logicRef(15, 13, "SmoothBrightnessChange");
  await applyNative(client, {
    operation: "logic_assignment",
    target_ref: smoothRef,
    reason: "Назначить плавное изменение яркости",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  const acc16DeviceWindowKey = hub.state.accessories.find(
    ({ id }) => id === 16,
  ).deviceWindow;
  assert.equal(typeof acc16DeviceWindowKey, "string");
  const acc16WindowRef = windowRef(acc16DeviceWindowKey);
  const tempRef = characteristicRef(19, 13, 17);

  const saved = await callOk(client, "configuration_point", {
    entity_refs: [
      tempRef,
      acc16WindowRef,
      smoothRef,
      scenarioRef("3"),
      scenarioRef("9"),
      accessoryRef(12),
    ],
    note: "Selected entities baseline",
  });
  assert.equal(saved.captured.length, 6);
  await new Promise((resolve) => setTimeout(resolve, 15));

  // Agent edits: TargetTemperature 23 -> 21, SmoothBrightnessChange active false -> true.
  const agentTemp = await applyNative(client, {
    operation: "characteristic_value",
    target_ref: tempRef,
    value: 21,
    reason: "Изменить уставку",
  });
  const agentLogicActive = await applyNative(client, {
    operation: "logic_active",
    target_ref: smoothRef,
    value: true,
    reason: "Включить логику яркости",
  });

  // Manual edits: window option 255 -> 1, logic option Duration 900 -> 300, scenario 3 data+name, scenario 9 code, accessory 12 move+rename.
  const win16 = hub.state.windows[acc16DeviceWindowKey];
  win16.options.find(
    ({ key }) => key === "/11/0006_OnOff/4003_StartUpOnOff/255",
  ).value = { intValue: 1 };

  const logicOptions =
    hub.state.logicOptionValues["15.13.SmoothBrightnessChange"];
  assert.ok(logicOptions);
  logicOptions.find(({ key }) => key === "Duration").value = {
    intValue: 300,
  };

  const scen3 = hub.state.scenarios.find(({ index }) => index === "3");
  const scen3Data = JSON.parse(scen3.data);
  scen3Data.targets[0].then_delay = 6_000;
  scen3.data = JSON.stringify(scen3Data);
  scen3.name = "Свет ручной";

  const scen9 = hub.state.scenarios.find(({ index }) => index === "9");
  scen9.data = `${scen9.data}\n// manual tweak`;

  const acc12 = hub.state.accessories.find(({ id }) => id === 12);
  acc12.name = "Прихожая лампа ручная";
  acc12.roomId = 2;

  const planned = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  assert.ok(planned.restore_plan, "expected top-level restore_plan");
  const plan = planned.restore_plan;
  assert.equal(plan.read_only, true);
  assert.equal(plan.coverage, "selected_entities");
  assert.equal(plan.has_manual_overrides, true);
  assert.equal(plan.requires_owner_confirmation, true);
  assert.equal(typeof plan.tell_owner, "string");

  const undoRefs = plan.undo_agent_changes.flatMap(
    (batch) => batch.arguments.change_refs,
  );
  assert.equal(undoRefs.includes(agentTemp.change_ref), true);
  // Logic had agent active edit + manual Duration edit -> entity attribution is agent_and_later_change, so agentLogicActive is NOT in undo_agent_changes and logic active + Duration both fall back cleanly to reapply_from_point!
  assert.equal(undoRefs.includes(agentLogicActive.change_ref), false);

  const reapplyOps = plan.reapply_from_point.map(
    ({ arguments: args }) => args.operation,
  );
  for (const op of [
    "window_option",
    "logic_active",
    "logic_option",
    "block_data_update",
    "logic_source_update",
    "accessory_placement",
  ]) {
    assert.equal(
      reapplyOps.includes(op),
      true,
      `expected ${op} in ${JSON.stringify(reapplyOps)}`,
    );
  }

  await executeRestorePlan(client, plan);

  const after = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    max_bytes: 32_768,
  });
  for (const entity of after.comparison.entities) {
    assert.equal(
      entity.status,
      "unchanged",
      `expected ${entity.entity_ref} unchanged, got ${JSON.stringify(entity)}`,
    );
    assert.deepEqual(entity.changes, []);
  }
});

test("validation mutual exclusion, /restore_plan pagination & staleness, MCP budgets, and single-home configuration_point({}) list", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const dummyPointRef =
    "spruthub-point://hub/sim-apartment-01/configuration/0123456789abcdef01234567";

  // 1. Pre-hub mutual exclusion (0 hub requests).
  const invalidCalls = [
    { plan_restore: true },
    { point_ref: dummyPointRef, plan_restore: true },
    { compare: true, plan_restore: true },
    {
      point_ref: dummyPointRef,
      compare: true,
      plan_restore: true,
      scope: "home",
    },
    { point_ref: dummyPointRef, compare: true, plan_restore: true, note: "x" },
    {
      point_ref: dummyPointRef,
      compare: true,
      plan_restore: true,
      entity_refs: [accessoryRef(15)],
    },
    {
      point_ref: dummyPointRef,
      compare: true,
      plan_restore: true,
      hub_backup: "list",
    },
    {
      point_ref: dummyPointRef,
      compare: true,
      plan_restore: true,
      entity_ref: accessoryRef(15),
    },
    {
      point_ref: dummyPointRef,
      compare: true,
      plan_restore: true,
      cursor: "abc",
    },
  ];
  for (const args of invalidCalls) {
    const failed = await callError(client, "configuration_point", args);
    assert.equal(failed.error.code, "invalid_point_call", JSON.stringify(args));
    assert.equal(failed.error.action, "configuration_point");
  }
  assert.equal(hub.requests.length, 0);

  // 2. Paginating /restore_plan with max_bytes=2048 completes without stale_entity_content, and fails stale on live mutation.
  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Pagination restore_plan baseline",
  });
  hub.state.rooms.find(({ id }) => id === 1).name = "Холл 1";
  hub.state.rooms.find(({ id }) => id === 2).name = "Коридор 2";
  hub.state.rooms.find(({ id }) => id === 3).name = "Гостиная 3";
  hub.state.accessories.find(({ id }) => id === 12).name = "Свет 12";
  hub.state.accessories.find(({ id }) => id === 15).name = "Люстра 15";
  hub.state.accessories.find(({ id }) => id === 16).name = "Торшер 16";

  const first = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    pointer: "/restore_plan",
    max_bytes: 2_048,
  });
  assert.equal(first.representation.kind, "selected_value");
  assert.equal(first.representation.selected_pointer, "/restore_plan");
  assert.ok(first.representation.next);
  assert.equal(first.representation.next.arguments.compare, true);
  assert.equal(first.representation.next.arguments.plan_restore, true);

  const seenPointers = [];
  let page = first;
  let pages = 0;
  for (;;) {
    pages += 1;
    seenPointers.push(
      ...page.representation.available_parts.map(({ pointer }) => pointer),
    );
    if (!page.representation.next) break;
    assert.equal(page.representation.next.arguments.compare, true);
    assert.equal(page.representation.next.arguments.plan_restore, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    page = await callOk(
      client,
      page.representation.next.tool,
      page.representation.next.arguments,
    );
    assert.ok(pages < 20, "restore_plan pagination did not finish");
  }
  assert.ok(pages >= 2);
  assert.equal(page.representation.available_parts_complete, true);
  assert.equal(seenPointers.includes("/restore_plan/summary"), true);
  assert.equal(seenPointers.includes("/restore_plan/undo_agent_changes"), true);
  assert.equal(seenPointers.includes("/restore_plan/reapply_from_point"), true);
  assert.equal(seenPointers.includes("/restore_plan/not_restorable"), true);

  // Mid-pagination live mutation MUST trigger stale_entity_content.
  const fresh = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    pointer: "/restore_plan",
    max_bytes: 2_048,
  });
  assert.ok(fresh.representation.next);
  hub.state.rooms.find(({ id }) => id === 4).name = "Кухня изменена";
  const stale = await callError(
    client,
    fresh.representation.next.tool,
    fresh.representation.next.arguments,
  );
  assert.equal(stale.error.code, "stale_entity_content");

  // 3. Single-home email+password account (no SPRUTHUB_SERIAL) lists configuration points with {} in 1 call.
  const emptyConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-restore-cfg-"),
  );
  t.after(async () => {
    await rm(emptyConfigRoot, { recursive: true, force: true });
  });
  const loginFixture = await loadHomeFixture("apartment");
  const singleHomeHub = await startSimulatedHub(loginFixture, {
    account: {
      login: "owner@example.invalid",
      password: "correct-password-123",
    },
  });
  t.after(async () => {
    await singleHomeHub.close().catch(() => {});
  });
  const singleHomeState = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-single-home-"),
  );
  t.after(async () => {
    await rm(singleHomeState, { recursive: true, force: true });
  });
  const singleHomeServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: singleHomeHub.url,
      SPRUTHUB_LOGIN: "owner@example.invalid",
      SPRUTHUB_PASSWORD: "correct-password-123",
      SPRUT_AGENT_STATE_DIR: singleHomeState,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  const singleListEmpty = await callOk(
    singleHomeServer.client,
    "configuration_point",
    {},
  );
  assert.equal(singleListEmpty.status, "ok");
  assert.equal(singleListEmpty.home_ref, HOME_REF);
  assert.deepEqual(singleListEmpty.points, []);

  // Save a point on the single-home unpinned connection and list again without home_ref.
  const singleSaved = await callOk(
    singleHomeServer.client,
    "configuration_point",
    { scope: "home", note: "Single-home list test" },
  );
  const singleListed = await callOk(
    singleHomeServer.client,
    "configuration_point",
    {},
  );
  assert.equal(singleListed.points.length, 1);
  assert.equal(singleListed.points[0].point_ref, singleSaved.point_ref);

  // 4. Multi-home email+password account without SPRUTHUB_SERIAL returns home_selection_required on {}.
  const multiHomeHub = await startMultiHomeAuthHub(t, {
    login: "multi@example.invalid",
    password: "multi-password-123",
    homes: [
      { serial: "home-a", name: "Дом A", online: true },
      { serial: "home-b", name: "Дом B", online: true },
    ],
  });
  const multiConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-multi-cfg-"),
  );
  t.after(async () => {
    await rm(multiConfigRoot, { recursive: true, force: true });
  });
  const multiServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: multiHomeHub.url,
      SPRUTHUB_LOGIN: "multi@example.invalid",
      SPRUTHUB_PASSWORD: "multi-password-123",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: multiConfigRoot,
    },
  });
  const multiErr = await callError(
    multiServer.client,
    "configuration_point",
    {},
  );
  assert.equal(multiErr.error.code, "home_selection_required");
  assert.equal(multiErr.error.action, "home_overview");

  // 5. Offline credential-less session returns home_ref_required on {}, and explicit home_ref / point_ref stays 0-hub-call offline.
  const offlineConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-offline-cfg-"),
  );
  t.after(async () => {
    await rm(offlineConfigRoot, { recursive: true, force: true });
  });
  const offlineServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: singleHomeHub.url,
      SPRUT_AGENT_STATE_DIR: singleHomeState,
      XDG_CONFIG_HOME: offlineConfigRoot,
    },
  });
  const requestsBeforeOffline = singleHomeHub.requests.length;
  const offlineNoRef = await callError(
    offlineServer.client,
    "configuration_point",
    {},
  );
  assert.equal(offlineNoRef.error.code, "home_ref_required");

  const offlineWithHomeRef = await callOk(
    offlineServer.client,
    "configuration_point",
    { home_ref: HOME_REF },
  );
  assert.equal(offlineWithHomeRef.points.length, 1);
  assert.equal(offlineWithHomeRef.points[0].point_ref, singleSaved.point_ref);

  const offlineWithPointRef = await callOk(
    offlineServer.client,
    "configuration_point",
    { point_ref: singleSaved.point_ref },
  );
  assert.equal(
    offlineWithPointRef.entity?.ref ?? offlineWithPointRef.identity?.ref,
    singleSaved.point_ref,
  );
  assert.equal(singleHomeHub.requests.length, requestsBeforeOffline);

  // 6. MCP surface budgets: 13 tools, instructions <= 2048, every description <= 1000, configuration_point <= 920.
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13);
  const configPoint = tools.find(({ name }) => name === "configuration_point");
  assert.ok(configPoint);
  assert.equal(configPoint.inputSchema.properties.plan_restore.type, "boolean");
  assert.ok(
    configPoint.description.length <= 920,
    `configuration_point description exceeded 920 chars: ${configPoint.description.length}`,
  );
  const oversized = tools
    .filter(({ description }) => description.length > 1_000)
    .map(({ name, description }) => `${name}: ${description.length}`);
  assert.deepEqual(oversized, []);
  const instructions = client.getInstructions();
  assert.ok(instructions.length <= 2_048);
});

test("P1-1: manual->agent and agent1->manual->agent2 chains keep manual_override_warning=true and require owner confirmation", async (t) => {
  const { hub, client } = await setup(t);

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "P1-1 manual-before-agent baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Case A: manual -> agent on room 1.
  hub.state.rooms.find(({ id }) => id === 1).name = "Прихожая ручная";
  const room1Agent = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(1),
    value: "Прихожая агента",
    reason: "Переименовать прихожую поверх ручной правки",
  });

  // Case B: agent1 -> manual -> agent2 on room 4.
  const room4Agent1 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(4),
    value: "Кухня агента 1",
    reason: "Первый шаг переименования кухни",
  });
  hub.state.rooms.find(({ id }) => id === 4).name = "Кухня ручная";
  const room4Agent2 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(4),
    value: "Кухня агента 2",
    reason: "Второй шаг переименования кухни",
  });

  const planned = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const plan = planned.restore_plan;
  const undoRefs = plan.undo_agent_changes.flatMap(
    (batch) => batch.arguments.change_refs,
  );
  for (const ref of [
    room1Agent.change_ref,
    room4Agent1.change_ref,
    room4Agent2.change_ref,
  ]) {
    assert.equal(undoRefs.includes(ref), false);
  }

  const room1Step = plan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === roomRef(1),
  );
  const room4Step = plan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === roomRef(4),
  );
  assert.ok(room1Step, "expected room 1 in reapply_from_point");
  assert.ok(room4Step, "expected room 4 in reapply_from_point");
  assert.equal(room1Step.manual_override_warning, true);
  assert.equal(room4Step.manual_override_warning, true);
  assert.equal(plan.has_manual_overrides, true);
  assert.equal(plan.requires_owner_confirmation, true);
  assert.equal(plan.summary.manual_override_count, 2);
  assert.equal(typeof plan.tell_owner, "string");
  assert.ok(plan.tell_owner.length > 0);
});

test("P1-2: clean JS with token ternary/case executes logic_source_update cleanly while connection secret in selected_entities routes to not_restorable", async (t) => {
  const CLEAN_TOKEN_INDEX = "211";
  const CONN_SECRET_INDEX = "212";
  const cleanCode = [
    "function pick(ok, token, fallback) {",
    "  switch (token) {",
    "    case token:",
    "      return ok ? token : fallback;",
    "    default:",
    "      return fallback;",
    "  }",
    "}",
  ].join("\n");

  const fixture = await createExtendedFixture();
  fixture.scenarios.push(
    {
      index: CLEAN_TOKEN_INDEX,
      name: "Выбор значения",
      desc: "Тернарник и switch с идентификатором token",
      type: "GLOBAL",
      predefined: false,
      active: true,
      onStart: true,
      sync: false,
      data: cleanCode,
    },
    {
      index: CONN_SECRET_INDEX,
      name: "Скрипт с токеном хаба",
      desc: "Содержит секрет подключения",
      type: "GLOBAL",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: `function auth() { return "${SIMULATED_HUB_TOKEN}"; }`,
    },
  );
  const { hub, client } = await setup(t, { fixture });

  const homeSaved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "P1-2 home baseline",
  });
  const selectedSaved = await callOk(client, "configuration_point", {
    entity_refs: [
      scenarioRef(CLEAN_TOKEN_INDEX),
      scenarioRef(CONN_SECRET_INDEX),
    ],
    note: "P1-2 selected baseline",
  });

  hub.state.scenarios.find(({ index }) => index === CLEAN_TOKEN_INDEX).data =
    "function pick(ok, token, fallback) { return fallback; }";
  hub.state.scenarios.find(({ index }) => index === CONN_SECRET_INDEX).data =
    'function auth() { return "changed"; }';

  // Selected-entities plan: cleanCode must stay unredacted and executable; connection secret must be not_restorable.
  const selectedPlanResp = await callOk(client, "configuration_point", {
    point_ref: selectedSaved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  assert.equal(
    JSON.stringify(selectedPlanResp).includes(SIMULATED_HUB_TOKEN),
    false,
    "connection secret must never appear in tool output",
  );
  const selPlan = selectedPlanResp.restore_plan;
  const cleanStep = selPlan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === scenarioRef(CLEAN_TOKEN_INDEX),
  );
  assert.ok(cleanStep, "expected clean JS scenario in reapply_from_point");
  assert.equal(cleanStep.arguments.operation, "logic_source_update");
  assert.equal(cleanStep.arguments.source, cleanCode);
  assert.equal(cleanStep.to_point, cleanCode);
  assert.equal(cleanStep.from_current.includes("[REDACTED]"), false);

  assert.equal(
    selPlan.reapply_from_point.some(
      ({ entity_ref }) => entity_ref === scenarioRef(CONN_SECRET_INDEX),
    ),
    false,
    "connection-secret scenario must NOT enter reapply_from_point",
  );
  assert.equal(
    selPlan.not_restorable.some(
      (item) =>
        item.entity_ref === scenarioRef(CONN_SECRET_INDEX) &&
        item.reason === "redacted_value",
    ),
    true,
    JSON.stringify(selPlan.not_restorable),
  );

  // Home plan must also preserve cleanCode unredacted in reapply_from_point.
  const homePlanResp = await callOk(client, "configuration_point", {
    point_ref: homeSaved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const homeCleanStep = homePlanResp.restore_plan.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === scenarioRef(CLEAN_TOKEN_INDEX),
  );
  assert.ok(homeCleanStep);
  assert.equal(homeCleanStep.arguments.source, cleanCode);

  // Actually execute cleanStep through prepare_native_change -> apply_native_change!
  await executeRestorePlan(client, {
    undo_agent_changes: [],
    reapply_from_point: [cleanStep],
  });
  assert.equal(
    hub.state.scenarios.find(({ index }) => index === CLEAN_TOKEN_INDEX).data,
    cleanCode,
  );
});

test("P1-3, P1-5, P2-1: selected_entities handles scenario options windows, deleted accessory rooms, and missing child refs honestly", async (t) => {
  const { hub, client } = await setup(t);

  // Create a virtual device with a characteristic so we can delete it via virtual_device_delete.
  const createdVirt = await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(3),
    name: "Виртуальный датчик для удаления",
    value: "TemperatureSensor",
    reason: "Создать виртуальный датчик температуры",
  });
  const virtAcc = hub.state.accessories.find(
    ({ name }) => name === "Виртуальный датчик для удаления",
  );
  assert.ok(virtAcc);
  const virtSvc = virtAcc.services.find(
    ({ type }) => type === "TemperatureSensor",
  );
  assert.ok(virtSvc);
  // Also create a Thermostat-like virtual switch or use a real window + scenario options window + logic ref.
  const blockScen = hub.state.scenarios.find(({ index }) => index === "3");
  const logicScen = hub.state.scenarios.find(({ index }) => index === "9");
  const predefinedScen = hub.state.scenarios.find(
    ({ index }) => index === PREDEFINED_INDEX,
  );
  assert.ok(blockScen?.optionsWindow);
  assert.ok(logicScen?.optionsWindow);
  assert.ok(predefinedScen?.optionsWindow);

  // P1-3 + P1-5 point: scenario options windows + accessories in room 2.
  const pointA = await callOk(client, "configuration_point", {
    entity_refs: [
      windowRef(blockScen.optionsWindow),
      windowRef(logicScen.optionsWindow),
      windowRef(predefinedScen.optionsWindow),
      accessoryRef(14),
    ],
    note: "P1-3 and P1-5 selected baseline",
  });

  // Flip writable CHECKBOX options (OnStart, Sync) on scenario options windows.
  blockScen.onStart = !blockScen.onStart;
  blockScen.sync = !blockScen.sync;
  logicScen.sync = !logicScen.sync;
  const logicOnStartOpt = hub.state.windows[
    logicScen.optionsWindow
  ].options.find((o) => o.key === "OnStart");
  logicOnStartOpt.value = {
    boolValue: !(logicOnStartOpt.value?.boolValue === true),
  };
  predefinedScen.onStart = !predefinedScen.onStart;

  // Move accessory 14 out of room 2 and delete room 2.
  const acc14 = hub.state.accessories.find(({ id }) => id === 14);
  acc14.roomId = 3;
  acc14.name = "Свет 14 переехал";
  hub.state.rooms = hub.state.rooms.filter(({ id }) => id !== 2);

  const planAResp = await callOk(client, "configuration_point", {
    point_ref: pointA.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const planA = planAResp.restore_plan;

  // P1-3: NONE of the scenario options windows may emit window_option into reapply_from_point!
  for (const winKey of [
    blockScen.optionsWindow,
    logicScen.optionsWindow,
    predefinedScen.optionsWindow,
  ]) {
    assert.equal(
      planA.reapply_from_point.some(
        ({ entity_ref }) => entity_ref === windowRef(winKey),
      ),
      false,
      `scenario options window ${winKey} must NOT emit reapply_from_point: ${JSON.stringify(planA.reapply_from_point)}`,
    );
  }
  assert.equal(
    planA.not_restorable.some(
      (item) =>
        item.entity_ref === windowRef(blockScen.optionsWindow) &&
        item.field === "options.OnStart" &&
        item.reason === "scenario_owner_required",
    ),
    true,
    JSON.stringify(planA.not_restorable),
  );
  assert.equal(
    planA.not_restorable.some(
      (item) =>
        item.entity_ref === windowRef(blockScen.optionsWindow) &&
        item.field === "options.Sync" &&
        item.reason === "scenario_owner_required",
    ),
    true,
    JSON.stringify(planA.not_restorable),
  );
  assert.equal(
    planA.not_restorable.some(
      (item) =>
        item.entity_ref === windowRef(logicScen.optionsWindow) &&
        item.field === "options.OnStart" &&
        item.reason === "logic_info_in_code",
    ),
    true,
    JSON.stringify(planA.not_restorable),
  );
  assert.equal(
    planA.not_restorable.some(
      (item) =>
        item.entity_ref === windowRef(logicScen.optionsWindow) &&
        item.field === "options.Sync" &&
        item.reason === "scenario_owner_required",
    ),
    true,
    JSON.stringify(planA.not_restorable),
  );

  // P1-5: room_ref must be target_room_missing; name reapply must target existing room 3 and execute cleanly!
  assert.equal(
    planA.not_restorable.some(
      (item) =>
        item.entity_ref === accessoryRef(14) &&
        item.field === "room_ref" &&
        item.reason === "target_room_missing",
    ),
    true,
    JSON.stringify(planA.not_restorable),
  );
  const acc14Step = planA.reapply_from_point.find(
    ({ entity_ref }) => entity_ref === accessoryRef(14),
  );
  assert.ok(acc14Step);
  assert.equal(acc14Step.arguments.operation, "accessory_placement");
  assert.equal(acc14Step.arguments.room_ref, roomRef(3));
  await executeRestorePlan(client, {
    undo_agent_changes: [],
    reapply_from_point: [acc14Step],
  });
  assert.equal(
    hub.state.accessories.find(({ id }) => id === 14).name,
    "Свет в коридоре",
  );

  // P2-1: selected_entities point with logic ref, scenario options window ref, and virtual device window ref.
  // Delete LOGIC scenario "9" via scenario_delete and virtual device via virtual_device_delete.
  const virtDeviceWindowKey = virtAcc.deviceWindow;
  const logicAssignmentRef = logicRef(14, 13, "9");
  const pointB = await callOk(client, "configuration_point", {
    entity_refs: [
      logicAssignmentRef,
      windowRef(logicScen.optionsWindow),
      ...(virtDeviceWindowKey ? [windowRef(virtDeviceWindowKey)] : []),
    ],
    note: "P2-1 missing child refs baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await applyNative(client, {
    operation: "scenario_delete",
    target_ref: scenarioRef("9"),
    reason: "Удалить LOGIC сценарий 9",
  });
  if (virtDeviceWindowKey) {
    await applyNative(client, {
      operation: "virtual_device_delete",
      target_ref: accessoryRef(virtAcc.id),
      reason: "Удалить виртуальный датчик",
    });
  }
  assert.ok(createdVirt.change_ref);

  const planBResp = await callOk(client, "configuration_point", {
    point_ref: pointB.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const planB = planBResp.restore_plan;
  assert.equal(planB.requires_owner_confirmation, true);
  assert.equal(
    planB.not_restorable.some(
      (item) => item.entity_ref === logicAssignmentRef && item.kind === "logic",
    ),
    true,
    JSON.stringify(planB.not_restorable),
  );
  assert.equal(
    planB.not_restorable.some(
      (item) =>
        item.entity_ref === windowRef(logicScen.optionsWindow) &&
        item.kind === "window",
    ),
    true,
    JSON.stringify(planB.not_restorable),
  );
  if (virtDeviceWindowKey) {
    assert.equal(
      planB.not_restorable.some(
        (item) =>
          item.entity_ref === windowRef(virtDeviceWindowKey) &&
          item.kind === "window",
      ),
      true,
      JSON.stringify(planB.not_restorable),
    );
  }
  assert.equal(planB.undo_agent_changes.length, 0);
});

test("P1-4: BLOCK planner rejects Nashorn-invalid code, condition code, deleted referenced accessory/scenario, 0-trigger regression, and HTTP-URL undo contradiction", async (t) => {
  const BAD_CODE_BLOCK = "221";
  const COND_CODE_BLOCK = "222";
  const REF_ACC_BLOCK = "223";
  const REF_SCEN_BLOCK = "224";
  const ZERO_TRIG_BLOCK = "225";
  const HTTP_AGENT_BLOCK = "226";

  const triggerCondition = {
    type: "characteristic",
    aId: 12,
    sId: 13,
    cId: 14,
    hs: "Lightbulb",
    hc: "On",
    cond: "==",
    value: "true",
    trigger: true,
    timeCond: "",
    time: 0,
  };
  const turnOn15Action = {
    type: "service",
    aId: 15,
    sId: 13,
    hs: "Lightbulb",
    characteristics: [{ cId: 14, hc: "On", type: "set", value: "true" }],
  };

  const fixture = await createExtendedFixture();
  fixture.scenarios.push(
    {
      index: BAD_CODE_BLOCK,
      name: "BLOCK с неподдерживаемым JS",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: {
              type: "condition",
              mode: "AND",
              conditions: [triggerCondition],
            },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK key.
            then: [{ type: "code", code: "const x = global?.foo;" }],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
    {
      index: COND_CODE_BLOCK,
      name: "BLOCK с кодом в условии",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: {
              type: "condition",
              mode: "AND",
              conditions: [
                triggerCondition,
                { type: "code", code: "return true;" },
              ],
            },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK key.
            then: [turnOn15Action],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
    {
      index: REF_ACC_BLOCK,
      name: "BLOCK со ссылкой на удаляемое устройство",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: {
              type: "condition",
              mode: "AND",
              conditions: [triggerCondition],
            },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK key.
            then: [
              {
                type: "service",
                aId: 20,
                sId: 13,
                hs: "Outlet",
                characteristics: [
                  { cId: 14, hc: "On", type: "set", value: "true" },
                ],
              },
            ],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
    {
      index: REF_SCEN_BLOCK,
      name: "BLOCK со ссылкой на удаляемый сценарий",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: {
              type: "condition",
              mode: "AND",
              conditions: [triggerCondition],
            },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK key.
            then: [{ type: "scenario", index: "7", mode: "ON" }],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
    {
      index: ZERO_TRIG_BLOCK,
      name: "BLOCK без триггера",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [turnOn15Action],
      },
    },
    {
      index: HTTP_AGENT_BLOCK,
      name: "BLOCK с HTTP и правкой агента",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: {
              type: "condition",
              mode: "AND",
              conditions: [triggerCondition],
            },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK key.
            then: [
              {
                type: "http",
                method: "GET",
                url: `https://api.telegram.org/bot${SECRET_TELEGRAM_TOKEN}/sendMessage?chat_id=2`,
              },
              turnOn15Action,
            ],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
  );
  const { hub, client } = await setup(t, { fixture });

  const homeSaved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "P1-4 home baseline",
  });
  const selectedSaved = await callOk(client, "configuration_point", {
    entity_refs: [scenarioRef(REF_ACC_BLOCK), scenarioRef(REF_SCEN_BLOCK)],
    note: "P1-4 selected baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Mutate all 5 manual BLOCKs into valid triggered BLOCKs, and delete acc 20 + scenario "7".
  const replaceWithCleanBlock = (index) => {
    const scen = hub.state.scenarios.find((s) => s.index === index);
    scen.data = JSON.stringify({
      targets: [
        {
          type: "if",
          mode: "EVERY",
          if: {
            type: "condition",
            mode: "AND",
            conditions: [triggerCondition],
          },
          // biome-ignore lint/suspicious/noThenProperty: SprutHub BLOCK key.
          then: [turnOn15Action],
          else: [],
          then_delay: 2_000,
          else_delay: 0,
        },
      ],
    });
  };
  for (const idx of [
    BAD_CODE_BLOCK,
    COND_CODE_BLOCK,
    REF_ACC_BLOCK,
    REF_SCEN_BLOCK,
    ZERO_TRIG_BLOCK,
  ]) {
    replaceWithCleanBlock(idx);
  }
  hub.state.accessories = hub.state.accessories.filter(({ id }) => id !== 20);
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== "7",
  );

  // For HTTP_AGENT_BLOCK: agent edits then_delay while keeping the HTTP node.
  const httpEntity = await callOk(client, "get_entity", {
    entity_ref: scenarioRef(HTTP_AGENT_BLOCK),
    include: ["configuration"],
  });
  const httpData = structuredClone(httpEntity.entity.configuration.value);
  httpData.targets[0].then_delay = 3_000;
  const httpAgentChange = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef(HTTP_AGENT_BLOCK),
    data: httpData,
    reason: "Добавить задержку HTTP сценарию",
  });

  const homePlanResp = await callOk(client, "configuration_point", {
    point_ref: homeSaved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const homePlan = homePlanResp.restore_plan;
  const homeUndoRefs = homePlan.undo_agent_changes.flatMap(
    (batch) => batch.arguments.change_refs,
  );

  // None of the 6 BLOCKs may appear in reapply_from_point, and HTTP_AGENT_BLOCK must NOT be in undo_agent_changes!
  for (const idx of [
    BAD_CODE_BLOCK,
    COND_CODE_BLOCK,
    REF_ACC_BLOCK,
    REF_SCEN_BLOCK,
    ZERO_TRIG_BLOCK,
    HTTP_AGENT_BLOCK,
  ]) {
    assert.equal(
      homePlan.reapply_from_point.some(
        ({ entity_ref }) => entity_ref === scenarioRef(idx),
      ),
      false,
      `BLOCK ${idx} must NOT emit reapply_from_point`,
    );
  }
  assert.equal(
    homeUndoRefs.includes(httpAgentChange.change_ref),
    false,
    "HTTP-URL BLOCK agent edit must NOT enter undo_agent_changes alongside redacted_http_url",
  );

  const expectNotRestorable = (plan, idx, reason) => {
    assert.equal(
      plan.not_restorable.some(
        (item) =>
          item.entity_ref === scenarioRef(idx) &&
          item.field === "configuration" &&
          item.reason === reason,
      ),
      true,
      `expected ${idx} -> ${reason} in ${JSON.stringify(plan.not_restorable)}`,
    );
  };
  expectNotRestorable(homePlan, BAD_CODE_BLOCK, "unsupported_javascript");
  expectNotRestorable(homePlan, COND_CODE_BLOCK, "unsupported_block_node");
  expectNotRestorable(homePlan, REF_ACC_BLOCK, "referenced_entity_missing");
  expectNotRestorable(homePlan, REF_SCEN_BLOCK, "referenced_entity_missing");
  expectNotRestorable(
    homePlan,
    ZERO_TRIG_BLOCK,
    "block_would_remove_last_trigger",
  );
  expectNotRestorable(homePlan, HTTP_AGENT_BLOCK, "redacted_http_url");

  // Also verify selected_entities mode catches deleted referenced accessory & scenario!
  const selPlanResp = await callOk(client, "configuration_point", {
    point_ref: selectedSaved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const selPlan = selPlanResp.restore_plan;
  assert.equal(selPlan.reapply_from_point.length, 0);
  expectNotRestorable(selPlan, REF_ACC_BLOCK, "referenced_entity_missing");
  expectNotRestorable(selPlan, REF_SCEN_BLOCK, "referenced_entity_missing");
});

test("P2-2: whole-home undo eligibility covers deleted virtual_device room, virtual_device_in_use + room_not_empty, virtual_light_group + light_group_members chain, and apply->restore->apply2", async (t) => {
  const { hub, client } = await setup(t);

  // Create virtInRoom2 AND a sentinel virtual device BEFORE snapshot so deleting virtInRoom2 never collides with later created IDs.
  await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(2),
    name: "Вирт в комнате 2",
    value: "Switch",
    reason: "Создать вирт в комнате 2 до снимка",
  });
  await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(3),
    name: "Опорный вирт",
    value: "Switch",
    reason: "Занять следующий id до снимка",
  });
  const virtInRoom2 = hub.state.accessories.find(
    ({ name }) => name === "Вирт в комнате 2",
  );
  assert.ok(virtInRoom2);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "P2-2 undo eligibility baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 7.1: virtual_device_delete whose baseline room (room 2) is then deleted.
  const delVirtRoom2 = await applyNative(client, {
    operation: "virtual_device_delete",
    target_ref: accessoryRef(virtInRoom2.id),
    reason: "Удалить вирт в комнате 2",
  });
  // Move remaining acc 14 out of room 2 before deleting room 2.
  hub.state.accessories.find(({ id }) => id === 14).roomId = 3;
  hub.state.rooms = hub.state.rooms.filter(({ id }) => id !== 2);

  // 7.2a: Agent creates roomA + virtual device virtA inside roomA; manual BLOCK references virtA.
  const roomA = await applyNative(client, {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Новая комната A",
    reason: "Создать комнату A",
  });
  const roomAObj = hub.state.rooms.find(
    ({ name }) => name === "Новая комната A",
  );
  assert.ok(roomAObj);
  const virtA = await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(roomAObj.id),
    name: "Выключатель A",
    value: "Switch",
    reason: "Создать выключатель A",
  });
  const virtAObj = hub.state.accessories.find(
    ({ name }) => name === "Выключатель A",
  );
  assert.ok(virtAObj);
  const virtASvc = virtAObj.services.find(({ type }) => type === "Switch");
  const virtAOn = virtASvc.characteristics.find(
    ({ control }) => (control?.type ?? control?.key) === "On",
  );
  // Manual scenario edit adds reference to virtA.
  const scen3 = hub.state.scenarios.find(({ index }) => index === "3");
  const scen3Data = JSON.parse(scen3.data);
  scen3Data.targets[0].then.push({
    type: "service",
    aId: virtAObj.id,
    sId: virtASvc.sId,
    hs: "Switch",
    characteristics: [
      { cId: virtAOn.cId, hc: "On", type: "set", value: "true" },
    ],
  });
  scen3.data = JSON.stringify(scen3Data);

  // 7.2b: Agent creates roomB + virtual device virtB inside roomB; manual bridge export adds virtB.
  const roomB = await applyNative(client, {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Новая комната B",
    reason: "Создать комнату B",
  });
  const roomBObj = hub.state.rooms.find(
    ({ name }) => name === "Новая комната B",
  );
  assert.ok(roomBObj);
  const virtB = await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(roomBObj.id),
    name: "Выключатель B",
    value: "Switch",
    reason: "Создать выключатель B",
  });
  const virtBObj = hub.state.accessories.find(
    ({ name }) => name === "Выключатель B",
  );
  assert.ok(virtBObj);
  // Export virtB manually in Yandex bridge window.
  const virtBSvc = virtBObj.services.find(({ type }) => type === "Switch");
  const yandexBridgeWinKey = `Bridge/yandex/Child/${virtBObj.id}/`;
  const bridgeWin = hub.state.windows[yandexBridgeWinKey];
  if (bridgeWin) {
    const opt = bridgeWin.options.find((o) => o.key === `s:${virtBSvc.sId}`);
    if (opt) opt.value = { boolValue: true };
  }
  const yandexExt = hub.state.extensions.find(
    ({ key }) => key === "Bridge:yandex" || key === "yandex",
  );
  if (
    yandexExt &&
    Array.isArray(hub.state.extensionChildren?.[yandexExt.key])
  ) {
    const existingChild = hub.state.extensionChildren[yandexExt.key].find(
      (c) => String(c.id) === String(virtBObj.id),
    );
    if (!existingChild) {
      hub.state.extensionChildren[yandexExt.key].push({
        id: String(virtBObj.id),
        name: virtBObj.name,
        enabled: true,
        optionsWindow: yandexBridgeWinKey,
      });
    } else {
      existingChild.enabled = true;
    }
  }

  // 7.3a: Agent creates virtual_light_group (vlg1) with [15, 16], then edits members via light_group_members (vlg1Members) to [15, 17].
  const vlg1Create = await applyNative(client, {
    operation: "virtual_light_group",
    target_ref: HOME_REF,
    room_ref: roomRef(3),
    name: "Группа света агента",
    member_service_refs: [serviceRef(15, 13), serviceRef(16, 13)],
    characteristic_types: ["On", "Brightness"],
    reason: "Создать группу света",
  });
  const vlg1Acc = hub.state.accessories.find(
    ({ name }) => name === "Группа света агента",
  );
  assert.ok(vlg1Acc);
  const vlg1Svc = vlg1Acc.services.find(({ type }) => type === "Lightbulb");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const vlg1Members = await applyNative(client, {
    operation: "virtual_light_group",
    target_ref: serviceRef(vlg1Acc.id, vlg1Svc.sId),
    member_service_refs: [serviceRef(15, 13), serviceRef(17, 13)],
    reason: "Заменить торшер на ленту в группе",
  });

  // 7.3b: Agent creates virtual_light_group (vlg2), then links are manually mutated.
  const vlg2Create = await applyNative(client, {
    operation: "virtual_light_group",
    target_ref: HOME_REF,
    room_ref: roomRef(4),
    name: "Группа с ручной правкой",
    member_service_refs: [serviceRef(15, 13), serviceRef(22, 13)],
    characteristic_types: ["On", "Brightness"],
    reason: "Создать вторую группу света",
  });
  const vlg2Acc = hub.state.accessories.find(
    ({ name }) => name === "Группа с ручной правкой",
  );
  assert.ok(vlg2Acc);
  const vlg2Svc = vlg2Acc.services.find(({ type }) => type === "Lightbulb");
  const vlg2On = vlg2Svc.characteristics.find(
    ({ control }) => (control?.type ?? control?.key) === "On",
  );
  const vlg2Key = `${vlg2Acc.id}.${vlg2Svc.sId}.${vlg2On.cId}`;
  // Manually drop one IN link from vlg2.
  const vlg2Links = hub.state.links.get(vlg2Key) ?? [];
  hub.state.links.set(vlg2Key, vlg2Links.slice(0, 1));

  // 7.4: apply -> restore -> apply2 on bridge export, room rename, and BLOCK.
  const exp1 = await applyNative(client, {
    operation: "window_option",
    target_ref: windowRef("Bridge/yandex/Child/12/"),
    option_key: "s:13",
    value: true,
    reason: "Экспорт 1",
  });
  await callOk(client, "restore_native_change", {
    change_ref: exp1.change_ref,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const exp2 = await applyNative(client, {
    operation: "window_option",
    target_ref: windowRef("Bridge/yandex/Child/12/"),
    option_key: "s:13",
    value: true,
    reason: "Экспорт 2",
  });

  const rename1 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(1),
    value: "Прихожая 1",
    reason: "Переименование 1",
  });
  await callOk(client, "restore_native_change", {
    change_ref: rename1.change_ref,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rename2 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(1),
    value: "Прихожая 2",
    reason: "Переименование 2",
  });

  const scen14Initial = JSON.parse(
    hub.state.scenarios.find(({ index }) => index === "14").data,
  );
  const scen14V1 = structuredClone(scen14Initial);
  scen14V1.targets[0].then_delay = 2_000;
  const block1 = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("14"),
    data: scen14V1,
    reason: "BLOCK правка 1",
  });
  await callOk(client, "restore_native_change", {
    change_ref: block1.change_ref,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const scen14V2 = structuredClone(scen14Initial);
  scen14V2.targets[0].then_delay = 5_000;
  const block2 = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("14"),
    data: scen14V2,
    reason: "BLOCK правка 2",
  });

  const planned = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    plan_restore: true,
    max_bytes: 32_768,
  });
  const plan = planned.restore_plan;
  const undoRefs = plan.undo_agent_changes.flatMap(
    (batch) => batch.arguments.change_refs,
  );

  // 7.1: delVirtRoom2 NOT in undo; target_room_missing in not_restorable.
  assert.equal(undoRefs.includes(delVirtRoom2.change_ref), false);
  assert.equal(
    plan.not_restorable.some(
      (item) =>
        item.entity_ref === accessoryRef(virtInRoom2.id) &&
        item.reason === "target_room_missing",
    ),
    true,
    JSON.stringify(plan.not_restorable),
  );

  // 7.2a & 7.2b: virtA, roomA, virtB, roomB all OUT of undo; virtual_device_in_use & room_not_empty in not_restorable!
  for (const ref of [
    virtA.change_ref,
    roomA.change_ref,
    virtB.change_ref,
    roomB.change_ref,
  ]) {
    assert.equal(
      undoRefs.includes(ref),
      false,
      `blocked change ${ref} must NOT enter undo_agent_changes`,
    );
  }
  for (const id of [virtAObj.id, virtBObj.id]) {
    assert.equal(
      plan.not_restorable.some(
        (item) =>
          item.entity_ref === accessoryRef(id) &&
          item.reason === "virtual_device_in_use",
      ),
      true,
      `expected virtual_device_in_use for ${id} in ${JSON.stringify(plan.not_restorable)}`,
    );
  }
  for (const rId of [roomAObj.id, roomBObj.id]) {
    assert.equal(
      plan.not_restorable.some(
        (item) =>
          item.entity_ref === roomRef(rId) && item.reason === "room_not_empty",
      ),
      true,
      `expected room_not_empty for ${rId} in ${JSON.stringify(plan.not_restorable)}`,
    );
  }

  // 7.3a: BOTH vlg1Members and vlg1Create MUST be in undo_agent_changes with vlg1Members BEFORE vlg1Create!
  const idxMembers = undoRefs.indexOf(vlg1Members.change_ref);
  const idxCreate = undoRefs.indexOf(vlg1Create.change_ref);
  assert.ok(
    idxMembers >= 0 && idxCreate >= 0 && idxMembers < idxCreate,
    `expected [vlg1Members, vlg1Create] in undoRefs, got ${JSON.stringify(undoRefs)}`,
  );

  // 7.3b: vlg2Create (manual link edit) MUST NOT be in undo_agent_changes!
  assert.equal(undoRefs.includes(vlg2Create.change_ref), false);
  assert.equal(
    plan.not_restorable.some(
      (item) => item.entity_ref === accessoryRef(vlg2Acc.id),
    ),
    true,
  );

  // 7.4: apply -> restore -> apply2 includes ONLY exp2, rename2, block2 (NOT exp1, rename1, block1)!
  for (const ref of [exp2.change_ref, rename2.change_ref, block2.change_ref]) {
    assert.equal(
      undoRefs.includes(ref),
      true,
      `expected active ${ref} in undo_agent_changes: ${JSON.stringify(undoRefs)}`,
    );
  }
  for (const ref of [exp1.change_ref, rename1.change_ref, block1.change_ref]) {
    assert.equal(undoRefs.includes(ref), false);
  }

  // ACTUALLY EXECUTE the entire undo_agent_changes batch — ZERO skips allowed!
  await executeRestorePlan(client, {
    undo_agent_changes: plan.undo_agent_changes,
    reapply_from_point: [],
  });
  assert.equal(
    hub.state.accessories.some(({ id }) => id === vlg1Acc.id),
    false,
    "vlg1 should be completely removed after undoing members then creation",
  );
  assert.equal(hub.state.rooms.find(({ id }) => id === 1).name, "Прихожая");
  assert.equal(
    JSON.parse(hub.state.scenarios.find(({ index }) => index === "14").data)
      .targets[0].then_delay,
    scen14Initial.targets[0].then_delay,
  );
});
