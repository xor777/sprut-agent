import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// Native SprutHub 3.0 dashboards through the public MCP boundary:
// home_overview(list="dashboards"), get_entity on dashboard/column/widget,
// and all 10 prepare/apply/get/restore dashboard operations with 0 new tools.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOME_REF = "spruthub://hub/sim-apartment-01";
const TEMP_CHAR_REF = `${HOME_REF}/accessory/19/service/13/characteristic/16`; // Кондиционер (Гостиная) CurrentTemperature °C
const KITCHEN_TEMP_CHAR_REF = `${HOME_REF}/accessory/21/service/13/characteristic/14`; // Кухня CurrentTemperature °C
const FLOOR_LAMP_SERVICE_REF = `${HOME_REF}/accessory/16/service/13`; // Торшер (Гостиная) Lightbulb
const HALL_LAMP_SERVICE_REF = `${HOME_REF}/accessory/14/service/13`; // Свет в коридоре (Коридор) Lightbulb
const FLOOR_LAMP_ON_REF = `${HOME_REF}/accessory/16/service/13/characteristic/14`;
const DASHBOARD_OPERATIONS = [
  "dashboard_create",
  "dashboard_update",
  "dashboard_delete",
  "dashboard_column_create",
  "dashboard_column_update",
  "dashboard_column_delete",
  "dashboard_widget_create",
  "dashboard_widget_update",
  "dashboard_widget_delete",
  "dashboard_widget_move",
];

async function setup(t, mutateFixture, hubOptions = {}) {
  const fixture = await loadHomeFixture("apartment");
  if (mutateFixture) mutateFixture(fixture);
  const hub = await startSimulatedHub(fixture, hubOptions);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-dashboards-"),
  );
  const servers = [];
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: "2500",
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "dashboards-test", version: "1.0.0" });
    await client.connect(transport);
    servers.push({ client, transport });
    return client;
  };
  const client = await connect();
  t.after(async () => {
    for (const server of servers) await server.client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return {
    hub,
    client,
    connect,
    killLatestServer: () => {
      const pid = servers.at(-1)?.transport?.pid;
      if (pid) process.kill(pid, "SIGKILL");
    },
  };
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

test("end-to-end household dashboard flow: overview, create, all 8 widget types, History check, get_entity enrichment, edits, and history filtering", async (t) => {
  const { hub, client } = await setup(t, (fixture) => {
    fixture.accessories.push({
      id: 45,
      roomId: 1,
      name: "Камера у входа",
      services: [
        {
          sId: 13,
          type: "CameraRTPStreamManagement",
          name: "Камера",
          characteristics: [{ cId: 14, type: "Name", value: "Камера" }],
        },
      ],
    });
  });

  // Base home_overview({}) must NOT add extra dashboard.list RPCs.
  await call(client, "home_overview", {});
  assert.equal(
    hub.requests.some((request) => request.method === "dashboard.list"),
    false,
    "base home_overview({}) must not call dashboard.list",
  );

  // Empty dashboard list (proto3 omits dashboards) returns [].
  const emptyList = await call(client, "home_overview", {
    list: "dashboards",
  });
  assert.equal(emptyList.list, "dashboards");
  assert.deepEqual(emptyList.dashboards, []);
  assert.equal(emptyList.total, 0);

  // dashboard_create with default column ("Основная").
  const { prepared: pDash1, applied: aDash1 } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Климат и воздух",
    reason: "Создать дашборд климата",
  });
  assert.match(
    aDash1.created_dashboard_ref,
    /^spruthub:\/\/hub\/sim-apartment-01\/dashboard\/[1-9]\d*$/,
  );
  assert.equal(aDash1.created_columns.length, 1);
  assert.equal(aDash1.created_columns[0].name, "Основная");
  const mainColRef = aDash1.created_columns[0].ref;
  assert.match(
    mainColRef,
    /^spruthub:\/\/hub\/sim-apartment-01\/dashboard\/[1-9]\d*\/column\/[1-9]\d*$/,
  );

  // dashboard_create with custom column_names and with 0 columns ([]).
  const { applied: aDash2 } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Энергия",
    column_names: ["Сейчас", "Расход"],
    reason: "Дашборд энергии с двумя колонками",
  });
  assert.equal(aDash2.created_columns.length, 2);
  assert.deepEqual(
    aDash2.created_columns.map(({ name }) => name),
    ["Сейчас", "Расход"],
  );

  const { applied: aDashEmpty } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Пустой черновик",
    column_names: [],
    reason: "Дашборд без колонок",
  });
  assert.deepEqual(aDashEmpty.created_columns, []);

  // home_overview(list="dashboards") lists dashboards with query Russian-stem filter and cursor pagination.
  const queryMatches = await call(client, "home_overview", {
    list: "dashboards",
    query: "климату",
  });
  assert.equal(queryMatches.dashboards.length, 1);
  assert.equal(queryMatches.dashboards[0].ref, aDash1.created_dashboard_ref);
  assert.equal(queryMatches.dashboards[0].name, "Климат и воздух");
  assert.equal(queryMatches.dashboards[0].column_count, 1);
  assert.equal(queryMatches.dashboards[0].widget_count, 0);

  const page1 = await call(client, "home_overview", {
    list: "dashboards",
    limit: 2,
  });
  assert.equal(page1.dashboards.length, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.next?.tool, "home_overview");
  const requestsBeforePage2 = hub.requests.length;
  const page2 = await call(client, "home_overview", page1.next.arguments);
  assert.equal(hub.requests.length, requestsBeforePage2);
  assert.equal(page2.dashboards.length, 1);
  assert.equal(page2.next, null);

  // Create ALL 8 widget kinds on dashboard 1's default column.
  // 1. characteristic
  const { applied: wChar } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: {
      type: "characteristic",
      name: "Температура дома",
      item_refs: [TEMP_CHAR_REF, KITCHEN_TEMP_CHAR_REF],
    },
    reason: "Показать текущую температуру",
  });
  assert.match(
    wChar.created_widget_ref,
    /^spruthub:\/\/hub\/sim-apartment-01\/dashboard\/[1-9]\d*\/widget\/[1-9]\d*$/,
  );

  // 2. service (with show_rooms)
  const { applied: wService } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: {
      type: "service",
      name: "Свет",
      item_refs: [FLOOR_LAMP_SERVICE_REF, HALL_LAMP_SERVICE_REF],
      show_rooms: true,
    },
    reason: "Управление светом",
  });

  // 3. chart WITHOUT History app running -> warns with history_app_missing: true, still allows creation!
  const { prepared: pChart, applied: aChart } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: {
      type: "chart",
      name: "График температуры",
      item_refs: [TEMP_CHAR_REF],
      history_group: "HOUR",
    },
    reason: "График температуры в гостиной",
  });
  assert.equal(pChart.history_app_missing, true);
  assert.equal(typeof pChart.warning, "string");
  assert.match(pChart.warning, /history|истори/i);
  assert.equal(aChart.history_app_missing, true);

  // 4. clock, 5. weather, 6. tile, 7. camera, 8. shortcut
  const cameraServiceRef = `${HOME_REF}/accessory/45/service/13`;
  const { applied: wClock } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: { type: "clock", name: "Часы" },
    reason: "Добавить часы",
  });
  const { applied: wWeather } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: { type: "weather", name: "Погода" },
    reason: "Добавить погоду",
  });
  const { applied: wTile } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: { type: "tile", name: "Плитка" },
    reason: "Добавить плитку",
  });
  const { applied: wCamera } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: {
      type: "camera",
      name: "Вход",
      item_refs: [cameraServiceRef],
    },
    reason: "Добавить камеру",
  });
  const { applied: wShortcut } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: mainColRef,
    widget: {
      type: "shortcut",
      name: "Быстрые действия",
      shortcut_ids: [1, 2],
    },
    reason: "Добавить быстрые действия",
  });
  assert.ok(wClock.created_widget_ref);
  assert.ok(wWeather.created_widget_ref);
  assert.ok(wTile.created_widget_ref);
  assert.ok(wCamera.created_widget_ref);
  assert.ok(wShortcut.created_widget_ref);

  // get_entity on dashboard, column, and widget returns refs + enriched names/rooms/types/units.
  const dashEntity = await call(client, "get_entity", {
    entity_ref: aDash1.created_dashboard_ref,
  });
  assert.equal(dashEntity.entity.kind, "dashboard");
  assert.equal(dashEntity.entity.ref, aDash1.created_dashboard_ref);
  assert.equal(dashEntity.entity.columns.length, 1);
  const col = dashEntity.entity.columns[0];
  assert.equal(col.ref, mainColRef);
  assert.equal(col.widgets.length, 8);

  const charWidget = col.widgets.find(
    ({ ref }) => ref === wChar.created_widget_ref,
  );
  assert.equal(charWidget.type, "characteristic");
  assert.equal(charWidget.items.length, 2);
  assert.equal(charWidget.items[0].characteristic_ref, TEMP_CHAR_REF);
  assert.equal(charWidget.items[0].accessory_name, "Кондиционер");
  assert.equal(charWidget.items[0].room_name, "Гостиная");
  assert.equal(charWidget.items[0].service_name, "Кондиционер");
  assert.equal(charWidget.items[0].characteristic_type, "CurrentTemperature");
  assert.equal(charWidget.items[0].unit, "°C");
  assert.equal(charWidget.items[0].missing, undefined);

  const serviceWidget = col.widgets.find(
    ({ ref }) => ref === wService.created_widget_ref,
  );
  assert.equal(serviceWidget.type, "service");
  assert.equal(serviceWidget.show_rooms, true);
  assert.equal(serviceWidget.items[0].service_ref, FLOOR_LAMP_SERVICE_REF);
  assert.equal(serviceWidget.items[0].accessory_name, "Торшер");
  assert.equal(serviceWidget.items[0].room_name, "Гостиная");

  const colEntity = await call(client, "get_entity", {
    entity_ref: mainColRef,
  });
  assert.equal(colEntity.entity.kind, "dashboard_column");
  assert.equal(colEntity.entity.ref, mainColRef);
  assert.equal(colEntity.entity.dashboard_ref, aDash1.created_dashboard_ref);
  assert.equal(colEntity.entity.widgets.length, 8);

  const widgetEntity = await call(client, "get_entity", {
    entity_ref: aChart.created_widget_ref,
  });
  assert.equal(widgetEntity.entity.kind, "dashboard_widget");
  assert.equal(widgetEntity.entity.ref, aChart.created_widget_ref);
  assert.equal(widgetEntity.entity.column_ref, mainColRef);
  assert.equal(widgetEntity.entity.type, "chart");
  assert.equal(widgetEntity.entity.history_group, "HOUR");
  assert.equal(widgetEntity.entity.items[0].unit, "°C");

  // Strict positive integer ID parsing in parseEntityRef.
  for (const badRef of [
    `${HOME_REF}/dashboard/0`,
    `${HOME_REF}/dashboard/01`,
    `${HOME_REF}/dashboard/1/column/0`,
    `${HOME_REF}/dashboard/1/widget/0`,
    `${HOME_REF}/dashboard/abc`,
  ]) {
    const err = await callError(client, "get_entity", { entity_ref: badRef });
    assert.equal(err.error.code, "invalid_entity_ref", badRef);
  }

  // Removing a referenced accessory marks that widget item missing: true on get_entity.
  hub.request({ accessory: { delete: { id: 45 } } });
  const cameraAfterDelete = await call(client, "get_entity", {
    entity_ref: wCamera.created_widget_ref,
  });
  assert.equal(cameraAfterDelete.entity.items[0].service_ref, cameraServiceRef);
  assert.equal(cameraAfterDelete.entity.items[0].missing, true);

  // dashboard_update, dashboard_column_create/update, dashboard_widget_update (+ already_desired).
  const { applied: uDash } = await prepareAndApply(client, {
    operation: "dashboard_update",
    target_ref: aDash1.created_dashboard_ref,
    name: "Климат квартиры",
    reason: "Уточнить название дашборда",
  });
  assert.equal(uDash.status, "applied");
  const alreadyDash = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: aDash1.created_dashboard_ref,
    name: "Климат квартиры",
    reason: "То же имя",
  });
  assert.equal(alreadyDash.status, "already_desired");

  const { applied: cCol2 } = await prepareAndApply(client, {
    operation: "dashboard_column_create",
    target_ref: aDash1.created_dashboard_ref,
    name: "Графики",
    reason: "Добавить вторую колонку",
  });
  const { applied: uCol2 } = await prepareAndApply(client, {
    operation: "dashboard_column_update",
    target_ref: cCol2.created_column_ref,
    name: "Динамика",
    reason: "Переименовать колонку",
  });
  assert.equal(uCol2.status, "applied");

  const { applied: uWidget } = await prepareAndApply(client, {
    operation: "dashboard_widget_update",
    target_ref: aChart.created_widget_ref,
    widget: {
      type: "chart",
      item_refs: [TEMP_CHAR_REF, KITCHEN_TEMP_CHAR_REF],
      history_group: "DAY",
    },
    reason: "Переключить график на дневную группировку",
  });
  assert.equal(uWidget.status, "applied");
  assert.equal(uWidget.history_app_missing, true);
  // Preserved existing widget name when omitted in widget update:
  const updatedChartEntity = await call(client, "get_entity", {
    entity_ref: aChart.created_widget_ref,
  });
  assert.equal(updatedChartEntity.entity.name, "График температуры");
  assert.equal(updatedChartEntity.entity.history_group, "DAY");
  assert.equal(updatedChartEntity.entity.items.length, 2);

  const alreadyWidget = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_update",
    target_ref: aChart.created_widget_ref,
    widget: {
      type: "chart",
      item_refs: [TEMP_CHAR_REF, KITCHEN_TEMP_CHAR_REF],
      history_group: "DAY",
    },
    reason: "То же содержимое виджета",
  });
  assert.equal(alreadyWidget.status, "already_desired");

  // get_native_change history filtering by dashboard_ref finds ALL changes under that dashboard.
  const history = await call(client, "get_native_change", {
    entity_ref: aDash1.created_dashboard_ref,
    limit: 50,
  });
  const ops = new Set(history.changes.map(({ operation }) => operation));
  assert.ok(ops.has("dashboard_create"));
  assert.ok(ops.has("dashboard_update"));
  assert.ok(ops.has("dashboard_column_create"));
  assert.ok(ops.has("dashboard_column_update"));
  assert.ok(ops.has("dashboard_widget_create"));
  assert.ok(ops.has("dashboard_widget_update"));
  assert.ok(
    history.changes.some(
      ({ change_ref, restore_supported }) =>
        change_ref === pDash1.change_ref && restore_supported === true,
    ),
  );
  // Unrelated dashboard changes must not match dashboard 1 filter:
  assert.equal(
    history.changes.some(
      ({ target_ref, name }) =>
        target_ref === aDash2.created_dashboard_ref || name === "Энергия",
    ),
    false,
  );
});

