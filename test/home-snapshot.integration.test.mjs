import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
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
const SECRET_JS_TOKEN = "js-secret-token-must-never-land-on-disk-991";
const SECRET_JS_TOKEN_2 = "js-secret-token-replacement-never-leak-992";
const SECRET_TELEGRAM_TOKEN = "12345678:AABBCCDDeeffgghhiijjkkllmmnn001122";
const NOTE_PASSWORD_SECRET = "OwnerSecretPassword123!";

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

function extensionRef(key) {
  return `${HOME_REF}/extension/${encodeURIComponent(key)}`;
}

function windowRef(windowKey) {
  return `${HOME_REF}/window/${encodeURIComponent(windowKey)}`;
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
    path.join(tmpdir(), "sprut-agent-home-snapshot-"),
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
    name: "home-snapshot-integration-test",
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
  assert.equal(prepared.status, "prepared");
  const applied = await callOk(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  return applied;
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

test("scope=home saves a compact secret-free whole-home point with note, 0600 permissions, list filtering, pagination, and note on selected_entities", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Before evening automation refactor",
  });

  assert.equal(saved.status, "ok");
  assert.match(
    saved.point_ref,
    /^spruthub-point:\/\/hub\/sim-apartment-01\/configuration\/[a-f0-9]{24}$/,
  );
  assert.equal(saved.home_ref, HOME_REF);
  assert.equal(saved.scope, "home");
  assert.equal(saved.coverage, "home");
  assert.equal(saved.house_complete, false);
  assert.equal(saved.atomic_snapshot, false);
  assert.equal(saved.note, "Before evening automation refactor");
  assert.ok(Date.parse(saved.capture_started_at));
  assert.ok(Date.parse(saved.capture_finished_at));
  assert.deepEqual(saved.counts, {
    rooms: hub.state.rooms.length,
    accessories: hub.state.accessories.length,
    scenarios: hub.state.scenarios.length,
    bridges: 2,
    climate_setpoints: 3,
  });
  assert.deepEqual(saved.not_captured, []);
  assert.deepEqual(saved.excluded_categories, [
    "device_window_options",
    "logic_options",
    "virtual_links",
    "ephemeral_states",
    "redacted_secrets",
  ]);
  assert.deepEqual(saved.next, {
    tool: "configuration_point",
    arguments: { point_ref: saved.point_ref },
  });

  // Fast capture: no per-device window.get storm, and no scenario.get for predefined scenarios.
  assert.equal(
    hub.requests.filter(({ method }) => method === "window.get").length,
    0,
  );
  assert.equal(
    hub.requests.some(
      ({ method, params }) =>
        method === "scenario.get" &&
        params.scenario?.get?.index === PREDEFINED_INDEX,
    ),
    false,
    "predefined scenarios must use scenario.list summary without scenario.get",
  );
  assert.deepEqual(hub.writes(), []);

  // Stored file must be 0600 and contain zero secrets.
  const storedFiles = (await filesUnder(stateDirectory)).filter((file) =>
    file.endsWith(".json"),
  );
  assert.equal(storedFiles.length, 1);
  assert.equal((await stat(storedFiles[0])).mode & 0o777, 0o600);
  const rawStored = await readFile(storedFiles[0], "utf8");
  for (const secret of [
    SECRET_JS_TOKEN,
    SECRET_TELEGRAM_TOKEN,
    SIMULATED_HUB_TOKEN,
  ]) {
    assert.equal(rawStored.includes(secret), false, `leaked ${secret}`);
  }
  const parsedStored = JSON.parse(rawStored);
  const secretScenarioOnDisk = parsedStored.home_snapshot.scenarios.find(
    ({ index }) => index === SECRET_LOGIC_INDEX,
  );
  assert.equal(secretScenarioOnDisk.configuration.value, "[REDACTED]");

  // list echoes scope and note, and entity_ref matches rooms, accessories, services, scenarios, bridges, climate setpoints.
  const listed = await callOk(client, "configuration_point", {});
  assert.equal(listed.points.length, 1);
  assert.equal(listed.points[0].point_ref, saved.point_ref);
  assert.equal(listed.points[0].scope, "home");
  assert.equal(listed.points[0].note, "Before evening automation refactor");
  assert.deepEqual(listed.points[0].counts, saved.counts);

  for (const matchedRef of [
    roomRef(3),
    accessoryRef(15),
    serviceRef(15, 13),
    scenarioRef("5"),
    extensionRef("Bridge:yandex"),
    characteristicRef(19, 13, 17),
  ]) {
    const byEntity = await callOk(client, "configuration_point", {
      entity_ref: matchedRef,
    });
    assert.equal(
      byEntity.points.some(({ point_ref }) => point_ref === saved.point_ref),
      true,
      `expected home point to match entity_ref ${matchedRef}`,
    );
  }
  const unmatched = await callOk(client, "configuration_point", {
    entity_ref: accessoryRef(9999),
  });
  assert.equal(unmatched.points.length, 0);

  // get({ point_ref }) without compare works with presentEntityResult pagination.
  const overview = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    max_bytes: 2_048,
  });
  assert.equal(overview.representation.kind, "entity_overview");
  assert.equal(overview.identity.scope, "home");
  assert.equal(overview.identity.note, "Before evening automation refactor");
  const snapshotPart = overview.representation.available_parts.find(
    ({ pointer }) => pointer === "/home_snapshot",
  );
  assert.ok(snapshotPart?.next);
  const roomsPage = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    pointer: "/home_snapshot/rooms",
    max_bytes: 4_096,
  });
  assert.equal(roomsPage.selection.status, "found");
  assert.equal(roomsPage.selection.value.length, hub.state.rooms.length);

  // note also works on selected_entities points and is echoed in save, list, and get.
  const selectedSaved = await callOk(client, "configuration_point", {
    entity_refs: [accessoryRef(15)],
    note: "Chandelier baseline",
  });
  assert.equal(selectedSaved.note, "Chandelier baseline");
  const selectedRead = await callOk(client, "configuration_point", {
    point_ref: selectedSaved.point_ref,
  });
  assert.equal(selectedRead.entity.note, "Chandelier baseline");
  const listBoth = await callOk(client, "configuration_point", {});
  const selectedSummary = listBoth.points.find(
    ({ point_ref }) => point_ref === selectedSaved.point_ref,
  );
  assert.equal(selectedSummary.note, "Chandelier baseline");
  assert.equal(selectedSummary.scope, "selected_entities");
});

