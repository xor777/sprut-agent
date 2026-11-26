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