test("chart widget omits history_app_missing when History extension is enabled and LOADED, and warns when disabled or FAILED", async (t) => {
  // Running History extension -> NO history_app_missing warning.
  const running = await setup(t, (fixture) => {
    fixture.extensions.push({
      extensionKey: "Bridge:history",
      type: "history",
      index: "history",
      bundleType: "BRIDGE",
      name: "История",
      optionsWindow: "Bridge/history/",
      enabled: true,
      state: "LOADED",
    });
  });
  const { applied: dashRun } = await prepareAndApply(running.client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Тренды",
    reason: "Панель графиков",
  });
  const preparedRunning = await call(running.client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: dashRun.created_columns[0].ref,
    widget: {
      type: "chart",
      name: "Температура",
      item_refs: [TEMP_CHAR_REF],
      history_group: "HOUR",
    },
    reason: "График с работающей Историей",
  });
  assert.equal(preparedRunning.history_app_missing, undefined);
  assert.equal(preparedRunning.warning, undefined);

  // Disabled/FAILED History extension -> warns with history_app_missing: true.
  const failed = await setup(t, (fixture) => {
    fixture.extensions.push({
      extensionKey: "Bridge:history",
      type: "history",
      index: "history",
      bundleType: "BRIDGE",
      name: "История",
      optionsWindow: "Bridge/history/",
      enabled: true,
      state: "FAILED",
    });
  });
  const { applied: dashFailed } = await prepareAndApply(failed.client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Тренды",
    reason: "Панель графиков",
  });
  const preparedFailed = await call(failed.client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: dashFailed.created_columns[0].ref,
    widget: {
      type: "chart",
      name: "Температура",
      item_refs: [TEMP_CHAR_REF],
      history_group: "MINUTE",
    },
    reason: "График со сломанной Историей",
  });
  assert.equal(preparedFailed.history_app_missing, true);
  assert.equal(typeof preparedFailed.warning, "string");
});

test("full undo (restore_native_change) across all 9 dashboard operations and safety conflict guards", async (t) => {
  const { hub, client } = await setup(t);

  // 1. dashboard_create clean undo deletes the dashboard.
  const { applied: cleanDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Временный",
    reason: "Создать и откатить",
  });
  const undoCleanDash = await call(client, "restore_native_change", {
    change_ref: cleanDash.change_ref,
  });
  assert.equal(undoCleanDash.status, "restored");
  const goneDash = await callError(client, "get_entity", {
    entity_ref: cleanDash.created_dashboard_ref,
  });
  assert.equal(goneDash.error.code, "entity_not_found");

  // 2. dashboard_create undo REFUSES when manual widgets were added (dashboard_not_empty).
  const { applied: dirtyDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Рабочий",
    reason: "Создать рабочий дашборд",
  });
  const dirtyDashId = Number(dirtyDash.created_dashboard_ref.split("/").at(-1));
  const dirtyColId = dirtyDash.created_columns[0].id;
  hub.request({
    dashboardWidget: {
      create: {
        dashboardId: dirtyDashId,
        columnId: dirtyColId,
        name: "Ручные часы",
        clock: {},
      },
    },
  });
  const refusedDirtyDash = await call(client, "restore_native_change", {
    change_ref: dirtyDash.change_ref,
  });
  assert.equal(refusedDirtyDash.status, "conflict");
  assert.equal(refusedDirtyDash.conflict_reason, "dashboard_not_empty");
  // Dashboard must still exist untouched:
  const stillThere = await call(client, "get_entity", {
    entity_ref: dirtyDash.created_dashboard_ref,
  });
  assert.equal(stillThere.entity.columns[0].widgets.length, 1);

  // 3. dashboard_update undo restores previous name.
  const { applied: renamedDash } = await prepareAndApply(client, {
    operation: "dashboard_update",
    target_ref: dirtyDash.created_dashboard_ref,
    name: "Рабочий 2",
    reason: "Переименовать",
  });
  const undoRenameDash = await call(client, "restore_native_change", {
    change_ref: renamedDash.change_ref,
  });
  assert.equal(undoRenameDash.status, "restored");
  assert.equal(
    (
      await call(client, "get_entity", {
        entity_ref: dirtyDash.created_dashboard_ref,
      })
    ).entity.name,
    "Рабочий",
  );

  // 4. dashboard_column_create clean undo deletes empty column; refuses if manual widget added!
  const { applied: colEmpty } = await prepareAndApply(client, {
    operation: "dashboard_column_create",
    target_ref: dirtyDash.created_dashboard_ref,
    name: "Пустая",
    reason: "Создать пустую колонку",
  });
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: colEmpty.change_ref,
      })
    ).status,
    "restored",
  );
  const { applied: colDirty } = await prepareAndApply(client, {
    operation: "dashboard_column_create",
    target_ref: dirtyDash.created_dashboard_ref,
    name: "Заполненная",
    reason: "Создать колонку",
  });
  const colDirtyId = Number(colDirty.created_column_ref.split("/").at(-1));
  hub.request({
    dashboardWidget: {
      create: {
        dashboardId: dirtyDashId,
        columnId: colDirtyId,
        name: "Ручная погода",
        weather: {},
      },
    },
  });
  const refusedColUndo = await call(client, "restore_native_change", {
    change_ref: colDirty.change_ref,
  });
  assert.equal(refusedColUndo.status, "conflict");
  assert.equal(refusedColUndo.conflict_reason, "column_not_empty");

  // 5. dashboard_column_update undo restores previous name.
  const { applied: colRename } = await prepareAndApply(client, {
    operation: "dashboard_column_update",
    target_ref: colDirty.created_column_ref,
    name: "Вторая колонка",
    reason: "Переименовать колонку",
  });
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: colRename.change_ref,
      })
    ).status,
    "restored",
  );
  assert.equal(
    (
      await call(client, "get_entity", {
        entity_ref: colDirty.created_column_ref,
      })
    ).entity.name,
    "Заполненная",
  );

  // 6. dashboard_widget_create, 7. dashboard_widget_update, 8. dashboard_widget_delete undo.
  const { applied: wCreated } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: colDirty.created_column_ref,
    widget: {
      type: "characteristic",
      name: "Климат",
      item_refs: [TEMP_CHAR_REF],
    },
    reason: "Добавить виджет температуры",
  });
  const { applied: wUpdated } = await prepareAndApply(client, {
    operation: "dashboard_widget_update",
    target_ref: wCreated.created_widget_ref,
    widget: {
      type: "characteristic",
      name: "Климат обновлённый",
      item_refs: [TEMP_CHAR_REF, KITCHEN_TEMP_CHAR_REF],
    },
    reason: "Добавить кухню в виджет",
  });
  // Undo widget update -> restores old name and 1 item.
  const undoWidgetUpdate = await call(client, "restore_native_change", {
    change_ref: wUpdated.change_ref,
  });
  assert.equal(undoWidgetUpdate.status, "restored");
  const widgetRestored = await call(client, "get_entity", {
    entity_ref: wCreated.created_widget_ref,
  });
  assert.equal(widgetRestored.entity.name, "Климат");
  assert.equal(widgetRestored.entity.items.length, 1);

  // Undo widget delete -> recreates widget in same column.
  const { applied: wDeleted } = await prepareAndApply(client, {
    operation: "dashboard_widget_delete",
    target_ref: wCreated.created_widget_ref,
    reason: "Удалить виджет",
  });
  const undoWidgetDelete = await call(client, "restore_native_change", {
    change_ref: wDeleted.change_ref,
  });
  assert.equal(undoWidgetDelete.status, "restored");
  assert.ok(undoWidgetDelete.recreated_widget_ref);
  const recreatedWidget = await call(client, "get_entity", {
    entity_ref: undoWidgetDelete.recreated_widget_ref,
  });
  assert.equal(recreatedWidget.entity.name, "Климат");
  assert.equal(
    recreatedWidget.entity.items[0].characteristic_ref,
    TEMP_CHAR_REF,
  );

  // Undo widget create on a fresh widget -> deletes it cleanly.
  const { applied: wClockTemp } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: colDirty.created_column_ref,
    widget: { type: "clock", name: "Временные часы" },
    reason: "Добавить и откатить часы",
  });
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: wClockTemp.change_ref,
      })
    ).status,
    "restored",
  );
  assert.equal(
    (
      await callError(client, "get_entity", {
        entity_ref: wClockTemp.created_widget_ref,
      })
    ).error.code,
    "entity_not_found",
  );

  // 8b. dashboard_column_delete (non-empty -> tell_owner, no next!) + undo recreates column & widgets.
  const pColDel = await call(client, "prepare_native_change", {
    operation: "dashboard_column_delete",
    target_ref: colDirty.created_column_ref,
    reason: "Удалить заполненную колонку",
  });
  assert.equal(pColDel.status, "prepared");
  assert.equal(typeof pColDel.tell_owner, "string");
  assert.equal(pColDel.next, undefined, "tell_owner suppresses next: apply");
  const aColDel = await call(client, "apply_native_change", {
    change_ref: pColDel.change_ref,
  });
  assert.equal(aColDel.status, "applied");
  const undoColDel = await call(client, "restore_native_change", {
    change_ref: aColDel.change_ref,
  });
  assert.equal(undoColDel.status, "restored");
  assert.ok(undoColDel.recreated_column_ref);
  const recreatedCol = await call(client, "get_entity", {
    entity_ref: undoColDel.recreated_column_ref,
  });
  assert.equal(recreatedCol.entity.name, "Заполненная");
  assert.equal(recreatedCol.entity.widgets.length, 2);

  // 9. dashboard_delete (non-empty -> tell_owner, no next!) + undo recreates under new ID and skips deleted device's widget!
  const { applied: wLamp } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: dirtyDash.created_columns[0].ref,
    widget: {
      type: "service",
      name: "Торшер",
      item_refs: [FLOOR_LAMP_SERVICE_REF],
    },
    reason: "Добавить торшер для проверки пропуска при откате",
  });
  assert.ok(wLamp.created_widget_ref);
  const pDashDel = await call(client, "prepare_native_change", {
    operation: "dashboard_delete",
    target_ref: dirtyDash.created_dashboard_ref,
    reason: "Удалить рабочий дашборд",
  });
  assert.equal(pDashDel.status, "prepared");
  assert.equal(typeof pDashDel.tell_owner, "string");
  assert.equal(pDashDel.next, undefined);
  const aDashDel = await call(client, "apply_native_change", {
    change_ref: pDashDel.change_ref,
  });
  assert.equal(aDashDel.status, "applied");

  // Delete accessory 16 (Торшер) before restoring the deleted dashboard!
  hub.request({ accessory: { delete: { id: 16 } } });

  const undoDashDel = await call(client, "restore_native_change", {
    change_ref: aDashDel.change_ref,
  });
  assert.equal(undoDashDel.status, "restored");
  assert.ok(undoDashDel.recreated_dashboard_ref);
  assert.notEqual(
    undoDashDel.recreated_dashboard_ref,
    dirtyDash.created_dashboard_ref,
  );
  assert.equal(undoDashDel.skipped_widgets.length, 1);
  assert.equal(undoDashDel.skipped_widgets[0].widget_name, "Торшер");
  assert.equal(
    undoDashDel.skipped_widgets[0].reason,
    "referenced_entity_missing",
  );
  const recreatedDash = await call(client, "get_entity", {
    entity_ref: undoDashDel.recreated_dashboard_ref,
  });
  assert.equal(recreatedDash.entity.name, "Рабочий");
  assert.equal(recreatedDash.entity.columns.length, 2);
  // Column 0 had Ручные часы + Торшер (skipped) -> 1 widget; Column 1 had 2 widgets.
  assert.equal(recreatedDash.entity.columns[0].widgets.length, 1);
  assert.equal(recreatedDash.entity.columns[1].widgets.length, 2);

  // dashboard_column_delete undo refuses cleanly with dashboard_missing when dashboard is deleted!
  const { applied: tempDash2 } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Удаляемый родитель",
    reason: "Тест удаления родителя",
  });
  const { applied: emptyColDel } = await prepareAndApply(client, {
    operation: "dashboard_column_delete",
    target_ref: tempDash2.created_columns[0].ref,
    reason: "Удалить пустую колонку (без tell_owner)",
  });
  // Empty dashboard delete has NO tell_owner and gets next: apply_native_change!
  await prepareAndApply(client, {
    operation: "dashboard_delete",
    target_ref: tempDash2.created_dashboard_ref,
    reason: "Удалить пустой дашборд",
  });
  const refusedMissingParent = await call(client, "restore_native_change", {
    change_ref: emptyColDel.change_ref,
  });
  assert.equal(refusedMissingParent.status, "conflict");
  assert.equal(refusedMissingParent.conflict_reason, "dashboard_missing");

  // Batch restore_native_change({ change_refs }) undoes newest-first:
  // widget create deleted first, then clean dashboard deleted!
  const { applied: batchDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Пакетный откат",
    reason: "Создать дашборд для пакетного отката",
  });
  const { applied: batchWidget } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: batchDash.created_columns[0].ref,
    widget: { type: "clock", name: "Часы" },
    reason: "Добавить часы для пакетного отката",
  });
  const batchUndo = await call(client, "restore_native_change", {
    change_refs: [batchDash.change_ref, batchWidget.change_ref],
  });
  assert.equal(batchUndo.status, "ok");
  assert.equal(batchUndo.summary.restored, 2);
  assert.equal(batchUndo.results[0].operation, "dashboard_widget_create");
  assert.equal(batchUndo.results[1].operation, "dashboard_create");

  // dashboard_widget_create undo refuses when widget was manually edited;
  // dashboard_widget_delete undo refuses when referenced device was deleted.
  const { applied: guardDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Защита виджетов",
    reason: "Проверка конфликтов виджетов",
  });
  const guardDashId = Number(guardDash.created_dashboard_ref.split("/").at(-1));
  const { applied: editedWidget } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: guardDash.created_columns[0].ref,
    widget: {
      type: "service",
      name: "Коридор",
      item_refs: [HALL_LAMP_SERVICE_REF],
    },
    reason: "Виджет света коридора",
  });
  const editedWidgetId = Number(
    editedWidget.created_widget_ref.split("/").at(-1),
  );
  hub.request({
    dashboardWidget: {
      update: {
        dashboardId: guardDashId,
        id: editedWidgetId,
        name: "Изменено вручную",
        service: { items: [{ aId: 14, sId: 13 }] },
      },
    },
  });
  const refusedEditedWidget = await call(client, "restore_native_change", {
    change_ref: editedWidget.change_ref,
  });
  assert.equal(refusedEditedWidget.status, "conflict");
  assert.equal(refusedEditedWidget.conflict_reason, "widget_changed_since");

  const { applied: delWidgetForMissingDevice } = await prepareAndApply(client, {
    operation: "dashboard_widget_delete",
    target_ref: editedWidget.created_widget_ref,
    reason: "Удалить виджет коридора",
  });
  hub.request({ accessory: { delete: { id: 14 } } });
  const refusedMissingDeviceWidget = await call(
    client,
    "restore_native_change",
    { change_ref: delWidgetForMissingDevice.change_ref },
  );
  assert.equal(refusedMissingDeviceWidget.status, "conflict");
  assert.equal(
    refusedMissingDeviceWidget.conflict_reason,
    "referenced_entity_missing",
  );
});

