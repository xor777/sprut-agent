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
});
