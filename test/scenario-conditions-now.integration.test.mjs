import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Лампа в кабинете не включается по движению, почему?» The owner's live
// case (13.10.2026): motion in another room starts the rule, and a light
// level condition that is false now keeps the lamp off. A scenario read
// tells, for each condition, the device's room, what it shows now and
// whether the condition holds now; relations of a device name the code
// scenarios whose source mentions it. Expected values are read off
// test/fixtures/homes/apartment.json and the scenarios added below by a
// person, not computed by the code under test.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const clockModule = pathToFileURL(
  path.join(projectRoot, "test/support/offset-clock.mjs"),
).href;
// The apartment hub's zone (Europe/Moscow) has kept +03:00 since 2014.
const HUB_OFFSET_MS = 3 * 3_600_000;
const WEEK = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// clockAt ("12:30") starts the server's clock at that time of today on the
// hub's wall clock.
async function setup(t, prepare, { clockAt } = {}) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  prepare?.(hub);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-conditions-now-"),
  );
  const hubDate = new Date(Date.now() + HUB_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  const offset =
    clockAt === undefined
      ? 0
      : Date.parse(`${hubDate}T${clockAt}:00+03:00`) - Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(clockAt === undefined ? [] : ["--import", clockModule]),
      "src/server.mjs",
    ],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      SPRUT_TEST_CLOCK_OFFSET_MS: String(offset),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "conditions-now-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, hubDate, baseline: hub.snapshot() };
}