test("whole-home compare=true returns compact unchanged summary and detects all manual edits with manual_or_external attribution", async (t) => {
  const { hub, client } = await setup(t);

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Baseline before manual app edits",
  });

  // 1. Unchanged home compare returns compact single-call result.
  const unchanged = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
  });
  assert.equal(unchanged.representation.kind, "complete_entity");
  assert.equal(unchanged.comparison.coverage, "home");
  assert.equal(unchanged.comparison.house_complete, false);
  assert.equal(unchanged.comparison.has_changes, false);
  assert.deepEqual(unchanged.comparison.rooms, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(unchanged.comparison.accessories, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(unchanged.comparison.scenarios, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(unchanged.comparison.bridges, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.deepEqual(unchanged.comparison.climate_setpoints, {
    added: [],
    removed: [],
    changed: [],
  });
  assert.equal(
    unchanged.comparison.unchanged_counts.rooms,
    hub.state.rooms.length,
  );
  assert.equal(
    unchanged.comparison.unchanged_counts.accessories,
    hub.state.accessories.length,
  );
  // Secret-bearing LOGIC code stays not_compared: redacted (not claimed unchanged or changed).
  assert.equal(
    unchanged.comparison.not_compared.some(
      (item) =>
        item.entity_ref === scenarioRef(SECRET_LOGIC_INDEX) &&
        item.reason === "redacted",
    ),
    true,
    JSON.stringify(unchanged.comparison.not_compared),
  );
  assert.deepEqual(unchanged.comparison.attribution_summary, {
    agent: 0,
    manual_or_external: 0,
    agent_and_later_change: 0,
  });

  // 2. Make manual edits directly in hub state across every category.
  // Rooms: rename 1, toggle visible 2, add 99, remove 30.
  hub.state.rooms.find(({ id }) => id === 1).name = "Холл";
  hub.state.rooms.find(({ id }) => id === 2).visible = false;
  hub.state.rooms.push({
    id: 99,
    name: "Гардеробная",
    order: 99,
    visible: true,
  });
  hub.state.rooms = hub.state.rooms.filter(({ id }) => id !== 30);

  // Accessories: rename + move 12, rename + hide service on 16, add 90, remove 20.
  const acc12 = hub.state.accessories.find(({ id }) => id === 12);
  acc12.name = "Люстра прихожей";
  acc12.roomId = 2;
  const svc16 = hub.state.accessories
    .find(({ id }) => id === 16)
    .services.find(({ sId }) => sId === 13);
  svc16.name = "Лампа торшера";
  svc16.visible = false;
  hub.state.accessories.push({
    id: 90,
    roomId: 1,
    name: "Новое реле",
    online: true,
    virtual: false,
    services: [
      {
        aId: 90,
        sId: 13,
        name: "Реле",
        type: "Switch",
        visible: true,
        characteristics: [
          {
            aId: 90,
            sId: 13,
            cId: 14,
            hasOptions: false,
            control: {
              name: "On",
              type: "On",
              read: true,
              write: true,
              events: true,
              value: { boolValue: false },
            },
          },
        ],
      },
    ],
  });
  hub.state.accessories = hub.state.accessories.filter(({ id }) => id !== 20);

  // Scenarios: edit BLOCK 3 (with blockId/state noise + real then_delay), edit GLOBAL, edit secret LOGIC, add 299, remove 8.
  const scen3 = hub.state.scenarios.find(({ index }) => index === "3");
  const parsed3 = JSON.parse(scen3.data);
  parsed3.blockId = 999;
  parsed3.targets[0].blockId = 888;
  parsed3.targets[0].state = true;
  parsed3.targets[0].then_delay = 5000;
  scen3.data = JSON.stringify(parsed3);

  const globalScen = hub.state.scenarios.find(
    ({ index }) => index === GLOBAL_INDEX,
  );
  globalScen.data = "function helper() { return 42; }";

  const secretScen = hub.state.scenarios.find(
    ({ index }) => index === SECRET_LOGIC_INDEX,
  );
  secretScen.data = `info = { name: "Интеграция с облаком" }; const apiToken = "${SECRET_JS_TOKEN_2}"; function trigger() { log("x"); }`;

  hub.state.scenarios.push({
    index: "299",
    name: "Новый сценарий",
    desc: "",
    type: "BLOCK",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    data: JSON.stringify({ targets: [] }),
  });
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== "8",
  );

  // Bridge exports: add 12 to yandex, remove 11 from homekit.
  const yandex = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:yandex",
  );
  yandex.exported["12"] = [13];
  const homekit = hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:homekit",
  );
  delete homekit.exported["11"];

  // Climate setpoints: TargetTemperature 23 -> 20, TargetHeatingCoolingState 0 -> 1, C_FanSpeed 3 -> 5.
  const acService = hub.state.accessories
    .find(({ id }) => id === 19)
    .services.find(({ sId }) => sId === 13);
  acService.characteristics.find(({ cId }) => cId === 17).control.value = {
    doubleValue: 20,
  };
  acService.characteristics.find(({ cId }) => cId === 15).control.value = {
    intValue: 1,
  };
  const breezerService = hub.state.accessories
    .find(({ id }) => id === 28)
    .services.find(({ sId }) => sId === 13);
  breezerService.characteristics.find(({ cId }) => cId === 17).control.value = {
    intValue: 5,
  };

  // 3. Compare detects every change cleanly in a single compact call.
  const compared = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
  });
  assert.equal(compared.representation.kind, "complete_entity");
  const { comparison } = compared;
  assert.equal(comparison.has_changes, true);

  // Secret hygiene on comparison response.
  const serialized = JSON.stringify(compared);
  assert.equal(serialized.includes(SECRET_JS_TOKEN), false);
  assert.equal(serialized.includes(SECRET_JS_TOKEN_2), false);
  assert.equal(serialized.includes(SECRET_TELEGRAM_TOKEN), false);

  // Rooms
  assert.deepEqual(
    comparison.rooms.added.map(({ ref, attribution }) => ({
      ref,
      attribution,
    })),
    [{ ref: roomRef(99), attribution: "manual_or_external" }],
  );
  assert.deepEqual(
    comparison.rooms.removed.map(({ ref, attribution }) => ({
      ref,
      attribution,
    })),
    [{ ref: roomRef(30), attribution: "manual_or_external" }],
  );
  assert.equal(comparison.rooms.changed.length, 2);
  const room1Diff = comparison.rooms.changed.find(({ id }) => id === 1);
  assert.equal(room1Diff.attribution, "manual_or_external");
  assert.deepEqual(room1Diff.changes, [
    { path: ["name"], from: "Прихожая", to: "Холл" },
  ]);
  const room2Diff = comparison.rooms.changed.find(({ id }) => id === 2);
  assert.equal(room2Diff.attribution, "manual_or_external");
  assert.deepEqual(room2Diff.changes, [
    { path: ["visible"], from: true, to: false },
  ]);
  assert.equal(comparison.unchanged_counts.rooms, 6);

  // Accessories
  assert.deepEqual(
    comparison.accessories.added.map(({ ref, attribution }) => ({
      ref,
      attribution,
    })),
    [{ ref: accessoryRef(90), attribution: "manual_or_external" }],
  );
  assert.deepEqual(
    comparison.accessories.removed.map(({ ref, attribution }) => ({
      ref,
      attribution,
    })),
    [{ ref: accessoryRef(20), attribution: "manual_or_external" }],
  );
  const acc12Diff = comparison.accessories.changed.find(({ id }) => id === 12);
  assert.equal(acc12Diff.attribution, "manual_or_external");
  assert.equal(
    acc12Diff.changes.some(
      ({ path: p, from, to }) =>
        p[0] === "name" &&
        from === "Свет в прихожей" &&
        to === "Люстра прихожей",
    ),
    true,
  );
  assert.equal(
    acc12Diff.changes.some(
      ({ path: p, from, to }) =>
        p[0] === "room_ref" && from === roomRef(1) && to === roomRef(2),
    ),
    true,
  );
  const acc16Diff = comparison.accessories.changed.find(({ id }) => id === 16);
  assert.equal(acc16Diff.attribution, "manual_or_external");
  assert.equal(acc16Diff.changed_services.length, 1);
  assert.equal(acc16Diff.changed_services[0].ref, serviceRef(16, 13));
  assert.equal(acc16Diff.changed_services[0].changes.length, 2);
  assert.equal(comparison.unchanged_counts.accessories, 26);

  // Scenarios
  assert.deepEqual(
    comparison.scenarios.added.map(({ ref, attribution }) => ({
      ref,
      attribution,
    })),
    [{ ref: scenarioRef("299"), attribution: "manual_or_external" }],
  );
  assert.deepEqual(
    comparison.scenarios.removed.map(({ ref, attribution }) => ({
      ref,
      attribution,
    })),
    [{ ref: scenarioRef("8"), attribution: "manual_or_external" }],
  );
  const scen3Diff = comparison.scenarios.changed.find(
    ({ index }) => index === "3",
  );
  assert.equal(scen3Diff.attribution, "manual_or_external");
  assert.deepEqual(scen3Diff.changes, [
    {
      path: ["configuration", "value", "targets", 0, "then_delay"],
      from: 0,
      to: 5000,
    },
  ]);
  const globalDiff = comparison.scenarios.changed.find(
    ({ index }) => index === GLOBAL_INDEX,
  );
  assert.equal(globalDiff.attribution, "manual_or_external");
  assert.equal(globalDiff.changes[0].path.join("."), "configuration.value");
  assert.equal(
    comparison.scenarios.changed.some(
      ({ index }) => index === SECRET_LOGIC_INDEX,
    ),
    false,
    "redacted code scenario must not be emitted as changed",
  );
  assert.equal(
    comparison.not_compared.some(
      (item) =>
        item.entity_ref === scenarioRef(SECRET_LOGIC_INDEX) &&
        item.reason === "redacted",
    ),
    true,
  );

  // Bridges
  const yandexDiff = comparison.bridges.changed.find(
    ({ key }) => key === "Bridge:yandex",
  );
  assert.equal(yandexDiff.attribution, "manual_or_external");
  assert.deepEqual(yandexDiff.added_exports, [accessoryRef(12)]);
  assert.equal(yandexDiff.removed_exports, undefined);
  const homekitDiff = comparison.bridges.changed.find(
    ({ key }) => key === "Bridge:homekit",
  );
  assert.equal(homekitDiff.attribution, "manual_or_external");
  assert.deepEqual(homekitDiff.removed_exports, [accessoryRef(11)]);
  assert.equal(homekitDiff.added_exports, undefined);

  // Climate setpoints
  assert.equal(comparison.climate_setpoints.changed.length, 3);
  for (const item of comparison.climate_setpoints.changed) {
    assert.equal(item.attribution, "manual_or_external");
  }
  assert.equal(comparison.unchanged_counts.climate_setpoints, 0);

  // Attribution summary & honest note
  assert.equal(comparison.attribution_summary.agent, 0);
  assert.equal(comparison.attribution_summary.agent_and_later_change, 0);
  assert.equal(comparison.attribution_summary.manual_or_external, 17);
  assert.match(comparison.attribution_note, /local/i);
  assert.match(comparison.attribution_note, /manual_or_external/);
  assert.deepEqual(hub.writes(), []);
});

