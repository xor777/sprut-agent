import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaledHome } from "./fixtures/homes/scaled.mjs";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Торшер есть в Алисе?», «какие устройства видит HomeKit?»: what a bridge
// (HomeKit, Yandex, Google) exports, read without the owner opening the
// bridge screens. The apartment's bridges, read off
// test/fixtures/homes/apartment.json by a person: HomeKit runs and exports
// the door sensor, the hall light, the chandelier, the air conditioner and
// the bedroom climate sensor's temperature; «Яндекс Алиса» does not run
// (NOT_LOADED, off) and keeps the chandelier, the floor lamp and the
// kitchen light, and cannot export the bedside button. A bridge's export
// is its child list and the child's window
// (research/protocol/2026-10-13-wave4-contracts.md, 3).
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const apartment = "spruthub://hub/sim-apartment-01";
const scaled = "spruthub://hub/sim-scaled-01";
const bridge = (home, key) =>
  `${home}/extension/${encodeURIComponent(`Bridge:${key}`)}`;
const service = (home, aId, sId) => `${home}/accessory/${aId}/service/${sId}`;

async function setup(t, fixture) {
  const hub = await startSimulatedHub(
    fixture ?? (await loadHomeFixture("apartment")),
  );
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-bridge-export-"),
  );
  const client = new Client({ name: "bridge-export-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    }),
  );
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, stateDirectory };
}

// The journal of native changes, as the server keeps it for this hub.
function journalFile(hub, stateDirectory) {
  const fingerprint = createHash("sha256")
    .update(`${hub.url}\0${hub.serial}`)
    .digest("hex");
  return path.join(
    stateDirectory,
    `automation-changes-${fingerprint.slice(0, 24)}.json`,
  );
}

