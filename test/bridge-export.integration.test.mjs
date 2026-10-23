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
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Торшер есть в Алисе?», «какие устройства видит HomeKit?», «добавь
// торшер в HomeKit»: what a bridge (HomeKit, Yandex, Google) exports, read
// and changed without the owner opening the bridge screens. The
// apartment's bridges, read off test/fixtures/homes/apartment.json by a
// person: HomeKit runs and exports the door sensor, the hall light, the
// chandelier, the air conditioner and the bedroom climate sensor's
// temperature; «Яндекс Алиса» does not run (NOT_LOADED, off) and keeps the
// chandelier, the floor lamp and the kitchen light, and cannot export the
// bedside button. A bridge's export is its child list and the child's
// window (research/protocol/2026-10-13-wave4-contracts.md, 3;
// 2026-10-14-bridge-export-write.md).
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const apartment = "spruthub://hub/sim-apartment-01";
const scaled = "spruthub://hub/sim-scaled-01";
const bridge = (home, key) =>
  `${home}/extension/${encodeURIComponent(`Bridge:${key}`)}`;
const service = (home, aId, sId) => `${home}/accessory/${aId}/service/${sId}`;
const childWindow = (home, key, aId) =>
  `${home}/window/${encodeURIComponent(`Bridge/${key}/Child/${aId}/`)}`;