test("safety, drift detection, inline contracts, HomeState neutrality, secret redaction, lost-reply reconciliation, and MCP surface budgets", async (t) => {
  const { hub, client } = await setup(t);

  // 1. MCP surface budgets: 13 tools, instructions <= 2048, every description <= 1000.
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13, "must keep exactly 13 MCP tools");
  for (const tool of tools) {
    assert.ok(
      tool.description.length <= 1_000,
      `${tool.name} description exceeded 1000 chars: ${tool.description.length}`,
    );
  }
  const instructions = client.getInstructions();
  assert.ok(
    instructions.length <= 2_048,
    `instructions exceeded 2048 chars: ${instructions.length}`,
  );

  // 2. All 9 dashboard contracts exist and fit inside <= 4096 B inline budget.
  for (const operation of DASHBOARD_OPERATIONS) {
    const res = await call(client, "get_native_change_contract", { operation });
    assert.equal(res.operation, operation);
    const bytes = Buffer.byteLength(JSON.stringify(res.contract), "utf8");
    assert.ok(
      bytes <= 4_096,
      `${operation} contract exceeded 4096 bytes: ${bytes}`,
    );
  }

  // 3. HomeState neutrality: warm HomeState, run dashboard writes + pushed dashboard events,
  //    then call find_devices again -> ZERO new accessory.list or room.list RPCs!
  hub.restEvent();
  await call(client, "find_devices", { query: "торшер" });
  const wholeReadsBefore = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  assert.ok(wholeReadsBefore > 0);

  const { applied: neutralDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Нейтральный",
    reason: "Проверка HomeState",
  });
  const neutralColRef = neutralDash.created_columns[0].ref;
  const { applied: neutralWidget } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: neutralColRef,
    widget: {
      type: "characteristic",
      name: "Лампа",
      item_refs: [FLOOR_LAMP_ON_REF],
    },
    reason: "Виджет для проверки HomeState",
  });
  // Push extra dashboard/column/widget events directly down the WebSocket:
  hub.emit({
    dashboard: {
      event: "EVENT_UPDATE",
      dashboards: [{ id: 1, order: 0, name: "Нейтральный" }],
    },
  });
  hub.emit({
    dashboardColumn: {
      event: "EVENT_UPDATE",
      columns: [{ dashboardId: 1, id: 1, order: 0, name: "Основная" }],
    },
  });
  hub.emit({
    dashboardWidget: {
      event: "EVENT_UPDATE",
      widgets: [{ dashboardId: 1, columnId: 1, id: 1, order: 0, clock: {} }],
    },
  });
  await call(client, "find_devices", { query: "торшер" });
  const wholeReadsAfter = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  assert.equal(
    wholeReadsAfter,
    wholeReadsBefore,
    "dashboard writes and pushed dashboard* events must NOT invalidate warm HomeState",
  );

  // 4. Inline contract recovery on invalid widget/dashboard inputs (<= 4096 B).
  const invalidWidgetCases = [
    // missing item_refs on characteristic
    {
      operation: "dashboard_widget_create",
      target_ref: neutralColRef,
      widget: { type: "characteristic" },
      reason: "test",
    },
    // forbidden show_rooms on characteristic
    {
      operation: "dashboard_widget_create",
      target_ref: neutralColRef,
      widget: {
        type: "characteristic",
        item_refs: [FLOOR_LAMP_ON_REF],
        show_rooms: true,
      },
      reason: "test",
    },
    // wrong ref kind (service passed to characteristic widget)
    {
      operation: "dashboard_widget_create",
      target_ref: neutralColRef,
      widget: {
        type: "characteristic",
        item_refs: [FLOOR_LAMP_SERVICE_REF],
      },
      reason: "test",
    },
    // forbidden item_refs on clock
    {
      operation: "dashboard_widget_create",
      target_ref: neutralColRef,
      widget: { type: "clock", item_refs: [FLOOR_LAMP_ON_REF] },
      reason: "test",
    },
    // missing shortcut_ids on shortcut
    {
      operation: "dashboard_widget_create",
      target_ref: neutralColRef,
      widget: { type: "shortcut" },
      reason: "test",
    },
    // missing name on dashboard_create
    {
      operation: "dashboard_create",
      target_ref: HOME_REF,
      reason: "test",
    },
  ];
  for (const args of invalidWidgetCases) {
    const err = await callError(client, "prepare_native_change", args);
    assert.ok(
      err.contract !== undefined,
      `expected inline contract for ${JSON.stringify(args)}: ${JSON.stringify(err)}`,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(err.contract), "utf8") <= 4_096);
  }

  // 5. Baseline drift guard on dashboard_update and dashboard_widget_update.
  const pDriftDash = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: neutralDash.created_dashboard_ref,
    name: "Агентское имя",
    reason: "Проверка drift",
  });
  const neutralDashId = Number(
    neutralDash.created_dashboard_ref.split("/").at(-1),
  );
  hub.request({
    dashboard: { update: { id: neutralDashId, name: "Ручное имя" } },
  });
  const aDriftDash = await call(client, "apply_native_change", {
    change_ref: pDriftDash.change_ref,
  });
  assert.equal(aDriftDash.status, "conflict");
  assert.equal(aDriftDash.conflict_reason, "dashboard_changed_since");

  const pDriftWidget = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_update",
    target_ref: neutralWidget.created_widget_ref,
    widget: { type: "clock", name: "Часы" },
    reason: "Проверка drift виджета",
  });
  const neutralWidgetId = Number(
    neutralWidget.created_widget_ref.split("/").at(-1),
  );
  hub.request({
    dashboardWidget: {
      update: {
        dashboardId: neutralDashId,
        id: neutralWidgetId,
        name: "Ручная правка",
        weather: {},
      },
    },
  });
  const aDriftWidget = await call(client, "apply_native_change", {
    change_ref: pDriftWidget.change_ref,
  });
  assert.equal(aDriftWidget.status, "conflict");
  assert.equal(aDriftWidget.conflict_reason, "widget_changed_since");

  // 6. Secret redaction in dashboard/column/widget names + [REDACTED] write refusal.
  const SECRET = "sk-ant-api03-secretvalue1234567890abcdef";
  hub.request({
    dashboard: {
      create: { name: `Панель Bearer ${SECRET}` },
    },
  });
  const redactedList = await call(client, "home_overview", {
    list: "dashboards",
  });
  assert.equal(
    JSON.stringify(redactedList).includes(SECRET),
    false,
    "secret must never leak in home_overview list=dashboards",
  );
  const secretDash = redactedList.dashboards.find((d) =>
    d.name.includes("[REDACTED]"),
  );
  assert.ok(secretDash, "secret-shaped dashboard name must be redacted");
  const redactedEntity = await call(client, "get_entity", {
    entity_ref: secretDash.ref,
  });
  assert.equal(JSON.stringify(redactedEntity).includes(SECRET), false);
  // Attempting to write [REDACTED] back must be refused without inline contract:
  const refusedRedacted = await callError(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: secretDash.ref,
    name: secretDash.name,
    reason: "Попытка записать [REDACTED]",
  });
  assert.equal(refusedRedacted.error.code, "invalid_native_value");
  assert.equal(refusedRedacted.contract, undefined);

  // 7. Lost-reply reconciliation via get_native_change (NO blind resend!).
  // 7a. dashboard_create with droppedReply (hub DID create, reply lost) -> uncertain + candidate_dashboards; retry does NOT create duplicate!
  const pLostCreate = await call(client, "prepare_native_change", {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Потерянный ответ",
    reason: "Проверка потерянного ответа создания",
  });
  const createsBefore = hub.requests.filter(
    ({ method }) => method === "dashboard.create",
  ).length;
  hub.state.faults.droppedReply.push({
    method: "dashboard.create",
    remaining: 1,
  });
  const aLostCreate = await call(client, "apply_native_change", {
    change_ref: pLostCreate.change_ref,
  });
  assert.equal(aLostCreate.status, "uncertain");
  assert.equal(aLostCreate.candidate_dashboards.length, 1);
  assert.equal(aLostCreate.candidate_dashboards[0].name, "Потерянный ответ");
  // Re-checking via get_native_change or retrying apply must NOT resend dashboard.create!
  const checkedLostCreate = await call(client, "get_native_change", {
    change_ref: pLostCreate.change_ref,
  });
  assert.equal(checkedLostCreate.status, "uncertain");
  await call(client, "apply_native_change", {
    change_ref: pLostCreate.change_ref,
  });
  const createsAfter = hub.requests.filter(
    ({ method }) => method === "dashboard.create",
  ).length;
  assert.equal(
    createsAfter,
    createsBefore + 1,
    "lost create reply must NEVER be resent blindly",
  );

  // 7b. dashboard_update with droppedReply -> reconciles to applied with recovered_after_uncertain_write!
  const pLostUpdate = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: neutralDash.created_dashboard_ref,
    name: "Восстановленное имя",
    reason: "Проверка потерянного ответа обновления",
  });
  hub.state.faults.droppedReply.push({
    method: "dashboard.update",
    remaining: 1,
  });
  const aLostUpdate = await call(client, "apply_native_change", {
    change_ref: pLostUpdate.change_ref,
  });
  // Reconciles immediately or via get_native_change to applied with recovered_after_uncertain_write!
  const settledUpdate =
    aLostUpdate.status === "applied"
      ? aLostUpdate
      : await call(client, "get_native_change", {
          change_ref: pLostUpdate.change_ref,
        });
  assert.equal(settledUpdate.status, "applied");
  assert.equal(settledUpdate.recovered_after_uncertain_write, true);

  // 7c. dashboard_update with loseNext (write never reached hub) -> uncertain, NO blind resend on get_native_change!
  const pLostReq = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: neutralDash.created_dashboard_ref,
    name: "Неотправленное имя",
    reason: "Проверка потерянного запроса",
  });
  const updatesBefore = hub.requests.filter(
    ({ method }) => method === "dashboard.update",
  ).length;
  hub.loseNext("dashboard.update");
  const aLostReq = await call(client, "apply_native_change", {
    change_ref: pLostReq.change_ref,
  });
  assert.equal(aLostReq.status, "uncertain");
  const checkedLostReq = await call(client, "get_native_change", {
    change_ref: pLostReq.change_ref,
  });
  assert.equal(checkedLostReq.status, "uncertain");
  const updatesAfter = hub.requests.filter(
    ({ method }) => method === "dashboard.update",
  ).length;
  assert.equal(
    updatesAfter,
    updatesBefore + 1,
    "lost update request must not be blindly resent by get_native_change",
  );
});