// One get_entity call with the native requests it cost.
async function read(hub, client, args) {
  const before = hub.requests.length;
  const result = await client.callTool({ name: "get_entity", arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const native = hub.requests.slice(before);
  return {
    ...result.structuredContent,
    text: result.content[0].text,
    bytes: Buffer.byteLength(result.content[0].text),
    native,
  };
}

const childWindowReads = (native) =>
  native
    .filter(({ method }) => method === "window.get")
    .map(({ params }) => params.window.get.windowKey);

const notRunning = (entry) => {
  const { limitation, ...rest } = entry;
  assert.match(limitation, /not running/i);
  return rest;
};

test("an accessory's bridges say where it is exported and which of its services", async (t) => {
  const { hub, client } = await setup(t);

  const floorLamp = await read(hub, client, {
    entity_ref: `${apartment}/accessory/16`,
    include: ["bridges"],
  });
  assert.deepEqual(floorLamp.entity.include_resolution.applied, ["bridges"]);
  const [homekit, yandex] = floorLamp.entity.bridges;
  assert.equal(floorLamp.entity.bridges.length, 2);
  // HomeKit runs and does not export the floor lamp.
  assert.deepEqual(homekit, {
    ref: bridge(apartment, "homekit"),
    name: "HomeKit",
    type: "homekit",
    state: "LOADED",
    enabled: true,
    running: true,
    exported: false,
  });
  // Alice's bridge keeps the floor lamp but does not run: the setting is
  // there, the assistant sees nothing from it now.
  assert.deepEqual(notRunning(yandex), {
    ref: bridge(apartment, "yandex"),
    name: "Яндекс Алиса",
    type: "yandex",
    state: "NOT_LOADED",
    enabled: false,
    running: false,
    exported: true,
    services: [
      { ref: service(apartment, 16, 13), name: "Свет", exported: true },
    ],
  });
  // The services are read from the window of the bridge that exports it.
  assert.deepEqual(childWindowReads(floorLamp.native), [
    "Bridge/yandex/Child/16/",
  ]);

  // One service of two exported: the climate sensor's temperature only.
  const climate = await read(hub, client, {
    entity_ref: `${apartment}/accessory/25`,
    include: ["bridges"],
  });
  assert.deepEqual(climate.entity.bridges, [
    {
      ref: bridge(apartment, "homekit"),
      name: "HomeKit",
      type: "homekit",
      state: "LOADED",
      enabled: true,
      running: true,
      exported: true,
      services: [
        {
          ref: service(apartment, 25, 13),
          name: "Температура",
          exported: true,
        },
        { ref: service(apartment, 25, 20), name: "Влажность", exported: false },
        { ref: service(apartment, 25, 90), name: "Батарея", exported: false },
      ],
    },
    {
      ...climate.entity.bridges[1],
      ref: bridge(apartment, "yandex"),
      running: false,
      exported: false,
    },
  ]);
  assert.match(climate.entity.bridges[1].limitation, /not running/i);
  assert.deepEqual(childWindowReads(climate.native), [
    "Bridge/homekit/Child/25/",
  ]);

  // A bridge that cannot export the accessory says so rather than "not
  // exported".
  const button = await read(hub, client, {
    entity_ref: `${apartment}/accessory/39`,
    include: ["bridges"],
  });
  const [buttonHomekit, buttonYandex] = button.entity.bridges;
  assert.equal(buttonHomekit.exported, false);
  assert.equal(Object.hasOwn(buttonHomekit, "exportable"), false);
  assert.equal(buttonYandex.exported, false);
  assert.equal(buttonYandex.exportable, false);

  // Without the include an accessory read touches no bridge.
  const plain = await read(hub, client, {
    entity_ref: `${apartment}/accessory/16`,
  });
  assert.equal(Object.hasOwn(plain.entity, "bridges"), false);
  assert.deepEqual(
    plain.native
      .map(({ method }) => method)
      .filter((m) => /^extension/.test(m)),
    [],
  );

  // A service or characteristic points at its accessory for bridges.
  const lampService = await read(hub, client, {
    entity_ref: service(apartment, 16, 13),
    include: ["bridges"],
  });
  const [unapplied] = lampService.entity.include_resolution.not_applied;
  assert.equal(unapplied.include, "bridges");
  assert.deepEqual(unapplied.next, {
    tool: "get_entity",
    arguments: {
      entity_ref: `${apartment}/accessory/16`,
      include: ["bridges"],
    },
  });

  assert.deepEqual(hub.writes(), []);
});

test("a bridge lists what it exports first, with rooms and a count", async (t) => {
  const { hub, client } = await setup(t);

  const homekit = await read(hub, client, {
    entity_ref: bridge(apartment, "homekit"),
    include: ["children"],
  });
  const { entity } = homekit;
  assert.equal(entity.exported_count, 5);
  assert.equal(Object.hasOwn(entity, "limitation"), false);
  assert.deepEqual(
    entity.spaces.map(({ key, child_count }) => [key, child_count]),
    [
      ["main", 5],
      ["notConnected", 24],
    ],
  );
  assert.equal(entity.children.length, 29);
  assert.deepEqual(
    entity.children
      .slice(0, 5)
      .map(({ name, room, space_key, accessory_ref }) => [
        name,
        room,
        space_key,
        accessory_ref,
      ]),
    [
      ["Датчик двери", "Прихожая", "main", `${apartment}/accessory/11`],
      ["Свет в прихожей", "Прихожая", "main", `${apartment}/accessory/12`],
      ["Люстра", "Гостиная", "main", `${apartment}/accessory/15`],
      ["Кондиционер", "Гостиная", "main", `${apartment}/accessory/19`],
      [
        "Датчик климата в спальне",
        "Спальня",
        "main",
        `${apartment}/accessory/25`,
      ],
    ],
  );
  assert.ok(
    entity.children
      .slice(5)
      .every(({ space_key }) => space_key === "notConnected"),
  );
  const floorLamp = entity.children.find(({ name }) => name === "Торшер");
  assert.equal(floorLamp.room, "Гостиная");
  assert.equal(floorLamp.accessory_ref, `${apartment}/accessory/16`);

  // A bridge that does not run still shows its export, and says it does not
  // run.
  const yandex = await read(hub, client, {
    entity_ref: bridge(apartment, "yandex"),
    include: ["children"],
  });
  assert.equal(yandex.entity.state, "NOT_LOADED");
  assert.equal(yandex.entity.enabled, false);
  assert.match(yandex.entity.limitation, /not running/i);
  assert.equal(yandex.entity.exported_count, 3);
  assert.equal(yandex.entity.children.length, 28);
  assert.deepEqual(
    yandex.entity.children.slice(0, 3).map(({ name, room }) => [name, room]),
    [
      ["Люстра", "Гостиная"],
      ["Торшер", "Гостиная"],
      ["Свет на кухне", "Кухня"],
    ],
  );
  assert.deepEqual(hub.writes(), []);
});

test("a bridge read that fails is not taken for an accessory not exported", async (t) => {
  const { hub, client } = await setup(t);

  hub.refuseNext("extensionChild.list", {
    code: -32603,
    message: "Internal error",
  });
  const oneUnread = await read(hub, client, {
    entity_ref: `${apartment}/accessory/15`,
    include: ["bridges"],
  });
  const unread = oneUnread.entity.bridges.filter(
    ({ exported }) => exported === null,
  );
  const answered = oneUnread.entity.bridges.filter(
    ({ exported }) => exported !== null,
  );
  assert.equal(unread.length, 1);
  assert.equal(typeof unread[0].error_code, "string");
  assert.equal(Object.hasOwn(unread[0], "services"), false);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].exported, true);

  hub.refuseNext("window.get", { code: -32603, message: "Internal error" });
  const servicesUnread = await read(hub, client, {
    entity_ref: `${apartment}/accessory/25`,
    include: ["bridges"],
  });
  const [homekit] = servicesUnread.entity.bridges;
  assert.equal(homekit.exported, true);
  assert.equal(Object.hasOwn(homekit, "services"), false);
  assert.equal(typeof homekit.services_error_code, "string");

  // Without the list of extensions no bridge is known: the include is
  // unread, the accessory still read.
  hub.refuseNext("extension.list", { code: -32603, message: "Internal error" });
  const noBridges = await read(hub, client, {
    entity_ref: `${apartment}/accessory/16`,
    include: ["bridges"],
  });
  assert.equal(noBridges.entity.name, "Торшер");
  assert.equal(Object.hasOwn(noBridges.entity, "bridges"), false);
  const [failed] = noBridges.entity.include_resolution.not_applied;
  assert.equal(failed.include, "bridges");
  assert.equal(failed.reason, "read_failed");
  assert.deepEqual(failed.next, {
    tool: "get_entity",
    arguments: {
      entity_ref: `${apartment}/accessory/16`,
      include: ["bridges"],
    },
  });
  assert.deepEqual(hub.writes(), []);
});

