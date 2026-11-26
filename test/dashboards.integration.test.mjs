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
// and all 9 prepare/apply/get/restore dashboard operations with 0 new tools.
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
  return { hub, client, connect };
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
  assert.equal(page2.next, undefined);

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
