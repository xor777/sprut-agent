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

// find_devices answers household questions about devices: what is on, what
// is in a room, which lights, which sensors. Its answer follows the question:
// it lists the matched services only and reads values for them only.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function setup(t, fixture) {
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-find-devices-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "3000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "find-devices-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const call = async (name, args) => {
    const before = hub.requests.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
    return {
      body: result.structuredContent,
      bytes: Buffer.byteLength(result.content[0].text),
      native: hub.requests.slice(before),
    };
  };
  const callError = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, result.content[0]?.text);
    return result.structuredContent;
  };
  return { hub, client, call, callError, home: homeRefOf(hub) };
}

function homeRefOf(hub) {
  return `spruthub://hub/${encodeURIComponent(hub.serial)}`;
}

// Services of a find_devices page with their room and device.
function listed(body) {
  return body.rooms.flatMap((room) =>
    room.devices.flatMap((device) =>
      device.services.map((service) => ({ room, device, service })),
    ),
  );
}

function methods(native) {
  return native.map(({ method, params }) =>
    method === "accessory.list" && params.accessory.list.roomId !== undefined
      ? "accessory.list{roomId}"
      : method,
  );
}

function readingOf(service, type) {
  return service.values.find((value) => value.type === type);
}

// Independent of the product: the services the simulator holds as on.
function servicesOnInState(state, home) {
  return state.accessories.flatMap((accessory) =>
    accessory.services
      .filter((service) =>
        service.characteristics.some(
          ({ control }) =>
            (control.type === "On" && control.value.boolValue === true) ||
            (control.type === "Active" && control.value.intValue === 1) ||
            (control.type === "TargetHeatingCoolingState" &&
              control.value.intValue !== 0),
        ),
      )
      .map(
        (service) => `${home}/accessory/${accessory.id}/service/${service.sId}`,
      ),
  );
}