test("compare=true attributes agent vs manual_or_external vs agent_and_later_change on both home and selected_entities points and tolerates corrupt journal", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);

  // Pre-point agent edit on room 7: must NOT bleed into a later manual edit after snapshot!
  await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(7),
    value: "Офис",
    reason: "Переименовать кабинет до снимка",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  // Save BOTH a whole-home point AND a selected_entities point.
  const homePoint = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Before mixed agent and manual edits",
  });
  const selectedPoint = await callOk(client, "configuration_point", {
    entity_refs: [
      accessoryRef(16),
      scenarioRef("3"),
      scenarioRef("5"),
      characteristicRef(19, 13, 17),
    ],
    note: "Selected entities attribution baseline",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  // Unapplied prepared draft on room 4: must NOT count as agent attribution!
  await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: roomRef(4),
    value: "Столовая",
    reason: "Черновик без применения",
  });

  // 1. Agent renames room 1 cleanly -> agent.
  const room1Change = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(1),
    value: "Прихожая новая",
    reason: "Обновить название прихожей",
  });

  // 2. Agent renames room 3 -> "Зал", then owner manually renames room 3 -> "Зал 2" -> agent_and_later_change.
  const room3Change = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(3),
    value: "Зал",
    reason: "Переименовать гостиную в Зал",
  });
  hub.state.rooms.find(({ id }) => id === 3).name = "Зал 2";

  // 3. Agent toggles scenario_active on scenario 5, then owner manually edits BLOCK data -> agent_and_later_change.
  const scen5ActiveChange = await applyNative(client, {
    operation: "scenario_active",
    target_ref: scenarioRef("5"),
    value: false,
    reason: "Выключить ночной режим",
  });
  const scen5 = hub.state.scenarios.find(({ index }) => index === "5");
  const parsed5 = JSON.parse(scen5.data);
  parsed5.targets[0].then_delay = 3000;
  scen5.data = JSON.stringify(parsed5);

  // 4. Agent edits scenario 3 BLOCK (which references accessory 14), while owner manually renames accessory 14.
  //    Scenario 3 -> agent; Accessory 14 -> manual_or_external (no cross-entity false attribution!).
  const scen3Current = JSON.parse(
    hub.state.scenarios.find(({ index }) => index === "3").data,
  );
  scen3Current.targets[0].then_delay = 2000;
  const scen3Change = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("3"),
    data: scen3Current,
    reason: "Добавить паузу в сценарий коридора",
  });
  hub.state.accessories.find(({ id }) => id === 14).name =
    "Лампа коридора вручную";

  // 5. Agent renames + moves accessory 16 via accessory_placement -> agent.
  const acc16Change = await applyNative(client, {
    operation: "accessory_placement",
    target_ref: accessoryRef(16),
    name: "Торшер у дивана",
    room_ref: roomRef(5),
    reason: "Переставить торшер в спальню",
  });

  // 6. Agent updates TargetTemperature on accessory 19 via send_device_commands -> agent.
  const tempCmd = await callOk(client, "send_device_commands", {
    home_ref: HOME_REF,
    commands: [{ target_ref: characteristicRef(19, 13, 17), value: 21 }],
    reason: "Понизить температуру кондиционера",
  });
  const tempChangeRef = tempCmd.results[0].change_ref;

  // 7. Agent exports accessory 12 to Yandex via window_option, while owner manually removes 11 from HomeKit.
  const yandexExportChange = await applyNative(client, {
    operation: "window_option",
    target_ref: windowRef("Bridge/yandex/Child/12/"),
    option_key: "s:13",
    value: true,
    reason: "Добавить свет прихожей в Алису",
  });
  delete hub.state.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:homekit",
  ).exported["11"];

  // 8. Owner manually renames room 7 (edited by agent BEFORE snapshot) and room 4 (unapplied draft only).
  hub.state.rooms.find(({ id }) => id === 7).name = "Кабинет ручной";
  hub.state.rooms.find(({ id }) => id === 4).name = "Кухня ручная";

  // Verify whole-home comparison attribution.
  const homeCompared = await callOk(client, "configuration_point", {
    point_ref: homePoint.point_ref,
    compare: true,
  });
  const hc = homeCompared.comparison;

  const r1 = hc.rooms.changed.find(({ id }) => id === 1);
  assert.equal(r1.attribution, "agent");
  assert.equal(r1.matching_agent_changes[0].change_ref, room1Change.change_ref);
  assert.equal(r1.matching_agent_changes[0].operation, "room_name");
  assert.equal(
    r1.matching_agent_changes[0].reason,
    "Обновить название прихожей",
  );

  const r3 = hc.rooms.changed.find(({ id }) => id === 3);
  assert.equal(r3.attribution, "agent_and_later_change");
  assert.equal(r3.matching_agent_changes[0].change_ref, room3Change.change_ref);

  const r4 = hc.rooms.changed.find(({ id }) => id === 4);
  assert.equal(r4.attribution, "manual_or_external");
  assert.equal(r4.matching_agent_changes, undefined);

  const r7 = hc.rooms.changed.find(({ id }) => id === 7);
  assert.equal(r7.attribution, "manual_or_external");
  assert.equal(r7.matching_agent_changes, undefined);

  const s5 = hc.scenarios.changed.find(({ index }) => index === "5");
  assert.equal(s5.attribution, "agent_and_later_change");
  assert.equal(
    s5.matching_agent_changes[0].change_ref,
    scen5ActiveChange.change_ref,
  );

  const s3 = hc.scenarios.changed.find(({ index }) => index === "3");
  assert.equal(s3.attribution, "agent");
  assert.equal(s3.matching_agent_changes[0].change_ref, scen3Change.change_ref);

  const a14 = hc.accessories.changed.find(({ id }) => id === 14);
  assert.equal(a14.attribution, "manual_or_external");

  const a16 = hc.accessories.changed.find(({ id }) => id === 16);
  assert.equal(a16.attribution, "agent");
  assert.equal(
    a16.matching_agent_changes[0].change_ref,
    acc16Change.change_ref,
  );

  const tempDiff = hc.climate_setpoints.changed.find(
    ({ ref }) => ref === characteristicRef(19, 13, 17),
  );
  assert.equal(tempDiff.attribution, "agent");
  assert.equal(tempDiff.matching_agent_changes[0].change_ref, tempChangeRef);

  const yandexDiff = hc.bridges.changed.find(
    ({ key }) => key === "Bridge:yandex",
  );
  assert.equal(yandexDiff.attribution, "agent");
  assert.equal(
    yandexDiff.matching_agent_changes[0].change_ref,
    yandexExportChange.change_ref,
  );
  const homekitDiff = hc.bridges.changed.find(
    ({ key }) => key === "Bridge:homekit",
  );
  assert.equal(homekitDiff.attribution, "manual_or_external");

  assert.deepEqual(hc.attribution_summary, {
    agent: 5,
    manual_or_external: 4,
    agent_and_later_change: 2,
  });

  // Verify selected_entities comparison attribution too!
  const selectedCompared = await callOk(client, "configuration_point", {
    point_ref: selectedPoint.point_ref,
    compare: true,
  });
  const sc = selectedCompared.comparison;
  const selAcc16 = sc.entities.find(
    ({ entity_ref }) => entity_ref === accessoryRef(16),
  );
  assert.equal(selAcc16.attribution, "agent");
  assert.equal(
    selAcc16.matching_agent_changes[0].change_ref,
    acc16Change.change_ref,
  );

  const selScen3 = sc.entities.find(
    ({ entity_ref }) => entity_ref === scenarioRef("3"),
  );
  assert.equal(selScen3.attribution, "agent");
  assert.equal(
    selScen3.matching_agent_changes[0].change_ref,
    scen3Change.change_ref,
  );

  const selScen5 = sc.entities.find(
    ({ entity_ref }) => entity_ref === scenarioRef("5"),
  );
  assert.equal(selScen5.attribution, "agent_and_later_change");
  assert.equal(
    selScen5.matching_agent_changes[0].change_ref,
    scen5ActiveChange.change_ref,
  );

  const selTemp = sc.entities.find(
    ({ entity_ref }) => entity_ref === characteristicRef(19, 13, 17),
  );
  assert.equal(selTemp.attribution, "agent");
  assert.equal(selTemp.matching_agent_changes[0].change_ref, tempChangeRef);

  assert.deepEqual(sc.attribution_summary, {
    agent: 3,
    manual_or_external: 0,
    agent_and_later_change: 1,
  });

  // Corrupt AutomationStore journal -> comparison MUST still succeed with attribution_unavailable: true!
  const journalFile = (await readdir(stateDirectory)).find((name) =>
    name.startsWith("automation-changes-"),
  );
  assert.ok(journalFile);
  await writeFile(path.join(stateDirectory, journalFile), "{corrupt-journal", {
    mode: 0o600,
  });

  for (const pointRef of [homePoint.point_ref, selectedPoint.point_ref]) {
    const degraded = await callOk(client, "configuration_point", {
      point_ref: pointRef,
      compare: true,
    });
    assert.equal(degraded.status, "ok");
    assert.equal(degraded.comparison.attribution_unavailable, true);
    assert.equal(
      JSON.stringify(degraded.comparison).includes(
        '"attribution":"manual_or_external"',
      ),
      false,
      "unreadable journal must never fabricate manual_or_external attribution",
    );
  }
});