test("bridge reads stay bounded by the question as the home grows", async (t) => {
  const small = await setup(
    t,
    scaledHome(await loadHomeFixture("apartment"), 80),
  );
  const large = await setup(
    t,
    scaledHome(await loadHomeFixture("apartment"), 400),
  );
  const bridgesOf = async ({ hub, client }) =>
    read(hub, client, {
      entity_ref: `${scaled}/accessory/25`,
      include: ["bridges"],
    });
  const smallRead = await bridgesOf(small);
  const largeRead = await bridgesOf(large);
  // The part answers per bridge, whatever the size of the home; the rest of
  // the read is the accessory itself.
  assert.deepEqual(largeRead.entity.bridges, smallRead.entity.bridges);
  const bridgesBytes = Buffer.byteLength(
    JSON.stringify(largeRead.entity.bridges),
  );
  assert.ok(bridgesBytes < 1_500, `${bridgesBytes} bytes`);
  assert.ok(Math.abs(largeRead.bytes - smallRead.bytes) < 64);
  // The list of extensions, each bridge's children and the window of the
  // one bridge that exports it: no request per accessory of the home.
  const methods = (native) =>
    native
      .map(({ method }) => method)
      .filter((method) => method !== "hub.list")
      .sort();
  assert.deepEqual(methods(largeRead.native), [
    "accessory.get",
    "extension.list",
    "extensionChild.list",
    "extensionChild.list",
    "window.get",
  ]);
  assert.deepEqual(methods(largeRead.native), methods(smallRead.native));

  // «Какие устройства видит HomeKit?» on 400 accessories: the overview
  // counts the exported ones, the first page of children starts with them,
  // and every page fits max_bytes.
  const { hub, client } = large;
  const maxBytes = 16_000;
  const overview = await read(hub, client, {
    entity_ref: bridge(scaled, "homekit"),
    include: ["children"],
  });
  assert.ok(overview.bytes <= maxBytes);
  assert.equal(overview.representation.kind, "entity_overview");
  assert.equal(overview.identity.exported_count, 5);
  let next = {
    entity_ref: bridge(scaled, "homekit"),
    include: ["children"],
    pointer: "/children",
    max_bytes: maxBytes,
  };
  const listed = [];
  while (next) {
    const page = await read(hub, client, next);
    assert.ok(page.bytes <= maxBytes, `${page.bytes} bytes`);
    listed.push(
      ...page.representation.available_parts.map(({ identity }) => identity),
    );
    next = page.representation.next?.arguments;
  }
  assert.equal(listed.length, 400);
  assert.equal(new Set(listed.map(({ ref }) => ref)).size, 400);
  assert.deepEqual(
    listed
      .slice(0, 5)
      .map(({ name, room, space_key }) => [name, room, space_key]),
    [
      ["Датчик двери", "Прихожая", "main"],
      ["Свет в прихожей", "Прихожая", "main"],
      ["Люстра", "Гостиная", "main"],
      ["Кондиционер", "Гостиная", "main"],
      ["Датчик климата в спальне", "Спальня", "main"],
    ],
  );
  assert.deepEqual(hub.writes(), []);
});