test("find_devices state=on lists every service that is on, air purifiers included", async (t) => {
  const { hub, call, home } = await setup(t, await loadHomeFixture("house"));

  const { body, bytes, native } = await call("find_devices", { state: "on" });

  const on = listed(body);
  assert.deepEqual(
    on.map(({ service }) => service.ref).sort(),
    servicesOnInState(hub.state, home).sort(),
  );
  assert.equal(body.total, on.length);
  assert.equal(body.next, null);
  // One entry per room, in the home's room order, although the hub lists
  // devices of one room apart.
  const roomOrder = hub.state.rooms.map(({ id }) => `${home}/room/${id}`);
  assert.deepEqual(
    body.rooms.map(({ ref }) => ref),
    roomOrder.filter((ref) => on.some(({ room }) => room.ref === ref)),
  );
  assert(on.every(({ service }) => service.on === true));
  const byDevice = (name) =>
    on
      .filter(({ device }) => device.name === name)
      .map(({ service }) => service);
  assert.deepEqual(
    byDevice("Бризер").map(({ type, kind, on_basis: basis }) => ({
      type,
      kind,
      basis,
    })),
    [{ type: "AirPurifier", kind: "air", basis: "Active" }],
  );
  assert.equal(byDevice("Очиститель воздуха")[0].on_basis, "Active");
  assert.equal(byDevice("Люстра")[0].on_basis, "On");
  // A relay's kind comes from its native type, not from its name.
  assert.deepEqual(
    byDevice("Выключатель гостиной").map(({ name, kind }) => [name, kind]),
    [
      ["Споты", "switch"],
      ["Вентиляция", "switch"],
    ],
  );
  // The air conditioner is in mode OFF and the open curtains are not "on".
  assert.deepEqual(byDevice("Кондиционер"), []);
  assert.deepEqual(byDevice("Шторы в гостиной"), []);
  // Devices without on/off, the alarm included, are counted, not dropped
  // or listed as unknown.
  assert(body.not_applicable.sensor > 0);
  assert(body.not_applicable.cover > 0);
  assert(body.not_applicable.button > 0);
  assert.equal(body.not_applicable.security, 1);
  assert.deepEqual(body.not_evaluated, []);
  assert.equal(body.not_evaluated_total, 0);
  assert.equal(JSON.stringify(body).includes("AccessoryInformation"), false);
  assert.match(body.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.catalog_observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert(bytes < 12_000, `state=on returned ${bytes} bytes`);
  assert.deepEqual(
    methods(native).filter((m) => m === "accessory.get"),
    [],
  );
  assert.deepEqual(hub.writes(), []);
});

// Native types of an appliance whose own settings a Switch or Outlet on the
// same accessory may be; independent of the product's table.
const APPLIANCE_TYPES = new Set([
  "Thermostat",
  "HeaterCooler",
  "AirPurifier",
  "HumidifierDehumidifier",
]);

// Independent of the product: refs of the services of these native types
// that the simulator holds as on; Switch and Outlet only when they are not
// on an appliance.
function standaloneOn(state, home, types) {
  return state.accessories.flatMap((accessory) => {
    const appliance = accessory.services.some(({ type }) =>
      APPLIANCE_TYPES.has(type),
    );
    return accessory.services
      .filter(
        (service) =>
          types.includes(service.type) &&
          !(appliance && ["Switch", "Outlet"].includes(service.type)) &&
          service.characteristics.some(
            ({ control }) =>
              control.type === "On" && control.value.boolValue === true,
          ),
      )
      .map(
        (service) => `${home}/accessory/${accessory.id}/service/${service.sId}`,
      );
  });
}

// Service refs of a switches section: its entries, or every page of its
// next call when the entries are not all.
async function allSwitches(call, section) {
  if (!section.next) return section.entries.map(({ ref }) => ref);
  const refs = [];
  let next = section.next;
  while (next) {
    const page = await call(next.tool, next.arguments);
    refs.push(...listed(page.body).map(({ service }) => service.ref));
    next = page.body.next;
  }
  return refs;
}

test("living-room lights list the lamps and beside them the room's relays, picked by name", async (t) => {
  const { hub, call, home } = await setup(t, await loadHomeFixture("house"));
  const living = `${home}/room/3`;

  const { body } = await call("find_devices", {
    room_ref: living,
    kind: "light",
  });

  assert.deepEqual(
    listed(body).map(({ device, service }) => [
      device.name,
      service.name,
      service.type,
    ]),
    [
      ["Люстра", "Люстра", "Lightbulb"],
      ["Торшер", "Свет", "Lightbulb"],
      ["Светодиодная лента", "Лента", "Lightbulb"],
    ],
  );
  // The room's relays and sockets: their names, not the tool, say which of
  // them drive lamps.
  const relays = body.switches;
  assert.deepEqual(
    relays.entries.map(({ device, name, room, on }) => [
      device,
      name,
      room,
      on,
    ]),
    [
      ["Розетка телевизора", "Розетка", "Гостиная", true],
      ["Выключатель гостиной", "Споты", "Гостиная", true],
      ["Выключатель гостиной", "Подсветка ниши", "Гостиная", false],
      ["Выключатель гостиной", "Вентиляция", "Гостиная", true],
    ],
  );
  assert.equal(relays.total, 4);
  assert.equal(Object.hasOwn(relays, "next"), false);
  assert.equal(typeof relays.note, "string");

  // «Выключи весь свет в гостиной»: the lamps that are on and, chosen by
  // name, the spots relay.
  const commands = [
    ...listed(body)
      .filter(({ service }) => service.on === true)
      .map(({ service }) => readingOf(service, "On").ref),
    ...relays.entries
      .filter(({ name, on }) => on && /^(Споты|Подсветка)/.test(name))
      .map(({ on_ref: ref }) => ref),
  ].map((ref) => ({ target_ref: ref, value: false }));
  assert.equal(commands.length, 3);
  const sent = await call("send_device_commands", {
    home_ref: home,
    commands,
    reason: "Выключи весь свет в гостиной",
  });
  assert.deepEqual(
    sent.body.results.map(({ status }) => status),
    ["applied", "applied", "applied"],
  );

  const after = await call("find_devices", {
    room_ref: living,
    kind: "light",
    state: "on",
  });
  assert.equal(after.body.total, 0);
  assert.deepEqual(
    after.body.switches.entries.map(({ device, name }) => [device, name]),
    [
      ["Розетка телевизора", "Розетка"],
      ["Выключатель гостиной", "Вентиляция"],
    ],
  );
  const ventilation = hub.state.accessories
    .find(({ name }) => name === "Выключатель гостиной")
    .services.find(({ name }) => name === "Вентиляция");
  assert.equal(ventilation.characteristics[0].control.value.boolValue, true);
});

test("switches of an air conditioner are its functions: never on for the house and never offered as lights", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  // The air conditioner is in mode OFF; its display and sound stay on.
  fixture.accessories
    .find(({ id }) => id === 19)
    .services.push(
      {
        sId: 20,
        type: "Switch",
        name: "Дисплей",
        characteristics: [{ cId: 21, type: "On", value: true }],
      },
      {
        sId: 22,
        type: "Switch",
        name: "Звук",
        characteristics: [{ cId: 23, type: "On", value: true }],
      },
      {
        sId: 24,
        type: "Switch",
        name: "Тихий режим",
        characteristics: [{ cId: 25, type: "On", value: false }],
      },
    );
  const { hub, call, home } = await setup(t, fixture);
  const living = `${home}/room/3`;
  const conditioner = `${home}/accessory/19`;
  const ofConditioner = (body) =>
    listed(body).filter(({ device }) => device.ref === conditioner);

  const climateOn = await call("find_devices", {
    kind: "climate",
    state: "on",
  });
  assert.equal(climateOn.body.total, 0);

  const on = await call("find_devices", { state: "on" });
  assert.deepEqual(ofConditioner(on.body), []);
  assert.equal(on.body.device_functions, 3);
  assert.deepEqual(
    listed(on.body)
      .map(({ service }) => service.ref)
      .sort(),
    servicesOnInState(hub.state, home)
      .filter((ref) => !ref.startsWith(`${conditioner}/`))
      .sort(),
  );

  const switchesOn = await call("find_devices", {
    kind: "switch",
    state: "on",
  });
  assert.deepEqual(
    listed(switchesOn.body).map(({ device }) => device.name),
    ["Розетка телевизора", "Розетка компьютера"],
  );
  assert.equal(switchesOn.body.device_functions, 3);

  const summary = await call("find_devices", {});
  assert.deepEqual(
    summary.body.rooms.find(({ ref }) => ref === living),
    { ref: living, name: "Гостиная", services: 9, on: 3, unavailable: 0 },
  );

  const lights = await call("find_devices", {
    room_ref: living,
    kind: "light",
    state: "on",
  });
  assert.deepEqual(
    lights.body.switches.entries.map(({ device, name }) => [device, name]),
    [["Розетка телевизора", "Розетка"]],
  );

  // By name a function is found with its device, state and writable On.
  const display = await call("find_devices", {
    query: "дисплей кондиционера",
  });
  const [entry] = listed(display.body);
  assert.deepEqual(
    {
      name: entry.service.name,
      kind: entry.service.kind,
      function_of: entry.service.function_of,
      on: entry.service.on,
    },
    {
      name: "Дисплей",
      kind: "switch",
      function_of: {
        kind: "climate",
        service_ref: `${conditioner}/service/13`,
      },
      on: true,
    },
  );
  assert.equal(readingOf(entry.service, "On").writable, true);
});