test("review P1-1: multi-step delete undo handles mid-sequence refusal, lost reply, resume without duplicates, and missing final readback", async (t) => {
  const hooks = {};
  const { hub, client } = await setup(t, undefined, {
    onRequest: (request) => hooks.onRequest?.(request),
  });

  // Create dashboard with 2 columns and 2 widgets, then delete it.
  const { applied: dash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Восстанавливаемый",
    column_names: ["Первая", "Вторая"],
    reason: "Дашборд для проверки частичного восстановления",
  });
  const col1Ref = dash.created_columns[0].ref;
  const col2Ref = dash.created_columns[1].ref;
  await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: col1Ref,
    widget: { type: "clock", name: "Часы 1" },
    reason: "Виджет в первой колонке",
  });
  await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: col2Ref,
    widget: { type: "weather", name: "Погода 2" },
    reason: "Виджет во второй колонке",
  });
  const pDel = await call(client, "prepare_native_change", {
    operation: "dashboard_delete",
    target_ref: dash.created_dashboard_ref,
    reason: "Удалить дашборд",
  });
  assert.equal(typeof pDel.tell_owner, "string");
  await call(client, "apply_native_change", { change_ref: pDel.change_ref });

  // Refuse the 2nd dashboardColumn.create during restore.
  let colCreates = 0;
  hooks.onRequest = (request) => {
    if (request.method !== "dashboardColumn.create") return;
    colCreates += 1;
    if (colCreates === 2) {
      hub.refuseNext("dashboardColumn.create", {
        code: -32000,
        message: "column limit hit",
      });
      hooks.onRequest = undefined;
    }
  };
  const partialErr = await callError(client, "restore_native_change", {
    change_ref: pDel.change_ref,
  });
  assert.equal(partialErr.hub_effect, "partial");
  assert.equal(partialErr.rejection?.protocol_code, -32000);
  assert.equal(partialErr.next?.tool, "restore_native_change");

  // get_native_change MUST NOT mark incomplete recreation as restored!
  const inspectedPartial = await call(client, "get_native_change", {
    change_ref: pDel.change_ref,
  });
  assert.notEqual(inspectedPartial.status, "restored");
  assert.equal(inspectedPartial.recreation_complete, false);

  // Following next: restore_native_change resumes ONLY remaining column/widget (no duplicate dashboard/column 1).
  const dashCreatesBeforeResume = hub.requests.filter(
    ({ method }) => method === "dashboard.create",
  ).length;
  const resumed = await call(
    client,
    partialErr.next.tool,
    partialErr.next.arguments,
  );
  assert.equal(resumed.status, "restored");
  assert.equal(resumed.recreation_complete, true);
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboard.create").length,
    dashCreatesBeforeResume,
    "resuming partial dashboard_delete restore must not create a second dashboard",
  );
  const fullRestored = await call(client, "get_entity", {
    entity_ref: resumed.recreated_dashboard_ref,
  });
  assert.equal(fullRestored.entity.columns.length, 2);
  assert.equal(fullRestored.entity.columns[0].widgets.length, 1);
  assert.equal(fullRestored.entity.columns[1].widgets.length, 1);
  assert.equal(fullRestored.entity.columns[1].widgets[0].name, "Погода 2");

  // dashboard_column_delete mid-loop droppedReply on widget 2 stays uncertain (never restored).
  const { applied: colDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Колоночный",
    reason: "Тест колоночного восстановления",
  });
  const cRef = colDash.created_columns[0].ref;
  await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: cRef,
    widget: { type: "clock", name: "W1" },
    reason: "Первый виджет",
  });
  await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: cRef,
    widget: { type: "tile", name: "W2" },
    reason: "Второй виджет",
  });
  const pColDel = await call(client, "prepare_native_change", {
    operation: "dashboard_column_delete",
    target_ref: cRef,
    reason: "Удалить колонку",
  });
  await call(client, "apply_native_change", { change_ref: pColDel.change_ref });

  let widgetCreates = 0;
  hooks.onRequest = (request) => {
    if (request.method !== "dashboardWidget.create") return;
    widgetCreates += 1;
    if (widgetCreates === 2) {
      hub.state.faults.droppedReply.push({
        method: "dashboardWidget.create",
        remaining: 1,
      });
      hooks.onRequest = undefined;
    }
  };
  const uncertainColRestore = await call(client, "restore_native_change", {
    change_ref: pColDel.change_ref,
  });
  assert.equal(uncertainColRestore.status, "uncertain");
  assert.equal(uncertainColRestore.recreation_complete, false);
  const inspectedColRestore = await call(client, "get_native_change", {
    change_ref: pColDel.change_ref,
  });
  assert.equal(inspectedColRestore.status, "uncertain");
  assert.equal(inspectedColRestore.recreation_complete, false);

  // dashboard_widget_delete undo where recreated widget vanishes before final readback -> conflict (not restored).
  const { applied: wDelDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Исчезнувший виджет",
    reason: "Тест readback null",
  });
  const { applied: wTemp } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: wDelDash.created_columns[0].ref,
    widget: { type: "clock", name: "Мигающий" },
    reason: "Создать виджет",
  });
  const { applied: wDeleted } = await prepareAndApply(client, {
    operation: "dashboard_widget_delete",
    target_ref: wTemp.created_widget_ref,
    reason: "Удалить виджет",
  });
  const wDelDashId = Number(wDelDash.created_dashboard_ref.split("/").at(-1));
  hooks.onRequest = (request) => {
    if (request.method !== "dashboardWidget.get") return;
    // Remove the just-recreated widget right before final readback.
    const liveDash = hub.state.dashboards.find((d) => d.id === wDelDashId);
    if (liveDash?.columns[0]?.widgets.length) {
      liveDash.columns[0].widgets.length = 0;
    }
    hooks.onRequest = undefined;
  };
  const missingReadback = await call(client, "restore_native_change", {
    change_ref: wDeleted.change_ref,
  });
  assert.equal(missingReadback.status, "conflict");
  assert.equal(missingReadback.conflict_reason, "recreated_widget_missing");
});

test("review P1-2: pre-write conflict and unconfirmed apply never overwrite owner edits or recreate manually deleted objects", async (t) => {
  const { hub, client } = await setup(t);
  const { applied: dash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Имя A",
    reason: "Создать дашборд",
  });
  const dashId = Number(dash.created_dashboard_ref.split("/").at(-1));

  // 2a. Pre-write conflict on dashboard_update (native_write_sent=false), then owner sets name to "Имя B".
  const pUpd = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: dash.created_dashboard_ref,
    name: "Имя B",
    reason: "Переименовать A -> B",
  });
  hub.request({ dashboard: { update: { id: dashId, name: "Имя C" } } });
  const aConflict = await call(client, "apply_native_change", {
    change_ref: pUpd.change_ref,
  });
  assert.equal(aConflict.status, "conflict");
  assert.equal(aConflict.native_write_sent, false);
  // Owner independently renames to "Имя B" matching requested_name!
  hub.request({ dashboard: { update: { id: dashId, name: "Имя B" } } });
  const updatesBefore = hub.requests.filter(
    ({ method }) => method === "dashboard.update",
  ).length;
  const restoreUnapplied = await call(client, "restore_native_change", {
    change_ref: pUpd.change_ref,
  });
  assert.equal(restoreUnapplied.status, "not_owned");
  assert.equal(restoreUnapplied.conflict_reason, "change_was_not_applied");
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboard.update").length,
    updatesBefore,
    "pre-write conflict must send 0 dashboard.update writes on restore",
  );
  assert.equal(
    (
      await call(client, "get_entity", {
        entity_ref: dash.created_dashboard_ref,
      })
    ).entity.name,
    "Имя B",
  );

  // 2b. Pre-write conflict on dashboard_delete, then owner manually deletes dashboard -> restore must NOT recreate it!
  const pDel = await call(client, "prepare_native_change", {
    operation: "dashboard_delete",
    target_ref: dash.created_dashboard_ref,
    reason: "Удалить дашборд",
  });
  hub.request({ dashboard: { update: { id: dashId, name: "Имя D" } } });
  const delConflict = await call(client, "apply_native_change", {
    change_ref: pDel.change_ref,
  });
  assert.equal(delConflict.status, "conflict");
  assert.equal(delConflict.native_write_sent, false);
  hub.request({ dashboard: { delete: { id: dashId } } });
  const createsBefore = hub.requests.filter(
    ({ method }) => method === "dashboard.create",
  ).length;
  const restoreUnappliedDel = await call(client, "restore_native_change", {
    change_ref: pDel.change_ref,
  });
  assert.equal(restoreUnappliedDel.status, "not_owned");
  assert.equal(restoreUnappliedDel.conflict_reason, "change_was_not_applied");
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboard.create").length,
    createsBefore,
    "pre-write delete conflict must NOT recreate manually deleted dashboard",
  );

  // 2c. Unconfirmed apply (loseNext on dashboard.update -> still baseline on hub) must stay uncertain on restore!
  const { applied: dash2 } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Исходный",
    reason: "Создать дашборд 2",
  });
  const pLostUpd = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: dash2.created_dashboard_ref,
    name: "Новый",
    reason: "Потерянное обновление",
  });
  hub.loseNext("dashboard.update");
  const aLost = await call(client, "apply_native_change", {
    change_ref: pLostUpd.change_ref,
  });
  assert.equal(aLost.status, "uncertain");
  const updatesBeforeUncertainRestore = hub.requests.filter(
    ({ method }) => method === "dashboard.update",
  ).length;
  const restoreUncertain = await call(client, "restore_native_change", {
    change_ref: pLostUpd.change_ref,
  });
  assert.equal(restoreUncertain.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboard.update").length,
    updatesBeforeUncertainRestore,
  );
});

test("review P1-3: dashboard_create partial column refusal and lost-reply preserve state on get and remain undoable", async (t) => {
  const hooks = {};
  const { hub, client } = await setup(t, undefined, {
    onRequest: (request) => hooks.onRequest?.(request),
  });

  // 3a. Refused 2nd column during dashboard_create reports rejection, preserves conflict on get, and undoes cleanly!
  const pPartial = await call(client, "prepare_native_change", {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Частичный",
    column_names: ["Колонка 1", "Колонка 2"],
    reason: "Проверка отказа 2-й колонки",
  });
  let colAttempt = 0;
  hooks.onRequest = (request) => {
    if (request.method !== "dashboardColumn.create") return;
    colAttempt += 1;
    if (colAttempt === 2) {
      hub.refuseNext("dashboardColumn.create", {
        code: -32001,
        message: "column rejected",
      });
      hooks.onRequest = undefined;
    }
  };
  const errPartial = await callError(client, "apply_native_change", {
    change_ref: pPartial.change_ref,
  });
  assert.equal(errPartial.hub_effect, "partial");
  assert.equal(errPartial.rejection?.protocol_code, -32001);
  assert.equal(errPartial.next?.tool, "restore_native_change");

  const getPartial = await call(client, "get_native_change", {
    change_ref: pPartial.change_ref,
  });
  assert.equal(getPartial.status, "conflict");
  assert.equal(getPartial.conflict_reason, "partial_column_creation_refused");
  const undoPartial = await call(client, "restore_native_change", {
    change_ref: pPartial.change_ref,
  });
  assert.equal(undoPartial.status, "restored");

  // 3b. droppedReply on column creation leaves uncertain on get AND allows clean undo of owned partial dashboard!
  const pLostCol = await call(client, "prepare_native_change", {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Потерянная колонка",
    column_names: ["Основная"],
    reason: "Проверка потерянного ответа колонки",
  });
  hub.state.faults.droppedReply.push({
    method: "dashboardColumn.create",
    remaining: 1,
  });
  const aLostCol = await call(client, "apply_native_change", {
    change_ref: pLostCol.change_ref,
  });
  assert.equal(aLostCol.status, "uncertain");
  const getLostCol = await call(client, "get_native_change", {
    change_ref: pLostCol.change_ref,
  });
  assert.equal(getLostCol.status, "uncertain");
  const undoLostCol = await call(client, "restore_native_change", {
    change_ref: pLostCol.change_ref,
  });
  assert.equal(undoLostCol.status, "restored");
  const goneLostCol = await callError(client, "get_entity", {
    entity_ref: aLostCol.created_dashboard_ref,
  });
  assert.equal(goneLostCol.error.code, "entity_not_found");
});