async function read(client, args) {
  const result = await client.callTool({ name: "get_entity", arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return {
    ...result.structuredContent,
    bytes: Buffer.byteLength(result.content[0].text),
  };
}

async function overview(client) {
  const result = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
}

// Native requests a call sends the hub.
async function requestsOf(hub, call) {
  const before = hub.requests.length;
  const value = await call();
  return { value, requests: hub.requests.slice(before) };
}

function accessoryReads(requests) {
  return requests
    .filter(({ method }) => method === "accessory.get")
    .map(({ params }) => params.accessory.get.id);
}

function assertReadOnly(hub, baseline) {
  assert.deepEqual(hub.writes(), []);
  assert.deepEqual(diffHomeSnapshots(baseline, hub.snapshot()), []);
}

function setValue(hub, aId, sId, cId, value) {
  const characteristic = hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find((service) => service.sId === sId)
    .characteristics.find((candidate) => candidate.cId === cId);
  characteristic.control.value = value;
}

function addScenario(hub, scenario) {
  hub.state.scenarios.push({
    desc: "",
    predefined: false,
    active: true,
    onStart: false,
    sync: false,
    error: false,
    ...scenario,
    data:
      typeof scenario.data === "string"
        ? scenario.data
        : JSON.stringify(scenario.data),
  });
}

function condition(aId, sId, cId, hc, cond, value, trigger = false) {
  return {
    type: "characteristic",
    aId,
    sId,
    cId,
    hc,
    cond,
    value,
    trigger,
    time: 0,
    timeCond: "",
  };
}

function interval(start, end, days = "*") {
  const cron = (time) => {
    const [hour, minute] = time.split(":").map(Number);
    return {
      type: "cron",
      cron: `0 ${minute} ${hour} ? * ${days} *`,
      mode: "NONE",
      offset: 0,
    };
  };
  return {
    type: "interval",
    start: cron(start),
    end: cron(end),
    trigger: false,
  };
}

function deskLamp(on) {
  return {
    type: "service",
    aId: 32,
    sId: 13,
    hs: "Lightbulb",
    characteristics: [{ type: "set", cId: 14, hc: "On", value: String(on) }],
  };
}

function rule(conditions, then = [deskLamp(true)]) {
  return {
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: { type: "condition", mode: "AND", conditions },
        then,
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

// The office lamp of the live case: motion in the corridor turns the desk
// lamp in the study on while the corridor sensor reads under 20 lux, and
// off 3 minutes later. The sensor reads 24 lux.
function addOfficeLampRule(hub) {
  setValue(hub, 13, 20, 21, { doubleValue: 24 });
  setValue(hub, 32, 13, 14, { boolValue: false });
  addScenario(hub, {
    index: "41",
    name: "Свет в кабинете по движению",
    type: "BLOCK",
    data: rule(
      [
        condition(13, 13, 14, "MotionDetected", "=", "true", true),
        condition(13, 20, 21, "CurrentAmbientLightLevel", "<", "20"),
      ],
      [
        deskLamp(true),
        {
          type: "delay",
          index: 1,
          mode: "RESET",
          time: 180_000,
          targets: [deskLamp(false)],
        },
      ],
    ),
  });
}

function leaf({
  type,
  trigger,
  device,
  room,
  characteristic,
  op,
  value,
  unit,
  current,
  holds_now,
}) {
  return {
    type,
    trigger,
    device,
    room,
    characteristic,
    op,
    value,
    ...(unit === undefined ? {} : { unit }),
    current,
    holds_now,
  };
}

test("a scenario read says which condition is false now, with the value and the sensor's room", async (t) => {
  const { hub, client } = await setup(t, addOfficeLampRule);
  const scenario = `${homeRef}/scenario/41`;

  const { value: cold, requests } = await requestsOf(hub, () =>
    read(client, { entity_ref: scenario }),
  );
  const summary = cold.entity.summary;
  assert.deepEqual(summary.triggers, [
    "Датчик движения в коридоре / Движение: Обнаружено движение = true",
  ]);
  const [ifStep] = summary.steps;
  assert.deepEqual(ifStep.condition.all.map(leaf), [
    {
      type: "characteristic",
      trigger: true,
      device: "Датчик движения в коридоре",
      room: "Коридор",
      characteristic: "Обнаружено движение",
      op: "=",
      value: true,
      current: { value: false },
      holds_now: false,
    },
    {
      type: "characteristic",
      trigger: false,
      device: "Датчик движения в коридоре",
      room: "Коридор",
      characteristic: "Освещенность",
      op: "<",
      value: 20,
      unit: "lux",
      current: { value: 24, unit: "lux" },
      holds_now: false,
    },
  ]);
  const [turnOn, pause] = ifStep.then;
  assert.deepEqual(
    [turnOn.device, turnOn.room, pause.seconds, pause.steps[0].device],
    ["Настольная лампа", "Кабинет", 180, "Настольная лампа"],
  );
  assert.equal(typeof summary.current_values.observed_at, "string");
  assert.equal(summary.current_values.devices_read, 1);
  assert.equal(
    Object.hasOwn(summary.current_values, "devices_not_read"),
    false,
  );
  // One read per distinct condition device; the lamp is read for its name.
  assert.deepEqual(accessoryReads(requests).sort(), [13, 32]);

  // The values are read at the time of the question, not taken from the
  // home catalog that an earlier read of the whole home left behind.
  await overview(client);
  setValue(hub, 13, 20, 21, { doubleValue: 15 });
  const baseline = hub.snapshot();
  const { value: warm, requests: warmRequests } = await requestsOf(hub, () =>
    read(client, { entity_ref: scenario }),
  );
  const [, light] = warm.entity.summary.steps[0].condition.all;
  assert.deepEqual(
    { current: light.current, holds_now: light.holds_now },
    { current: { value: 15, unit: "lux" }, holds_now: true },
  );
  assert.deepEqual(accessoryReads(warmRequests), [13]);

  // From the sensor's side its roles carry the same facts, from the read of
  // the sensor itself.
  const { value: sensor, requests: sensorRequests } = await requestsOf(
    hub,
    () =>
      read(client, {
        entity_ref: `${homeRef}/accessory/13`,
        include: ["relations"],
      }),
  );
  assert.deepEqual(
    sensor.entity.relations.scenario_roles
      .filter(({ scenario_ref: ref }) => ref === scenario)
      .map(({ characteristic, role, current, holds_now: holds }) => ({
        characteristic,
        role,
        current,
        holds_now: holds,
      })),
    [
      {
        characteristic: "Обнаружено движение",
        role: "trigger",
        current: { value: false },
        holds_now: false,
      },
      {
        characteristic: "Освещенность",
        role: "condition",
        current: { value: 15, unit: "lux" },
        holds_now: true,
      },
    ],
  );
  assert.deepEqual(accessoryReads(sensorRequests), [13]);
  assertReadOnly(hub, baseline);
});

test("an interval condition says whether the hub's clock is inside it now", async (t) => {
  const date = new Date(Date.now() + HUB_OFFSET_MS).toISOString().slice(0, 10);
  const today = WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const { hub, client, hubDate, baseline } = await setup(
    t,
    (hub) => {
      const others = WEEK.filter((day) => day !== today);
      const scenarios = [
        ["42", interval("11:00", "13:00")],
        ["43", interval("14:00", "15:00")],
        ["44", interval("22:00", "02:00")],
        ["45", interval("11:00", "13:00", others.join(","))],
        ["46", interval("11:00", "13:00", today)],
      ];
      for (const [index, window] of scenarios) {
        addScenario(hub, {
          index,
          name: `Окно ${index}`,
          type: "BLOCK",
          data: rule([window]),
        });
      }
      addScenario(hub, {
        index: "47",
        name: "От заката до рассвета",
        type: "BLOCK",
        data: rule([
          {
            type: "interval",
            start: {
              type: "cron",
              cron: "0 0 12 ? * * *",
              mode: "SUNSET",
              offset: 0,
            },
            end: {
              type: "cron",
              cron: "0 0 0 ? * * *",
              mode: "SUNRISE",
              offset: 0,
            },
            trigger: false,
          },
        ]),
      });
    },
    { clockAt: "12:30" },
  );
  const holds = async (index) => {
    const { entity } = await read(client, {
      entity_ref: `${homeRef}/scenario/${index}`,
    });
    const [window] = entity.summary.steps[0].condition.all;
    return { holds: window.holds_now, summary: entity.summary };
  };

  // Without the hub's zone the time of day on its clock is unknown.
  hub.refuseNext("window.get", { code: -32000, message: "Busy" });
  const unknown = await holds("42");
  assert.equal(unknown.holds, null);
  assert.equal(unknown.summary.current_values.hub_time, null);

  const inside = await holds("42");
  assert.equal(inside.holds, true);
  assert.match(
    inside.summary.current_values.hub_time,
    new RegExp(`^${hubDate}T12:3\\d:\\d\\d\\.\\d{3}\\+03:00$`),
  );
  assert.equal((await holds("43")).holds, false);
  assert.equal((await holds("44")).holds, false);
  // Inside the hours, but on days other than today.
  assert.equal((await holds("45")).holds, false);
  assert.equal((await holds("46")).holds, true);
  // Sunrise and sunset times are not read.
  assert.equal((await holds("47")).holds, null);
  assertReadOnly(hub, baseline);
});

test("a condition on a device that cannot be read now holds neither way", async (t) => {
  const { hub, client, baseline } = await setup(t, (hub) => {
    addScenario(hub, {
      index: "48",
      name: "Проветривание кабинета",
      type: "BLOCK",
      data: rule([
        // The bedroom climate sensor: its read is refused below.
        condition(25, 13, 14, "CurrentTemperature", ">", "20"),
        // The study window sensor is offline in the fixture.
        condition(34, 13, 14, "ContactSensorState", "=", "1"),
        // No accessory 99 in the home.
        condition(99, 13, 14, "On", "=", "true"),
      ]),
    });
  });
  await overview(client);
  hub.refuseNext("accessory.get", { code: -32000, message: "Busy" });
  const { value, requests } = await requestsOf(hub, () =>
    read(client, { entity_ref: `${homeRef}/scenario/48` }),
  );
  const [climate, window, missing] =
    value.entity.summary.steps[0].condition.all;
  assert.deepEqual(accessoryReads(requests), [25, 34, 99]);
  assert.deepEqual(
    { current: climate.current, holds_now: climate.holds_now },
    { current: { status: "read_failed" }, holds_now: null },
  );
  assert.deepEqual(
    { current: window.current, holds_now: window.holds_now },
    {
      current: { value: 0, value_name: "Закрыто", device_available: false },
      holds_now: null,
    },
  );
  assert.deepEqual(
    { current: missing.current, holds_now: missing.holds_now },
    { current: { status: "not_found" }, holds_now: null },
  );
  // Of the three devices only the offline window sensor gave a value.
  const { observed_at: observedAt, ...counts } =
    value.entity.summary.current_values;
  assert.equal(typeof observedAt, "string");
  assert.deepEqual(counts, { devices_read: 1 });
  assertReadOnly(hub, baseline);
});

test("a scenario with conditions on more devices than are read at once says which were not read", async (t) => {
  const devices = Array.from({ length: 20 }, (_, index) => 11 + index);
  const { hub, client, baseline } = await setup(t, (hub) => {
    addScenario(hub, {
      index: "60",
      name: "Все в сети",
      type: "BLOCK",
      data: rule(
        devices.map((aId) => condition(aId, 1, 8, "C_Online", "=", "true")),
      ),
    });
  });
  await overview(client);
  const { value, requests } = await requestsOf(hub, () =>
    read(client, { entity_ref: `${homeRef}/scenario/60` }),
  );
  const summary = value.entity.summary;
  assert.deepEqual(accessoryReads(requests), devices.slice(0, 16));
  assert.deepEqual(
    summary.steps[0].condition.all.map(({ holds_now: holds }) => holds),
    [...Array(16).fill(true), ...Array(4).fill(null)],
  );
  assert.deepEqual(summary.steps[0].condition.all.at(-1).current, {
    status: "not_read",
  });
  const { observed_at: observedAt, ...counts } = summary.current_values;
  assert.equal(typeof observedAt, "string");
  assert.deepEqual(counts, {
    devices_read: 16,
    devices_not_read: 4,
    read_limit: 16,
  });
  assertReadOnly(hub, baseline);
});

const LIGHT_LOGIC = [
  "info = {",
  '  name: "Лампа по кнопке",',
  '  description: "Включает лампу",',
  '  version: "1.0",',
  '  author: "owner",',
  "  onStart: false,",
  "  sourceServices: [HS.StatelessProgrammableSwitch],",
  "  sourceCharacteristics: [HC.ProgrammableSwitchEvent],",
  "  options: {},",
  "  variables: {}",
  "};",
  "",
  "function trigger(source, value, variables, options, context) {",
  "  Hub.getAccessory(32).getService(HS.Lightbulb).getCharacteristic(HC.On).setValue(true);",
  "}",
].join("\n");

test("relations of a device name the owner's code scenarios whose source mentions it", async (t) => {
  const { hub, client, baseline } = await setup(t, (hub) => {
    addScenario(hub, {
      index: "50",
      name: "Лампа по кнопке",
      type: "LOGIC",
      data: LIGHT_LOGIC,
    });
    addScenario(hub, {
      index: "51",
      name: "Найти лампу",
      type: "GLOBAL",
      data: [
        "global.deskLamp = function () {",
        "  return Hub.getAccessories().filter(function (accessory) {",
        '    return accessory.getName() === "Настольная лампа";',
        "  })[0];",
        "};",
      ].join("\n"),
    });
    // A built-in LOGIC is assigned to services; its relation is the
    // device's assigned logic, not a mention.
    addScenario(hub, {
      index: "52",
      name: "Встроенная лампа",
      type: "LOGIC",
      predefined: true,
      data: LIGHT_LOGIC,
    });
    addScenario(hub, {
      index: "53",
      name: "Другая лампа",
      type: "LOGIC",
      data: [
        "// Hub.getAccessory(32) was the desk lamp before",
        "Hub.getAccessory(320).getService(HS.Lightbulb);",
        'log("Настольная лампа у окна");',
      ].join("\n"),
    });
    addScenario(hub, {
      index: "54",
      name: "Состояние лампы",
      type: "GLOBAL",
      data: "global.deskLampOn = function () {\n  return Hub.getCharacteristic(32, 14).getValue();\n};",
    });
  });
  const mentions = [
    {
      scenario_ref: `${homeRef}/scenario/50`,
      scenario_name: "Лампа по кнопке",
      scenario_type: "LOGIC",
      active: true,
      found_by: ["accessory_id"],
      lines: [14],
    },
    {
      scenario_ref: `${homeRef}/scenario/51`,
      scenario_name: "Найти лампу",
      scenario_type: "GLOBAL",
      active: true,
      found_by: ["accessory_name"],
      lines: [3],
    },
    {
      scenario_ref: `${homeRef}/scenario/54`,
      scenario_name: "Состояние лампы",
      scenario_type: "GLOBAL",
      active: true,
      found_by: ["accessory_id"],
      lines: [2],
    },
  ];
  const withoutNext = (list) => list.map(({ next: _next, ...rest }) => rest);

  const { value: lamp, requests } = await requestsOf(hub, () =>
    read(client, {
      entity_ref: `${homeRef}/accessory/32`,
      include: ["relations"],
    }),
  );
  assert.deepEqual(withoutNext(lamp.entity.relations.code_mentions), mentions);
  assert.deepEqual(lamp.entity.relations.code_mentions[0].next, {
    tool: "get_entity",
    arguments: {
      entity_ref: `${homeRef}/scenario/50`,
      include: ["configuration"],
    },
  });
  // The apartment's own LOGIC and the four added user ones; the built-in
  // one is not read.
  assert.equal(lamp.entity.relations.checked.code_scenarios_searched, 5);
  assert.deepEqual(
    requests
      .filter(
        ({ method, params }) =>
          method === "scenario.get" &&
          params.scenario.get.expand === "data" &&
          ["9", "50", "51", "52", "53", "54"].includes(
            params.scenario.get.index,
          ),
      )
      .map(({ params }) => params.scenario.get.index)
      .sort(),
    ["50", "51", "53", "54", "9"],
  );

  const on = await read(client, {
    entity_ref: `${homeRef}/accessory/32/service/13/characteristic/14`,
    include: ["relations"],
  });
  assert.deepEqual(withoutNext(on.entity.relations.code_mentions), mentions);

  // The leak protection LOGIC of the fixture switches the kettle socket off.
  const kettle = await read(client, {
    entity_ref: `${homeRef}/accessory/24`,
    include: ["relations"],
  });
  assert.deepEqual(
    withoutNext(kettle.entity.relations.code_mentions).map(
      ({ scenario_name: name, found_by: by }) => [name, by],
    ),
    [["Защита от протечки", ["accessory_id"]]],
  );
  assertReadOnly(hub, baseline);
});

test("relations name how many code scenarios were not searched and how to list them, at any number of them", async (t) => {
  // The apartment's own LOGIC, then the owner's GLOBAL and LOGIC code that
  // does not mention the lamp: 31 and 65 code scenarios, of which the
  // first 24 are searched.
  const homeWith = (globals) => (hub) => {
    for (let index = 0; index < globals + 4; index += 1) {
      const type = index < globals ? "GLOBAL" : "LOGIC";
      addScenario(hub, {
        index: String(100 + index),
        name: `Код ${index + 1}`,
        type,
        data: `global.value${index} = function () {\n  return ${index};\n};`,
      });
    }
  };
  const relationsOf = async (globals) => {
    const { hub, client, baseline } = await setup(t, homeWith(globals));
    const lamp = await read(client, {
      entity_ref: `${homeRef}/accessory/32`,
      include: ["relations"],
    });
    assertReadOnly(hub, baseline);
    return { ...lamp, client };
  };
  const notRead = (lamp) =>
    lamp.entity.relations.unchecked.filter(
      ({ area }) => area === "scenario_code",
    );
  const next = {
    tool: "home_overview",
    candidates: [
      { home_ref: homeRef, list: "scenarios", type: "GLOBAL" },
      { home_ref: homeRef, list: "scenarios", type: "LOGIC" },
    ],
  };

  const few = await relationsOf(26);
  assert.equal(few.entity.relations.checked.code_scenarios_searched, 24);
  assert.deepEqual(notRead(few), [
    {
      area: "scenario_code",
      outcome: "not_read",
      limit: 24,
      scenarios_not_read: 7,
      next,
    },
  ]);
  // The listed LOGIC: the apartment's own, searched, and the four added
  // last, not searched.
  const logic = await few.client.callTool({
    name: "home_overview",
    arguments: next.candidates[1],
  });
  assert.equal(logic.isError, undefined, logic.content[0]?.text);
  assert.deepEqual(
    logic.structuredContent.scenarios.map(({ name }) => name),
    ["Защита от протечки", "Код 27", "Код 28", "Код 29", "Код 30"],
  );

  const many = await relationsOf(60);
  assert.equal(many.entity.relations.checked.code_scenarios_searched, 24);
  assert.deepEqual(notRead(many), [
    {
      area: "scenario_code",
      outcome: "not_read",
      limit: 24,
      scenarios_not_read: 41,
      next,
    },
  ]);
  // One more digit in the count, nothing else.
  assert.equal(many.bytes - few.bytes, 1);
});
