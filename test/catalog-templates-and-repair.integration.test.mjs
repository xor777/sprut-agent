import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOME_REF = "spruthub://hub/sim-apartment-01";
const OTHER_HOME_REF = "spruthub://hub/other-home-99";
const ZIGBEE_EXT_KEY = "Controller:zigbee_1";
const ZIGBEE_CHILD_ID = "00158d0001repair";
const ZIGBEE_COORD_ID = "00124b0000000000";
const ZIGBEE_CHILD_WINDOW = `Controller/zigbee_1/Child/${ZIGBEE_CHILD_ID}/`;
const ZIGBEE_COORD_WINDOW = `Controller/zigbee_1/Child/${ZIGBEE_COORD_ID}/`;

const CATALOG_OPERATIONS = [
  "catalog_template_create",
  "catalog_template_update",
  "catalog_template_delete",
];

// Top-level schema keys of prepare_native_change at base SHA 33c15f7.
// Catalog operations MUST reuse target_ref, value, source, reason (0 new fields).
const EXPECTED_PREPARE_SCHEMA_KEYS = [
  "action_pointer",
  "active",
  "characteristic_types",
  "column_names",
  "column_ref",
  "data",
  "description",
  "duration_seconds",
  "member_service_refs",
  "name",
  "on_start",
  "operation",
  "option_key",
  "position",
  "reason",
  "room_ref",
  "source",
  "sync",
  "target_ref",
  "value",
  "widget",
];

function catalogRef(store, controller, file, home = HOME_REF) {
  return `${home}/catalog/${store}/${controller}/${encodeURIComponent(file)}`;
}

function windowRef(windowKey) {
  return `${HOME_REF}/window/${encodeURIComponent(windowKey)}`;
}