test("review P1-4: get_native_change preserves uncertain restore and conflict states on *_create", async (t) => {
  const { hub, client } = await setup(t);

  const { applied: d } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Статусы",
    reason: "Проверка P1-4",
  });
  const dashId = Number(d.created_dashboard_ref.split("/").at(-1));
  const { applied: cLostDel } = await prepareAndApply(client, {
    operation: "dashboard_column_create",
    target_ref: d.created_dashboard_ref,
    name: "Теряемая",
    reason: "Колонка для loseNext",
  });
  hub.loseNext("dashboardColumn.delete");
  const uncertainRestore = await call(client, "restore_native_change", {
    change_ref: cLostDel.change_ref,
  });
  assert.equal(uncertainRestore.status, "uncertain");
  const afterGetUncertain = await call(client, "get_native_change", {
    change_ref: cLostDel.change_ref,
  });
  assert.equal(
    afterGetUncertain.status,
    "uncertain",
    "get_native_change must not overwrite uncertain restore back to applied",
  );

  // Conflict preserved on get_native_change:
  const { applied: cNonEmpty } = await prepareAndApply(client, {
    operation: "dashboard_column_create",
    target_ref: d.created_dashboard_ref,
    name: "Непустая",
    reason: "Колонка с ручным виджетом",
  });
  const cNonEmptyId = Number(cNonEmpty.created_column_ref.split("/").at(-1));
  hub.request({
    dashboardWidget: {
      create: {
        dashboardId: dashId,
        columnId: cNonEmptyId,
        name: "Ручной",
        clock: {},
      },
    },
  });
  const colConflict = await call(client, "restore_native_change", {
    change_ref: cNonEmpty.change_ref,
  });
  assert.equal(colConflict.status, "conflict");
  assert.equal(colConflict.conflict_reason, "column_not_empty");
  const afterGetConflict = await call(client, "get_native_change", {
    change_ref: cNonEmpty.change_ref,
  });
  assert.equal(afterGetConflict.status, "conflict");
  assert.equal(afterGetConflict.conflict_reason, "column_not_empty");
});

test("review P1-5: crash/restart while status === restoring on dashboard_delete creates no duplicate", async (t) => {
  const hooks = {};
  const { hub, client, connect, killLatestServer } = await setup(t, undefined, {
    onRequest: (request) => hooks.onRequest?.(request),
  });

  const { applied: crashDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Краш при откате",
    column_names: [],
    reason: "Дашборд для теста краша",
  });
  const { applied: crashDel } = await prepareAndApply(client, {
    operation: "dashboard_delete",
    target_ref: crashDash.created_dashboard_ref,
    reason: "Удалить перед крашем",
  });
  const crashClient = await connect();
  const dashCreatesBeforeCrash = hub.requests.filter(
    ({ method }) => method === "dashboard.create",
  ).length;
  const killed = new Promise((resolve) => {
    hooks.onRequest = (request) => {
      if (request.method !== "dashboard.create") return;
      hooks.onRequest = undefined;
      killLatestServer();
      resolve();
    };
  });
  crashClient
    .callTool({
      name: "restore_native_change",
      arguments: { change_ref: crashDel.change_ref },
    })
    .catch(() => {});
  await killed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const recoveredClient = await connect();
  const afterRestartRestore = await call(
    recoveredClient,
    "restore_native_change",
    { change_ref: crashDel.change_ref },
  );
  assert.equal(afterRestartRestore.status, "uncertain");
  assert.equal(afterRestartRestore.candidate_dashboards?.length, 1);
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboard.create").length,
    dashCreatesBeforeCrash + 1,
    "retrying restore after crash in status=restoring must NOT send a second dashboard.create",
  );
});

test("review P2-1: read-only get_native_change does not bump updated_at or break later_owned_change", async (t) => {
  const { client } = await setup(t);
  const { applied: d } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Порядок",
    reason: "Проверка P2-1",
  });
  const { applied: upd1 } = await prepareAndApply(client, {
    operation: "dashboard_update",
    target_ref: d.created_dashboard_ref,
    name: "Порядок 2",
    reason: "Первое переименование",
  });
  const { applied: upd2 } = await prepareAndApply(client, {
    operation: "dashboard_update",
    target_ref: d.created_dashboard_ref,
    name: "Порядок 3",
    reason: "Второе переименование",
  });
  const histBefore = await call(client, "get_native_change", {
    entity_ref: d.created_dashboard_ref,
    limit: 50,
  });
  const createEntryBefore = histBefore.changes.find(
    ({ change_ref }) => change_ref === d.change_ref,
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  await call(client, "get_native_change", { change_ref: d.change_ref });
  await call(client, "get_native_change", { change_ref: upd1.change_ref });
  const histAfter = await call(client, "get_native_change", {
    entity_ref: d.created_dashboard_ref,
    limit: 50,
  });
  const createEntryAfter = histAfter.changes.find(
    ({ change_ref }) => change_ref === d.change_ref,
  );
  assert.equal(
    createEntryAfter.updated_at,
    createEntryBefore.updated_at,
    "read-only get_native_change must not bump updated_at",
  );
  const restoreEarlier = await call(client, "restore_native_change", {
    change_ref: upd1.change_ref,
  });
  assert.equal(restoreEarlier.status, "conflict");
  assert.equal(restoreEarlier.conflict_reason, "later_owned_change");
  assert.equal(restoreEarlier.restore_first_change_ref, upd2.change_ref);
});

test("review P3-1: non-device widgets and empty dashboard restores skip homeCatalog refresh", async (t) => {
  const { hub, client } = await setup(t);
  hub.restEvent();
  await call(client, "find_devices", { query: "торшер" });
  const catalogCallsBefore = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  const { applied: emptyDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Без устройств",
    reason: "Проверка P3-1",
  });
  const { applied: clockW } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: emptyDash.created_columns[0].ref,
    widget: { type: "clock", name: "Часы" },
    reason: "Часы без устройств",
  });
  await prepareAndApply(client, {
    operation: "dashboard_widget_update",
    target_ref: clockW.created_widget_ref,
    widget: { type: "weather", name: "Погода" },
    reason: "Погода без устройств",
  });
  const { applied: delClock } = await prepareAndApply(client, {
    operation: "dashboard_widget_delete",
    target_ref: clockW.created_widget_ref,
    reason: "Удалить погоду",
  });
  await call(client, "restore_native_change", {
    change_ref: delClock.change_ref,
  });
  const pDelEmptyDash = await call(client, "prepare_native_change", {
    operation: "dashboard_delete",
    target_ref: emptyDash.created_dashboard_ref,
    reason: "Удалить дашборд без устройств",
  });
  await call(client, "apply_native_change", {
    change_ref: pDelEmptyDash.change_ref,
  });
  await call(client, "restore_native_change", {
    change_ref: pDelEmptyDash.change_ref,
  });
  const catalogCallsAfter = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  assert.equal(
    catalogCallsAfter,
    catalogCallsBefore,
    "non-device widgets and non-device dashboard deletes must not call homeCatalog refresh",
  );
});

test("hub name normalization: warns on prepare, applies cleanly with hub_normalized_name, preserves conflict on third-party edits and uncertain on timeout", async (t) => {
  const hooks = {};
  const { hub, client } = await setup(t, undefined, {
    onRequest: (request) => hooks.onRequest?.(request),
  });

  const { applied: dash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Энергия",
    column_names: ["Сейчас"],
    reason: "Создать дашборд для теста нормализации имён",
  });
  const dashRef = dash.created_dashboard_ref;
  const dashId = Number(dashRef.split("/").at(-1));
  const colRef = dash.created_columns[0].ref;
  const { applied: widget } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: {
      type: "characteristic",
      name: "Обогреватель",
      item_refs: [TEMP_CHAR_REF],
    },
    reason: "Создать виджет для теста нормализации",
  });
  const widgetRef = widget.created_widget_ref;
  const widgetId = Number(widgetRef.split("/").at(-1));

  // 1. dashboard_update with stripped punctuation ("·" -> internal double space):
  //    prepare warns, apply succeeds as applied (NOT false conflict!), get_native_change confirms, restore undoes cleanly!
  const dottedName = "Гостиная · розетка обогревателя";
  const expectedDottedStored = "Гостиная  розетка обогревателя";
  const pDashNorm = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: dashRef,
    name: dottedName,
    reason: "Переименовать панель с точкой посередине",
  });
  assert.equal(pDashNorm.status, "prepared");
  assert.ok(
    Array.isArray(pDashNorm.warnings) && pDashNorm.warnings.length >= 1,
  );
  assert.equal(typeof pDashNorm.warning, "string");
  assert.ok(
    pDashNorm.warnings.some(
      (message) =>
        message.includes(expectedDottedStored) && message.includes("32"),
    ),
    `expected normalization warning with stored name and 32-char limit: ${JSON.stringify(pDashNorm.warnings)}`,
  );

  const aDashNorm = await call(client, "apply_native_change", {
    change_ref: pDashNorm.change_ref,
  });
  assert.equal(
    aDashNorm.status,
    "applied",
    "hub-normalized dashboard_update must settle as applied, not false conflict",
  );
  assert.deepEqual(aDashNorm.hub_normalized_name, {
    requested: dottedName,
    stored: expectedDottedStored,
  });
  assert.equal(aDashNorm.name_normalized, true);
  assert.equal(aDashNorm.verification?.result, "requested_name_observed");
  assert.equal(
    (await call(client, "get_entity", { entity_ref: dashRef })).entity.name,
    expectedDottedStored,
  );
  const gDashNorm = await call(client, "get_native_change", {
    change_ref: pDashNorm.change_ref,
  });
  assert.equal(gDashNorm.status, "applied");
  assert.equal(gDashNorm.verification?.result, "applied_name_observed");
  const rDashNorm = await call(client, "restore_native_change", {
    change_ref: pDashNorm.change_ref,
  });
  assert.equal(rDashNorm.status, "restored");
  assert.equal(
    (await call(client, "get_entity", { entity_ref: dashRef })).entity.name,
    "Энергия",
  );

  // 2. dashboard_column_update with >32 Unicode code points truncates to 32 chars and restores cleanly.
  const longColName = "Очень длинное название колонки для проверки обрезки";
  const expectedLongCol = "Очень длинное название колонки д";
  assert.equal([...expectedLongCol].length, 32);
  const pColNorm = await call(client, "prepare_native_change", {
    operation: "dashboard_column_update",
    target_ref: colRef,
    name: longColName,
    reason: "Проверить обрезку имени колонки до 32 символов",
  });
  assert.equal(pColNorm.status, "prepared");
  assert.ok(
    pColNorm.warnings?.some((message) => message.includes(expectedLongCol)),
  );
  const aColNorm = await call(client, "apply_native_change", {
    change_ref: pColNorm.change_ref,
  });
  assert.equal(aColNorm.status, "applied");
  assert.deepEqual(aColNorm.hub_normalized_name, {
    requested: longColName,
    stored: expectedLongCol,
  });
  const gColNorm = await call(client, "get_native_change", {
    change_ref: pColNorm.change_ref,
  });
  assert.equal(gColNorm.status, "applied");
  assert.equal(gColNorm.verification?.result, "applied_name_observed");
  const rColNorm = await call(client, "restore_native_change", {
    change_ref: pColNorm.change_ref,
  });
  assert.equal(rColNorm.status, "restored");
  assert.equal(
    (await call(client, "get_entity", { entity_ref: colRef })).entity.name,
    "Сейчас",
  );

  // 3. dashboard_widget_update with punctuation + >32 chars applies cleanly and restores cleanly!
  const pWidgetNorm = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_update",
    target_ref: widgetRef,
    widget: {
      type: "characteristic",
      name: dottedName,
      item_refs: [TEMP_CHAR_REF],
    },
    reason: "Переименовать виджет с точкой",
  });
  assert.equal(pWidgetNorm.status, "prepared");
  assert.ok(
    pWidgetNorm.warnings?.some((message) =>
      message.includes(expectedDottedStored),
    ),
  );
  const aWidgetNorm = await call(client, "apply_native_change", {
    change_ref: pWidgetNorm.change_ref,
  });
  assert.equal(
    aWidgetNorm.status,
    "applied",
    "hub-normalized dashboard_widget_update must settle as applied, not false conflict",
  );
  assert.deepEqual(aWidgetNorm.hub_normalized_name, {
    requested: dottedName,
    stored: expectedDottedStored,
  });
  assert.equal(aWidgetNorm.verification?.result, "requested_widget_observed");
  const gWidgetNorm = await call(client, "get_native_change", {
    change_ref: pWidgetNorm.change_ref,
  });
  assert.equal(gWidgetNorm.status, "applied");
  assert.equal(gWidgetNorm.verification?.result, "applied_widget_observed");
  const rWidgetNorm = await call(client, "restore_native_change", {
    change_ref: pWidgetNorm.change_ref,
  });
  assert.equal(rWidgetNorm.status, "restored");
  assert.equal(
    (await call(client, "get_entity", { entity_ref: widgetRef })).entity.name,
    "Обогреватель",
  );

  // 4. dashboard_create / dashboard_column_create / dashboard_widget_create:
  //    record hub_normalized_name on apply AND match normalized names in recordUnknown*Create!
  const pCreateNorm = await call(client, "prepare_native_change", {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Климат · гостиная",
    column_names: ["Датчики · сейчас"],
    reason: "Создание панели с нормализацией имени",
  });
  assert.ok(pCreateNorm.warnings?.length >= 2);
  const aCreateNorm = await call(client, "apply_native_change", {
    change_ref: pCreateNorm.change_ref,
  });
  assert.equal(aCreateNorm.status, "applied");
  assert.deepEqual(aCreateNorm.hub_normalized_name, {
    requested: "Климат · гостиная",
    stored: "Климат  гостиная",
  });

  const pLostNormCreate = await call(client, "prepare_native_change", {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Потеря · тест",
    column_names: [],
    reason: "Потерянный ответ при нормализации",
  });
  hub.state.faults.droppedReply.push({
    method: "dashboard.create",
    remaining: 1,
  });
  const aLostNormCreate = await call(client, "apply_native_change", {
    change_ref: pLostNormCreate.change_ref,
  });
  assert.equal(aLostNormCreate.status, "uncertain");
  assert.equal(aLostNormCreate.candidate_dashboards?.length, 1);
  assert.equal(aLostNormCreate.candidate_dashboards[0].name, "Потеря  тест");

  const pLostNormWidget = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: { type: "clock", name: "Часы · спальня" },
    reason: "Потерянный ответ создания виджета с нормализацией",
  });
  hub.state.faults.droppedReply.push({
    method: "dashboardWidget.create",
    remaining: 1,
  });
  const aLostNormWidget = await call(client, "apply_native_change", {
    change_ref: pLostNormWidget.change_ref,
  });
  assert.equal(aLostNormWidget.status, "uncertain");
  assert.equal(aLostNormWidget.candidate_widgets?.length, 1);
  assert.equal(aLostNormWidget.candidate_widgets[0].name, "Часы  спальня");

  // 5. Required name consisting ONLY of stripped punctuation ("···") is rejected cleanly on prepare!
  for (const invalidArgs of [
    {
      operation: "dashboard_create",
      target_ref: HOME_REF,
      name: "···",
      reason: "Пустое после очистки имя панели",
    },
    {
      operation: "dashboard_create",
      target_ref: HOME_REF,
      name: "Обычная",
      column_names: ["Основная", "···"],
      reason: "Пустое после очистки имя колонки",
    },
    {
      operation: "dashboard_update",
      target_ref: dashRef,
      name: "···",
      reason: "Пустое после очистки обновление панели",
    },
    {
      operation: "dashboard_column_update",
      target_ref: colRef,
      name: "···",
      reason: "Пустое после очистки обновление колонки",
    },
  ]) {
    const err = await callError(client, "prepare_native_change", invalidArgs);
    assert.equal(err.error.code, "invalid_native_value");
    assert.ok(err.contract !== undefined, "should include inline contract");
  }
  // Optional widget.name and column create name: "···" warns without rejecting, "" has no warning.
  const pOptWarn = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: { type: "clock", name: "···" },
    reason: "Необязательное имя из пунктуации",
  });
  assert.equal(pOptWarn.status, "prepared");
  assert.ok(pOptWarn.warnings?.length >= 1);
  const pOptEmpty = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: { type: "clock", name: "" },
    reason: "Явно пустое имя виджета",
  });
  assert.equal(pOptEmpty.status, "prepared");
  assert.equal(pOptEmpty.warnings, undefined);
  assert.equal(pOptEmpty.warning, undefined);

  // 6. Real concurrent third-party rename during apply MUST STILL return conflict (*_changed_since)!
  const pThirdPartyDash = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: dashRef,
    name: "Энергия · новая",
    reason: "Конкурентное переименование панели",
  });
  let sawDashUpdate = false;
  hooks.onRequest = (request) => {
    if (request.method === "dashboard.update") {
      sawDashUpdate = true;
      return;
    }
    if (sawDashUpdate && request.method === "dashboard.get") {
      const liveDash = hub.state.dashboards.find((d) => d.id === dashId);
      if (liveDash) liveDash.name = "Чужое имя";
      hooks.onRequest = undefined;
    }
  };
  const aThirdPartyDash = await call(client, "apply_native_change", {
    change_ref: pThirdPartyDash.change_ref,
  });
  assert.equal(aThirdPartyDash.status, "conflict");
  assert.equal(aThirdPartyDash.conflict_reason, "dashboard_changed_since");

  const pThirdPartyWidget = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_update",
    target_ref: widgetRef,
    widget: {
      type: "characteristic",
      name: "Обогреватель · зал",
      item_refs: [TEMP_CHAR_REF],
    },
    reason: "Конкурентное переименование виджета",
  });
  let sawWidgetUpdate = false;
  hooks.onRequest = (request) => {
    if (request.method === "dashboardWidget.update") {
      sawWidgetUpdate = true;
      return;
    }
    if (sawWidgetUpdate && request.method === "dashboardWidget.get") {
      const liveDash = hub.state.dashboards.find((d) => d.id === dashId);
      const liveWidget = liveDash?.columns
        .flatMap((c) => c.widgets)
        .find((w) => w.id === widgetId);
      if (liveWidget) liveWidget.name = "Чужой виджет";
      hooks.onRequest = undefined;
    }
  };
  const aThirdPartyWidget = await call(client, "apply_native_change", {
    change_ref: pThirdPartyWidget.change_ref,
  });
  assert.equal(aThirdPartyWidget.status, "conflict");
  assert.equal(aThirdPartyWidget.conflict_reason, "widget_changed_since");

  // 7. Uncertain write timeout (loseNext) when hub still holds previous MUST stay uncertain, NEVER applied!
  //    Even when requested name normalizes to the SAME string as previous ("Чужое имя · " -> "Чужое имя")!
  const pLoseSameNorm = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: dashRef,
    name: "Чужое имя · ",
    reason: "Таймаут записи при совпадении нормализованного имени с прежним",
  });
  hub.loseNext("dashboard.update");
  const aLoseSameNorm = await call(client, "apply_native_change", {
    change_ref: pLoseSameNorm.change_ref,
  });
  assert.equal(
    aLoseSameNorm.status,
    "uncertain",
    "uncertain write whose readback still equals previous must NEVER claim applied",
  );
  const gLoseSameNorm = await call(client, "get_native_change", {
    change_ref: pLoseSameNorm.change_ref,
  });
  assert.equal(gLoseSameNorm.status, "uncertain");

  // Whereas droppedReply on a genuinely NEW normalized name DOES recover to applied!
  const pDropNewNorm = await call(client, "prepare_native_change", {
    operation: "dashboard_update",
    target_ref: dashRef,
    name: "Энергия · дом",
    reason: "Потерянный ответ при новом нормализованном имени",
  });
  hub.state.faults.droppedReply.push({
    method: "dashboard.update",
    remaining: 1,
  });
  const aDropNewNorm = await call(client, "apply_native_change", {
    change_ref: pDropNewNorm.change_ref,
  });
  const settledDropNewNorm =
    aDropNewNorm.status === "applied"
      ? aDropNewNorm
      : await call(client, "get_native_change", {
          change_ref: pDropNewNorm.change_ref,
        });
  assert.equal(settledDropNewNorm.status, "applied");
  assert.equal(settledDropNewNorm.recovered_after_uncertain_write, true);
  assert.deepEqual(settledDropNewNorm.hub_normalized_name, {
    requested: "Энергия · дом",
    stored: "Энергия  дом",
  });

  // 8. Renaming away from a hub-stored double-spaced name ("Энергия  дом") and restoring
  //    settles as restored even though hub collapses the double space on restore write!
  const { applied: awayFromDoubleSpace } = await prepareAndApply(client, {
    operation: "dashboard_update",
    target_ref: dashRef,
    name: "Энергия кратко",
    reason: "Переименовать после имени с двойным пробелом",
  });
  const restoredDoubleSpace = await call(client, "restore_native_change", {
    change_ref: awayFromDoubleSpace.change_ref,
  });
  assert.equal(restoredDoubleSpace.status, "restored");
  assert.equal(
    (await call(client, "get_entity", { entity_ref: dashRef })).entity.name,
    "Энергия дом",
  );
});