async function setup(t, fixture, { timeoutMs = ORDINARY_HUB_TIMEOUT_MS } = {}) {
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
        SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
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
  // HomeKit runs and does not export the floor lamp; its window and the
  // lamp's checkbox there are what an export would change.
  assert.deepEqual(homekit, {
    ref: bridge(apartment, "homekit"),
    name: "HomeKit",
    type: "homekit",
    state: "LOADED",
    enabled: true,
    running: true,
    exported: false,
    window_ref: childWindow(apartment, "homekit", 16),
    services: [
      {
        ref: service(apartment, 16, 13),
        name: "Свет",
        option_key: "s:13",
        exported: false,
      },
    ],
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
    window_ref: childWindow(apartment, "yandex", 16),
    services: [
      {
        ref: service(apartment, 16, 13),
        name: "Свет",
        option_key: "s:13",
        exported: true,
      },
    ],
  });
  // The services are read from the window of each bridge that lists it.
  assert.deepEqual(childWindowReads(floorLamp.native).sort(), [
    "Bridge/homekit/Child/16/",
    "Bridge/yandex/Child/16/",
  ]);

  // One service of two exported: the climate sensor's temperature only.
  const climate = await read(hub, client, {
    entity_ref: `${apartment}/accessory/25`,
    include: ["bridges"],
  });
  const climateServices = (temperature) => [
    {
      ref: service(apartment, 25, 13),
      name: "Температура",
      option_key: "s:13",
      exported: temperature,
    },
    {
      ref: service(apartment, 25, 20),
      name: "Влажность",
      option_key: "s:20",
      exported: false,
    },
    {
      ref: service(apartment, 25, 90),
      name: "Батарея",
      option_key: "s:90",
      exported: false,
    },
  ];
  assert.deepEqual(climate.entity.bridges, [
    {
      ref: bridge(apartment, "homekit"),
      name: "HomeKit",
      type: "homekit",
      state: "LOADED",
      enabled: true,
      running: true,
      exported: true,
      window_ref: childWindow(apartment, "homekit", 25),
      services: climateServices(true),
    },
    {
      ...climate.entity.bridges[1],
      ref: bridge(apartment, "yandex"),
      running: false,
      exported: false,
      window_ref: childWindow(apartment, "yandex", 25),
      services: climateServices(false),
    },
  ]);
  assert.match(climate.entity.bridges[1].limitation, /not running/i);
  assert.deepEqual(childWindowReads(climate.native).sort(), [
    "Bridge/homekit/Child/25/",
    "Bridge/yandex/Child/25/",
  ]);

  // A bridge that cannot export the accessory says so rather than "not
  // exported", and offers no window to change.
  const button = await read(hub, client, {
    entity_ref: `${apartment}/accessory/39`,
    include: ["bridges"],
  });
  const [buttonHomekit, buttonYandex] = button.entity.bridges;
  assert.equal(buttonHomekit.exported, false);
  assert.equal(Object.hasOwn(buttonHomekit, "exportable"), false);
  assert.equal(buttonHomekit.window_ref, childWindow(apartment, "homekit", 39));
  assert.equal(buttonYandex.exported, false);
  assert.equal(buttonYandex.exportable, false);
  assert.equal(Object.hasOwn(buttonYandex, "window_ref"), false);
  assert.equal(Object.hasOwn(buttonYandex, "services"), false);

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
  // One of the two windows failed: that bridge still says from its list
  // whether it exports the sensor, and gives no services.
  const windowUnread = servicesUnread.entity.bridges.filter((entry) =>
    Object.hasOwn(entry, "services_error_code"),
  );
  assert.equal(windowUnread.length, 1);
  assert.equal(typeof windowUnread[0].exported, "boolean");
  assert.equal(Object.hasOwn(windowUnread[0], "services"), false);
  assert.equal(typeof windowUnread[0].services_error_code, "string");

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

// A bridge lists every accessory it can export, so one missing from a list
// with children cannot be exported. A list with no children at all (the hub
// then omits it, 2026-09-17-extension-child-empty-list) shows nothing about
// one accessory: neither that the bridge cannot export it nor that it does
// not.
test("a bridge that lists no accessories does not say an accessory cannot be exported", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  const homekitBridge = fixture.extensions.find(
    ({ extensionKey }) => extensionKey === "Bridge:homekit",
  );
  homekitBridge.unexportable = fixture.accessories.map(({ id }) => id);
  homekitBridge.exported = {};
  const { hub, client } = await setup(t, fixture);

  const floorLamp = await read(hub, client, {
    entity_ref: `${apartment}/accessory/16`,
    include: ["bridges"],
  });
  const [homekit, yandex] = floorLamp.entity.bridges;
  const { reason, ...unknown } = homekit;
  assert.deepEqual(unknown, {
    ref: bridge(apartment, "homekit"),
    name: "HomeKit",
    type: "homekit",
    state: "LOADED",
    enabled: true,
    running: true,
    exported: null,
    exportable: null,
  });
  assert.match(reason, /lists no accessories/i);
  // The other bridge still answers from its own list.
  assert.equal(yandex.exported, true);
  // The bridge's own read shows the list as it is: empty.
  const homekitChildren = await read(hub, client, {
    entity_ref: bridge(apartment, "homekit"),
    include: ["children"],
  });
  assert.equal(homekitChildren.entity.exported_count, 0);
  assert.deepEqual(homekitChildren.entity.children, []);
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
  // Two bridges, each with its window and the sensor's three services.
  assert.ok(bridgesBytes < 2_000, `${bridgesBytes} bytes`);
  assert.ok(Math.abs(largeRead.bytes - smallRead.bytes) < 64);
  // The list of extensions, each bridge's children and the window of each
  // bridge that lists it: no request per accessory of the home.
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

// «Добавь торшер в HomeKit», «убери люстру из Алисы», «верни как было»: a
// device's service is ticked or unticked in a bridge child's window
// (research/protocol/2026-10-14-bridge-export-write.md), as one prepared
// change per service and bridge, from what the bridges read gives.

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

async function refused(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent;
}

// The prepare input for one service of an accessory in one bridge, from
// the accessory's bridges read.
async function exportInput(hub, client, aId, bridgeKey, sId, value) {
  const { entity } = await read(hub, client, {
    entity_ref: `${apartment}/accessory/${aId}`,
    include: ["bridges"],
  });
  const entry = entity.bridges.find(
    ({ ref }) => ref === bridge(apartment, bridgeKey),
  );
  assert.ok(entry?.window_ref, "the bridges read names the window to change");
  const option = entry.services.find(
    ({ ref }) => ref === service(apartment, aId, sId),
  );
  assert.ok(option?.option_key, "the bridges read names the service's flag");
  return {
    operation: "window_option",
    target_ref: entry.window_ref,
    option_key: option.option_key,
    value,
    reason: "Просьба владельца",
  };
}

const exportWrite = (bridgeKey, aId, sId, value) => ({
  window: {
    update: {
      windowKey: `Bridge/${bridgeKey}/Child/${aId}/`,
      options: [{ key: `s:${sId}`, value: { boolValue: value } }],
    },
  },
});

const writtenSince = (hub, count) =>
  hub
    .writes()
    .slice(count)
    .map(({ params }) => params);

test("a device is added to a running bridge, read back, and undone", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const floorLamp = `${apartment}/accessory/16`;
  const tick = await exportInput(hub, client, 16, "homekit", 13, true);
  assert.equal(tick.target_ref, childWindow(apartment, "homekit", 16));
  const lampInHomekit = {
    device: "Торшер",
    service: "Свет",
    service_ref: service(apartment, 16, 13),
    bridge: "HomeKit",
    bridge_ref: bridge(apartment, "homekit"),
    running: true,
  };

  // The contract and the prepared change name the device and the bridge;
  // nothing is written before apply.
  const contract = await call(client, "get_native_change_contract", {
    operation: tick.operation,
    target_ref: tick.target_ref,
    option_key: tick.option_key,
  });
  assert.deepEqual(contract.bridge_export, lampInHomekit);
  const writes = hub.writes().length;
  const prepared = await call(client, "prepare_native_change", tick);
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.diff.value, {
    from: false,
    to: true,
    kind: "boolValue",
  });
  assert.deepEqual(prepared.bridge_export, lampInHomekit);
  assert.equal(hub.writes().length, writes);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(applied.bridge_export, lampInHomekit);
  assert.deepEqual(writtenSince(hub, writes), [
    exportWrite("homekit", 16, 13, true),
  ]);
  // Only the floor lamp's light in HomeKit changed.
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), [
    { key: "bridge/Bridge:homekit/16.13", before: undefined, after: true },
  ]);
  const after = await read(hub, client, {
    entity_ref: floorLamp,
    include: ["bridges"],
  });
  assert.equal(after.entity.bridges[0].exported, true);
  assert.equal(after.entity.bridges[0].services[0].exported, true);

  // The history of the floor lamp says what changed and where.
  const history = await call(client, "get_native_change", {
    home_ref: apartment,
    entity_ref: floorLamp,
  });
  assert.deepEqual(
    history.changes.map(({ change_ref, name, bridge, value }) => ({
      change_ref,
      name,
      bridge,
      value,
    })),
    [
      {
        change_ref: prepared.change_ref,
        name: "Торшер / Свет",
        bridge: "HomeKit",
        value: { from: false, to: true },
      },
    ],
  );

  // «Верни как было».
  const undone = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone));
  assert.equal(undone.results[0].status, "restored");
  assert.equal(undone.results[0].bridge, "HomeKit");
  assert.deepEqual(writtenSince(hub, writes), [
    exportWrite("homekit", 16, 13, true),
    exportWrite("homekit", 16, 13, false),
  ]);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// «Убери люстру из HomeKit и из Алисы»: one change per bridge; Alice's