async function setup(t, { patchFixture, faults, onRequest, timeoutMs } = {}) {
  const fixture = await loadHomeFixture("apartment");
  fixture.extensions.push({
    extensionKey: ZIGBEE_EXT_KEY,
    type: "zigbee",
    index: "zigbee_1",
    bundleType: "CONTROLLER",
    name: "ZigBee 1",
    state: "LOADED",
    enabled: true,
    optionsWindow: "Controller/zigbee_1/",
    spaces: [],
    children: [
      {
        id: ZIGBEE_CHILD_ID,
        name: "Розетка Tuya TS011F",
        spaceKey: "main",
        online: true,
        status: "Работает",
        optionsWindow: ZIGBEE_CHILD_WINDOW,
      },
      {
        id: ZIGBEE_COORD_ID,
        name: "Координатор ZigBee",
        spaceKey: "main",
        online: true,
        status: "Работает",
        optionsWindow: ZIGBEE_COORD_WINDOW,
      },
    ],
  });
  patchFixture?.(fixture);
  const hub = await startSimulatedHub(fixture, { faults, onRequest });
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-catalog-repair-"),
  );
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: String(timeoutMs ?? ORDINARY_HUB_TIMEOUT_MS),
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "catalog-repair-test",
      version: "1.0.0",
    });
    await client.connect(transport);
    t.after(async () => {
      await client.close().catch(() => {});
    });
    return client;
  };
  const client = await connect();
  t.after(async () => {
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, connect, stateDirectory };
}

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} failed unexpectedly: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    true,
    `${name} unexpectedly succeeded: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

async function prepareAndApply(client, args) {
  const prepared = await callOk(client, "prepare_native_change", args);
  assert.equal(prepared.status, "prepared");
  const applied = await callOk(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  return { prepared, applied };
}

test("catalog read: home_overview list=catalog filters/pages, get_entity reads templates/parents/chunks, and HomeState stays neutral", async (t) => {
  const { hub, client } = await setup(t, {
    patchFixture: (fixture) => {
      fixture.catalog = {
        stores: ["MAIN", "INTERNAL"],
        controllers: ["sonoff", "xiaomi", "zigbee"],
        templates: [
          {
            active: true,
            store: "MAIN",
            controller: "zigbee",
            file: "/_Tuya/PollMetering.json",
            manufacturer: "Tuya",
            model: "PollMetering Base",
            availableServices: [{ type: "C_WattMeter", count: 1 }],
            catalogId: 100,
            write: false,
            template: JSON.stringify({
              manufacturer: "Tuya",
              model: "PollMetering Base",
              services: [{ type: "C_WattMeter" }],
            }),
          },
          {
            active: true,
            store: "MAIN",
            controller: "zigbee",
            file: "/Tuya/TS011F.json",
            manufacturer: "Tuya",
            model: "TS011F Smart Plug",
            manufacturerIds: ["_TZ3000_g5xawfcq"],
            modelIds: ["TS011F"],
            availableServices: [
              { type: "Outlet", count: 1 },
              { type: "C_WattMeter", count: 1 },
            ],
            catalogId: 101,
            write: false,
            deviceCount: 1,
            devices: [
              {
                extensionKey: ZIGBEE_EXT_KEY,
                id: ZIGBEE_CHILD_ID,
                name: "Розетка Tuya TS011F",
                online: true,
                paired: true,
                manufacturer: "_TZ3000_g5xawfcq",
                model: "TS011F",
              },
            ],
            accessories: [{ id: 16, name: "Торшер", roomId: 3, online: true }],
            template: JSON.stringify(
              {
                manufacturer: "Tuya",
                model: "TS011F Smart Plug",
                manufacturerIds: ["_TZ3000_g5xawfcq"],
                modelIds: ["TS011F"],
                template: "/_Tuya/PollMetering.json",
                services: [{ type: "Outlet" }],
              },
              null,
              2,
            ),
          },
          {
            active: true,
            store: "MAIN",
            controller: "xiaomi",
            file: "/Lumi/sensor_ht.json",
            manufacturer: "Xiaomi",
            model: "WSDCGQ01LM",
            manufacturerIds: ["LUMI"],
            modelIds: ["lumi.sensor_ht"],
            availableServices: [{ type: "TemperatureSensor", count: 1 }],
            catalogId: 201,
            write: false,
            template: JSON.stringify({
              manufacturer: "Xiaomi",
              model: "WSDCGQ01LM",
            }),
          },
          {
            active: true,
            store: "INTERNAL",
            controller: "zigbee",
            file: "/1.json",
            manufacturer: "Tuya Custom",
            model: "TS011F Custom",
            manufacturerIds: ["_TZ3000_custom01"],
            modelIds: ["TS011F"],
            availableServices: [{ type: "Outlet", count: 1 }],
            write: true,
            template: JSON.stringify(
              {
                manufacturer: "Tuya Custom",
                model: "TS011F Custom",
                manufacturerIds: ["_TZ3000_custom01"],
                modelIds: ["TS011F"],
                template: ["/_Tuya/PollMetering.json", "/Tuya/TS011F.json"],
                padding: "x".repeat(5_000),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  // Warm HomeState first to prove catalog reads do not invalidate or populate it.
  await callOk(client, "find_devices", { query: "торшер" });
  hub.restEvent();
  const wholeReadsBefore = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  assert.ok(wholeReadsBefore > 0);

  // 1. home_overview list=catalog without filters
  const allCatalog = await callOk(client, "home_overview", { list: "catalog" });
  assert.equal(allCatalog.list, "catalog");
  assert.equal(allCatalog.total, 4);
  assert.equal(allCatalog.catalog.length, 4);
  const ts011fItem = allCatalog.catalog.find(
    (entry) => entry.file === "/Tuya/TS011F.json",
  );
  assert.ok(ts011fItem);
  assert.equal(
    ts011fItem.ref,
    catalogRef("MAIN", "zigbee", "/Tuya/TS011F.json"),
  );
  assert.equal(ts011fItem.store, "MAIN");
  assert.equal(ts011fItem.controller, "zigbee");
  assert.equal(ts011fItem.active, true);
  assert.equal(ts011fItem.manufacturer, "Tuya");
  assert.equal(ts011fItem.model, "TS011F Smart Plug");
  assert.deepEqual(ts011fItem.manufacturer_ids, ["_TZ3000_g5xawfcq"]);
  assert.deepEqual(ts011fItem.model_ids, ["TS011F"]);
  assert.equal(ts011fItem.catalog_id, 101);
  assert.equal(ts011fItem.device_count, 1);
  assert.deepEqual(ts011fItem.available_services, [
    { type: "Outlet", count: 1 },
    { type: "C_WattMeter", count: 1 },
  ]);

  // 2. query passes as search to catalog.list; type filters by controller, store (case-insensitive), and store:controller
  const bySearch = await callOk(client, "home_overview", {
    list: "catalog",
    query: "TS011F",
  });
  assert.equal(bySearch.total, 2);
  assert.ok(
    hub.requests.some(
      (req) =>
        req.method === "catalog.list" &&
        req.params?.catalog?.list?.search === "TS011F",
    ),
    "query must be passed as search to catalog.list",
  );

  const byController = await callOk(client, "home_overview", {
    list: "catalog",
    type: "xiaomi",
  });
  assert.equal(byController.total, 1);
  assert.equal(byController.catalog[0].controller, "xiaomi");

  const byStore = await callOk(client, "home_overview", {
    list: "catalog",
    type: "internal",
  });
  assert.equal(byStore.total, 1);
  assert.equal(byStore.catalog[0].store, "INTERNAL");

  const byStoreAndController = await callOk(client, "home_overview", {
    list: "catalog",
    type: "INTERNAL:zigbee",
  });
  assert.equal(byStoreAndController.total, 1);
  assert.equal(byStoreAndController.catalog[0].file, "/1.json");

  const badType = await callError(client, "home_overview", {
    list: "catalog",
    type: "unknown_controller",
  });
  assert.equal(badType.error.code, "invalid_filter");

  // 3. Paging with limit & cursor
  const page1 = await callOk(client, "home_overview", {
    list: "catalog",
    limit: 2,
  });
  assert.equal(page1.returned, 2);
  assert.equal(page1.total, 4);
  assert.ok(page1.next?.arguments?.cursor);
  const page2 = await callOk(client, page1.next.tool, page1.next.arguments);
  assert.equal(page2.returned, 2);
  assert.equal(page2.next, null);

  // 4. get_entity on MAIN catalog ref returns referenced_templates, linked_devices, linked_accessories, writable=false
  const mainEntity = await callOk(client, "get_entity", {
    entity_ref: ts011fItem.ref,
  });
  assert.equal(mainEntity.entity.kind, "catalog_template");
  assert.equal(mainEntity.entity.ref, ts011fItem.ref);
  assert.equal(mainEntity.entity.store, "MAIN");
  assert.equal(mainEntity.entity.controller, "zigbee");
  assert.equal(mainEntity.entity.file, "/Tuya/TS011F.json");
  assert.equal(mainEntity.entity.active, true);
  assert.equal(mainEntity.entity.writable, false);
  assert.equal(mainEntity.entity.device_count, 1);
  assert.equal(mainEntity.entity.linked_devices.length, 1);
  assert.equal(mainEntity.entity.linked_accessories.length, 1);
  assert.deepEqual(mainEntity.entity.referenced_templates, [
    {
      file: "/_Tuya/PollMetering.json",
      main_ref: catalogRef("MAIN", "zigbee", "/_Tuya/PollMetering.json"),
      internal_ref: catalogRef(
        "INTERNAL",
        "zigbee",
        "/_Tuya/PollMetering.json",
      ),
    },
  ]);
  assert.ok(mainEntity.entity.template.includes("TS011F Smart Plug"));

  // 5. get_entity on large INTERNAL template respects max_bytes + pointer="/template" paging and lists array referenced_templates
  const largeRef = catalogRef("INTERNAL", "zigbee", "/1.json");
  const overviewLarge = await callOk(client, "get_entity", {
    entity_ref: largeRef,
    max_bytes: 2_048,
  });
  assert.equal(overviewLarge.representation.kind, "entity_overview");
  assert.equal(overviewLarge.identity.kind, "catalog_template");
  assert.equal(overviewLarge.identity.writable, true);
  const templatePart = overviewLarge.representation.available_parts.find(
    (part) => part.pointer === "/template",
  );
  assert.ok(templatePart, "large template must expose /template pointer");
  const chunk1 = await callOk(
    client,
    templatePart.next.tool,
    templatePart.next.arguments,
  );
  assert.equal(chunk1.selection.value.kind, "string_chunk");
  assert.equal(chunk1.selection.value.complete, false);
  assert.ok(chunk1.selection.next);
  const refsPart = await callOk(client, "get_entity", {
    entity_ref: largeRef,
    pointer: "/referenced_templates",
  });
  assert.equal(refsPart.selection.value.length, 2);
  assert.equal(refsPart.selection.value[0].file, "/_Tuya/PollMetering.json");
  assert.equal(refsPart.selection.value[1].file, "/Tuya/TS011F.json");

  // 6. Malformed or unsafe catalog refs are rejected
  for (const badRef of [
    `${HOME_REF}/catalog/BADSTORE/zigbee/%2F1.json`,
    `${HOME_REF}/catalog/INTERNAL/bad$ctrl/%2F1.json`,
    `${HOME_REF}/catalog/INTERNAL/zigbee/no-leading-slash.json`,
    `${HOME_REF}/catalog/INTERNAL/zigbee/%2F..%2Fetc%2Fpasswd`,
    `${HOME_REF}/catalog/INTERNAL/zigbee/%2Ffoo%2F..%2Fbar.json`,
    `${HOME_REF}/catalog/INTERNAL/zigbee/%2Fbad%00.json`,
    `${OTHER_HOME_REF}/catalog/INTERNAL/zigbee/%2F1.json`,
  ]) {
    const err = await callError(client, "get_entity", { entity_ref: badRef });
    assert.ok(
      [
        "invalid_entity_ref",
        "home_not_found",
        "unsupported_home_write",
      ].includes(err.error.code),
      `expected rejection for ${badRef}, got ${err.error.code}`,
    );
  }

  // 7. HomeState neutrality check after all catalog reads
  await callOk(client, "find_devices", { query: "торшер" });
  const wholeReadsAfter = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  assert.equal(
    wholeReadsAfter,
    wholeReadsBefore,
    "catalog reads must NOT invalidate warm HomeState",
  );
  assert.deepEqual(hub.writes(), []);
});

test("catalog write + undo lifecycle: create, update, delete, already_desired, overlap warning, linked-device confirmation, and HomeState neutrality", async (t) => {
  const { hub, client } = await setup(t);

  // Warm HomeState before catalog writes
  await callOk(client, "find_devices", { query: "торшер" });
  hub.restEvent();
  const wholeReadsBefore = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;

  // 1. Create valid INTERNAL template referencing existing MAIN base template + legitimate hex/IEEE and "key"/"token" fields
  const templateV1 = JSON.stringify(
    {
      manufacturer: "Tuya",
      model: "TS011F Meter",
      manufacturerIds: ["_TZ3000_newplug1"],
      modelIds: ["TS011F"],
      template: "/_Tuya/PollMetering.json",
      ieeeExample: "00158d0001a2b3c4",
      options: [
        { key: "PowerOnBehavior", value: "0x01" },
        { key: "token", value: "" },
      ],
      services: [{ type: "Outlet" }],
    },
    null,
    2,
  );
  const { prepared: pCreate, applied: aCreate } = await prepareAndApply(
    client,
    {
      operation: "catalog_template_create",
      target_ref: HOME_REF,
      value: "zigbee",
      source: templateV1,
      reason: "Добавить кастомный шаблон розетки TS011F",
    },
  );
  assert.equal(pCreate.warning, undefined);
  assert.equal(
    aCreate.created_catalog_ref,
    catalogRef("INTERNAL", "zigbee", "/1.json"),
  );
  assert.equal(aCreate.restore_supported, true);

  // Read back via get_entity: full unredacted JSON must be preserved (never "[REDACTED]")
  const createdEntity = await callOk(client, "get_entity", {
    entity_ref: aCreate.created_catalog_ref,
  });
  assert.equal(createdEntity.entity.writable, true);
  assert.equal(createdEntity.entity.active, true);
  assert.equal(createdEntity.entity.model, "TS011F Meter");
  assert.notEqual(createdEntity.entity.template, "[REDACTED]");
  assert.ok(createdEntity.entity.template.includes("00158d0001a2b3c4"));
  assert.ok(createdEntity.entity.template.includes("PowerOnBehavior"));
  assert.ok(createdEntity.entity.template.includes("TS011F Meter"));

  // 2. Creating another INTERNAL template overlapping manufacturerIds + modelIds returns non-blocking warning
  const pOverlap = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({
      manufacturer: "Tuya",
      model: "TS011F Duplicate",
      manufacturerIds: ["_TZ3000_newplug1"],
      modelIds: ["TS011F"],
    }),
    reason: "Проверить предупреждение о пересечении шаблонов",
  });
  assert.equal(pOverlap.status, "prepared");
  assert.equal(typeof pOverlap.warning, "string");
  assert.ok(pOverlap.next, "overlap warning must be non-blocking");

  // 3. catalog_template_update already_desired on semantically identical reformatted JSON
  const reformattedV1 = JSON.stringify(JSON.parse(templateV1));
  const alreadyDesired = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: aCreate.created_catalog_ref,
    source: reformattedV1,
    reason: "Проверка already_desired на эквивалентном JSON",
  });
  assert.equal(alreadyDesired.status, "already_desired");
  assert.equal(alreadyDesired.native_write_sent, false);

  // 4. catalog_template_update happy path + later_owned_change guard + undo chain
  const templateV2 = JSON.stringify(
    {
      manufacturer: "Tuya",
      model: "TS011F Meter v2",
      manufacturerIds: ["_TZ3000_newplug1"],
      modelIds: ["TS011F"],
      template: "/_Tuya/PollMetering.json",
      services: [{ type: "Outlet" }, { type: "C_WattMeter" }],
    },
    null,
    2,
  );
  const { applied: aUpdate } = await prepareAndApply(client, {
    operation: "catalog_template_update",
    target_ref: aCreate.created_catalog_ref,
    source: templateV2,
    reason: "Добавить ваттметр в кастомный шаблон",
  });
  assert.equal(aUpdate.restore_supported, true);
  assert.equal(
    (
      await callOk(client, "get_entity", {
        entity_ref: aCreate.created_catalog_ref,
      })
    ).entity.model,
    "TS011F Meter v2",
  );

  // Trying to undo create while update is still applied MUST conflict with later_owned_change!
  const createUndoBlocked = await callOk(client, "restore_native_change", {
    change_ref: aCreate.change_ref,
  });
  assert.equal(createUndoBlocked.status, "conflict");
  assert.equal(createUndoBlocked.conflict_reason, "later_owned_change");
  assert.equal(createUndoBlocked.restore_first_change_ref, aUpdate.change_ref);

  // Undo update -> restores templateV1
  const uUpdate = await callOk(client, "restore_native_change", {
    change_ref: aUpdate.change_ref,
  });
  assert.equal(uUpdate.status, "restored");
  assert.equal(
    (
      await callOk(client, "get_entity", {
        entity_ref: aCreate.created_catalog_ref,
      })
    ).entity.model,
    "TS011F Meter",
  );

  // 5. catalog_template_delete requires owner confirmation when devices/accessories are linked
  const liveEntry = hub.state.catalogs.find(
    (entry) => entry.store === "INTERNAL" && entry.file === "/1.json",
  );
  liveEntry.deviceCount = 1;
  liveEntry.devices = [
    {
      extensionKey: ZIGBEE_EXT_KEY,
      id: ZIGBEE_CHILD_ID,
      name: "Розетка Tuya TS011F",
      online: true,
      paired: true,
    },
  ];
  const pDeleteLinked = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_delete",
    target_ref: aCreate.created_catalog_ref,
    reason: "Удалить шаблон, к которому привязано устройство",
  });
  assert.equal(pDeleteLinked.status, "prepared");
  assert.equal(pDeleteLinked.requires_confirmation, true);
  assert.equal(typeof pDeleteLinked.tell_owner, "string");
  assert.equal(
    pDeleteLinked.next,
    undefined,
    "delete with linked devices must require owner confirmation via tell_owner (no next)",
  );

  // Apply confirmed delete -> verifies absent
  const aDelete = await callOk(client, "apply_native_change", {
    change_ref: pDeleteLinked.change_ref,
  });
  assert.equal(aDelete.status, "applied");
  const goneAfterDelete = await callError(client, "get_entity", {
    entity_ref: aCreate.created_catalog_ref,
  });
  assert.equal(goneAfterDelete.error.code, "entity_not_found");

  // 6. Undo catalog_template_delete recreates template in INTERNAL under a fresh /N.json file
  const uDelete = await callOk(client, "restore_native_change", {
    change_ref: aDelete.change_ref,
  });
  assert.equal(uDelete.status, "restored");
  assert.equal(
    uDelete.restored_catalog_ref,
    catalogRef("INTERNAL", "zigbee", "/2.json"),
  );
  const recreatedEntity = await callOk(client, "get_entity", {
    entity_ref: uDelete.restored_catalog_ref,
  });
  assert.equal(recreatedEntity.entity.active, true);
  assert.equal(recreatedEntity.entity.model, "TS011F Meter");

  // 7. Create + direct undo deletes created file and verifies absent
  const { applied: aTempCreate } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Temp", model: "DeleteMe" }),
    reason: "Временный шаблон для проверки отмены создания",
  });
  const uTempCreate = await callOk(client, "restore_native_change", {
    change_ref: aTempCreate.change_ref,
  });
  assert.equal(uTempCreate.status, "restored");
  const goneAfterCreateUndo = await callError(client, "get_entity", {
    entity_ref: aTempCreate.created_catalog_ref,
  });
  assert.equal(goneAfterCreateUndo.error.code, "entity_not_found");

  // 8. HomeState remained completely neutral across all catalog writes & restores
  await callOk(client, "find_devices", { query: "торшер" });
  const wholeReadsAfter = hub.requests.filter(
    ({ method }) => method === "accessory.list" || method === "room.list",
  ).length;
  assert.equal(
    wholeReadsAfter,
    wholeReadsBefore,
    "catalog writes and restores must NOT invalidate warm HomeState",
  );
});

test("catalog validation refuses MAIN/read-only writes, bad JSON/size/secrets/[REDACTED], unknown controller, and missing base template typos at prepare time", async (t) => {
  const { hub, client } = await setup(t);
  const mainRef = catalogRef("MAIN", "zigbee", "/Tuya/TS011F.json");

  // 1. MAIN store refused on update & delete
  const updMain = await callError(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: mainRef,
    source: JSON.stringify({ manufacturer: "Tuya" }),
    reason: "Попытка изменить MAIN шаблон",
  });
  assert.equal(updMain.error.code, "catalog_template_read_only");

  const delMain = await callError(client, "prepare_native_change", {
    operation: "catalog_template_delete",
    target_ref: mainRef,
    reason: "Попытка удалить MAIN шаблон",
  });
  assert.equal(delMain.error.code, "catalog_template_read_only");

  // 2. Read-only INTERNAL template (write: false) refused too
  hub.state.catalogs.push({
    active: true,
    store: "INTERNAL",
    controller: "zigbee",
    file: "/99.json",
    write: false,
    template: JSON.stringify({ manufacturer: "Locked" }),
    manufacturerIds: [],
    modelIds: [],
    availableServices: [],
    deviceCount: 0,
    devices: [],
    accessories: [],
  });
  const updLocked = await callError(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: catalogRef("INTERNAL", "zigbee", "/99.json"),
    source: JSON.stringify({ manufacturer: "Unlocked" }),
    reason: "Попытка изменить read-only INTERNAL шаблон",
  });
  assert.equal(updLocked.error.code, "catalog_template_read_only");

  // 3. Unknown controller refused (validated against catalog.types)
  const badCtrl = await callError(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "not_a_real_controller",
    source: JSON.stringify({ manufacturer: "Test" }),
    reason: "Неизвестный контроллер",
  });
  assert.equal(badCtrl.error.code, "invalid_native_value");
  assert.ok(
    badCtrl.contract,
    "caller field error must inline compact contract",
  );

  // 4. Invalid JSON, non-object JSON, oversized > 262144 bytes, [REDACTED], and secret-shaped strings refused
  const SECRET = "sk-ant-api03-supersecretcatalogvalue999999";
  const invalidSources = [
    ["malformed JSON", "{ not valid json"],
    ["array root", '["not", "an", "object"]'],
    ["null root", "null"],
    ["primitive root", '"just-a-string"'],
    [
      "oversized > 262144 bytes",
      JSON.stringify({ manufacturer: "Big", blob: "a".repeat(262_200) }),
    ],
    [
      "[REDACTED] mark",
      JSON.stringify({ manufacturer: "Tuya", note: "[REDACTED]" }),
    ],
    [
      "Bearer secret",
      JSON.stringify({ manufacturer: "Tuya", note: `Bearer ${SECRET}` }),
    ],
    [
      "password field secret",
      JSON.stringify({ manufacturer: "Tuya", password: SECRET }),
    ],
    [
      "bad base template path (no leading slash)",
      JSON.stringify({
        manufacturer: "Tuya",
        template: "_Tuya/PollMetering.json",
      }),
    ],
    [
      "bad base template path traversal",
      JSON.stringify({
        manufacturer: "Tuya",
        template: "/_Tuya/../secret.json",
      }),
    ],
  ];
  for (const [label, source] of invalidSources) {
    const err = await callError(client, "prepare_native_change", {
      operation: "catalog_template_create",
      target_ref: HOME_REF,
      value: "zigbee",
      source,
      reason: `Проверка отказа: ${label}`,
    });
    assert.equal(err.error.code, "invalid_native_value", label);
    assert.equal(
      JSON.stringify(err).includes(SECRET),
      false,
      `${label} must never leak secret`,
    );
  }

  // 5. Missing base template typo (e.g. /_Tuya/PollMeteringTypo.json) rejected at prepare time!
  const missingBase = await callError(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({
      manufacturer: "Tuya",
      model: "TS011F",
      template: "/_Tuya/PollMeteringTypo.json",
    }),
    reason: "Опечатка в пути базового шаблона",
  });
  assert.equal(missingBase.error.code, "referenced_template_not_found");
  assert.equal(missingBase.next?.tool, "home_overview");

  // 6. Wrong home serial refused
  const wrongHome = await callError(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: catalogRef("INTERNAL", "zigbee", "/1.json", OTHER_HOME_REF),
    source: JSON.stringify({ manufacturer: "Other" }),
    reason: "Чужой дом",
  });
  assert.equal(wrongHome.error.code, "unsupported_home_write");

  assert.deepEqual(hub.writes(), []);
});

test("catalog live hub quirk: active=false/error cleans up on create, rolls back on update, and degrades honestly if cleanup/rollback fails", async (t) => {
  const hooks = {};
  const { hub, client } = await setup(t, {
    onRequest: (req) => hooks.onRequest?.(req),
  });

  // 1. catalog.create returns active=false + error -> apply cleans up ghost file and marks rejected!
  const pBadCreate = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "BadSchemaField" }),
    reason: "Проверка очистки при active=false от хаба",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: неизвестное поле services[0]",
  });
  const rejectedCreate = await callOk(client, "apply_native_change", {
    change_ref: pBadCreate.change_ref,
  });
  assert.equal(rejectedCreate.status, "rejected");
  assert.match(rejectedCreate.hub_template_error, /Неправильный шаблон/);
  assert.equal(rejectedCreate.cleanup_confirmed, true);
  assert.equal(rejectedCreate.restore_supported, false);
  // Zero broken INTERNAL ghost files remain on hub!
  assert.equal(
    hub.state.catalogs.filter((c) => c.store === "INTERNAL").length,
    0,
    "broken active=false file must be cleaned up from the hub",
  );
  // History with applied_only=true excludes rejected create
  const appliedHistory = await callOk(client, "get_native_change", {
    applied_only: true,
  });
  assert.equal(
    appliedHistory.changes.some((c) => c.change_ref === pBadCreate.change_ref),
    false,
    "applied_only=true must skip rejected catalog changes",
  );

  // 2. catalog.create returns active=false + cleanup catalog.delete fails -> keeps honest status + created_catalog_ref + restore_supported=true!
  const pFailedCleanup = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "StuckBroken" }),
    reason: "Проверка честного статуса при сбое cleanup",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: неверный кластер",
  });
  hub.refuseNext("catalog.delete", { code: -32603, message: "disk busy" });
  const stuckCreate = await callOk(client, "apply_native_change", {
    change_ref: pFailedCleanup.change_ref,
  });
  assert.ok(
    ["applied", "uncertain"].includes(stuckCreate.status),
    `expected honest applied/uncertain, got ${stuckCreate.status}`,
  );
  assert.match(stuckCreate.hub_template_error, /неверный кластер/);
  assert.ok(stuckCreate.created_catalog_ref);
  assert.equal(stuckCreate.restore_supported, true);
  // Now restore_native_change cleanly deletes the stuck broken file!
  const cleanedViaRestore = await callOk(client, "restore_native_change", {
    change_ref: pFailedCleanup.change_ref,
  });
  assert.equal(cleanedViaRestore.status, "restored");
  assert.equal(
    hub.state.catalogs.filter((c) => c.store === "INTERNAL").length,
    0,
  );

  // 3. catalog.update returns active=false + error -> immediately rolls back to baseline and marks rejected!
  const baselineJson = JSON.stringify(
    {
      manufacturer: "Tuya",
      model: "WorkingBase",
      services: [{ type: "Outlet" }],
    },
    null,
    2,
  );
  const { applied: goodTemplate } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: baselineJson,
    reason: "Создать рабочий шаблон",
  });
  const pBadUpdate = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: goodTemplate.created_catalog_ref,
    source: JSON.stringify({ manufacturer: "Tuya", model: "BrokenUpdate" }),
    reason: "Обновление, которое хаб пометит active=false",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: сломанный конвертер",
  });
  const rejectedUpdate = await callOk(client, "apply_native_change", {
    change_ref: pBadUpdate.change_ref,
  });
  assert.equal(rejectedUpdate.status, "rejected");
  assert.match(rejectedUpdate.hub_template_error, /сломанный конвертер/);
  assert.equal(rejectedUpdate.rollback_confirmed, true);
  assert.equal(rejectedUpdate.restore_supported, false);
  // Live template on hub is confirmed back to WorkingBase and active=true!
  const afterRollback = await callOk(client, "get_entity", {
    entity_ref: goodTemplate.created_catalog_ref,
  });
  assert.equal(afterRollback.entity.active, true);
  assert.equal(afterRollback.entity.model, "WorkingBase");

  // 4. catalog.update rollback fails -> honest status + restore_supported=true so restore recovers baseline!
  const pRollbackFail = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: goodTemplate.created_catalog_ref,
    source: JSON.stringify({ manufacturer: "Tuya", model: "BrokenUpdate2" }),
    reason: "Обновление с отказом автоматического rollback",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: ошибка 2",
  });
  // Fail the second catalog.update (the rollback write)
  let updateCount = 0;
  hooks.onRequest = (req) => {
    if (req.method === "catalog.update") {
      updateCount += 1;
      if (updateCount === 2) {
        hub.refuseNext("catalog.update", {
          code: -32603,
          message: "temporary error",
        });
        hooks.onRequest = undefined;
      }
    }
  };
  const stuckUpdate = await callOk(client, "apply_native_change", {
    change_ref: pRollbackFail.change_ref,
  });
  hooks.onRequest = undefined;
  assert.ok(["applied", "uncertain"].includes(stuckUpdate.status));
  assert.match(stuckUpdate.hub_template_error, /ошибка 2/);
  assert.equal(stuckUpdate.restore_supported, true);
  const recoveredUpdate = await callOk(client, "restore_native_change", {
    change_ref: pRollbackFail.change_ref,
  });
  assert.equal(recoveredUpdate.status, "restored");
  const afterManualRestore = await callOk(client, "get_entity", {
    entity_ref: goodTemplate.created_catalog_ref,
  });
  assert.equal(afterManualRestore.entity.active, true);
  assert.equal(afterManualRestore.entity.model, "WorkingBase");
});

test("catalog lost ACK recovery, pre-write drift conflict, and pending restore intent guard prevent duplicates", async (t) => {
  const { hub, client } = await setup(t, { timeoutMs: 350 });

  // 1. Lost reply on catalog_template_create -> uncertain + candidate_templates, retry/get NEVER resends duplicate!
  const pLostCreate = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "LostAck", model: "Create1" }),
    reason: "Потеря ответа на catalog.create",
  });
  const createsBefore = hub.requests.filter(
    ({ method }) => method === "catalog.create",
  ).length;
  hub.state.faults.droppedReply.push({
    method: "catalog.create",
    remaining: 1,
  });
  const aLostCreate = await callOk(client, "apply_native_change", {
    change_ref: pLostCreate.change_ref,
  });
  assert.equal(aLostCreate.status, "uncertain");
  assert.equal(aLostCreate.candidate_templates?.length, 1);
  // Retrying apply and calling get_native_change MUST NOT resend catalog.create!
  await callOk(client, "get_native_change", {
    change_ref: pLostCreate.change_ref,
  });
  await callOk(client, "apply_native_change", {
    change_ref: pLostCreate.change_ref,
  });
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.create").length,
    createsBefore + 1,
    "lost catalog.create reply must NEVER be resent blindly",
  );

  // 2. Pre-write drift conflict on catalog_template_update & catalog_template_delete
  const { applied: tpl } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Drift", model: "V1" }),
    reason: "Шаблон для теста drift и lost ACK",
  });
  const pDriftUpd = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: tpl.created_catalog_ref,
    source: JSON.stringify({ manufacturer: "Drift", model: "V2" }),
    reason: "Обновление перед ручной правкой",
  });
  hub.request({
    catalog: {
      update: {
        store: "INTERNAL",
        controller: "zigbee",
        file: "/2.json",
        template: JSON.stringify({
          manufacturer: "Drift",
          model: "ManualEdit",
        }),
      },
    },
  });
  const driftConflict = await callOk(client, "apply_native_change", {
    change_ref: pDriftUpd.change_ref,
  });
  assert.equal(driftConflict.status, "conflict");
  assert.equal(driftConflict.native_write_sent, false);

  // 3. Lost reply on catalog_template_update reconciles to applied with recovered_after_uncertain_write
  const pLostUpd = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: tpl.created_catalog_ref,
    source: JSON.stringify({ manufacturer: "Drift", model: "AfterLostAck" }),
    reason: "Потеря ответа на catalog.update",
  });
  hub.state.faults.droppedReply.push({
    method: "catalog.update",
    remaining: 1,
  });
  const aLostUpd = await callOk(client, "apply_native_change", {
    change_ref: pLostUpd.change_ref,
  });
  const settledUpd =
    aLostUpd.status === "applied"
      ? aLostUpd
      : await callOk(client, "get_native_change", {
          change_ref: pLostUpd.change_ref,
        });
  assert.equal(settledUpd.status, "applied");
  assert.equal(settledUpd.recovered_after_uncertain_write, true);

  // 4. Lost reply on restore of catalog_template_update reconciles to restored via isPendingRestoreIntent
  hub.state.faults.droppedReply.push({
    method: "catalog.update",
    remaining: 1,
  });
  const rLostUpd = await callOk(client, "restore_native_change", {
    change_ref: pLostUpd.change_ref,
  });
  const settledRestoreUpd =
    rLostUpd.status === "restored"
      ? rLostUpd
      : await callOk(client, "get_native_change", {
          change_ref: pLostUpd.change_ref,
        });
  assert.equal(settledRestoreUpd.status, "restored");
  assert.equal(settledRestoreUpd.recovered_after_uncertain_write, true);

  // 5. Lost reply on catalog_template_delete reconciles to applied, and lost reply on its restore NEVER duplicates catalog.create
  const pLostDel = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_delete",
    target_ref: tpl.created_catalog_ref,
    reason: "Потеря ответа на catalog.delete",
  });
  hub.state.faults.droppedReply.push({
    method: "catalog.delete",
    remaining: 1,
  });
  const aLostDel = await callOk(client, "apply_native_change", {
    change_ref: pLostDel.change_ref,
  });
  assert.equal(aLostDel.status, "applied");
  assert.equal(aLostDel.recovered_after_uncertain_write, true);

  const createsBeforeDelRestore = hub.requests.filter(
    ({ method }) => method === "catalog.create",
  ).length;
  hub.state.faults.droppedReply.push({
    method: "catalog.create",
    remaining: 1,
  });
  const rLostDel = await callOk(client, "restore_native_change", {
    change_ref: pLostDel.change_ref,
  });
  assert.equal(rLostDel.status, "uncertain");
  assert.equal(rLostDel.candidate_templates?.length, 1);
  // Retrying restore_native_change must NOT send a duplicate catalog.create!
  const rLostDelRetry = await callOk(client, "restore_native_change", {
    change_ref: pLostDel.change_ref,
  });
  assert.equal(rLostDelRetry.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.create").length,
    createsBeforeDelRestore + 1,
    "lost catalog.create reply during delete undo must NEVER be resent blindly",
  );
});

test("ZigBee Repair («Переспарить») window_button: allows child Repair, protects coordinator, reads back honestly, refuses undo, and never resends on lost reply", async (t) => {
  const { hub, client } = await setup(t, { timeoutMs: 350 });
  const childWinRef = windowRef(ZIGBEE_CHILD_WINDOW);
  const coordWinRef = windowRef(ZIGBEE_COORD_WINDOW);

  // 1. get_entity on normal ZigBee child window exposes Repair as supported window_button (no confirmation)
  const childWin = await callOk(client, "get_entity", {
    entity_ref: childWinRef,
  });
  const repairCmd = childWin.entity.commands.find(
    ({ key }) => key === "Repair",
  );
  assert.ok(repairCmd, "ZigBee child window must expose Repair command");
  assert.deepEqual(repairCmd.native_change, {
    native_write: true,
    supported: true,
    operation: "window_button",
  });

  // 2. get_entity on ZigBee coordinator window MUST NOT offer native_change on Repair!
  const coordWin = await callOk(client, "get_entity", {
    entity_ref: coordWinRef,
  });
  const coordRepairCmd = coordWin.entity.commands.find(
    ({ key }) => key === "Repair",
  );
  assert.ok(coordRepairCmd);
  assert.equal(
    coordRepairCmd.native_change,
    undefined,
    "coordinator Repair must NOT expose native_change",
  );

  // 3. get_native_change_contract succeeds on child Repair (< 4096 B) and refuses coordinator
  const repairContract = await callOk(client, "get_native_change_contract", {
    operation: "window_button",
    target_ref: childWinRef,
    option_key: "Repair",
  });
  assert.equal(repairContract.contract.button.kind, "zigbee_repair");
  assert.equal(repairContract.contract.button.requires_confirmation, false);
  assert.ok(repairContract.contract.allowlist.zigbee_repair);
  assert.ok(
    Buffer.byteLength(JSON.stringify(repairContract.contract), "utf8") < 4_096,
  );

  const coordContractErr = await callError(
    client,
    "get_native_change_contract",
    {
      operation: "window_button",
      target_ref: coordWinRef,
      option_key: "Repair",
    },
  );
  assert.equal(coordContractErr.error.code, "zigbee_coordinator_protected");

  // 4. prepare_native_change refuses coordinator Repair with zigbee_coordinator_protected
  const coordPrepErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: coordWinRef,
    option_key: "Repair",
    reason: "Попытка переспарить координатор",
  });
  assert.equal(coordPrepErr.error.code, "zigbee_coordinator_protected");

  // 5. prepare_native_change refuses Repair on non-ZigBee child windows
  const xiaomiWinKey = "Controller/xiaomi_1/Child/mi_dev_1/";
  hub.state.windows[xiaomiWinKey] = {
    windowKey: xiaomiWinKey,
    label: { text: "Xiaomi Device" },
    options: [
      {
        key: "Repair",
        name: "Переспарить",
        inputType: "BUTTON",
        read: true,
        write: true,
        visible: true,
        disabled: false,
        value: { boolValue: false },
        type: "GenericBoolean",
        parent: "debug",
      },
    ],
  };
  const xiaomiRepairErr = await callError(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: windowRef(xiaomiWinKey),
    option_key: "Repair",
    reason: "Repair на не-ZigBee окне",
  });
  assert.equal(xiaomiRepairErr.error.code, "unsupported_window_button");
  assert.deepEqual(hub.writes(), []);

  // 6. Happy path: prepare + apply Repair on normal ZigBee child sends { boolValue: false }, reads back status, restore_supported=false
  const prepRepair = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: childWinRef,
    option_key: "Repair",
    reason: "Переспарить розетку после обновления шаблона",
  });
  assert.equal(prepRepair.status, "prepared");
  assert.equal(prepRepair.button.kind, "zigbee_repair");
  assert.equal(prepRepair.button.requires_confirmation, false);
  assert.equal(prepRepair.tell_owner, undefined);
  assert.ok(prepRepair.next);

  const appliedRepair = await callOk(client, "apply_native_change", {
    change_ref: prepRepair.change_ref,
  });
  assert.equal(appliedRepair.status, "applied");
  assert.equal(appliedRepair.native_write_sent, true);
  assert.equal(appliedRepair.native_acknowledged, true);
  assert.equal(appliedRepair.restore_supported, false);
  assert.equal(
    appliedRepair.observed_effect.window_status,
    "Переспаривание запущено",
  );
  assert.equal(appliedRepair.observed_effect.child_status, "Переспаривание");
  assert.equal(appliedRepair.verification.result, "zigbee_repair_observed");
  // Verify exact wire payload { boolValue: false }
  assert.equal(hub.state.repairedChildren.length, 1);
  assert.deepEqual(hub.state.repairedChildren[0].value, { boolValue: false });
  // Must NOT carry Telegram limitation text
  assert.equal(
    appliedRepair.limitations.some((line) => /Telegram/i.test(line)),
    false,
  );

  // 7. restore_native_change refuses with restore_unsupported
  const undoRepairErr = await callError(client, "restore_native_change", {
    change_ref: prepRepair.change_ref,
  });
  assert.equal(undoRepairErr.error.code, "restore_unsupported");

  // 8. Lost reply marks uncertain (hub_effect="unknown") and never resends
  const prepLostRepair = await callOk(client, "prepare_native_change", {
    operation: "window_button",
    target_ref: childWinRef,
    option_key: "Repair",
    reason: "Повторный Repair с потерей ответа",
  });
  const writesBefore = hub.writes().length;
  hub.state.faults.droppedReply.push({
    method: "window.update",
    remaining: 1,
  });
  const uncertainRepair = await callOk(client, "apply_native_change", {
    change_ref: prepLostRepair.change_ref,
  });
  assert.equal(uncertainRepair.status, "uncertain");
  assert.equal(uncertainRepair.hub_effect, "unknown");
  assert.equal(hub.writes().length, writesBefore + 1);
  const retriedRepair = await callOk(client, "apply_native_change", {
    change_ref: prepLostRepair.change_ref,
  });
  assert.equal(retriedRepair.status, "uncertain");
  assert.equal(
    hub.writes().length,
    writesBefore + 1,
    "lost Repair reply must NEVER be resent blindly",
  );
});

test("MCP surface budgets stay intact: 13 tools, <= 2048 instructions, <= 1000 descriptions, 0 new prepare_native_change fields, and < 4096 B contracts", async (t) => {
  const { client } = await setup(t);
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

  // Zero new top-level schema fields on prepare_native_change
  const prepareTool = tools.find(
    ({ name }) => name === "prepare_native_change",
  );
  assert.ok(prepareTool);
  const actualKeys = Object.keys(
    prepareTool.inputSchema.properties ?? {},
  ).sort();
  assert.deepEqual(
    actualKeys,
    EXPECTED_PREPARE_SCHEMA_KEYS,
    "prepare_native_change must NOT add any new top-level schema fields",
  );

  // All 3 catalog contracts + window_button contract fit strictly under 4096 bytes
  for (const operation of [...CATALOG_OPERATIONS, "window_button"]) {
    const res = await callOk(client, "get_native_change_contract", {
      operation,
    });
    assert.equal(res.operation, operation);
    const bytes = Buffer.byteLength(JSON.stringify(res.contract), "utf8");
    assert.ok(
      bytes < 4_096,
      `${operation} contract must be < 4096 bytes, got ${bytes}`,
    );
  }
});

test("regression P1-1: read-only get_native_change never sends catalog.update rollback writes and confirmed rollback clears contradictory flags", async (t) => {
  let refuseGetAfterNextUpdate = false;
  let hubRef;
  const { hub, client } = await setup(t, {
    timeoutMs: 350,
    onRequest: (req) => {
      if (refuseGetAfterNextUpdate && req.method === "catalog.update") {
        refuseGetAfterNextUpdate = false;
        hubRef.refuseNext("catalog.get", {
          code: -32000,
          message: "temporary read error",
        });
      }
    },
  });
  hubRef = hub;
  const baseJson = JSON.stringify({
    manufacturer: "Tuya",
    model: "ReadOnlyGuardBase",
    services: [{ type: "Outlet" }],
  });
  const badJson = JSON.stringify({
    manufacturer: "Tuya",
    model: "ReadOnlyGuardBad",
    services: [{ type: "Outlet" }],
  });
  const { applied: created } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: baseJson,
    reason: "Создать шаблон для проверки read-only get_native_change",
  });

  // 1. catalog.update reply is dropped while hub marks template active=false,
  // and post-timeout catalog.get also fails -> apply settles uncertain.
  const prep = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: created.created_catalog_ref,
    source: badJson,
    reason: "Обновить шаблон с потерей ответа и ошибкой хаба",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: ошибка после потери ответа",
  });
  hub.state.faults.droppedReply.push({
    method: "catalog.update",
    remaining: 1,
  });
  refuseGetAfterNextUpdate = true;
  const uncertain = await callOk(client, "apply_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(uncertain.status, "uncertain");

  // Calling read-only get_native_change MUST send ZERO catalog.update writes!
  const updatesBeforeGet = hub.requests.filter(
    ({ method }) => method === "catalog.update",
  ).length;
  const inspected = await callOk(client, "get_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.update").length,
    updatesBeforeGet,
    "read-only get_native_change must NEVER send catalog.update writes",
  );
  assert.equal(inspected.status, "applied");
  assert.equal(inspected.rollback_failed, true);
  assert.match(inspected.hub_template_error, /ошибка после потери ответа/);
  assert.equal(inspected.restore_supported, true);
  assert.equal(inspected.next?.tool, "restore_native_change");
  assert.equal(inspected.verification?.result, "hub_template_rollback_failed");

  // Explicit restore_native_change now rolls back to baseline cleanly.
  const restored = await callOk(client, "restore_native_change", {
    change_ref: prep.change_ref,
  });
  assert.equal(restored.status, "restored");

  // 2. When rollback catalog.update succeeded on hub after a transient readback
  // failure, settling to rejected must clear rollback_failed & rollback_error.
  const prep2 = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: created.created_catalog_ref,
    source: badJson,
    reason: "Проверить очистку флагов после подтверждённого rollback",
  });
  let getCount = 0;
  // First catalog.get is apply precondition (must pass); second catalog.get is
  // post-rollback readback (must fail once so change settles uncertain with rollback_failed).
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: повторная ошибка",
  });
  let updateSeen = 0;
  hub.state.catalogValidator = (ctx) => {
    if (ctx.op === "update") {
      updateSeen += 1;
      if (updateSeen === 1) {
        // After rollback update executes, fail its post-rollback catalog.get once
        hub.refuseNext("catalog.get", {
          code: -32000,
          message: "post-rollback read timeout",
        });
      }
    }
    return null;
  };
  const uncertainRollback = await callOk(client, "apply_native_change", {
    change_ref: prep2.change_ref,
  });
  hub.state.catalogValidator = null;
  assert.equal(uncertainRollback.status, "uncertain");
  assert.equal(uncertainRollback.rollback_failed, true);
  getCount = hub.requests.filter(
    ({ method }) => method === "catalog.update",
  ).length;

  const confirmedRejected = await callOk(client, "get_native_change", {
    change_ref: prep2.change_ref,
  });
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.update").length,
    getCount,
    "get_native_change must not write when confirming rollback",
  );
  assert.equal(confirmedRejected.status, "rejected");
  assert.equal(confirmedRejected.rollback_confirmed, true);
  assert.equal(confirmedRejected.rollback_failed, undefined);
  assert.equal(confirmedRejected.rollback_error, undefined);
});

test("regression P1-2: hub-refused restore_native_change never leaves stale pending restore intent on create, update, or delete", async (t) => {
  const { hub, client } = await setup(t);
  const v1 = JSON.stringify({ manufacturer: "Tuya", model: "RefusedV1" });
  const v2 = JSON.stringify({ manufacturer: "Tuya", model: "RefusedV2" });
  const v3 = JSON.stringify({ manufacturer: "Tuya", model: "RefusedV3" });

  // 1. Create settled uncertain (transient post-create readback failure) ->
  // restore_native_change refused by hub -> status must become applied (not uncertain
  // with pending restore!), so external deletion reports conflict (not restored).
  const pCreate1 = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: v1,
    reason: "Создать шаблон 1 с отказом readback",
  });
  hub.refuseNext("catalog.get", { code: -32000, message: "readback glitch" });
  const uCreate1 = await callOk(client, "apply_native_change", {
    change_ref: pCreate1.change_ref,
  });
  assert.equal(uCreate1.status, "uncertain");

  hub.refuseNext("catalog.delete", { code: -32603, message: "delete refused" });
  const refusedRestore1 = await callError(client, "restore_native_change", {
    change_ref: pCreate1.change_ref,
  });
  assert.ok(refusedRestore1.error);

  // Externally delete /1.json on hub
  hub.state.catalogs = hub.state.catalogs.filter(
    (entry) => !(entry.store === "INTERNAL" && entry.file === "/1.json"),
  );
  const afterManualDelGet = await callOk(client, "get_native_change", {
    change_ref: pCreate1.change_ref,
  });
  assert.equal(
    afterManualDelGet.status,
    "conflict",
    "external deletion after hub-refused restore must report conflict, never restored",
  );
  assert.equal(
    afterManualDelGet.conflict_reason,
    "created_catalog_template_missing",
  );

  // 1b. Create -> hub refuses restore -> later update applied -> restore on create
  // MUST report later_owned_change (never bypassed by stale refused restore intent!).
  const { applied: createGuard } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: v1,
    reason:
      "Создать шаблон 1b для проверки later_owned_change после отказа restore",
  });
  hub.refuseNext("catalog.delete", {
    code: -32603,
    message: "delete refused 1b",
  });
  await callError(client, "restore_native_change", {
    change_ref: createGuard.change_ref,
  });
  const { applied: updAfterRefused } = await prepareAndApply(client, {
    operation: "catalog_template_update",
    target_ref: createGuard.created_catalog_ref,
    source: v2,
    reason: "Обновить шаблон 1b после отказа restore",
  });
  const blockedCreateGuard = await callOk(client, "restore_native_change", {
    change_ref: createGuard.change_ref,
  });
  assert.equal(blockedCreateGuard.status, "conflict");
  assert.equal(blockedCreateGuard.conflict_reason, "later_owned_change");
  assert.equal(
    blockedCreateGuard.restore_first_change_ref,
    updAfterRefused.change_ref,
  );

  // 2. Update -> hub refuses restore_native_change -> external manual revert to v1 ->
  // batch restore_native_change must report skipped/changed_since (already_previous=true),
  // NOT falsely restored via stale rejected write_intent.at!
  const { applied: create2 } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: v1,
    reason: "Создать шаблон 2",
  });
  const { applied: upd1 } = await prepareAndApply(client, {
    operation: "catalog_template_update",
    target_ref: create2.created_catalog_ref,
    source: v2,
    reason: "Обновить шаблон 2 до v2",
  });
  hub.refuseNext("catalog.update", { code: -32603, message: "update refused" });
  await callError(client, "restore_native_change", {
    change_ref: upd1.change_ref,
  });
  // External manual revert back to v1 on hub
  const liveEntry = hub.state.catalogs.find(
    (entry) => entry.store === "INTERNAL" && entry.file === create2.file,
  );
  liveEntry.template = v1;
  const batchAfterRefused = await callOk(client, "restore_native_change", {
    home_ref: HOME_REF,
    change_refs: [upd1.change_ref],
  });
  assert.equal(batchAfterRefused.results[0].status, "skipped");
  assert.equal(batchAfterRefused.results[0].reason, "changed_since");
  assert.equal(batchAfterRefused.results[0].already_previous, true);
  assert.equal(batchAfterRefused.results[0].sent, false);

  // 3. Delete -> hub refuses restore catalog.create -> get_native_change stays applied,
  // and retrying restore_native_change actually sends catalog.create and succeeds!
  const { applied: create3 } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: v3,
    reason: "Создать шаблон 3 для удаления",
  });
  const { applied: del3 } = await prepareAndApply(client, {
    operation: "catalog_template_delete",
    target_ref: create3.created_catalog_ref,
    reason: "Удалить шаблон 3",
  });
  hub.refuseNext("catalog.create", { code: -32603, message: "create refused" });
  await callError(client, "restore_native_change", {
    change_ref: del3.change_ref,
  });
  const afterRefusedDelGet = await callOk(client, "get_native_change", {
    change_ref: del3.change_ref,
  });
  assert.equal(afterRefusedDelGet.status, "applied");
  assert.equal(
    afterRefusedDelGet.verification?.result,
    "deleted_catalog_template_absent",
  );
  const retriedDelRestore = await callOk(client, "restore_native_change", {
    change_ref: del3.change_ref,
  });
  assert.equal(retriedDelRestore.status, "restored");
  assert.ok(retriedDelRestore.restored_catalog_ref);
});

test("regression P1-3: proto3 implicit-presence omitted store (MAIN) and omitted active (false) work end-to-end", async (t) => {
  const { hub, client } = await setup(t, {
    patchFixture: (fixture) => {
      fixture.catalog = { omitProto3Defaults: true };
    },
  });

  // 1. home_overview list="catalog" and get_entity decode omitted store as "MAIN"
  const listed = await callOk(client, "home_overview", {
    home_ref: HOME_REF,
    list: "catalog",
    type: "MAIN",
  });
  assert.ok(listed.catalog.length >= 2);
  assert.ok(listed.catalog.every((item) => item.store === "MAIN"));

  const mainRef = catalogRef("MAIN", "zigbee", "/Tuya/TS011F.json");
  const mainEntity = await callOk(client, "get_entity", {
    entity_ref: mainRef,
  });
  assert.equal(mainEntity.entity.store, "MAIN");
  assert.equal(mainEntity.entity.writable, false);
  assert.equal(mainEntity.entity.active, true);

  // 2. catalog.create returning proto3-omitted active (no active key, no error key)
  // MUST be detected as inactive (active=false) -> cleaned up -> rejected!
  const pCreate = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({
      manufacturer: "Tuya",
      model: "Proto3SilentInactive",
    }),
    reason: "Проверить proto3-пропуск active=false при create",
  });
  hub.state.catalogRejectNext.push({ error: null });
  const aCreate = await callOk(client, "apply_native_change", {
    change_ref: pCreate.change_ref,
  });
  assert.equal(aCreate.status, "rejected");
  assert.equal(aCreate.cleanup_confirmed, true);
  assert.match(aCreate.hub_template_error, /inactive/i);

  // 3. catalog.update returning proto3-omitted active (no active key, no error key)
  // MUST be detected as inactive -> rolled back -> rejected!
  const { applied: good } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "Proto3Base" }),
    reason: "Создать рабочий шаблон для update",
  });
  const pUpd = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_update",
    target_ref: good.created_catalog_ref,
    source: JSON.stringify({ manufacturer: "Tuya", model: "Proto3BadUpd" }),
    reason: "Проверить proto3-пропуск active=false при update",
  });
  hub.state.catalogRejectNext.push({ error: null });
  const aUpd = await callOk(client, "apply_native_change", {
    change_ref: pUpd.change_ref,
  });
  assert.equal(aUpd.status, "rejected");
  assert.equal(aUpd.rollback_confirmed, true);
  assert.match(aUpd.hub_template_error, /inactive/i);
});

test("regression P1-4: later_owned_change is never bypassed by cyclic content updates and inactive baseline is never marked restored", async (t) => {
  const { hub, client } = await setup(t);
  const v1 = JSON.stringify({ manufacturer: "Tuya", model: "CycleV1" });
  const v2 = JSON.stringify({ manufacturer: "Tuya", model: "CycleV2" });

  // Create V1 -> Update 1 (V1 -> V2) -> Update 2 (V2 -> V1, cycling back to V1!)
  const { applied: created } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: v1,
    reason: "Создать шаблон V1",
  });
  const { applied: upd1 } = await prepareAndApply(client, {
    operation: "catalog_template_update",
    target_ref: created.created_catalog_ref,
    source: v2,
    reason: "Обновить V1 -> V2",
  });
  const { applied: upd2 } = await prepareAndApply(client, {
    operation: "catalog_template_update",
    target_ref: created.created_catalog_ref,
    source: v1,
    reason: "Вернуть V2 -> V1 новым обновлением",
  });

  // Undoing CREATE while upd2 is still applied MUST report later_owned_change (not delete!)
  const rCreateBlocked = await callOk(client, "restore_native_change", {
    change_ref: created.change_ref,
  });
  assert.equal(rCreateBlocked.status, "conflict");
  assert.equal(rCreateBlocked.conflict_reason, "later_owned_change");
  assert.equal(rCreateBlocked.restore_first_change_ref, upd2.change_ref);
  assert.ok(
    hub.state.catalogs.some(
      (entry) => entry.store === "INTERNAL" && entry.file === created.file,
    ),
    "template must NOT be deleted while later owned changes exist",
  );

  // Undoing UPDATE 1 while upd2 cycled content back to V1 MUST report later_owned_change
  // (NOT falsely return status=restored!)
  const rUpd1Blocked = await callOk(client, "restore_native_change", {
    change_ref: upd1.change_ref,
  });
  assert.equal(rUpd1Blocked.status, "conflict");
  assert.equal(rUpd1Blocked.conflict_reason, "later_owned_change");
  assert.equal(rUpd1Blocked.restore_first_change_ref, upd2.change_ref);

  // Proper reverse order: upd2 -> upd1 -> create succeeds cleanly
  const rUpd2 = await callOk(client, "restore_native_change", {
    change_ref: upd2.change_ref,
  });
  assert.equal(rUpd2.status, "restored");
  const rUpd1 = await callOk(client, "restore_native_change", {
    change_ref: upd1.change_ref,
  });
  assert.equal(rUpd1.status, "restored");
  const rCreate = await callOk(client, "restore_native_change", {
    change_ref: created.change_ref,
  });
  assert.equal(rCreate.status, "restored");

  // Active-baseline guard: if baseline was active V1 and live is now V1 but inactive/broken,
  // restore_native_change MUST NOT claim status=restored!
  const { applied: createdB } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: v1,
    reason: "Создать активный V1",
  });
  const { applied: updB } = await prepareAndApply(client, {
    operation: "catalog_template_update",
    target_ref: createdB.created_catalog_ref,
    source: v2,
    reason: "Обновить активный V1 -> V2",
  });
  const entryB = hub.state.catalogs.find(
    (entry) => entry.store === "INTERNAL" && entry.file === createdB.file,
  );
  entryB.template = v1;
  entryB.active = false;
  entryB.error = "Базовый шаблон повреждён";
  const rBrokenBaseline = await callOk(client, "restore_native_change", {
    change_ref: updB.change_ref,
  });
  assert.notEqual(rBrokenBaseline.status, "restored");
  assert.equal(rBrokenBaseline.status, "conflict");
  assert.match(rBrokenBaseline.hub_template_error, /повреждён/);
});

test("regression P2-1: catalog_template_create settles from uncertain after transient post-create readback failure and clears cleanup_error on delayed cleanup", async (t) => {
  const { hub, client } = await setup(t);

  // 1. Healthy create whose immediate post-create catalog.get fails -> apply returns uncertain;
  // subsequent get_native_change MUST settle to applied (not stay stuck in uncertain!).
  const p1 = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "SettleUncertain1" }),
    reason: "Создать шаблон с временным сбоем readback",
  });
  hub.refuseNext("catalog.get", {
    code: -32000,
    message: "transient readback error",
  });
  const u1 = await callOk(client, "apply_native_change", {
    change_ref: p1.change_ref,
  });
  assert.equal(u1.status, "uncertain");
  assert.ok(u1.created_catalog_ref);

  const settled1 = await callOk(client, "get_native_change", {
    change_ref: p1.change_ref,
  });
  assert.equal(settled1.status, "applied");
  assert.equal(
    settled1.verification?.result,
    "created_catalog_template_observed",
  );

  // 2. Create rejected by hub + cleanup delete fails + post-delete readback fails -> uncertain
  // with cleanup_failed & cleanup_error. Subsequent get_native_change while broken file is still
  // present sends ZERO writes and settles to applied with cleanup_failed & next=restore_native_change.
  const p2 = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "SettleUncertain2" }),
    reason: "Создать битый шаблон со сбоем cleanup и readback",
  });
  hub.state.catalogRejectNext.push({ error: "Неправильный шаблон: сбой 2" });
  hub.refuseNext("catalog.delete", {
    code: -32603,
    message: "cleanup refused",
  });
  hub.refuseNext("catalog.get", {
    code: -32000,
    message: "post-cleanup read failed",
  });
  const u2 = await callOk(client, "apply_native_change", {
    change_ref: p2.change_ref,
  });
  assert.equal(u2.status, "uncertain");
  assert.equal(u2.cleanup_failed, true);
  assert.ok(u2.cleanup_error);

  const deletesBeforeGet = hub.requests.filter(
    ({ method }) => method === "catalog.delete",
  ).length;
  const settled2 = await callOk(client, "get_native_change", {
    change_ref: p2.change_ref,
  });
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.delete").length,
    deletesBeforeGet,
    "get_native_change must send ZERO delete writes",
  );
  assert.equal(settled2.status, "applied");
  assert.equal(settled2.cleanup_failed, true);
  assert.match(settled2.hub_template_error, /сбой 2/);
  assert.equal(settled2.next?.tool, "restore_native_change");

  // 3. Delayed cleanup confirmed via get_native_change clears cleanup_failed AND cleanup_error!
  const p3 = await callOk(client, "prepare_native_change", {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "DelayedCleanup" }),
    reason: "Проверить очистку cleanup_error при отложенном удалении",
  });
  hub.state.catalogRejectNext.push({ error: "Неправильный шаблон: сбой 3" });
  hub.refuseNext("catalog.delete", {
    code: -32603,
    message: "cleanup refused 3",
  });
  hub.refuseNext("catalog.get", { code: -32000, message: "read failed 3" });
  const u3 = await callOk(client, "apply_native_change", {
    change_ref: p3.change_ref,
  });
  assert.equal(u3.status, "uncertain");
  assert.ok(u3.cleanup_error);

  // Remove the broken file from hub (delayed cleanup succeeded)
  hub.state.catalogs = hub.state.catalogs.filter(
    (entry) => !(entry.store === "INTERNAL" && entry.file === u3.file),
  );
  const confirmed3 = await callOk(client, "get_native_change", {
    change_ref: p3.change_ref,
  });
  assert.equal(confirmed3.status, "rejected");
  assert.equal(confirmed3.cleanup_confirmed, true);
  assert.equal(confirmed3.cleanup_failed, undefined);
  assert.equal(confirmed3.cleanup_error, undefined);
});

test("regression P2-2: restoreCatalogTemplateDelete handles inactive baselines, preserves ghost file on failed cleanup, and never re-creates from conflict", async (t) => {
  const { hub, client } = await setup(t);

  // 1. Previously-inactive INTERNAL template deleted and restored -> succeeds (status=restored)!
  const inactiveTemplate = JSON.stringify({
    manufacturer: "Tuya",
    model: "AlreadyInactive",
  });
  hub.state.catalogs.push({
    active: false,
    store: "INTERNAL",
    controller: "zigbee",
    file: "/50.json",
    write: true,
    error: "Старое предупреждение шаблона",
    manufacturer: "Tuya",
    model: "AlreadyInactive",
    manufacturerIds: [],
    modelIds: [],
    availableServices: [],
    template: inactiveTemplate,
    deviceCount: 0,
    devices: [],
    accessories: [],
  });
  const { applied: delInactive } = await prepareAndApply(client, {
    operation: "catalog_template_delete",
    target_ref: catalogRef("INTERNAL", "zigbee", "/50.json"),
    reason: "Удалить ранее неактивный шаблон",
  });
  hub.state.catalogRejectNext.push({ error: "Старое предупреждение шаблона" });
  const restoredInactive = await callOk(client, "restore_native_change", {
    change_ref: delInactive.change_ref,
  });
  assert.equal(restoredInactive.status, "restored");
  assert.ok(restoredInactive.restored_catalog_ref);

  // 2. Active template deleted -> restore hits hub rejection AND cleanup delete fails ->
  // MUST preserve cleanup_failed, cleanup_error, and leftover broken file identity!
  const { applied: activeCreated } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({ manufacturer: "Tuya", model: "GhostIdentity" }),
    reason: "Создать активный шаблон для теста ghost cleanup",
  });
  const { applied: delActive } = await prepareAndApply(client, {
    operation: "catalog_template_delete",
    target_ref: activeCreated.created_catalog_ref,
    reason: "Удалить активный шаблон",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: базовый файл отсутствует",
  });
  hub.refuseNext("catalog.delete", { code: -32603, message: "delete busy" });
  const failedCleanupRestore = await callOk(client, "restore_native_change", {
    change_ref: delActive.change_ref,
  });
  assert.equal(failedCleanupRestore.status, "uncertain");
  assert.equal(failedCleanupRestore.cleanup_failed, true);
  assert.ok(failedCleanupRestore.cleanup_error);
  assert.ok(
    failedCleanupRestore.restored_catalog_ref,
    "failed cleanup on delete restore must NOT drop the leftover broken file identity",
  );
  assert.match(
    failedCleanupRestore.hub_template_error,
    /базовый файл отсутствует/,
  );

  // Retrying restore_native_change on this uncertain failed-cleanup delete must NOT create another file!
  const createsBeforeRetry = hub.requests.filter(
    ({ method }) => method === "catalog.create",
  ).length;
  const retriedUncertain = await callOk(client, "restore_native_change", {
    change_ref: delActive.change_ref,
  });
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.create").length,
    createsBeforeRetry,
  );
  assert.equal(retriedUncertain.status, "uncertain");
  assert.equal(retriedUncertain.next?.tool, "get_native_change");

  // Once the leftover broken file is removed from the hub, get_native_change settles
  // cleanly to conflict with cleanup_confirmed=true and cleared cleanup_failed/error/ref.
  const ghostFile = decodeURIComponent(
    failedCleanupRestore.restored_catalog_ref.split("/").pop(),
  );
  hub.state.catalogs = hub.state.catalogs.filter(
    (entry) => !(entry.store === "INTERNAL" && entry.file === ghostFile),
  );
  const afterGhostRemoved = await callOk(client, "get_native_change", {
    change_ref: delActive.change_ref,
  });
  assert.equal(afterGhostRemoved.status, "conflict");
  assert.equal(afterGhostRemoved.cleanup_confirmed, true);
  assert.equal(afterGhostRemoved.cleanup_failed, undefined);
  assert.equal(afterGhostRemoved.cleanup_error, undefined);
  assert.equal(afterGhostRemoved.restored_catalog_ref, undefined);

  // 3. Delete restore settles to conflict (hub rejected & cleanup succeeded) ->
  // calling restore_native_change again MUST return stored conflict with ZERO duplicate catalog.create!
  const { applied: activeCreated2 } = await prepareAndApply(client, {
    operation: "catalog_template_create",
    target_ref: HOME_REF,
    value: "zigbee",
    source: JSON.stringify({
      manufacturer: "Tuya",
      model: "NoRecreateFromConflict",
    }),
    reason: "Создать шаблон для теста conflict",
  });
  const { applied: delActive2 } = await prepareAndApply(client, {
    operation: "catalog_template_delete",
    target_ref: activeCreated2.created_catalog_ref,
    reason: "Удалить шаблон для теста conflict",
  });
  hub.state.catalogRejectNext.push({
    error: "Неправильный шаблон: отклонён при восстановлении",
  });
  const conflictRestore = await callOk(client, "restore_native_change", {
    change_ref: delActive2.change_ref,
  });
  assert.equal(conflictRestore.status, "conflict");
  assert.equal(conflictRestore.cleanup_confirmed, true);

  const createsBeforeConflictRetry = hub.requests.filter(
    ({ method }) => method === "catalog.create",
  ).length;
  const secondConflictRestore = await callOk(client, "restore_native_change", {
    change_ref: delActive2.change_ref,
  });
  assert.equal(secondConflictRestore.status, "conflict");
  assert.equal(
    hub.requests.filter(({ method }) => method === "catalog.create").length,
    createsBeforeConflictRetry,
    "restore_native_change on conflict delete must NEVER send a duplicate catalog.create",
  );
});

test("regression P3-1: isValidCatalogFile rejects backslashes, empty/trailing segments, dot segments, and whitespace-only segments", async (t) => {
  const { client } = await setup(t);
  const badFiles = [
    "/Tuya\\TS011F.json",
    "//Tuya/TS011F.json",
    "/Tuya//TS011F.json",
    "/Tuya/",
    "/./TS011F.json",
    "/ /TS011F.json",
  ];
  for (const badFile of badFiles) {
    const getErr = await callError(client, "get_entity", {
      entity_ref: catalogRef("MAIN", "zigbee", badFile),
    });
    assert.equal(
      getErr.error.code,
      "invalid_entity_ref",
      `get_entity must reject invalid catalog file ${JSON.stringify(badFile)}`,
    );

    const prepErr = await callError(client, "prepare_native_change", {
      operation: "catalog_template_create",
      target_ref: HOME_REF,
      value: "zigbee",
      source: JSON.stringify({
        manufacturer: "Tuya",
        template: badFile,
      }),
      reason: `Проверить отказ невалидного пути ${badFile}`,
    });
    assert.equal(
      prepErr.error.code,
      "invalid_native_value",
      `prepare_native_change must reject invalid base template path ${JSON.stringify(badFile)}`,
    );
  }
});