test("characteristic widget warns on duplicate characteristic_type across >=2 devices, stays silent on same device or distinct types, and strengthens History warning", async (t) => {
  const { client } = await setup(t, (fixture) => {
    fixture.accessories.push(
      {
        id: 46,
        roomId: 3,
        name: "Розетка обогревателя",
        services: [
          {
            sId: 13,
            type: "Outlet",
            name: "Розетка",
            characteristics: [
              { cId: 14, type: "On", value: true },
              { cId: 15, type: "C_Watt", value: 1200 },
              { cId: 16, type: "C_KiloWattHour", value: 42.5 },
            ],
          },
        ],
      },
      {
        id: 47,
        roomId: 4,
        name: "Розетка посудомойки",
        services: [
          {
            sId: 13,
            type: "Outlet",
            name: "Розетка",
            characteristics: [
              { cId: 14, type: "On", value: true },
              { cId: 15, type: "C_Watt", value: 850 },
              { cId: 16, type: "C_KiloWattHour", value: 18.2 },
            ],
          },
        ],
      },
    );
  });

  const OUTLET1_WATT = `${HOME_REF}/accessory/46/service/13/characteristic/15`;
  const OUTLET1_KWH = `${HOME_REF}/accessory/46/service/13/characteristic/16`;
  const OUTLET2_WATT = `${HOME_REF}/accessory/47/service/13/characteristic/15`;

  const { applied: dash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Энергия",
    reason: "Панель энергии",
  });
  const colRef = dash.created_columns[0].ref;

  // 1. Same characteristic_type (C_Watt) across 2 different accessories -> clear non-blocking warning!
  const pDupCreate = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: {
      type: "characteristic",
      name: "Мощность",
      item_refs: [OUTLET1_WATT, OUTLET2_WATT],
    },
    reason: "Показать мощность двух розеток",
  });
  assert.equal(pDupCreate.status, "prepared");
  assert.ok(
    Array.isArray(pDupCreate.warnings) && pDupCreate.warnings.length >= 1,
  );
  assert.equal(typeof pDupCreate.warning, "string");
  assert.ok(
    pDupCreate.warnings.some((message) => message.includes("C_Watt")),
    `warning must name repeated type C_Watt: ${JSON.stringify(pDupCreate.warnings)}`,
  );

  // 2. Same accessory with different characteristic types (C_Watt + C_KiloWattHour) -> NO warning!
  const pSameDevice = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: {
      type: "characteristic",
      name: "Гостиная обогреватель",
      item_refs: [OUTLET1_WATT, OUTLET1_KWH],
    },
    reason: "Метрики одной розетки",
  });
  assert.equal(pSameDevice.status, "prepared");
  assert.equal(pSameDevice.warnings, undefined);
  assert.equal(pSameDevice.warning, undefined);
  const aSameDevice = await call(client, "apply_native_change", {
    change_ref: pSameDevice.change_ref,
  });
  assert.equal(aSameDevice.status, "applied");

  // 3. Different accessories with distinct characteristic types -> NO warning!
  const pDistinct = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: {
      type: "characteristic",
      name: "Сводка",
      item_refs: [OUTLET1_WATT, TEMP_CHAR_REF],
    },
    reason: "Разные типы характеристик",
  });
  assert.equal(pDistinct.status, "prepared");
  assert.equal(pDistinct.warnings, undefined);
  assert.equal(pDistinct.warning, undefined);

  // 4. dashboard_widget_update adding a second device's C_Watt -> triggers duplicate-type warning!
  const pDupUpdate = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_update",
    target_ref: aSameDevice.created_widget_ref,
    widget: {
      type: "characteristic",
      name: "Все розетки",
      item_refs: [OUTLET1_WATT, OUTLET2_WATT],
    },
    reason: "Добавить вторую розетку",
  });
  assert.equal(pDupUpdate.status, "prepared");
  assert.ok(pDupUpdate.warnings?.some((message) => message.includes("C_Watt")));

  // 5. Strengthened HISTORY_MISSING_WARNING advises against empty chart placeholders and notes microSD/USB.
  const pChartMissing = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_create",
    target_ref: colRef,
    widget: {
      type: "chart",
      name: "График мощности",
      item_refs: [OUTLET1_WATT, OUTLET2_WATT],
      history_group: "HOUR",
    },
    reason: "График без приложения История",
  });
  assert.equal(pChartMissing.history_app_missing, true);
  assert.equal(pChartMissing.warnings?.length, 1);
  assert.match(pChartMissing.warning, /microSD|USB/i);
  assert.match(pChartMissing.warning, /characteristic/i);
  assert.match(pChartMissing.warning, /placeholder|empty|by default/i);
});