test("a relay's generic channel beside its fan channel stays a relay", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  // A two-channel relay: the owner set channel 1 to a fan, channel 2 kept
  // its generic name.
  fixture.accessories.push({
    id: 42,
    roomId: 8,
    name: "Реле ванной",
    extensionKey: "Controller:zigbee",
    deviceId: "00158d0004a1b242",
    services: [
      {
        sId: 13,
        type: "Fan",
        name: "Вытяжка",
        characteristics: [{ cId: 14, type: "On", value: false }],
      },
      {
        sId: 15,
        type: "Switch",
        name: "Канал 2",
        characteristics: [{ cId: 16, type: "On", value: true }],
      },
    ],
  });
  const { call, home } = await setup(t, fixture);
  const bathroom = `${home}/room/8`;

  const air = await call("find_devices", { kind: "air", room_ref: bathroom });
  assert.deepEqual(
    listed(air.body).map(({ device, service }) => [device.name, service.name]),
    [
      ["Вытяжка", "Вытяжка"],
      ["Реле ванной", "Вытяжка"],
    ],
  );

  const on = await call("find_devices", { state: "on", room_ref: bathroom });
  const [channel] = listed(on.body);
  assert.deepEqual(
    [channel.service.name, channel.service.kind, channel.service.function_of],
    ["Канал 2", "switch", undefined],
  );
  assert.equal(Object.hasOwn(on.body, "device_functions"), false);

  const lights = await call("find_devices", {
    kind: "light",
    room_ref: bathroom,
    state: "on",
  });
  assert.equal(lights.body.total, 0);
  assert.deepEqual(
    lights.body.switches.entries.map(({ device, name, on: value }) => [
      device,
      name,
      value,
    ]),
    [["Реле ванной", "Канал 2", true]],
  );
});

test("a light question in words lists the room's lamps whatever their names and its neutral relays beside them", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  // A relay channel with a neutral name that may drive a kitchen lamp.
  fixture.accessories.push({
    id: 41,
    roomId: 4,
    name: "Реле 2",
    extensionKey: "Controller:zigbee",
    deviceId: "00158d0004a1b241",
    services: [
      {
        sId: 13,
        type: "Switch",
        name: "Канал 1",
        characteristics: [{ cId: 14, type: "On", value: true }],
      },
    ],
  });
  // A kitchen lamp whose name says nothing of light.
  fixture.accessories.push({
    id: 43,
    roomId: 4,
    name: "Подвес над столом",
    extensionKey: "Controller:zigbee",
    deviceId: "00158d0004a1b243",
    services: [
      {
        sId: 13,
        type: "Lightbulb",
        name: "Подвес",
        characteristics: [{ cId: 14, type: "On", value: true }],
      },
    ],
  });
  const { call, home } = await setup(t, fixture);

  const { body } = await call("find_devices", {
    query: "свет на кухне",
    state: "on",
  });

  assert.deepEqual(
    listed(body).map(({ device, service }) => [device.name, service.name]),
    [
      ["Свет на кухне", "Свет"],
      ["Подвес над столом", "Подвес"],
    ],
  );
  assert.deepEqual(body.switches.entries, [
    {
      ref: `${home}/accessory/41/service/13`,
      name: "Канал 1",
      device: "Реле 2",
      room: "Кухня",
      on: true,
      on_ref: `${home}/accessory/41/service/13/characteristic/14`,
    },
  ]);
  assert.equal(body.switches.total, 1);

  // A question that is not about light carries no relays.
  const temperature = await call("find_devices", {
    query: "температура на кухне",
  });
  assert.equal(Object.hasOwn(temperature.body, "switches"), false);
});