test("partial hub read errors on scenario.get or extensionChild.list stay in not_captured/not_compared and never report false adds or removals", async (t) => {
  const { hub, client } = await setup(t);

  // Case A: failures during save
  hub.refuseNext("scenario.get", {
    code: -32000,
    message: "scenario read temporarily failed",
  });
  hub.refuseNext("extensionChild.list", {
    code: -32000,
    message: "bridge children read temporarily failed",
  });

  const partialPoint = await callOk(client, "configuration_point", {
    scope: "home",
  });
  assert.equal(partialPoint.status, "ok");
  const unreadScenarioOnSave = partialPoint.not_captured.find(
    ({ kind, reason }) => kind === "scenario" && reason === "read_error",
  );
  const unreadBridgeOnSave = partialPoint.not_captured.find(
    ({ kind, reason }) => kind === "bridge" && reason === "bridge_unread",
  );
  assert.ok(unreadScenarioOnSave, JSON.stringify(partialPoint.not_captured));
  assert.ok(unreadBridgeOnSave, JSON.stringify(partialPoint.not_captured));
  assert.equal(typeof unreadScenarioOnSave.error_code, "string");
  assert.equal(typeof unreadBridgeOnSave.error_code, "string");

  // Comparing partialPoint when live hub reads succeed must NOT report them as added!
  const comparedFromPartial = await callOk(client, "configuration_point", {
    point_ref: partialPoint.point_ref,
    compare: true,
  });
  assert.deepEqual(comparedFromPartial.comparison.scenarios.added, []);
  assert.deepEqual(comparedFromPartial.comparison.scenarios.removed, []);
  assert.deepEqual(comparedFromPartial.comparison.bridges.added, []);
  assert.deepEqual(comparedFromPartial.comparison.bridges.removed, []);
  assert.equal(
    comparedFromPartial.comparison.not_compared.some(
      ({ entity_ref, reason }) =>
        entity_ref === unreadScenarioOnSave.entity_ref &&
        reason === "read_error",
    ),
    true,
  );
  assert.equal(
    comparedFromPartial.comparison.not_compared.some(
      ({ entity_ref, reason }) =>
        entity_ref === unreadBridgeOnSave.entity_ref &&
        reason === "bridge_unread",
    ),
    true,
  );

  // Case B: clean save, then failures during compare
  const cleanPoint = await callOk(client, "configuration_point", {
    scope: "home",
  });
  assert.deepEqual(cleanPoint.not_captured, []);

  hub.refuseNext("scenario.get", {
    code: -32000,
    message: "scenario read failed during compare",
  });
  hub.refuseNext("extensionChild.list", {
    code: -32000,
    message: "bridge read failed during compare",
  });

  const comparedWithLiveFailure = await callOk(client, "configuration_point", {
    point_ref: cleanPoint.point_ref,
    compare: true,
  });
  assert.deepEqual(comparedWithLiveFailure.comparison.scenarios.added, []);
  assert.deepEqual(comparedWithLiveFailure.comparison.scenarios.removed, []);
  assert.deepEqual(comparedWithLiveFailure.comparison.bridges.added, []);
  assert.deepEqual(comparedWithLiveFailure.comparison.bridges.removed, []);
  assert.deepEqual(comparedWithLiveFailure.comparison.bridges.changed, []);
  assert.equal(
    comparedWithLiveFailure.comparison.not_compared.some(
      ({ kind, reason }) => kind === "scenario" && reason === "read_error",
    ),
    true,
  );
  assert.equal(
    comparedWithLiveFailure.comparison.not_compared.some(
      ({ kind, reason }) => kind === "bridge" && reason === "bridge_unread",
    ),
    true,
  );
});