// bridge does not run, so its export is kept and served nothing now, and
// the agent is told so before and after.
test("a device is removed from two bridges, one not running, and both are undone together", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const fromHomekit = await call(
    client,
    "prepare_native_change",
    await exportInput(hub, client, 15, "homekit", 13, false),
  );
  const fromAlice = await call(
    client,
    "prepare_native_change",
    await exportInput(hub, client, 15, "yandex", 13, false),
  );
  assert.equal(fromHomekit.bridge_export.running, true);
  assert.equal(Object.hasOwn(fromHomekit.bridge_export, "limitation"), false);
  const { limitation, ...alice } = fromAlice.bridge_export;
  assert.deepEqual(alice, {
    device: "Люстра",
    service: "Люстра",
    service_ref: service(apartment, 15, 13),
    bridge: "Яндекс Алиса",
    bridge_ref: bridge(apartment, "yandex"),
    running: false,
  });
  assert.match(limitation, /not running/i);

  for (const prepared of [fromHomekit, fromAlice]) {
    const applied = await call(client, "apply_native_change", {
      change_ref: prepared.change_ref,
    });
    assert.equal(applied.status, "applied", JSON.stringify(applied));
  }
  assert.match(
    (
      await call(client, "get_native_change", {
        change_ref: fromAlice.change_ref,
      })
    ).bridge_export.limitation,
    /not running/i,
  );
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), [
    { key: "bridge/Bridge:homekit/15.13", before: true, after: undefined },
    { key: "bridge/Bridge:yandex/15.13", before: true, after: undefined },
  ]);
  const removed = await read(hub, client, {
    entity_ref: `${apartment}/accessory/15`,
    include: ["bridges"],
  });
  assert.deepEqual(
    removed.entity.bridges.map(({ exported }) => exported),
    [false, false],
  );
  assert.match(removed.entity.bridges[1].limitation, /not running/i);

  const undone = await call(client, "restore_native_change", {
    change_refs: [fromHomekit.change_ref, fromAlice.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone));
  assert.deepEqual(
    undone.results.map(({ bridge, status }) => [bridge, status]).sort(),
    [
      ["HomeKit", "restored"],
      ["Яндекс Алиса", "restored"],
    ],
  );
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// The hub stores the tick but its answer is lost, as once on the owner's
// running «Yandex» (2026-10-14-bridge-export-write 10): the window read
// decides, and an unknown outcome is not reported as nothing done.
test("a bridge export whose answer is lost is found done by reading the window", async (t) => {
  const { hub, client } = await setup(t, undefined, { timeoutMs: 2_000 });
  const initial = hub.snapshot();
  const prepared = await call(
    client,
    "prepare_native_change",
    await exportInput(hub, client, 16, "homekit", 13, true),
  );
  hub.state.faults.droppedReply.push({ method: "window.update", remaining: 1 });
  // The client times out on the write and reads the window back.
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(applied.verification.result, "requested_value_observed");
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), [
    { key: "bridge/Bridge:homekit/16.13", before: undefined, after: true },
  ]);
  const read16 = await read(hub, client, {
    entity_ref: `${apartment}/accessory/16`,
    include: ["bridges"],
  });
  assert.equal(read16.entity.bridges[0].services[0].exported, true);

  const undone = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });
  assert.equal(undone.results[0].status, "restored", JSON.stringify(undone));
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// A bridge exports what its child window offers: a bridge that does not
// list the accessory has no window for it, and a service without a
// checkbox is not exported by that bridge. The agent learns why before
// anything is sent. Yandex's bridge offers no checkbox for a filter
// (2026-10-14-bridge-export-write 12); the apartment's Alice bridge does
// not list the bedside button.
test("a service or device a bridge cannot export is refused with the reason", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  const breezer = fixture.accessories.find(({ id }) => id === 28);
  breezer.services.push({
    sId: 20,
    type: "FilterMaintenance",
    name: "Фильтр",
    characteristics: [
      { cId: 21, type: "FilterChangeIndication", value: 0 },
      { cId: 22, type: "FilterLifeLevel", value: 80 },
    ],
  });
  const { hub, client } = await setup(t, fixture);

  const read28 = await read(hub, client, {
    entity_ref: `${apartment}/accessory/28`,
    include: ["bridges"],
  });
  const [homekit, yandex] = read28.entity.bridges;
  assert.deepEqual(
    homekit.services.map(({ name, option_key }) => [name, option_key]),
    [
      ["Бризер", "s:13"],
      ["Фильтр", "s:20"],
    ],
  );
  assert.deepEqual(yandex.services, [
    {
      ref: service(apartment, 28, 13),
      name: "Бризер",
      option_key: "s:13",
      exported: false,
    },
    { ref: service(apartment, 28, 20), name: "Фильтр", exportable: false },
  ]);

  const breezerBridges = {
    tool: "get_entity",
    arguments: {
      entity_ref: `${apartment}/accessory/28`,
      include: ["bridges"],
    },
  };
  const filter = {
    operation: "window_option",
    target_ref: yandex.window_ref,
    option_key: "s:20",
  };
  for (const [name, args] of [
    ["get_native_change_contract", filter],
    [
      "prepare_native_change",
      { ...filter, value: true, reason: "Добавить фильтр в Алису" },
    ],
  ]) {
    const { error, next } = await refused(client, name, args);
    assert.equal(error.code, "bridge_service_not_exportable", name);
    assert.match(error.message, /Яндекс Алиса/);
    assert.match(error.message, /Фильтр/);
    assert.match(error.message, /Бризер/);
    assert.match(error.message, /Nothing was sent/);
    assert.deepEqual(next, breezerBridges);
  }

  const button = {
    operation: "window_option",
    target_ref: childWindow(apartment, "yandex", 39),
    option_key: "s:13",
    value: true,
    reason: "Добавить кнопку в Алису",
  };
  const { error, next } = await refused(
    client,
    "prepare_native_change",
    button,
  );
  assert.equal(error.code, "bridge_export_unavailable");
  assert.match(error.message, /Яндекс Алиса/);
  assert.match(error.message, /Кнопка у кровати/);
  assert.deepEqual(next, {
    tool: "get_entity",
    arguments: {
      entity_ref: `${apartment}/accessory/39`,
      include: ["bridges"],
    },
  });

  assert.deepEqual(hub.writes(), []);
  const changes = await call(client, "get_native_change", {
    home_ref: apartment,
  });
  assert.deepEqual(changes.changes, []);
});