test("kind=light lists lamps and counts every relay that is on, with a call for the rest", async (t) => {
  const { hub, call, home } = await setup(t, await loadHomeFixture("house"));

  const on = await call("find_devices", { kind: "light", state: "on" });

  assert.deepEqual(
    listed(on.body)
      .map(({ service }) => service.ref)
      .sort(),
    standaloneOn(hub.state, home, ["Lightbulb"]).sort(),
  );
  const relaysOn = standaloneOn(hub.state, home, ["Switch", "Outlet"]);
  assert.equal(on.body.switches.total, relaysOn.length);
  assert.deepEqual(
    (await allSwitches(call, on.body.switches)).sort(),
    relaysOn.sort(),
  );
  assert(
    on.body.switches.entries.some(
      ({ device, name }) =>
        device === "Выключатель кухни" && name === "Споты кухня",
    ),
  );

  // Without a state filter the house has more relays than one list shows:
  // the next call lists them all.
  const all = await call("find_devices", { kind: "light", values: false });
  const relays = hub.state.accessories.flatMap(({ id, services }) =>
    services
      .filter(({ type }) => type === "Switch" || type === "Outlet")
      .map(({ sId }) => `${home}/accessory/${id}/service/${sId}`),
  );
  assert.equal(all.body.switches.total, relays.length);
  assert(all.body.switches.entries.length < relays.length);
  assert.deepEqual(all.body.switches.next, {
    tool: "find_devices",
    arguments: { home_ref: home, kind: "switch", values: false },
  });
  assert.deepEqual(
    (await allSwitches(call, all.body.switches)).sort(),
    relays.sort(),
  );
});

// Independent of the product: refs of the simulator's services that pass
// keep, which gets the service, its accessory and the words of the service,
// device and room names.
function servicesWhere(state, home, keep) {
  return state.accessories.flatMap((accessory) => {
    const room = state.rooms.find(({ id }) => id === accessory.roomId);
    return accessory.services
      .filter((service) =>
        keep({
          service,
          accessory,
          words: `${service.name} ${accessory.name} ${room?.name ?? ""}`
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u),
        }),
      )
      .map(({ sId }) => `${home}/accessory/${accessory.id}/service/${sId}`);
  });
}

const named = (words, ...starts) =>
  starts.every((start) => words.some((word) => word.startsWith(start)));
const isLamp = ({ service }) => service.type === "Lightbulb";
const isOn = ({ service }) =>
  service.characteristics.some(
    ({ control }) => control.type === "On" && control.value.boolValue === true,
  );

// Service refs of a find_devices answer: its page, or every page.
async function allListed(call, body) {
  const refs = listed(body).map(({ service }) => service.ref);
  let next = body.next;
  while (next) {
    const page = await call(next.tool, next.arguments);
    refs.push(...listed(page.body).map(({ service }) => service.ref));
    next = page.body.next;
  }
  return refs;
}

test("a light word classifies the question: lamps are found by type, not by the light word in their names", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("house"));
  const home = homeRefOf(hub);
  const expected = (keep) => servicesWhere(hub.state, home, keep).sort();
  const answer = async (args) =>
    (await allListed(call, (await call("find_devices", args)).body)).sort();

  // «Какой свет горит в гостиной»: the chandelier is a lamp that is on,
  // though no word of its names starts with "свет".
  const livingOn = await call("find_devices", {
    query: "свет в гостиной",
    state: "on",
  });
  assert.deepEqual(
    (await allListed(call, livingOn.body)).sort(),
    expected(
      (item) =>
        isOn(item) &&
        ((isLamp(item) && named(item.words, "гостин")) ||
          named(item.words, "свет", "гостин")),
    ),
  );
  assert(listed(livingOn.body).some(({ device }) => device.name === "Люстра"));
  assert.equal(Object.hasOwn(livingOn.body, "query_words"), false);
  // The relays beside them are the room's other relays that are on.
  const living = new Set(
    listed(livingOn.body).map(({ service }) => service.ref),
  );
  assert.deepEqual(
    (await allSwitches(call, livingOn.body.switches)).sort(),
    expected(
      (item) =>
        isOn(item) &&
        ["Switch", "Outlet"].includes(item.service.type) &&
        named(item.words, "гостин"),
    ).filter((ref) => !living.has(ref)),
  );

  assert.deepEqual(
    await answer({ kind: "light", query: "свет в гостиной" }),
    expected((item) => isLamp(item) && named(item.words, "гостин")),
  );

  // «Где горит свет»: every lamp that is on, and whatever else with "свет"
  // in its names is on.
  assert.deepEqual(
    await answer({ query: "свет", state: "on" }),
    expected(
      (item) => isOn(item) && (isLamp(item) || named(item.words, "свет")),
    ),
  );

  assert.deepEqual(
    await answer({ query: "лампы в гостиной", state: "on" }),
    expected(
      (item) =>
        isOn(item) &&
        ((isLamp(item) && named(item.words, "гостин")) ||
          named(item.words, "ламп", "гостин")),
    ),
  );

  // A light word in a lamp's own name still finds it: the other word
  // filters.
  const stairs = await answer({ query: "подсветка лестницы" });
  assert.deepEqual(
    stairs,
    expected(
      (item) =>
        (isLamp(item) && named(item.words, "лестниц")) ||
        named(item.words, "подсветк", "лестниц"),
    ),
  );
  const stairsLight = hub.state.accessories.find(
    ({ name }) => name === "Подсветка лестницы",
  );
  assert(
    stairs.includes(
      `${home}/accessory/${stairsLight.id}/service/${stairsLight.services[0].sId}`,
    ),
  );
});