test("mutual exclusion, blank/secret note handling, foreign/malformed home_ref, unpinned multi-home, and MCP surface budgets", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const dummyPointRef =
    "spruthub-point://hub/sim-apartment-01/configuration/0123456789abcdef01234567";

  // 1. Mutual exclusion and invalid note calls reject with 0 hub requests.
  const invalidCalls = [
    { scope: "home", entity_refs: [accessoryRef(15)] },
    { scope: "home", point_ref: dummyPointRef },
    { scope: "home", compare: true },
    { scope: "home", hub_backup: "create" },
    { scope: "home", hub_backup: "list" },
    { scope: "home", entity_ref: accessoryRef(15) },
    { scope: "home", cursor: "abc" },
    { scope: "home", pointer: "/home_snapshot" },
    { scope: "home", offset: 0 },
    { scope: "home", version: "v1" },
    { note: "list with note" },
    { point_ref: dummyPointRef, note: "read with note" },
    { hub_backup: "create", note: "backup with note" },
    { hub_backup: "list", note: "backup list with note" },
    { scope: "home", note: "   " },
    { entity_refs: [accessoryRef(15)], note: "\t\n " },
  ];
  for (const args of invalidCalls) {
    const failed = await callError(client, "configuration_point", args);
    assert.equal(failed.error.code, "invalid_point_call", JSON.stringify(args));
    assert.equal(failed.error.action, "configuration_point");
  }
  assert.equal(hub.requests.length, 0);

  // 2. Secrets in note are redacted before saving to disk and in responses.
  const secretNotePattern = await callOk(client, "configuration_point", {
    scope: "home",
    note: `password=${NOTE_PASSWORD_SECRET}`,
  });
  assert.equal(secretNotePattern.note, "[REDACTED]");
  const secretNoteToken = await callOk(client, "configuration_point", {
    entity_refs: [accessoryRef(15)],
    note: `using token ${SIMULATED_HUB_TOKEN}`,
  });
  assert.equal(secretNoteToken.note, "[REDACTED]");
  for (const file of await filesUnder(stateDirectory)) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes(NOTE_PASSWORD_SECRET), false, file);
    assert.equal(text.includes(SIMULATED_HUB_TOKEN), false, file);
  }

  // 3. Foreign/malformed home_ref under SPRUTHUB_LOGIN/SPRUTHUB_PASSWORD -> 0 hub requests.
  const emptyConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-home-snap-empty-cfg-"),
  );
  t.after(async () => {
    await rm(emptyConfigRoot, { recursive: true, force: true });
  });
  const loginFixture = await loadHomeFixture("apartment");
  const loginHub = await startSimulatedHub(loginFixture, {
    account: {
      login: "owner@example.invalid",
      password: "correct-password-123",
    },
  });
  t.after(async () => {
    await loginHub.close().catch(() => {});
  });
  const loginServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: loginHub.url,
      SPRUTHUB_SERIAL: loginHub.serial,
      SPRUTHUB_LOGIN: "owner@example.invalid",
      SPRUTHUB_PASSWORD: "correct-password-123",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  for (const [args, expectedCode] of [
    [{ scope: "home", home_ref: "spruthub://hub/foreign-home" }, "wrong_home"],
    [{ scope: "home", home_ref: "not-a-home-ref" }, "invalid_home_ref"],
    [{ scope: "home", home_ref: roomRef(1) }, "invalid_home_ref"],
  ]) {
    const failed = await callError(
      loginServer.client,
      "configuration_point",
      args,
    );
    assert.equal(failed.error.code, expectedCode, JSON.stringify(args));
  }
  assert.equal(loginHub.requests.length, 0);

  // 4. Multi-home unpinned live client enforces home_selection_required.
  const { SPRUTHUB_SERIAL: _omitted, ...unpinnedEnv } = hub.connectionEnv();
  const unpinned = await connectServer(t, {
    env: {
      ...unpinnedEnv,
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  const unpinnedError = await callError(
    unpinned.client,
    "configuration_point",
    {
      scope: "home",
      home_ref: HOME_REF,
    },
  );
  assert.equal(unpinnedError.error.code, "home_selection_required");
  assert.equal(unpinnedError.error.action, "home_overview");

  // 5. MCP surface budgets: 13 tools, instructions <= 2048, every tool description <= 1000.
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13, "must keep exactly 13 MCP tools");
  const configPoint = tools.find(({ name }) => name === "configuration_point");
  assert.ok(configPoint);
  assert.equal(configPoint.inputSchema.properties.scope.const, "home");
  assert.equal(configPoint.inputSchema.properties.note.type, "string");
  const oversized = tools
    .filter(({ description }) => description.length > 1_000)
    .map(({ name, description }) => `${name}: ${description.length}`);
  assert.deepEqual(oversized, []);
  const instructions = client.getInstructions();
  assert.ok(
    instructions.length <= 2_048,
    `instructions exceeded 2048 chars: ${instructions.length}`,
  );
});