test("bridge text stays data and secrets in it stay hidden", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  const yandex = fixture.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:yandex",
  );
  const payload = "X-HM://0026ABCDEFGHIJ";
  yandex.name = `Алиса ${payload}`;
  const { hub, client } = await setup(t, fixture);

  const floorLamp = await read(hub, client, {
    entity_ref: `${apartment}/accessory/16`,
    include: ["bridges"],
  });
  assert.doesNotMatch(floorLamp.text, /X-HM:\/\/0026/);
  assert.equal(floorLamp.entity.bridges[1].exported, true);
});

// «Добавь торшер в HomeKit»: ticking a service in a bridge child's window
// was never checked on a hub (2026-10-13-wave4-contracts, limitations), so
// the export is read but not written: the agent learns it before anything
// is sent and is pointed at the current export, the owner at the app.
test("a bridge's export is read but not changed until a hub confirms the write", async (t) => {
  const { hub, client } = await setup(t);
  const floorLamp = `${apartment}/accessory/16`;
  const offersWrite = /get_native_change_contract|prepare_native_change/;

  // The way an agent reaches the flag: the bridge lists the floor lamp, its
  // window holds s:13, the lamp's light. No read offers a write of it.
  const homekit = await read(hub, client, {
    entity_ref: bridge(apartment, "homekit"),
    include: ["children"],
  });
  assert.doesNotMatch(homekit.text, offersWrite);
  const child = homekit.entity.children.find(
    ({ accessory_ref }) => accessory_ref === floorLamp,
  );
  const childWindow = await read(hub, client, {
    entity_ref: child.options_window_ref,
  });
  const flag = childWindow.entity.options.find(({ key }) => key === "s:13");
  assert.equal(flag.configured_value, false);
  assert.equal(flag.native_change.supported, false);
  assert.equal(flag.native_change.reason, "bridge_export_unverified");
  assert.doesNotMatch(childWindow.text, offersWrite);
  const lampBridges = await read(hub, client, {
    entity_ref: floorLamp,
    include: ["bridges"],
  });
  assert.doesNotMatch(lampBridges.text, offersWrite);

  const refusedWith = async (name, args, next) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, result.content[0]?.text);
    const { error } = result.structuredContent;
    assert.equal(error.code, "bridge_export_unverified");
    assert.match(error.message, /not (been )?verified/i);
    assert.match(error.message, /SprutHub app/);
    assert.deepEqual(result.structuredContent.next, next);
  };
  const lampExport = {
    tool: "get_entity",
    arguments: { entity_ref: floorLamp, include: ["bridges"] },
  };
  const tick = {
    operation: "window_option",
    target_ref: child.options_window_ref,
    option_key: "s:13",
  };
  await refusedWith("get_native_change_contract", tick, lampExport);
  await refusedWith(
    "prepare_native_change",
    { ...tick, value: true, reason: "Show the floor lamp in HomeKit" },
    lampExport,
  );

  // Which new accessories a bridge takes is its own window's
  // AutoAddNewAccessory: not written either.
  const autoAdd = {
    operation: "window_option",
    target_ref: homekit.entity.options_window_ref,
    option_key: "AutoAddNewAccessory",
  };
  const bridgeExport = {
    tool: "get_entity",
    arguments: {
      entity_ref: bridge(apartment, "homekit"),
      include: ["children"],
    },
  };
  await refusedWith("get_native_change_contract", autoAdd, bridgeExport);
  await refusedWith(
    "prepare_native_change",
    { ...autoAdd, value: true, reason: "Export new accessories to HomeKit" },
    bridgeExport,
  );

  assert.deepEqual(hub.writes(), []);
  const changes = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: apartment },
  });
  assert.equal(changes.isError, undefined, changes.content[0]?.text);
  assert.deepEqual(changes.structuredContent.changes, []);

  // Reading the export still works and shows it unchanged.
  const after = await read(hub, client, {
    entity_ref: floorLamp,
    include: ["bridges"],
  });
  assert.equal(after.entity.bridges[0].exported, false);
});