test("a room word finds both bedrooms' sensors with battery inline and technical services hidden", async (t) => {
  const { call, home } = await setup(t, await loadHomeFixture("apartment"));

  const { body } = await call("find_devices", {
    query: "в спальне",
    kind: "sensor",
  });

  assert.deepEqual(
    body.rooms.map(({ ref, name, matches }) => ({ ref, name, matches })),
    [
      { ref: `${home}/room/5`, name: "Спальня", matches: 2 },
      { ref: `${home}/room/6`, name: "Детская спальня", matches: 3 },
    ],
  );
  const [bedroom, nursery] = body.rooms;
  assert.deepEqual(
    bedroom.devices.map(({ name, available, battery_percent }) => ({
      name,
      available,
      battery_percent,
    })),
    [
      {
        name: "Датчик климата в спальне",
        available: true,
        battery_percent: 70,
      },
    ],
  );
  const bedroomTemperature = readingOf(
    bedroom.devices[0].services[0],
    "CurrentTemperature",
  );
  assert.deepEqual(
    { value: bedroomTemperature.value, unit: bedroomTemperature.unit },
    { value: 21.4, unit: "°C" },
  );
  assert.equal(
    readingOf(nursery.devices[0].services[0], "CurrentTemperature").value,
    23.8,
  );
  assert.equal(
    listed(body).some(({ service }) =>
      ["AccessoryInformation", "BatteryService"].includes(service.type),
    ),
    false,
  );

  const technical = await call("find_devices", {
    room_ref: `${home}/room/5`,
    query: "климат",
    include_technical: true,
  });
  assert.deepEqual(
    listed(technical.body).map(({ service }) => [service.type, service.kind]),
    [
      ["AccessoryInformation", "technical"],
      ["TemperatureSensor", "sensor"],
      ["HumiditySensor", "sensor"],
      ["BatteryService", "technical"],
    ],
  );
});

test("everyday phrases with prepositions find the room's devices", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  fixture.accessories.push({
    id: 40,
    roomId: 30,
    name: "Гирлянда",
    extensionKey: "Controller:zigbee",
    deviceId: "00158d0004a1b240",
    services: [
      {
        sId: 13,
        type: "Outlet",
        name: "Гирлянда",
        characteristics: [{ cId: 14, type: "On", value: true }],
      },
    ],
  });
  const { hub, call, home } = await setup(t, fixture);
  const technical = new Set(["AccessoryInformation", "BatteryService"]);
  const kitchenServices = hub.state.accessories
    .filter(({ roomId }) => roomId === 4)
    .flatMap(({ id, services }) =>
      services
        .filter(({ type }) => !technical.has(type))
        .map(({ sId }) => `${home}/accessory/${id}/service/${sId}`),
    );
  assert.equal(kitchenServices.length, 5);

  const kitchen = await call("find_devices", { query: "на кухне" });
  assert.deepEqual(
    listed(kitchen.body)
      .map(({ service }) => service.ref)
      .sort(),
    kitchenServices.sort(),
  );

  const outlet = await call("find_devices", { query: "розетка на кухне" });
  assert.deepEqual(
    listed(outlet.body).map(({ device, service }) => [
      device.name,
      service.name,
    ]),
    [["Розетка чайника", "Розетка"]],
  );

  const garland = await call("find_devices", {
    query: "гирлянда на балконе",
  });
  assert.deepEqual(
    listed(garland.body).map(({ room, device }) => [room.name, device.name]),
    [["Балкон", "Гирлянда"]],
  );
});

test("query words match at the start of a word, not inside one", async (t) => {
  const { call } = await setup(t, await loadHomeFixture("apartment"));

  // "не" stays in the query (a name filter cannot negate) and occurs inside
  // "кухне"; it must not find the lamp named «Свет на кухне».
  const negated = await call("find_devices", { query: "свет не на кухне" });
  assert.deepEqual(listed(negated.body), []);

  // Word forms still match at word starts.
  const kitchen = await call("find_devices", { query: "свет на кухне" });
  assert.deepEqual(
    listed(kitchen.body).map(({ device }) => device.name),
    ["Свет на кухне"],
  );
  const nursery = await call("find_devices", { query: "свет в детской" });
  assert.deepEqual(
    listed(nursery.body).map(({ room, device }) => [room.name, device.name]),
    [["Детская спальня", "Свет в детской"]],
  );
});