test("manual BLOCK edits after agent block_data_update or block_action_pause are attributed as agent_and_later_change on home and selected_entities points", async (t) => {
  const { hub, client } = await setup(t);

  const homePoint = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Before BLOCK edits",
  });
  const selectedPoint = await callOk(client, "configuration_point", {
    entity_refs: [scenarioRef("3"), scenarioRef("5"), scenarioRef("14")],
    note: "Selected BLOCKs",
  });
  await new Promise((resolve) => setTimeout(resolve, 15));

  // 1. Agent updates scenario 3 BLOCK data, then owner manually edits it further -> agent_and_later_change.
  const scen3Data = JSON.parse(
    hub.state.scenarios.find(({ index }) => index === "3").data,
  );
  scen3Data.targets[0].then_delay = 2_000;
  const scen3Update = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("3"),
    data: scen3Data,
    reason: "Поставить задержку 2с",
  });
  const scen3After = hub.state.scenarios.find(({ index }) => index === "3");
  const scen3Manual = JSON.parse(scen3After.data);
  scen3Manual.targets[0].then_delay = 9_000;
  scen3After.data = JSON.stringify(scen3Manual);

  // 2. Agent pauses an action on scenario 5, then owner manually edits scenario 5 BLOCK data -> agent_and_later_change.
  const scen5Pause = await applyNative(client, {
    operation: "block_action_pause",
    target_ref: scenarioRef("5"),
    action_pointer: "/targets/0/then/0",
    duration_seconds: 3_600,
    reason: "Временно поставить действие на паузу",
  });
  const scen5After = hub.state.scenarios.find(({ index }) => index === "5");
  const scen5Manual = JSON.parse(scen5After.data);
  scen5Manual.targets[0].then_delay = 7_000;
  scen5After.data = JSON.stringify(scen5Manual);

  // 3. Control: clean agent block_data_update on scenario 14 (no later manual edit) -> agent.
  const scen14Data = JSON.parse(
    hub.state.scenarios.find(({ index }) => index === "14").data,
  );
  scen14Data.targets[0].then_delay = 4_000;
  const scen14Update = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("14"),
    data: scen14Data,
    reason: "Добавить задержку вечернему свету",
  });

  // Verify on whole-home point.
  const homeCompared = await callOk(client, "configuration_point", {
    point_ref: homePoint.point_ref,
    compare: true,
  });
  const h3 = homeCompared.comparison.scenarios.changed.find(
    ({ index }) => index === "3",
  );
  assert.equal(h3.attribution, "agent_and_later_change");
  assert.equal(h3.matching_agent_changes[0].change_ref, scen3Update.change_ref);

  const h5 = homeCompared.comparison.scenarios.changed.find(
    ({ index }) => index === "5",
  );
  assert.equal(h5.attribution, "agent_and_later_change");
  assert.equal(h5.matching_agent_changes[0].change_ref, scen5Pause.change_ref);

  const h14 = homeCompared.comparison.scenarios.changed.find(
    ({ index }) => index === "14",
  );
  assert.equal(h14.attribution, "agent");
  assert.equal(
    h14.matching_agent_changes[0].change_ref,
    scen14Update.change_ref,
  );

  // Verify on selected_entities point too.
  const selectedCompared = await callOk(client, "configuration_point", {
    point_ref: selectedPoint.point_ref,
    compare: true,
  });
  const s3 = selectedCompared.comparison.entities.find(
    ({ entity_ref }) => entity_ref === scenarioRef("3"),
  );
  assert.equal(s3.attribution, "agent_and_later_change");
  const s5 = selectedCompared.comparison.entities.find(
    ({ entity_ref }) => entity_ref === scenarioRef("5"),
  );
  assert.equal(s5.attribution, "agent_and_later_change");
  const s14 = selectedCompared.comparison.entities.find(
    ({ entity_ref }) => entity_ref === scenarioRef("14"),
  );
  assert.equal(s14.attribution, "agent");
});