// The owner ticks the floor lamp in HomeKit in the app between prepare and
// apply: apply writes nothing and says the baseline changed. After an
// applied change the owner unticks it by hand: «верни как было» writes
// nothing and says it is already as before.
test("an owner's change of a bridge export is reported and not written over", async (t) => {
  const { hub, client } = await setup(t);
  const prepared = await call(
    client,
    "prepare_native_change",
    await exportInput(hub, client, 16, "homekit", 13, true),
  );
  hub.request(exportWrite("homekit", 16, 13, true));
  const writes = hub.writes().length;
  const conflict = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(conflict.status, "conflict", JSON.stringify(conflict));
  assert.equal(conflict.conflict_reason, "baseline_changed");
  assert.equal(conflict.native_write_sent, false);
  assert.deepEqual(writtenSince(hub, writes), []);
  assert.equal(hub.snapshot()["bridge/Bridge:homekit/16.13"], true);

  const kitchen = await call(
    client,
    "prepare_native_change",
    await exportInput(hub, client, 22, "homekit", 13, true),
  );
  const applied = await call(client, "apply_native_change", {
    change_ref: kitchen.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  hub.request(exportWrite("homekit", 22, 13, false));
  const beforeUndo = hub.writes().length;
  const undone = await call(client, "restore_native_change", {
    change_refs: [kitchen.change_ref],
  });
  assert.deepEqual(
    undone.results.map(({ status, reason, already_previous, sent }) => ({
      status,
      reason,
      already_previous,
      sent,
    })),
    [
      {
        status: "skipped",
        reason: "changed_since",
        already_previous: true,
        sent: false,
      },
    ],
  );
  assert.deepEqual(writtenSince(hub, beforeUndo), []);
  assert.equal(hub.snapshot()["bridge/Bridge:homekit/22.13"], undefined);
});

// What the probe did not cover stays refused: which new accessories a
// bridge takes (its own window's AutoAddNewAccessory). The child window's
// checkbox is offered, the bridge's own setting is not.
test("a bridge's own setting for new accessories is still not written", async (t) => {
  const { hub, client } = await setup(t);
  const childOptions = await read(hub, client, {
    entity_ref: childWindow(apartment, "homekit", 16),
  });
  const flag = childOptions.entity.options.find(({ key }) => key === "s:13");
  assert.equal(flag.native_change.supported, true);

  const homekit = await read(hub, client, {
    entity_ref: bridge(apartment, "homekit"),
  });
  const bridgeWindow = await read(hub, client, {
    entity_ref: homekit.entity.options_window_ref,
  });
  const autoAddOption = bridgeWindow.entity.options.find(
    ({ key }) => key === "AutoAddNewAccessory",
  );
  assert.equal(autoAddOption.native_change.supported, false);
  assert.equal(autoAddOption.native_change.reason, "bridge_export_unverified");

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
  for (const [name, args] of [
    ["get_native_change_contract", autoAdd],
    [
      "prepare_native_change",
      { ...autoAdd, value: true, reason: "Export new accessories to HomeKit" },
    ],
  ]) {
    const { error, next } = await refused(client, name, args);
    assert.equal(error.code, "bridge_export_unverified", name);
    assert.match(error.message, /SprutHub app/);
    assert.deepEqual(next, bridgeExport);
  }
  assert.deepEqual(hub.writes(), []);
});

// A change of AutoAddNewAccessory journaled before prepare refused it, by
// an earlier version: apply and restore refuse it as prepare does, before
// anything is sent, and the records stay as they were. The records are
// made on the floor lamp's device setting and recast onto the bridge, as
// such a version would have saved them.
test("a bridge setting change journaled earlier is neither applied nor restored", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const lampSetting = {
    operation: "window_option",
    target_ref: `${apartment}/window/${encodeURIComponent("Controller/zigbee/Child/000d6ffffe3c4a16/")}`,
    option_key: "/11/0006_OnOff/4003_StartUpOnOff/255",
    reason: "Set how the floor lamp starts after a power cut",
  };
  const prepared = async (value) =>
    (await call(client, "prepare_native_change", { ...lampSetting, value }))
      .change_ref;
  const applied = async (value) => {
    const changeRef = await prepared(value);
    const result = await call(client, "apply_native_change", {
      change_ref: changeRef,
    });
    assert.equal(result.status, "applied");
    return changeRef;
  };
  const autoAddOn = await prepared(1);
  const autoAddBack = await applied(0);

  const file = journalFile(hub, stateDirectory);
  const journal = JSON.parse(await readFile(file, "utf8"));
  const recast = (changeRef, baseline, requested) => {
    const change = journal.changes[changeRef.split("/").at(-1)];
    Object.assign(change, {
      target_ref: `${apartment}/window/${encodeURIComponent("Bridge/homekit/")}`,
      target: { kind: "window", windowKey: "Bridge/homekit/" },
      option_key: "AutoAddNewAccessory",
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
  // HomeKit's AutoAddNewAccessory is off.
  recast(autoAddOn, false, true);
  recast(autoAddBack, true, false);
  await writeFile(file, `${JSON.stringify(journal, null, 2)}\n`);
  const writesBefore = hub.writes().length;

  const homekitExport = {
    tool: "get_entity",
    arguments: {
      entity_ref: bridge(apartment, "homekit"),
      include: ["children"],
    },
  };
  for (const [name, changeRef] of [
    ["apply_native_change", autoAddOn],
    ["restore_native_change", autoAddBack],
  ]) {
    const { error, next } = await refused(client, name, {
      change_ref: changeRef,
    });
    assert.equal(error.code, "bridge_export_unverified", name);
    assert.match(error.message, /SprutHub app/);
    assert.deepEqual(next, homekitExport, name);
  }

  assert.equal(hub.writes().length, writesBefore);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), journal);
});