test("a query of several words that finds nothing says which words match alone", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  // Independent of the product: non-technical services with a word of the
  // service, device or room name that starts with the given text.
  const withWord = (start) =>
    hub.state.accessories.flatMap((accessory) => {
      const room = hub.state.rooms.find(({ id }) => id === accessory.roomId);
      return accessory.services.filter(
        ({ type, name }) =>
          !["AccessoryInformation", "BatteryService"].includes(type) &&
          `${name} ${accessory.name} ${room?.name ?? ""}`
            .toLowerCase()
            .split(/\s+/)
            .some((word) => word.startsWith(start)),
      );
    }).length;

  // No name has both words: the balcony has no light.
  const balcony = await call("find_devices", { query: "свет на балконе" });
  assert.equal(balcony.body.total, 0);
  assert.deepEqual(balcony.body.query_words, {
    matching_all: 0,
    matching_each: { свет: withWord("свет"), балконе: 0 },
  });

  // Both words name the kitchen lamp, which is on: nothing of it is off.
  const off = await call("find_devices", {
    query: "свет на кухне",
    state: "off",
  });
  assert.equal(off.body.total, 0);
  assert.deepEqual(off.body.query_words, {
    matching_all: 1,
    matching_each: { свет: withWord("свет"), кухне: withWord("кухн") },
  });

  // One word or a found answer needs no breakdown.
  const garage = await call("find_devices", { query: "гараж" });
  assert.equal(Object.hasOwn(garage.body, "query_words"), false);
  const on = await call("find_devices", {
    query: "свет на кухне",
    state: "on",
  });
  assert.equal(on.body.total, 1);
  assert.equal(Object.hasOwn(on.body, "query_words"), false);
});

test("without filters find_devices sums services, on and unavailable per room", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );

  const { body } = await call("find_devices", {});

  assert.equal(Object.hasOwn(body, "next"), false);
  assert.deepEqual(
    body.rooms.find(({ name }) => name === "Гостиная"),
    {
      ref: `${home}/room/3`,
      name: "Гостиная",
      services: 6,
      on: 3,
      unavailable: 0,
    },
  );
  assert.deepEqual(
    body.rooms.find(({ name }) => name === "Кабинет"),
    {
      ref: `${home}/room/7`,
      name: "Кабинет",
      services: 3,
      on: 2,
      unavailable: 1,
    },
  );
  assert.deepEqual(body.rooms.at(-1), {
    ref: `${home}/room/30`,
    name: "Балкон",
    services: 0,
    on: 0,
    unavailable: 0,
  });
  const technical = new Set(["AccessoryInformation", "BatteryService"]);
  assert.equal(
    body.services,
    hub.state.accessories
      .flatMap(({ services }) => services)
      .filter(({ type }) => !technical.has(type)).length,
  );
  assert.equal(body.on, servicesOnInState(hub.state, home).length);
  assert.equal(body.unavailable, 2);
});

test("unknown values, unavailable devices and hidden services are reported, not dropped", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  // Twelve alarm zones listed first by the hub: writable, without on/off.
  for (let zone = 12; zone >= 1; zone -= 1) {
    fixture.accessories.unshift({
      id: 200 + zone,
      roomId: 1,
      name: `Охрана зона ${zone}`,
      extensionKey: "Controller:zigbee",
      deviceId: `00158d0004a1b${200 + zone}`,
      services: [
        {
          sId: 13,
          type: "SecuritySystem",
          name: "Охрана",
          characteristics: [
            { cId: 14, type: "SecuritySystemCurrentState", value: 3 },
            { cId: 15, type: "SecuritySystemTargetState", value: 3 },
          ],
        },
      ],
    });
  }
  const bathroomLight = fixture.accessories.find(({ id }) => id === 35);
  bathroomLight.online = false;
  bathroomLight.services[0].characteristics[0].value = true;
  fixture.accessories.find(({ id }) => id === 16).services[0].visible = false;
  const { hub, call, home } = await setup(t, fixture);
  const nightLight = hub.state.accessories.find(({ id }) => id === 26);
  delete nightLight.services.find(({ type }) => type === "Lightbulb")
    .characteristics[0].control.value;

  const on = await call("find_devices", { state: "on" });

  const floorLamp = listed(on.body).find(
    ({ device }) => device.name === "Торшер",
  );
  assert.equal(floorLamp.service.hidden, true);
  assert.equal(
    listed(on.body).some(({ device }) => device.name === "Свет в ванной"),
    false,
  );
  assert.deepEqual(
    on.body.not_evaluated.map(({ ref, device, reason }) => ({
      ref,
      device,
      reason,
    })),
    [
      {
        ref: `${home}/accessory/26/service/13`,
        device: "Ночник",
        reason: "value_unknown",
      },
      {
        ref: `${home}/accessory/35/service/13`,
        device: "Свет в ванной",
        reason: "unavailable",
      },
    ],
  );
  assert.equal(on.body.not_evaluated_total, 2);
  assert.equal(on.body.not_applicable.security, 12);

  const nightLightRead = await call("find_devices", { query: "ночник" });
  const [entry] = listed(nightLightRead.body);
  assert.equal(entry.service.on, null);
  assert.equal(entry.service.on_unknown, "value_unknown");
  assert.deepEqual(readingOf(entry.service, "On"), {
    type: "On",
    value: null,
    value_status: "unknown",
    writable: true,
    ref: `${home}/accessory/26/service/13/characteristic/14`,
  });

  const unavailable = await call("find_devices", { state: "unavailable" });
  assert.deepEqual(
    [...new Set(listed(unavailable.body).map(({ device }) => device.name))],
    ["Датчик окна в кабинете", "Свет в ванной", "Датчик протечки в ванной"],
  );
  assert(
    listed(unavailable.body).every(({ device }) => device.available === false),
  );
});

