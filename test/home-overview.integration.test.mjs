import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaledHome } from "./fixtures/homes/scaled.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// home_overview is the entry read of a home: who the home is, its rooms, how
// many scenarios of each kind run, extension states and what is broken. Its
// size must follow the number of rooms and problems, not the devices.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function setup(t, fixture) {
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-overview-"),
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
  const client = new Client({ name: "home-overview-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
}

async function overview(client, args = {}) {
  const result = await client.callTool({
    name: "home_overview",
    arguments: args,
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  return {
    body: result.structuredContent,
    bytes: Buffer.byteLength(result.content[0].text),
  };
}

async function toolError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, result.content[0]?.text);
  return result.structuredContent;
}

// Every page of a home_overview list from its first call on; a
// continuation must not read the hub again.
async function allPages(hub, client, args, key) {
  const pages = [await overview(client, args)];
  let next = pages[0].body.next;
  while (next) {
    assert.equal(next.tool, "home_overview");
    const before = hub.requests.length;
    pages.push(await overview(client, next.arguments));
    assert.equal(hub.requests.length, before, "a continuation reads no hub");
    next = pages.at(-1).body.next;
    assert(pages.length < 30);
  }
  for (const page of pages) {
    assert(page.bytes <= 16_000, `a page of ${page.bytes} bytes`);
    assert.equal(page.body.total, pages[0].body.total);
    assert.equal(page.body.returned, page.body[key].length);
  }
  return {
    pages,
    entries: pages.flatMap(({ body }) => body[key]),
  };
}

test("home_overview names the home, its rooms, scenario counts, extensions and problems", async (t) => {
  const { hub, client } = await setup(t, await loadHomeFixture("apartment"));
  const home = "spruthub://hub/sim-apartment-01";

  const { body } = await overview(client);

  assert.deepEqual(body.home, {
    ref: home,
    name: "Квартира на Лесной",
    online: true,
    model: "Sprut.hub 2",
    firmware: { version: "3.0.0", revision: "20131" },
    options_window_ref: `${home}/window/`,
  });
  assert.equal(Object.hasOwn(body, "selection"), false);
  assert.deepEqual(body.rooms, [
    { ref: `${home}/room/1`, name: "Прихожая", device_count: 2 },
    { ref: `${home}/room/2`, name: "Коридор", device_count: 2 },
    { ref: `${home}/room/3`, name: "Гостиная", device_count: 6 },
    { ref: `${home}/room/4`, name: "Кухня", device_count: 4 },
    { ref: `${home}/room/5`, name: "Спальня", device_count: 5 },
    { ref: `${home}/room/6`, name: "Детская спальня", device_count: 3 },
    { ref: `${home}/room/7`, name: "Кабинет", device_count: 3 },
    { ref: `${home}/room/8`, name: "Ванная", device_count: 4 },
    { ref: `${home}/room/30`, name: "Балкон", device_count: 0 },
  ]);
  assert.deepEqual(body.scenarios, {
    total: 9,
    by_type: {
      BLOCK: { active: 7, inactive: 1 },
      LOGIC: { active: 1, inactive: 0 },
    },
    next: {
      tool: "home_overview",
      arguments: { home_ref: home, list: "scenarios" },
    },
  });
  assert.equal(JSON.stringify(body).includes("Ночной режим"), false);
  assert.deepEqual(
    body.extensions.find(({ name }) => name === "Telegram"),
    {
      ref: `${home}/extension/Notification%3Atelegram`,
      name: "Telegram",
      type: "telegram",
      state: "STOPPED",
      enabled: false,
    },
  );
  assert.equal(body.extensions.length, 5);
  // A disabled, stopped provider is the owner's choice, not a problem.
  assert.deepEqual(body.problems, [
    {
      kind: "device_unavailable",
      ref: `${home}/accessory/34`,
      name: "Датчик окна в кабинете",
      room: "Кабинет",
    },
    {
      kind: "device_unavailable",
      ref: `${home}/accessory/37`,
      name: "Датчик протечки в ванной",
      room: "Ванная",
    },
  ]);
  assert.equal(body.problems_total, 2);
  assert.match(body.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    hub.requests.filter(({ write }) => write),
    [],
    "an overview never writes",
  );
});

test("home_overview shows a failed provider, a scenario execution error and caps problems", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  const telegram = fixture.extensions.find(({ type }) => type === "telegram");
  telegram.enabled = true;
  telegram.state = "FAILED";
  fixture.scenarios.find(({ name }) => name === "Ночной режим").error = true;
  for (const accessory of fixture.accessories.slice(0, 12)) {
    accessory.online = false;
  }
  const { client } = await setup(t, fixture);
  const home = "spruthub://hub/sim-apartment-01";

  const { body } = await overview(client);

  assert.deepEqual(
    body.extensions.find(({ name }) => name === "Telegram").state,
    "FAILED",
  );
  assert.deepEqual(body.problems.slice(0, 2), [
    {
      kind: "extension",
      ref: `${home}/extension/Notification%3Atelegram`,
      name: "Telegram",
      state: "FAILED",
      enabled: true,
    },
    {
      kind: "scenario_error",
      ref: `${home}/scenario/5`,
      name: "Ночной режим",
    },
  ]);
  assert.equal(body.problems.length, 10);
  // 12 switched off here plus the two offline sensors of the fixture.
  assert.equal(body.problems_total, 2 + 14);
});