test("dashboard_widget_move: cross-column move, intra-column reorder, emptying column, validation, conflict, uncertain recovery, history, and restore", async (t) => {
  const { hub, client } = await setup(t);

  // Create two dashboards: primary with 3 columns (3rd stays unrelated for history filter test) and secondary for cross-dashboard rejection.
  const { applied: dash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Главная",
    column_names: ["Сейчас", "Детали", "Справка"],
    reason: "Дашборд для проверки перемещения виджетов",
  });
  const { applied: otherDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Другая",
    column_names: ["Колонка"],
    reason: "Вторая панель для проверки запрета переноса между панелями",
  });
  const dashRef = dash.created_dashboard_ref;
  const dashId = Number(dashRef.split("/").at(-1));
  const col1Ref = dash.created_columns[0].ref;
  const col2Ref = dash.created_columns[1].ref;
  const col3Ref = dash.created_columns[2].ref;
  const col1Id = dash.created_columns[0].id;
  const col2Id = dash.created_columns[1].id;

  const { applied: w1 } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: col1Ref,
    widget: { type: "clock", name: "Часы" },
    reason: "W1",
  });
  const { applied: w2 } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: col1Ref,
    widget: { type: "weather", name: "Погода" },
    reason: "W2",
  });
  const { applied: w3 } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: col1Ref,
    widget: { type: "tile", name: "Плитка" },
    reason: "W3",
  });
  const { applied: w4 } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: col2Ref,
    widget: {
      type: "characteristic",
      name: "Температура",
      item_refs: [TEMP_CHAR_REF],
    },
    reason: "W4",
  });
  const w1Ref = w1.created_widget_ref;
  const w2Ref = w2.created_widget_ref;
  const w3Ref = w3.created_widget_ref;
  const w4Ref = w4.created_widget_ref;

  // Warm HomeState so we can also assert HomeState neutrality for dashboardWidget.orders!
  hub.restEvent();
  await call(client, "find_devices", { query: "торшер" });
  const wholeReadsBefore = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;

  // 1. Cross-column move with omitted position -> defaults to end of destination column!
  const ordersBefore = hub.requests.filter(
    ({ method }) => method === "dashboardWidget.orders",
  ).length;
  const pMove1 = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w1Ref,
    column_ref: col2Ref,
    reason: "Перенести часы в конец колонки Детали",
  });
  assert.equal(pMove1.status, "prepared");
  assert.equal(pMove1.dashboard_ref, dashRef);
  assert.equal(pMove1.source_column_ref, col1Ref);
  assert.equal(pMove1.column_ref, col2Ref);
  assert.deepEqual(pMove1.diff, {
    from: { column_ref: col1Ref, column_name: "Сейчас", position: 0 },
    to: { column_ref: col2Ref, column_name: "Детали", position: 1 },
  });
  const aMove1 = await call(client, "apply_native_change", {
    change_ref: pMove1.change_ref,
  });
  assert.equal(aMove1.status, "applied");
  assert.equal(aMove1.restore_supported, true);
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboardWidget.orders")
      .length,
    ordersBefore + 1,
    "cross-column move must execute in ONE dashboardWidget.orders RPC",
  );
  let stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(
    stateDash.columns[0].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w2Ref, order: 0 },
      { ref: w3Ref, order: 1 },
    ],
  );
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w4Ref, order: 0 },
      { ref: w1Ref, order: 1 },
    ],
  );

  // Verify HomeState neutrality after dashboard_widget_move!
  await call(client, "find_devices", { query: "торшер" });
  assert.equal(
    hub.requests.filter(
      ({ method }) => method === "accessory.list" || method === "room.list",
    ).length,
    wholeReadsBefore,
    "dashboard_widget_move must NOT invalidate warm HomeState",
  );

  // 2. Cross-column move with explicit position 0 (start of destination column).
  const { applied: aMove2 } = await prepareAndApply(client, {
    operation: "dashboard_widget_move",
    target_ref: w3Ref,
    column_ref: col2Ref,
    position: 0,
    reason: "Перенести плитку в начало Деталей",
  });
  stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(
    stateDash.columns[0].widgets.map(({ ref, order }) => ({ ref, order })),
    [{ ref: w2Ref, order: 0 }],
  );
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w3Ref, order: 0 },
      { ref: w4Ref, order: 1 },
      { ref: w1Ref, order: 2 },
    ],
  );

  // 3. Emptying a column (moving last widget w2 out of col1 into col2 at position 1) + restore!
  const { applied: aEmptyMove } = await prepareAndApply(client, {
    operation: "dashboard_widget_move",
    target_ref: w2Ref,
    column_ref: col2Ref,
    position: 1,
    reason: "Опустошить первую колонку",
  });
  stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(stateDash.columns[0].widgets, []);
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w3Ref, order: 0 },
      { ref: w2Ref, order: 1 },
      { ref: w4Ref, order: 2 },
      { ref: w1Ref, order: 3 },
    ],
  );
  const undoEmpty = await call(client, "restore_native_change", {
    change_ref: aEmptyMove.change_ref,
  });
  assert.equal(undoEmpty.status, "restored");
  stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(
    stateDash.columns[0].widgets.map(({ ref, order }) => ({ ref, order })),
    [{ ref: w2Ref, order: 0 }],
  );
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w3Ref, order: 0 },
      { ref: w4Ref, order: 1 },
      { ref: w1Ref, order: 2 },
    ],
  );

  // 4. Intra-column reorder (w1 from pos 2 -> pos 0, omitting column_ref) + restore!
  const { applied: aReorder } = await prepareAndApply(client, {
    operation: "dashboard_widget_move",
    target_ref: w1Ref,
    position: 0,
    reason: "Поднять часы наверх в Деталях",
  });
  assert.equal(aReorder.source_column_ref, col2Ref);
  assert.equal(aReorder.column_ref, col2Ref);
  stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w1Ref, order: 0 },
      { ref: w3Ref, order: 1 },
      { ref: w4Ref, order: 2 },
    ],
  );
  const undoReorder = await call(client, "restore_native_change", {
    change_ref: aReorder.change_ref,
  });
  assert.equal(undoReorder.status, "restored");
  stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w3Ref, order: 0 },
      { ref: w4Ref, order: 1 },
      { ref: w1Ref, order: 2 },
    ],
  );

  // 5. already_desired when already at requested column & position with contiguous orders.
  const alreadyMove = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w3Ref,
    column_ref: col2Ref,
    position: 0,
    reason: "Уже на месте",
  });
  assert.equal(alreadyMove.status, "already_desired");
  assert.equal(alreadyMove.operation, "dashboard_widget_move");
  assert.equal(alreadyMove.column_ref, col2Ref);
  assert.equal(alreadyMove.position, 0);

  // 6. Validation errors (cross-dashboard, out-of-range position, same-column without position, unexpected fields).
  const crossDashErr = await callError(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w3Ref,
    column_ref: otherDash.created_columns[0].ref,
    reason: "Перенос в чужой дашборд",
  });
  assert.equal(crossDashErr.error.code, "invalid_native_value");
  assert.ok(crossDashErr.contract !== undefined);

  const outOfRangeErr = await callError(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w3Ref,
    position: 3, // col2 has 3 widgets -> valid intra-column positions are 0..2
    reason: "Позиция за пределами колонки",
  });
  assert.equal(outOfRangeErr.error.code, "invalid_native_value");
  assert.match(outOfRangeErr.error.message, /0.*2/);
  assert.ok(outOfRangeErr.contract !== undefined);

  const missingPosSameColErr = await callError(
    client,
    "prepare_native_change",
    {
      operation: "dashboard_widget_move",
      target_ref: w3Ref,
      reason: "Без позиции в той же колонке",
    },
  );
  assert.equal(missingPosSameColErr.error.code, "invalid_native_change");
  assert.ok(missingPosSameColErr.contract !== undefined);

  const missingPosExplicitSameColErr = await callError(
    client,
    "prepare_native_change",
    {
      operation: "dashboard_widget_move",
      target_ref: w3Ref,
      column_ref: col2Ref,
      reason: "Та же колонка без позиции",
    },
  );
  assert.equal(
    missingPosExplicitSameColErr.error.code,
    "invalid_native_change",
  );

  const unexpectedFieldErr = await callError(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w3Ref,
    position: 1,
    name: "Неожиданное имя",
    reason: "Лишнее поле",
  });
  assert.equal(unexpectedFieldErr.error.code, "invalid_native_change");

  // 7. Read-only get_native_change stability: does NOT bump updated_at on settled move!
  const histBefore = await call(client, "get_native_change", {
    entity_ref: dashRef,
    limit: 50,
  });
  const move2EntryBefore = histBefore.changes.find(
    ({ change_ref }) => change_ref === aMove2.change_ref,
  );
  assert.ok(move2EntryBefore);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const inspectedMove2 = await call(client, "get_native_change", {
    change_ref: aMove2.change_ref,
  });
  assert.equal(inspectedMove2.status, "applied");
  assert.equal(inspectedMove2.verification?.result, "applied_layout_observed");
  const histAfter = await call(client, "get_native_change", {
    entity_ref: dashRef,
    limit: 50,
  });
  const move2EntryAfter = histAfter.changes.find(
    ({ change_ref }) => change_ref === aMove2.change_ref,
  );
  assert.equal(
    move2EntryAfter.updated_at,
    move2EntryBefore.updated_at,
    "read-only get_native_change on applied move must not bump updated_at",
  );

  // 8. History filtering matches dashboard_ref, widget_ref, source_column_ref, and dest column_ref (and NOT col3).
  for (const filterRef of [dashRef, w1Ref, col1Ref, col2Ref]) {
    const filtered = await call(client, "get_native_change", {
      entity_ref: filterRef,
      limit: 50,
    });
    assert.ok(
      filtered.changes.some(
        ({ change_ref }) => change_ref === aMove1.change_ref,
      ),
      `history filter ${filterRef} must match move1`,
    );
  }
  const col3History = await call(client, "get_native_change", {
    entity_ref: col3Ref,
    limit: 50,
  });
  assert.equal(
    col3History.changes.some(
      ({ change_ref }) => change_ref === aMove1.change_ref,
    ),
    false,
    "unrelated column 3 must NOT match move1",
  );

  // 9. Refusal on restore when a later layout change intervened (later_owned_change), then undo newest-first!
  const refuseEarlierMove = await call(client, "restore_native_change", {
    change_ref: aMove1.change_ref,
  });
  assert.equal(refuseEarlierMove.status, "conflict");
  assert.equal(refuseEarlierMove.conflict_reason, "later_owned_change");
  assert.equal(refuseEarlierMove.restore_first_change_ref, aMove2.change_ref);
  // Restore move2 first, then move1 -> full original layout restored!
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: aMove2.change_ref,
      })
    ).status,
    "restored",
  );
  assert.equal(
    (
      await call(client, "restore_native_change", {
        change_ref: aMove1.change_ref,
      })
    ).status,
    "restored",
  );
  stateDash = (await call(client, "get_entity", { entity_ref: dashRef }))
    .entity;
  assert.deepEqual(
    stateDash.columns[0].widgets.map(({ ref, order }) => ({ ref, order })),
    [
      { ref: w1Ref, order: 0 },
      { ref: w2Ref, order: 1 },
      { ref: w3Ref, order: 2 },
    ],
  );
  assert.deepEqual(
    stateDash.columns[1].widgets.map(({ ref, order }) => ({ ref, order })),
    [{ ref: w4Ref, order: 0 }],
  );

  // 10. Conflict on concurrent layout change between prepare and apply (0 orders RPCs sent!).
  const pDriftMove = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w1Ref,
    position: 2,
    reason: "Проверка конфликта раскладки",
  });
  const w1Id = Number(w1Ref.split("/").at(-1));
  const w2Id = Number(w2Ref.split("/").at(-1));
  const w3Id = Number(w3Ref.split("/").at(-1));
  hub.request({
    dashboardWidget: {
      orders: {
        orders: [
          { dashboardId: dashId, columnId: col1Id, id: w2Id, order: 0 },
          { dashboardId: dashId, columnId: col1Id, id: w1Id, order: 1 },
          { dashboardId: dashId, columnId: col1Id, id: w3Id, order: 2 },
        ],
      },
    },
  });
  const ordersBeforeDrift = hub.requests.filter(
    ({ method }) => method === "dashboardWidget.orders",
  ).length;
  const aDriftMove = await call(client, "apply_native_change", {
    change_ref: pDriftMove.change_ref,
  });
  assert.equal(aDriftMove.status, "conflict");
  assert.equal(aDriftMove.conflict_reason, "dashboard_layout_changed_since");
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboardWidget.orders")
      .length,
    ordersBeforeDrift,
    "drift conflict must send 0 dashboardWidget.orders RPCs",
  );

  // 11. Uncertain write recovery: droppedReply -> applied with recovered_after_uncertain_write;
  //     loseNext -> uncertain without blind resend on get_native_change!
  const pDropMove = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w3Ref,
    column_ref: col2Ref,
    reason: "Потерянный ответ перемещения",
  });
  hub.state.faults.droppedReply.push({
    method: "dashboardWidget.orders",
    remaining: 1,
  });
  const aDropMove = await call(client, "apply_native_change", {
    change_ref: pDropMove.change_ref,
  });
  const settledDropMove =
    aDropMove.status === "applied"
      ? aDropMove
      : await call(client, "get_native_change", {
          change_ref: pDropMove.change_ref,
        });
  assert.equal(settledDropMove.status, "applied");
  assert.equal(settledDropMove.recovered_after_uncertain_write, true);

  const pLoseMove = await call(client, "prepare_native_change", {
    operation: "dashboard_widget_move",
    target_ref: w2Ref,
    column_ref: col2Ref,
    reason: "Потерянный запрос перемещения",
  });
  const ordersBeforeLose = hub.requests.filter(
    ({ method }) => method === "dashboardWidget.orders",
  ).length;
  hub.loseNext("dashboardWidget.orders");
  const aLoseMove = await call(client, "apply_native_change", {
    change_ref: pLoseMove.change_ref,
  });
  assert.equal(aLoseMove.status, "uncertain");
  const checkedLoseMove = await call(client, "get_native_change", {
    change_ref: pLoseMove.change_ref,
  });
  assert.equal(checkedLoseMove.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboardWidget.orders")
      .length,
    ordersBeforeLose + 1,
    "lost dashboardWidget.orders request must NOT be resent blindly by get_native_change",
  );
  // Restore of unconfirmed move stays uncertain without writing:
  const restoreLoseMove = await call(client, "restore_native_change", {
    change_ref: pLoseMove.change_ref,
  });
  assert.equal(restoreLoseMove.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ method }) => method === "dashboardWidget.orders")
      .length,
    ordersBeforeLose + 1,
  );
  // Suppress unused variable warning for col2Id if any:
  assert.ok(col2Id > 0);
});