test("pages come from one snapshot, stay within max_bytes and drill down by room", async (t) => {
  const { call, callError, home } = await setup(
    t,
    await loadHomeFixture("house"),
  );
  const first = await call("find_devices", {
    state: "off",
    limit: 12,
    max_bytes: 6_000,
  });

  assert(first.body.total > 40, `total ${first.body.total}`);
  assert(first.body.returned <= 12);
  assert(first.bytes <= 6_000, `${first.bytes} bytes`);
  const drill = first.body.remaining_rooms[0];
  assert.equal(typeof drill.remaining, "number");
  assert.deepEqual(drill.next, {
    tool: "find_devices",
    arguments: {
      home_ref: home,
      state: "off",
      limit: 12,
      max_bytes: 6_000,
      room_ref: drill.ref,
    },
  });

  const refs = listed(first.body).map(({ service }) => service.ref);
  let next = first.body.next;
  let pages = 1;
  while (next) {
    const page = await call(next.tool, next.arguments);
    assert.deepEqual(page.native, [], "a continuation reads no hub data");
    assert(page.bytes <= 6_000, `${page.bytes} bytes`);
    assert.equal(page.body.observed_at, first.body.observed_at);
    refs.push(...listed(page.body).map(({ service }) => service.ref));
    next = page.body.next;
    pages += 1;
    assert(pages < 50);
  }
  assert.equal(refs.length, first.body.total);
  assert.equal(new Set(refs).size, refs.length);

  const drilled = await call(drill.next.tool, drill.next.arguments);
  assert(listed(drilled.body).every(({ room }) => room.ref === drill.ref));
  assert(listed(drilled.body).every(({ service }) => service.on === false));

  const otherFilters = await callError("find_devices", {
    state: "on",
    cursor: first.body.next.arguments.cursor,
  });
  assert.equal(otherFilters.error.code, "invalid_cursor");
  assert.deepEqual(otherFilters.next, {
    tool: "find_devices",
    arguments: { home_ref: home, state: "on" },
  });
  const garbage = await callError("find_devices", {
    state: "off",
    cursor: "not-a-cursor",
  });
  assert.equal(garbage.error.code, "invalid_cursor");
});

test("a page that cannot fit max_bytes says so instead of passing silently", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  // Unavailable lamps with long names: even the most compact page of one
  // service carries three of them in not_evaluated.
  for (let n = 1; n <= 12; n += 1) {
    fixture.accessories.push({
      id: 300 + n,
      roomId: 4,
      name: `Потолочная лампа над обеденным столом у окна в дальнем углу кухни, группа ${n}`,
      online: false,
      extensionKey: "Controller:zigbee",
      deviceId: `00158d0004a1b${300 + n}`,
      services: [
        {
          sId: 13,
          type: "Lightbulb",
          name: "Свет",
          characteristics: [{ cId: 14, type: "On", value: false }],
        },
      ],
    });
  }
  const { call } = await setup(t, fixture);

  const tight = await call("find_devices", {
    state: "on",
    limit: 1,
    max_bytes: 2_048,
  });
  assert(tight.bytes > 2_048, `${tight.bytes} bytes`);
  assert.equal(tight.body.max_bytes_exceeded, true);
  assert.equal(tight.body.returned, 1);

  const roomy = await call("find_devices", { state: "on", limit: 1 });
  assert(roomy.bytes <= 16_000);
  assert.equal(Object.hasOwn(roomy.body, "max_bytes_exceeded"), false);
});

test("the session catalog is reused, dropped by this process's writes and refreshed for unknown names", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );

  const cold = await call("find_devices", { query: "торшер" });
  assert.deepEqual(methods(cold.native).sort(), [
    "accessory.list",
    "room.list",
  ]);
  const floorLamp = hub.state.accessories.find(({ id }) => id === 16);
  floorLamp.services
    .find(({ type }) => type === "Lightbulb")
    .characteristics.find(
      ({ control }) => control.type === "Brightness",
    ).control.value = { intValue: 30 };

  const warm = await call("find_devices", { query: "торшер" });
  assert.deepEqual(methods(warm.native), ["accessory.get"]);
  assert.equal(
    readingOf(listed(warm.body)[0].service, "Brightness").value,
    30,
    "values are read fresh even when names come from the catalog",
  );

  // A rename made in the SprutHub app: the cached catalog does not know the
  // new name, so the read refreshes it once instead of answering "nothing".
  hub.state.accessories
    .find(({ id }) => id === 26)
    .services.find(({ type }) => type === "Lightbulb").name =
    "Ночник у кровати";
  const renamed = await call("find_devices", { query: "ночник у кровати" });
  assert(methods(renamed.native).includes("room.list"));
  assert.deepEqual(
    listed(renamed.body).map(({ service }) => service.name),
    ["Ночник у кровати"],
  );

  // A device renamed in the app is caught by the targeted read that
  // disagrees with the catalog.
  floorLamp.name = "Торшер у окна";
  const renamedDevice = await call("find_devices", { query: "торшер" });
  assert.deepEqual(
    listed(renamedDevice.body).map(({ device }) => device.name),
    ["Торшер у окна"],
  );

  // A write by this process drops the catalog at once.
  const prepared = await call("prepare_native_change", {
    operation: "service_name",
    target_ref: `${home}/accessory/17/service/13`,
    value: "Лента над диваном",
    reason: "Переименовать ленту",
  });
  await call("apply_native_change", {
    change_ref: prepared.body.change_ref,
  });
  const afterWrite = await call("find_devices", { query: "лента" });
  assert(methods(afterWrite.native).includes("room.list"));
  assert.deepEqual(
    listed(afterWrite.body).map(({ service }) => service.name),
    ["Лента над диваном"],
  );
});