test("home_overview stays within 3 KB at the owner's scale and counts the whole house", async (t) => {
  const owner = await setup(
    t,
    scaledHome(await loadHomeFixture("apartment"), 80),
  );
  const real = await overview(owner.client);
  assert.equal(real.body.rooms.length, 13);
  assert(real.bytes <= 3_072, `home_overview returned ${real.bytes} bytes`);

  const houseFixture = await loadHomeFixture("house");
  const house = await setup(t, houseFixture);
  const { body, bytes } = await overview(house.client);
  assert.equal(body.rooms.length, houseFixture.rooms.length);
  assert.equal(
    body.rooms.reduce((sum, { device_count }) => sum + device_count, 0),
    houseFixture.accessories.length,
  );
  assert.equal(body.scenarios.total, houseFixture.scenarios.length);
  t.diagnostic(`owner scale ${real.bytes} bytes, house ${bytes} bytes`);
});

test("home_overview query finds rooms, scenarios and extensions by name", async (t) => {
  const { client } = await setup(t, await loadHomeFixture("apartment"));
  const home = "spruthub://hub/sim-apartment-01";

  const bedrooms = await overview(client, { query: "спальне" });
  assert.deepEqual(bedrooms.body.home, {
    ref: home,
    name: "Квартира на Лесной",
  });
  assert.deepEqual(bedrooms.body.matches, [
    { kind: "room", ref: `${home}/room/5`, name: "Спальня", device_count: 5 },
    {
      kind: "room",
      ref: `${home}/room/6`,
      name: "Детская спальня",
      device_count: 3,
    },
  ]);
  assert.equal(bedrooms.body.total, 2);

  const kitchen = await overview(client, { query: "на кухне" });
  assert.deepEqual(kitchen.body.matches, [
    { kind: "room", ref: `${home}/room/4`, name: "Кухня", device_count: 4 },
  ]);

  const buttons = await overview(client, { query: "кнопка у кровати" });
  assert.deepEqual(
    buttons.body.matches.map(({ kind, name, type, active }) => ({
      kind,
      name,
      type,
      active,
    })),
    [
      {
        kind: "scenario",
        name: "Кнопка у кровати: ночник",
        type: "BLOCK",
        active: true,
      },
      {
        kind: "scenario",
        name: "Кнопка у кровати: спать",
        type: "BLOCK",
        active: true,
      },
    ],
  );

  const provider = await overview(client, { query: "TELEGRAM" });
  assert.deepEqual(provider.body.matches, [
    {
      kind: "extension",
      ref: `${home}/extension/Notification%3Atelegram`,
      name: "Telegram",
      type: "telegram",
      state: "STOPPED",
      enabled: false,
    },
  ]);

  const none = await overview(client, { query: "гараж" });
  assert.deepEqual(none.body.matches, []);
  assert.equal(none.body.total, 0);
});

test("home_overview query returns the ten best matches and the total", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  for (let index = 1; index <= 12; index += 1) {
    fixture.rooms.push({ id: 100 + index, name: `Кладовая ${index}` });
  }
  const { client } = await setup(t, fixture);

  const { body } = await overview(client, { query: "кладовой" });

  assert.equal(body.matches.length, 10);
  assert.equal(body.total, 12);
  assert(
    body.matches.every(
      ({ kind, name }) => kind === "room" && /^Кладовая/.test(name),
    ),
  );
  // The two past the first ten are one call away.
  const rest = await overview(client, body.next.arguments);
  assert.deepEqual(
    [...body.matches, ...rest.body.matches].map(({ name }) => name).sort(),
    Array.from({ length: 12 }, (_, index) => `Кладовая ${index + 1}`).sort(),
  );
  assert.equal(rest.body.next, null);
  const rooms = await overview(client, { list: "rooms", query: "кладовой" });
  assert.equal(rooms.body.rooms.length, 12);
  assert.equal(rooms.body.next, null);
});