test("review return 1: interrupted restore retry on double-spaced baseline, refused-restore guards, 32-char trailing-space match, and control.key fallback", async (t) => {
  const hooks = {};
  const { hub, client } = await setup(
    t,
    (fixture) => {
      fixture.accessories.push(
        {
          id: 48,
          roomId: 3,
          name: "Счётчик 1",
          services: [
            {
              sId: 13,
              type: "Outlet",
              name: "Розетка",
              characteristics: [{ cId: 15, type: "C_Watt", value: 110 }],
            },
          ],
        },
        {
          id: 49,
          roomId: 4,
          name: "Счётчик 2",
          services: [
            {
              sId: 13,
              type: "Outlet",
              name: "Розетка",
              characteristics: [{ cId: 15, type: "C_Watt", value: 220 }],
            },
          ],
        },
      );
    },
    { onRequest: (request) => hooks.onRequest?.(request) },
  );

  // Strip control.type and set control.key on custom characteristics for accessories 48 & 49.
  for (const accessoryId of [48, 49]) {
    const acc = hub.state.accessories.find(({ id }) => id === accessoryId);
    const char = acc?.services?.[0]?.characteristics?.[0];
    assert.ok(char?.control);
    delete char.control.type;
    char.control.key = "CustomPower";
  }

  // 1. P1-A: Interrupted/uncertain restore retry on hub-normalized double-spaced baseline
  //    across dashboard_update, dashboard_column_update, and dashboard_widget_update.
  const { applied: normDash } = await prepareAndApply(client, {
    operation: "dashboard_create",
    target_ref: HOME_REF,
    name: "Энергия · дом",
    column_names: ["Свет · зал"],
    reason: "Панель с двойным пробелом после нормализации",
  });
  const normDashRef = normDash.created_dashboard_ref;
  const normDashId = Number(normDashRef.split("/").at(-1));
  const normColRef = normDash.created_columns[0].ref;
  const { applied: normWidget } = await prepareAndApply(client, {
    operation: "dashboard_widget_create",
    target_ref: normColRef,
    widget: { type: "clock", name: "Лампа · стол" },
    reason: "Виджет с двойным пробелом после нормализации",
  });
  const normWidgetRef = normWidget.created_widget_ref;

  await t.test(
    "P1-A: retrying interrupted restore on double-spaced baseline settles as restored",
    async () => {
      // 1a. dashboard_update
      const { applied: updDash } = await prepareAndApply(client, {
        operation: "dashboard_update",
        target_ref: normDashRef,
        name: "Энергия кратко",
        reason: "Временное переименование панели",
      });
      let dashRestoreSent = false;
      hub.state.faults.droppedReply.push({
        method: "dashboard.update",
        remaining: 1,
      });
      hooks.onRequest = (request) => {
        if (request.method === "dashboard.update") {
          dashRestoreSent = true;
          return;
        }
        if (dashRestoreSent && request.method === "dashboard.get") {
          hub.refuseNext("dashboard.get", {
            code: -32000,
            message: "transient",
          });
          hooks.onRequest = undefined;
        }
      };
      const uncertainDashRestore = await call(client, "restore_native_change", {
        change_ref: updDash.change_ref,
      });
      assert.equal(uncertainDashRestore.status, "uncertain");
      const retriedDashRestore = await call(client, "restore_native_change", {
        change_ref: updDash.change_ref,
      });
      assert.equal(
        retriedDashRestore.status,
        "restored",
        "retrying uncertain restore on double-spaced dashboard baseline must settle as restored",
      );
      assert.equal(retriedDashRestore.recovered_after_uncertain_write, true);

      // 1b. dashboard_column_update
      const { applied: updCol } = await prepareAndApply(client, {
        operation: "dashboard_column_update",
        target_ref: normColRef,
        name: "Свет кратко",
        reason: "Временное переименование колонки",
      });
      let colRestoreSent = false;
      hub.state.faults.droppedReply.push({
        method: "dashboardColumn.update",
        remaining: 1,
      });
      hooks.onRequest = (request) => {
        if (request.method === "dashboardColumn.update") {
          colRestoreSent = true;
          return;
        }
        if (colRestoreSent && request.method === "dashboard.get") {
          hub.refuseNext("dashboard.get", {
            code: -32000,
            message: "transient",
          });
          hooks.onRequest = undefined;
        }
      };
      const uncertainColRestore = await call(client, "restore_native_change", {
        change_ref: updCol.change_ref,
      });
      assert.equal(uncertainColRestore.status, "uncertain");
      const retriedColRestore = await call(client, "restore_native_change", {
        change_ref: updCol.change_ref,
      });
      assert.equal(
        retriedColRestore.status,
        "restored",
        "retrying uncertain restore on double-spaced column baseline must settle as restored",
      );
      assert.equal(retriedColRestore.recovered_after_uncertain_write, true);

      // 1c. dashboard_widget_update
      const { applied: updWidget } = await prepareAndApply(client, {
        operation: "dashboard_widget_update",
        target_ref: normWidgetRef,
        widget: { type: "clock", name: "Лампа кратко" },
        reason: "Временное переименование виджета",
      });
      let widgetRestoreSent = false;
      hub.state.faults.droppedReply.push({
        method: "dashboardWidget.update",
        remaining: 1,
      });
      hooks.onRequest = (request) => {
        if (request.method === "dashboardWidget.update") {
          widgetRestoreSent = true;
          return;
        }
        if (widgetRestoreSent && request.method === "dashboardWidget.get") {
          hub.refuseNext("dashboardWidget.get", {
            code: -32000,
            message: "transient",
          });
          hooks.onRequest = undefined;
        }
      };
      const uncertainWidgetRestore = await call(
        client,
        "restore_native_change",
        { change_ref: updWidget.change_ref },
      );
      assert.equal(uncertainWidgetRestore.status, "uncertain");
      const retriedWidgetRestore = await call(client, "restore_native_change", {
        change_ref: updWidget.change_ref,
      });
      assert.equal(
        retriedWidgetRestore.status,
        "restored",
        "retrying uncertain restore on double-spaced widget baseline must settle as restored",
      );
      assert.equal(retriedWidgetRestore.recovered_after_uncertain_write, true);
    },
  );

  // 2. P1-B: Refused restore leaves status="applied" with write_intent.direction="restore":
  //    must NEVER skip later_owned_change or falsely claim recovered_after_uncertain_write!
  await t.test(
    "P1-B: refused restore preserves later_owned_change and never falsely marks recovered_after_uncertain_write",
    async () => {
      const { applied: moveDash } = await prepareAndApply(client, {
        operation: "dashboard_create",
        target_ref: HOME_REF,
        name: "Отказ отката",
        column_names: ["Колонка 1", "Колонка 2"],
        reason: "Панель для теста refused restore",
      });
      const mDashId = Number(moveDash.created_dashboard_ref.split("/").at(-1));
      const mCol1Ref = moveDash.created_columns[0].ref;
      const mCol2Ref = moveDash.created_columns[1].ref;
      const mCol1Id = moveDash.created_columns[0].id;
      const { applied: mW1 } = await prepareAndApply(client, {
        operation: "dashboard_widget_create",
        target_ref: mCol1Ref,
        widget: { type: "clock", name: "Часы" },
        reason: "Виджет 1",
      });
      const { applied: mW2 } = await prepareAndApply(client, {
        operation: "dashboard_widget_create",
        target_ref: mCol1Ref,
        widget: { type: "weather", name: "Погода" },
        reason: "Виджет 2",
      });

      // 2a. Move W1 col1 -> col2 (M1), refuse restore(M1), apply M2 moving W1 back col2 -> col1 pos 0,
      //     then restore(M1) MUST return conflict: later_owned_change pointing to M2!
      const { applied: m1 } = await prepareAndApply(client, {
        operation: "dashboard_widget_move",
        target_ref: mW1.created_widget_ref,
        column_ref: mCol2Ref,
        reason: "M1: перенести часы во вторую колонку",
      });
      hub.refuseNext("dashboardWidget.orders", {
        code: -32000,
        message: "temporarily busy",
      });
      const refusedM1 = await callError(client, "restore_native_change", {
        change_ref: m1.change_ref,
      });
      assert.equal(refusedM1.hub_effect, "not_applied");
      const { applied: m2 } = await prepareAndApply(client, {
        operation: "dashboard_widget_move",
        target_ref: mW1.created_widget_ref,
        column_ref: mCol1Ref,
        position: 0,
        reason: "M2: вернуть часы в первую колонку",
      });
      const retryAfterLaterMove = await call(client, "restore_native_change", {
        change_ref: m1.change_ref,
      });
      assert.equal(
        retryAfterLaterMove.status,
        "conflict",
        "refused restore must NOT skip later_owned_change check on retry",
      );
      assert.equal(retryAfterLaterMove.conflict_reason, "later_owned_change");
      assert.equal(retryAfterLaterMove.restore_first_change_ref, m2.change_ref);
      assert.equal(
        retryAfterLaterMove.recovered_after_uncertain_write,
        undefined,
      );

      // 2b. Refused restore + manual revert to baseline must NOT set recovered_after_uncertain_write!
      const { applied: m3 } = await prepareAndApply(client, {
        operation: "dashboard_widget_move",
        target_ref: mW2.created_widget_ref,
        column_ref: mCol2Ref,
        reason: "M3: перенести погоду во вторую колонку",
      });
      hub.refuseNext("dashboardWidget.orders", {
        code: -32000,
        message: "refused",
      });
      const refusedM3 = await callError(client, "restore_native_change", {
        change_ref: m3.change_ref,
      });
      assert.equal(refusedM3.hub_effect, "not_applied");
      const mW1Id = Number(mW1.created_widget_ref.split("/").at(-1));
      const mW2Id = Number(mW2.created_widget_ref.split("/").at(-1));
      hub.request({
        dashboardWidget: {
          orders: {
            orders: [
              { dashboardId: mDashId, columnId: mCol1Id, id: mW1Id, order: 0 },
              { dashboardId: mDashId, columnId: mCol1Id, id: mW2Id, order: 1 },
            ],
          },
        },
      });
      const afterManualRevert = await call(client, "restore_native_change", {
        change_ref: m3.change_ref,
      });
      assert.equal(afterManualRevert.status, "restored");
      assert.equal(
        afterManualRevert.recovered_after_uncertain_write,
        undefined,
        "refused restore followed by manual revert must NOT falsely set recovered_after_uncertain_write",
      );

      // 2c. Refused restore on dashboard_create + manual deletion -> conflict: created_dashboard_missing!
      const { applied: dRefused } = await prepareAndApply(client, {
        operation: "dashboard_create",
        target_ref: HOME_REF,
        name: "Удалят вручную",
        column_names: [],
        reason: "Проверка refused restore на dashboard_create",
      });
      const dRefusedId = Number(
        dRefused.created_dashboard_ref.split("/").at(-1),
      );
      hub.refuseNext("dashboard.delete", { code: -32000, message: "refused" });
      await callError(client, "restore_native_change", {
        change_ref: dRefused.change_ref,
      });
      hub.request({ dashboard: { delete: { id: dRefusedId } } });
      const afterManualDelete = await call(client, "restore_native_change", {
        change_ref: dRefused.change_ref,
      });
      assert.equal(afterManualDelete.status, "conflict");
      assert.equal(
        afterManualDelete.conflict_reason,
        "created_dashboard_missing",
      );
      assert.equal(
        afterManualDelete.recovered_after_uncertain_write,
        undefined,
      );
    },
  );

  // 3. P2: Name whose 32nd surviving code point is a space (raw 32-char slice preserved by hub)
  //    reconciles cleanly as applied without false conflict!
  await t.test(
    "P2: raw 32-code-point truncation keeping trailing space reconciles as applied",
    async () => {
      const boundaryInput = "1234567890123456789012345678901 extra";
      const raw32WithTrailingSpace = "1234567890123456789012345678901 ";
      assert.equal([...raw32WithTrailingSpace].length, 32);
      const pBoundary = await call(client, "prepare_native_change", {
        operation: "dashboard_update",
        target_ref: normDashRef,
        name: boundaryInput,
        reason: "Проверка пробела на 32-й позиции обрезки",
      });
      let boundaryUpdated = false;
      hooks.onRequest = (request) => {
        if (request.method === "dashboard.update") {
          boundaryUpdated = true;
          return;
        }
        if (boundaryUpdated && request.method === "dashboard.get") {
          const liveDash = hub.state.dashboards.find(
            (d) => d.id === normDashId,
          );
          if (liveDash) liveDash.name = raw32WithTrailingSpace;
          hooks.onRequest = undefined;
        }
      };
      const aBoundary = await call(client, "apply_native_change", {
        change_ref: pBoundary.change_ref,
      });
      assert.equal(
        aBoundary.status,
        "applied",
        "raw 32-code-point cut keeping trailing space at char #32 must reconcile as applied",
      );
      assert.deepEqual(aBoundary.hub_normalized_name, {
        requested: boundaryInput,
        stored: raw32WithTrailingSpace,
      });
    },
  );

  // 4. P3: Custom characteristic with control.key (and no control.type) across 2 accessories
  //    triggers duplicate-characteristic warning naming CustomPower!
  await t.test(
    "P3: custom characteristic control.key fallback warns on duplicate across 2 accessories",
    async () => {
      const pKeyDup = await call(client, "prepare_native_change", {
        operation: "dashboard_widget_create",
        target_ref: normColRef,
        widget: {
          type: "characteristic",
          name: "Счётчики",
          item_refs: [
            `${HOME_REF}/accessory/48/service/13/characteristic/15`,
            `${HOME_REF}/accessory/49/service/13/characteristic/15`,
          ],
        },
        reason: "Проверка control.key fallback при дубле характеристик",
      });
      assert.equal(pKeyDup.status, "prepared");
      assert.ok(
        pKeyDup.warnings?.some((message) => message.includes("CustomPower")),
        `expected duplicate characteristic warning naming CustomPower: ${JSON.stringify(pKeyDup.warnings)}`,
      );
    },
  );
});