// A lamp added in the SprutHub app: a copy of the desk lamp (on) under a
// new id, name and room.
function addLampInHub(hub, id, roomId, name) {
  const lamp = structuredClone(
    hub.state.accessories.find((accessory) => accessory.id === 32),
  );
  lamp.id = id;
  lamp.roomId = roomId;
  lamp.name = name;
  for (const service of lamp.services) {
    service.aId = id;
    for (const characteristic of service.characteristics) {
      characteristic.aId = id;
    }
  }
  hub.state.accessories.push(lamp);
}

test("a room read sees devices moved or added in the SprutHub app after the catalog", async (t) => {
  const { hub, call, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  // In the SprutHub app: the floor lamp (on) moves to the bedroom, a lamp
  // is added there and another on the empty balcony.
  hub.state.accessories.find(({ id }) => id === 16).roomId = 5;
  addLampInHub(hub, 60, 5, "Лампа у кровати");
  addLampInHub(hub, 61, 30, "Фонарь на балконе");

  const bedroom = await call("find_devices", {
    room_ref: `${home}/room/5`,
    kind: "light",
    state: "on",
  });
  assert.deepEqual(
    listed(bedroom.body)
      .map(({ device }) => device.name)
      .sort(),
    ["Лампа у кровати", "Торшер"],
  );
  assert.equal(methods(bedroom.native)[0], "accessory.list{roomId}");

  const balcony = await call("find_devices", {
    room_ref: `${home}/room/30`,
    kind: "light",
  });
  assert.deepEqual(
    listed(balcony.body).map(({ device }) => device.name),
    ["Фонарь на балконе"],
  );
});

test("a room deleted in the SprutHub app is not found on the first call", async (t) => {
  const { hub, call, callError, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );
  await call("home_overview", {});
  // In the SprutHub app, after the catalog: the empty balcony is deleted,
  // the study's devices move to the living room and the study is deleted.
  const deleteRoom = (id) =>
    hub.state.rooms.splice(
      hub.state.rooms.findIndex((room) => room.id === id),
      1,
    );
  deleteRoom(30);
  for (const accessory of hub.state.accessories) {
    if (accessory.roomId === 7) accessory.roomId = 3;
  }
  deleteRoom(7);

  const balcony = await callError("find_devices", {
    room_ref: `${home}/room/30`,
    kind: "light",
  });
  assert.equal(balcony.error.code, "room_not_found");
  assert.deepEqual(balcony.next, {
    tool: "home_overview",
    arguments: { home_ref: home },
  });
  const study = await callError("find_devices", {
    room_ref: `${home}/room/7`,
    state: "on",
  });
  assert.equal(study.error.code, "room_not_found");
});

test("refresh re-reads names changed in the SprutHub app that a query cannot notice", async (t) => {
  const { hub, call } = await setup(t, await loadHomeFixture("apartment"));
  const first = await call("find_devices", { query: "лампа" });
  assert.deepEqual(
    listed(first.body).map(({ device }) => device.name),
    ["Настольная лампа"],
  );
  addLampInHub(hub, 60, 5, "Лампа у кровати");
  hub.state.rooms.find(({ id }) => id === 5).name = "Спальня родителей";

  const refreshed = await call("find_devices", {
    query: "лампа",
    refresh: true,
  });
  assert.deepEqual(
    listed(refreshed.body).map(({ room, device }) => [room.name, device.name]),
    [
      ["Спальня родителей", "Лампа у кровати"],
      ["Кабинет", "Настольная лампа"],
    ],
  );
  assert(methods(refreshed.native).includes("room.list"));
  assert(refreshed.body.catalog_observed_at > first.body.catalog_observed_at);
});

test("a broad match reads values with one whole-home request", async (t) => {
  const { call } = await setup(t, await loadHomeFixture("house"));
  await call("home_overview", {});

  const { body, native } = await call("find_devices", { kind: "light" });

  assert(body.total > 50);
  assert.deepEqual(methods(native), ["accessory.list"]);
});

test("find_devices refuses a foreign or unknown room with a way back", async (t) => {
  const { callError, home } = await setup(
    t,
    await loadHomeFixture("apartment"),
  );

  const foreign = await callError("find_devices", {
    room_ref: "spruthub://hub/other-home/room/3",
  });
  assert.equal(foreign.error.code, "invalid_room_ref");
  assert.deepEqual(foreign.next, {
    tool: "home_overview",
    arguments: { home_ref: home },
  });
  const unknown = await callError("find_devices", {
    room_ref: `${home}/room/999`,
  });
  assert.equal(unknown.error.code, "room_not_found");
  assert.deepEqual(unknown.next, {
    tool: "home_overview",
    arguments: { home_ref: home },
  });
});