// A bridge's export journaled before prepare refused it, by an earlier
// version: apply of a prepared tick and restore of an applied one refuse it
// as prepare does, before anything is sent, and the records stay as they
// were. The records are made on the floor lamp's device setting and recast
// onto the bridge, as such a version would have saved them.
test("a bridge export change journaled earlier is neither applied nor restored", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const lampSetting = {
    operation: "window_option",
    target_ref: `${apartment}/window/${encodeURIComponent("Controller/zigbee/Child/000d6ffffe3c4a16/")}`,
    option_key: "/11/0006_OnOff/4003_StartUpOnOff/255",
    reason: "Set how the floor lamp starts after a power cut",
  };
  const changeTool = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return result.structuredContent;
  };
  const prepared = async (value) =>
    (await changeTool("prepare_native_change", { ...lampSetting, value }))
      .change_ref;
  const applied = async (value) => {
    const changeRef = await prepared(value);
    const result = await changeTool("apply_native_change", {
      change_ref: changeRef,
    });
    assert.equal(result.status, "applied");
    return changeRef;
  };
  const tickLamp = await prepared(1);
  const autoAddOn = await prepared(0);
  const untickClimate = await applied(1);
  const autoAddBack = await applied(0);

  const file = journalFile(hub, stateDirectory);
  const journal = JSON.parse(await readFile(file, "utf8"));
  const recast = (changeRef, windowKey, optionKey, baseline, requested) => {
    const change = journal.changes[changeRef.split("/").at(-1)];
    Object.assign(change, {
      target_ref: `${apartment}/window/${encodeURIComponent(windowKey)}`,
      target: { kind: "window", windowKey },
      option_key: optionKey,
      contract: {
        type: "GenericBoolean",
        input_type: "CHECKBOX",
        kind: "boolValue",
        confirmation: "separate_window_get_readback",
      },
      baseline_value: { value: baseline, kind: "boolValue" },
      requested_value: { value: requested, kind: "boolValue" },
    });
    if (change.observed_value) {
      change.observed_value = { value: requested, kind: "boolValue" };
    }
  };
  // HomeKit does not export the floor lamp and exports the climate sensor's
  // temperature; its AutoAddNewAccessory is off.
  recast(tickLamp, "Bridge/homekit/Child/16/", "s:13", false, true);
  recast(autoAddOn, "Bridge/homekit/", "AutoAddNewAccessory", false, true);
  recast(untickClimate, "Bridge/homekit/Child/25/", "s:13", false, true);
  recast(autoAddBack, "Bridge/homekit/", "AutoAddNewAccessory", true, false);
  await writeFile(file, `${JSON.stringify(journal, null, 2)}\n`);
  const writesBefore = hub.writes().length;

  const accessoryExport = (aId) => ({
    tool: "get_entity",
    arguments: {
      entity_ref: `${apartment}/accessory/${aId}`,
      include: ["bridges"],
    },
  });
  const homekitExport = {
    tool: "get_entity",
    arguments: {
      entity_ref: bridge(apartment, "homekit"),
      include: ["children"],
    },
  };
  for (const [name, changeRef, next] of [
    ["apply_native_change", tickLamp, accessoryExport(16)],
    ["apply_native_change", autoAddOn, homekitExport],
    ["restore_native_change", untickClimate, accessoryExport(25)],
    ["restore_native_change", autoAddBack, homekitExport],
  ]) {
    const result = await client.callTool({
      name,
      arguments: { change_ref: changeRef },
    });
    assert.equal(result.isError, true, result.content[0]?.text);
    const { error } = result.structuredContent;
    assert.equal(error.code, "bridge_export_unverified", name);
    assert.match(error.message, /SprutHub app/);
    assert.deepEqual(result.structuredContent.next, next, name);
  }

  assert.equal(hub.writes().length, writesBefore);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), journal);
  const climate = await read(hub, client, {
    entity_ref: `${apartment}/accessory/25`,
    include: ["bridges"],
  });
  assert.equal(climate.entity.bridges[0].services[0].exported, true);
});