test("in-window event modeling handles pre-snapshot reconciliation, clean post-snapshot restore, and sequential C1->C2 agent edits", async (t) => {
  const { hub, client } = await setup(t);

  // Pre-snapshot changes:
  // A1: room 1 renamed before snapshot; later manual edit + get_native_change conflict must NOT bleed in.
  const preRoom1 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(1),
    value: "Холл",
    reason: "До снимка переименовать прихожую",
  });
  // A2: room 2 renamed before snapshot, then manually reverted BEFORE snapshot; later no-write restore must NOT bleed in.
  const preRoom2 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(2),
    value: "Галерея",
    reason: "До снимка переименовать коридор",
  });
  hub.state.rooms.find(({ id }) => id === 2).name = "Коридор";

  // B1: room 7 renamed before snapshot; cleanly restored AFTER snapshot -> agent.
  const preRoom7 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(7),
    value: "Офис",
    reason: "До снимка переименовать кабинет",
  });
  // B2: room created before snapshot; cleanly restored (deleted) AFTER snapshot -> agent.
  const preCreatedRoom = await applyNative(client, {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Временная",
    reason: "До снимка создать временную комнату",
  });
  const createdRoomRef = preCreatedRoom.room_ref;
  // B3: scenario 3 BLOCK updated before snapshot; cleanly restored AFTER snapshot -> agent.
  const scen3Data = JSON.parse(
    hub.state.scenarios.find(({ index }) => index === "3").data,
  );
  scen3Data.targets[0].then_delay = 1_500;
  const preScen3 = await applyNative(client, {
    operation: "block_data_update",
    target_ref: scenarioRef("3"),
    data: scen3Data,
    reason: "До снимка задать задержку",
  });
  // B4: scenario 8 deleted before snapshot; cleanly restored (recreated under new index) AFTER snapshot -> agent.
  const preScen8Delete = await applyNative(client, {
    operation: "scenario_delete",
    target_ref: scenarioRef("8"),
    reason: "До снимка удалить сценарий кабинета",
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Baseline for event modeling",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Post-snapshot A1: manual rename on room 1, then read-only get_native_change bumps updated_at + sets conflict.
  hub.state.rooms.find(({ id }) => id === 1).name = "Прихожая ручная";
  const preRoom1Checked = await callOk(client, "get_native_change", {
    change_ref: preRoom1.change_ref,
  });
  assert.equal(preRoom1Checked.status, "conflict");

  // Post-snapshot A2: no-write restore reconciliation on preRoom2 (already back to "Коридор"), then manual edit.
  const preRoom2Restored = await callOk(client, "restore_native_change", {
    change_ref: preRoom2.change_ref,
  });
  assert.equal(preRoom2Restored.status, "restored");
  hub.state.rooms.find(({ id }) => id === 2).name = "Коридор ручной";

  // Post-snapshot B1-B4: clean agent restores!
  for (const changeRef of [
    preRoom7.change_ref,
    preCreatedRoom.change_ref,
    preScen3.change_ref,
  ]) {
    const restored = await callOk(client, "restore_native_change", {
      change_ref: changeRef,
    });
    assert.equal(restored.status, "restored", changeRef);
  }
  const restoredScen8 = await callOk(client, "restore_native_change", {
    change_ref: preScen8Delete.change_ref,
  });
  assert.equal(restoredScen8.status, "restored");

  // Post-snapshot C: sequential purely-agent edits C1 -> C2 on room 3, with C1 reconciled to later_owned_change.
  const c1 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(3),
    value: "Зал",
    reason: "Первое переименование гостиной",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const c2 = await applyNative(client, {
    operation: "room_name",
    target_ref: roomRef(3),
    value: "Большая комната",
    reason: "Второе переименование гостиной",
  });
  const c1Checked = await callOk(client, "get_native_change", {
    change_ref: c1.change_ref,
  });
  assert.equal(c1Checked.status, "conflict");
  assert.equal(c1Checked.conflict_reason, "later_owned_change");

  const compared = await callOk(client, "configuration_point", {
    point_ref: snapshot.point_ref,
    compare: true,
  });
  const { comparison } = compared;

  // A1 & A2: purely manual edits must NOT inherit pre-snapshot changes.
  const r1 = comparison.rooms.changed.find(({ id }) => id === 1);
  assert.equal(r1.attribution, "manual_or_external");
  assert.equal(r1.matching_agent_changes, undefined);

  const r2 = comparison.rooms.changed.find(({ id }) => id === 2);
  assert.equal(r2.attribution, "manual_or_external");
  assert.equal(r2.matching_agent_changes, undefined);

  // B1-B4: clean agent restores must attribute to "agent".
  const r7 = comparison.rooms.changed.find(({ id }) => id === 7);
  assert.equal(r7.attribution, "agent");
  assert.equal(r7.matching_agent_changes[0].change_ref, preRoom7.change_ref);

  const removedRoom = comparison.rooms.removed.find(
    ({ ref }) => ref === createdRoomRef,
  );
  assert.ok(removedRoom, JSON.stringify(comparison.rooms.removed));
  assert.equal(removedRoom.attribution, "agent");
  assert.equal(
    removedRoom.matching_agent_changes[0].change_ref,
    preCreatedRoom.change_ref,
  );

  const s3 = comparison.scenarios.changed.find(({ index }) => index === "3");
  assert.equal(s3.attribution, "agent");
  assert.equal(s3.matching_agent_changes[0].change_ref, preScen3.change_ref);

  assert.equal(comparison.scenarios.added.length, 1);
  assert.equal(comparison.scenarios.added[0].attribution, "agent");
  assert.equal(
    comparison.scenarios.added[0].matching_agent_changes[0].change_ref,
    preScen8Delete.change_ref,
  );

  // C: sequential C1 -> C2 purely-agent edits must attribute to "agent" with C2 first.
  const r3 = comparison.rooms.changed.find(({ id }) => id === 3);
  assert.equal(r3.attribution, "agent");
  assert.equal(r3.matching_agent_changes[0].change_ref, c2.change_ref);
});