test("home_overview lists scenarios with their flags, filtered by type, activity and error", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  fixture.scenarios.find(({ name }) => name === "Ночной режим").error = true;
  const { hub, client } = await setup(t, fixture);
  const home = "spruthub://hub/sim-apartment-01";
  // Independent of the product: the scenarios the simulator holds.
  const expected = hub.state.scenarios.map((scenario) => ({
    ref: `${home}/scenario/${scenario.index}`,
    name: scenario.name,
    type: scenario.type,
    active: scenario.active,
    on_start: scenario.onStart,
    sync: scenario.sync,
    execution_error: scenario.error,
  }));

  const { body: summary } = await overview(client);
  assert.deepEqual(summary.scenarios.next, {
    tool: "home_overview",
    arguments: { home_ref: home, list: "scenarios" },
  });

  const all = await overview(client, summary.scenarios.next.arguments);
  assert.deepEqual(all.body.scenarios, expected);
  assert.equal(all.body.total, expected.length);
  assert.equal(all.body.next, null);

  const inactive = await overview(client, {
    list: "scenarios",
    active: false,
  });
  assert.deepEqual(
    inactive.body.scenarios,
    expected.filter(({ active }) => !active),
  );
  assert.equal(inactive.body.total, 1);

  const failing = await overview(client, { list: "scenarios", error: true });
  assert.deepEqual(
    failing.body.scenarios.map(({ name }) => name),
    ["Ночной режим"],
  );

  const logic = await overview(client, { list: "scenarios", type: "logic" });
  assert.deepEqual(
    logic.body.scenarios.map(({ name, type }) => [name, type]),
    [["Защита от протечки", "LOGIC"]],
  );

  const telegram = await overview(client, {
    list: "extensions",
    type: "telegram",
  });
  assert.deepEqual(
    telegram.body.extensions.map(({ name, state }) => [name, state]),
    [["Telegram", "STOPPED"]],
  );
  const rooms = await overview(client, { list: "rooms" });
  assert.deepEqual(rooms.body.rooms, summary.rooms);

  // A filter the chosen list lacks is refused with the call that has it.
  const unlisted = await toolError(client, "home_overview", { active: false });
  assert.equal(unlisted.error.code, "invalid_filter");
  assert.deepEqual(unlisted.next, {
    tool: "home_overview",
    arguments: { list: "scenarios", active: false },
  });
  const roomType = await toolError(client, "home_overview", {
    list: "rooms",
    type: "BLOCK",
  });
  assert.equal(roomType.error.code, "invalid_filter");

  // Errors about a scenario ref name the call that lists scenarios.
  const contract = await toolError(client, "get_native_change_contract", {
    operation: "block_action_pause",
    target_ref: `${home}/room/1`,
  });
  assert.equal(contract.error.code, "invalid_scenario_ref");
  assert.deepEqual(contract.next, {
    tool: "home_overview",
    arguments: { list: "scenarios" },
  });
  const log = await toolError(client, "read_hub_log", {
    home_ref: home,
    scenario_ref: `${home}/room/1`,
  });
  assert.equal(log.error.code, "invalid_log_filter");
  assert.deepEqual(log.next, {
    tool: "home_overview",
    arguments: { home_ref: home, list: "scenarios" },
  });
  assert.deepEqual(
    hub.requests.filter(({ write }) => write),
    [],
  );
});

test("home_overview pages long lists and query matches past the first ten", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  const template = fixture.scenarios.find(({ index }) => index === "14");
  for (let n = 1; n <= 60; n += 1) {
    fixture.scenarios.push({
      ...structuredClone(template),
      index: String(100 + n),
      name: `Полив грядки ${n}`,
      desc: "",
    });
  }
  const { hub, client } = await setup(t, fixture);
  const home = "spruthub://hub/sim-apartment-01";
  const refs = (entries) => entries.map(({ ref }) => ref);

  const scenarios = await allPages(
    hub,
    client,
    { list: "scenarios" },
    "scenarios",
  );
  assert(scenarios.pages.length >= 2);
  assert.deepEqual(
    refs(scenarios.entries),
    hub.state.scenarios.map(({ index }) => `${home}/scenario/${index}`),
  );

  const watering = await allPages(hub, client, { query: "полив" }, "matches");
  assert.equal(watering.pages[0].body.returned, 10);
  assert.equal(watering.pages[0].body.total, 60);
  assert.equal(new Set(refs(watering.entries)).size, 60);
  assert(watering.entries.every(({ kind }) => kind === "scenario"));

  const listed = await allPages(
    hub,
    client,
    { list: "scenarios", query: "полив", limit: 25 },
    "scenarios",
  );
  assert.deepEqual(
    listed.pages.map(({ body }) => body.returned),
    [25, 25, 10],
  );
  assert.deepEqual(
    new Set(refs(listed.entries)),
    new Set(refs(watering.entries)),
  );

  // A cursor continues only the call it came from.
  const other = await toolError(client, "home_overview", {
    home_ref: home,
    list: "scenarios",
    active: false,
    cursor: scenarios.pages[0].body.next.arguments.cursor,
  });
  assert.equal(other.error.code, "invalid_cursor");
  assert.deepEqual(other.next, {
    tool: "home_overview",
    arguments: { home_ref: home, list: "scenarios", active: false },
  });
});
