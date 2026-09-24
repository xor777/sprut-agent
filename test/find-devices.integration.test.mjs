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
  assert.deepEqual(
    byDevice("Выключатель гостиной").map(({ name, kind }) => [name, kind]),
    [
      ["Споты", "light"],
      ["Вентиляция", "outlet"],
    ],
  );
  // The air conditioner is in mode OFF and the open curtains are not "on".
  assert.deepEqual(byDevice("Кондиционер"), []);
  assert.deepEqual(byDevice("Шторы в гостиной"), []);
  // Devices without on/off are counted, not dropped or listed.
  assert(body.not_applicable.sensor > 0);
  assert(body.not_applicable.cover > 0);
  assert(body.not_applicable.button > 0);
  assert.deepEqual(
    body.not_evaluated.map(({ device, type, reason }) => ({
      device,
      type,
      reason,
    })),
    [
      {
        device: "Охрана",
        type: "SecuritySystem",
        reason: "no_on_off_characteristic",
      },
    ],
  );
  assert.equal(body.not_evaluated_total, 1);
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

test("living-room lights include relays named as lights and leave the ventilation relay on", async (t) => {
  const { hub, call, home } = await setup(t, await loadHomeFixture("house"));
  const living = `${home}/room/3`;

  const { body } = await call("find_devices", {
    room_ref: living,
    kind: "light",
  });

  const lights = listed(body);
  assert.deepEqual(
    lights.map(({ device, service }) => [
      device.name,
      service.name,
      service.type,
      service.kind_basis ?? null,
    ]),
    [
      ["Люстра", "Люстра", "Lightbulb", null],
      ["Торшер", "Свет", "Lightbulb", null],
      ["Светодиодная лента", "Лента", "Lightbulb", null],
      ["Выключатель гостиной", "Споты", "Switch", "name"],
      ["Выключатель гостиной", "Подсветка ниши", "Switch", "name"],
    ],
  );
  assert(lights.every(({ room }) => room.ref === living));
  const commands = lights
    .filter(({ service }) => service.on === true)
    .map(({ service }) => {
      const on = readingOf(service, "On");
      assert.equal(on.writable, true);
      return { target_ref: on.ref, value: false };
    });
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
  const ventilation = hub.state.accessories
    .find(({ name }) => name === "Выключатель гостиной")
    .services.find(({ name }) => name === "Вентиляция");
  assert.equal(ventilation.characteristics[0].control.value.boolValue, true);
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