test("paginating /comparison under compare=true completes despite advancing compared_at and rejects mid-pagination mutations as stale_entity_content", async (t) => {
  const { hub, client } = await setup(t);

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
    note: "Pagination baseline",
  });
  hub.state.rooms.find(({ id }) => id === 1).name = "Холл 1";
  hub.state.rooms.find(({ id }) => id === 2).name = "Коридор 2";
  hub.state.accessories.find(({ id }) => id === 12).name = "Лампа прихожей 2";
  hub.state.accessories.find(({ id }) => id === 15).name = "Люстра гостиной 2";

  const first = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    pointer: "/comparison",
    max_bytes: 2_048,
  });
  assert.equal(first.representation.kind, "selected_value");
  assert.equal(first.representation.selected_pointer, "/comparison");
  assert.ok(
    first.representation.next,
    "/comparison must paginate across multiple pages at max_bytes=2048",
  );

  const seenPointers = [];
  let page = first;
  let pages = 0;
  for (;;) {
    pages += 1;
    seenPointers.push(
      ...page.representation.available_parts.map(({ pointer }) => pointer),
    );
    if (!page.representation.next) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
    page = await callOk(
      client,
      page.representation.next.tool,
      page.representation.next.arguments,
    );
    assert.ok(pages < 20, "pagination loop did not finish");
  }
  assert.ok(pages >= 2);
  assert.equal(page.representation.available_parts_complete, true);
  assert.equal(seenPointers.includes("/comparison/rooms"), true);
  assert.equal(seenPointers.includes("/comparison/accessories"), true);
  assert.equal(seenPointers.includes("/comparison/attribution_summary"), true);

  // Real mutation mid-pagination MUST still trigger stale_entity_content.
  const fresh = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
    pointer: "/comparison",
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
});

test("redacted fields and services stay in comparison.not_compared even when another field on the same entity changes", async (t) => {
  const { hub, client } = await setup(t);

  // Add a second service with a redacted name to accessory 16.
  hub.state.accessories
    .find(({ id }) => id === 16)
    .services.push({
      aId: 16,
      sId: 25,
      name: "password=service-secret-value-42",
      type: "Switch",
      visible: true,
      characteristics: [
        {
          aId: 16,
          sId: 25,
          cId: 1,
          hasOptions: false,
          control: {
            name: "On",
            type: "On",
            read: true,
            write: true,
            events: true,
            value: { boolValue: false },
          },
        },
      ],
    });

  const saved = await callOk(client, "configuration_point", {
    scope: "home",
  });

  // Change another visible field on BOTH accessory 16 and the secret-bearing LOGIC scenario.
  hub.state.accessories.find(({ id }) => id === 16).name = "Торшер обновлённый";
  hub.state.scenarios.find(({ index }) => index === SECRET_LOGIC_INDEX).name =
    "Интеграция обновлённая";

  const compared = await callOk(client, "configuration_point", {
    point_ref: saved.point_ref,
    compare: true,
  });
  const { comparison } = compared;

  assert.equal(
    comparison.accessories.changed.some(({ id }) => id === 16),
    true,
  );
  assert.equal(
    comparison.not_compared.some(
      (item) =>
        item.entity_ref === serviceRef(16, 25) &&
        item.kind === "service" &&
        item.reason === "redacted",
    ),
    true,
    JSON.stringify(comparison.not_compared),
  );

  assert.equal(
    comparison.scenarios.changed.some(
      ({ index }) => index === SECRET_LOGIC_INDEX,
    ),
    true,
  );
  assert.equal(
    comparison.not_compared.some(
      (item) =>
        item.entity_ref === scenarioRef(SECRET_LOGIC_INDEX) &&
        item.kind === "scenario" &&
        item.reason === "redacted",
    ),
    true,
    JSON.stringify(comparison.not_compared),
  );
});

test("selected_entities missing logic and window refs destroyed by scenario_delete or virtual_device_delete are attributed to agent", async (t) => {
  const { hub, client } = await setup(t);

  // User LOGIC scenario 9 ("Защита от протечки", type "9") is already assigned to leak sensor 23/13 in apartment fixture.
  const assignedLogicRef = `${serviceRef(23, 13)}/logic/9`;
  const scen9WindowKey = hub.state.scenarios.find(
    ({ index }) => index === "9",
  ).optionsWindow;
  assert.ok(scen9WindowKey);
  const scen9WindowRef = windowRef(scen9WindowKey);

  // Create a virtual switch so it has a HomeKit bridge child window, then snapshot it.
  const createdVirtual = await applyNative(client, {
    operation: "virtual_device",
    target_ref: HOME_REF,
    room_ref: roomRef(3),
    name: "Тестовый тумблер",
    value: "Switch",
    reason: "Создать тестовый виртуальный выключатель",
  });
  const virtualAccRef = createdVirtual.device.ref;
  const virtualId = Number(virtualAccRef.split("/").at(-1));
  const virtualBridgeWindowRef = windowRef(
    `Bridge/homekit/Child/${virtualId}/`,
  );

  await new Promise((resolve) => setTimeout(resolve, 15));
  const selectedPoint = await callOk(client, "configuration_point", {
    entity_refs: [assignedLogicRef, scen9WindowRef, virtualBridgeWindowRef],
    note: "Logic and windows before delete",
  });
  assert.equal(selectedPoint.captured.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 15));

  // Agent deletes scenario 9 (destroying assignedLogicRef and scen9WindowRef) and deletes virtual switch (destroying virtualBridgeWindowRef).
  const deletedScen9 = await applyNative(client, {
    operation: "scenario_delete",
    target_ref: scenarioRef("9"),
    reason: "Удалить сценарий защиты от протечки",
  });
  const deletedVirtual = await applyNative(client, {
    operation: "virtual_device_delete",
    target_ref: virtualAccRef,
    reason: "Удалить тестовый виртуальный выключатель",
  });

  const compared = await callOk(client, "configuration_point", {
    point_ref: selectedPoint.point_ref,
    compare: true,
  });

  const logicDiff = compared.comparison.entities.find(
    ({ entity_ref }) => entity_ref === assignedLogicRef,
  );
  assert.equal(logicDiff.status, "missing");
  assert.equal(logicDiff.attribution, "agent");
  assert.equal(
    logicDiff.matching_agent_changes[0].change_ref,
    deletedScen9.change_ref,
  );

  const scenWinDiff = compared.comparison.entities.find(
    ({ entity_ref }) => entity_ref === scen9WindowRef,
  );
  assert.equal(scenWinDiff.status, "missing");
  assert.equal(scenWinDiff.attribution, "agent");
  assert.equal(
    scenWinDiff.matching_agent_changes[0].change_ref,
    deletedScen9.change_ref,
  );

  const bridgeWinDiff = compared.comparison.entities.find(
    ({ entity_ref }) => entity_ref === virtualBridgeWindowRef,
  );
  assert.equal(bridgeWinDiff.status, "missing");
  assert.equal(bridgeWinDiff.attribution, "agent");
  assert.equal(
    bridgeWinDiff.matching_agent_changes[0].change_ref,
    deletedVirtual.change_ref,
  );
});
