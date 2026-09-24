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
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// Entity reads answer household questions ("why does the corridor light turn
// on at night?") without the agent decoding native BLOCK JSON by hand. The
// expectations below are read off test/fixtures/homes/apartment.json by a
// person, not computed by the code under test.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const corridorOn = `${homeRef}/accessory/14/service/13/characteristic/14`;
const corridorBrightness = `${homeRef}/accessory/14/service/13/characteristic/15`;

async function setup(t, prepare) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  prepare?.(hub);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-entity-reads-"),
  );
  const transport = new StdioClientTransport({
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
  });
  const client = new Client({ name: "entity-reads-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
}

async function read(client, args) {
  const result = await client.callTool({ name: "get_entity", arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return {
    ...result.structuredContent,
    bytes: Buffer.byteLength(result.content[0].text),
  };
}

function assertReadOnly(hub, baseline = hub.initialSnapshot()) {
  assert.deepEqual(hub.writes(), []);
  assert.deepEqual(diffHomeSnapshots(baseline, hub.snapshot()), []);
  assert.deepEqual(
    hub.requests
      .filter(({ error }) => error?.code === -32601)
      .map(({ method }) => method),
    [],
  );
}

function action({ op, device, room, characteristic, value, unit, ref }) {
  return {
    op,
    device,
    room,
    characteristic,
    ...(value === undefined ? {} : { value }),
    ...(unit === undefined ? {} : { unit }),
    ref,
  };
}

test("a BLOCK summary names what the scenario does without its JSON", async (t) => {
  const { hub, client } = await setup(t);

  const night = await read(client, { entity_ref: `${homeRef}/scenario/5` });
  assert.equal(night.entity.name, "Ночной режим");
  assert.equal(Object.hasOwn(night.entity, "configuration"), false);
  const nightSummary = night.entity.summary;
  assert.equal(nightSummary.format, "block");
  assert.equal(nightSummary.clock, "hub_local");
  assert.deepEqual(nightSummary.triggers, [
    "23:00–06:00 every day (at start and at end)",
  ]);
  assert.deepEqual(nightSummary.unrecognized, []);
  const [rule] = nightSummary.steps;
  assert.equal(nightSummary.steps.length, 1);
  assert.equal(rule.type, "if");
  assert.deepEqual(rule.condition, {
    all: [
      {
        type: "interval",
        trigger: true,
        from: { at: "23:00" },
        to: { at: "06:00" },
        days: "every day",
        text: "23:00–06:00 every day",
      },
    ],
  });
  assert.deepEqual(rule.then.map(action), [
    {
      op: "set",
      device: "Люстра",
      room: "Гостиная",
      characteristic: "Включено",
      value: false,
      ref: `${homeRef}/accessory/15/service/13/characteristic/14`,
    },
    {
      op: "set",
      device: "Свет в коридоре",
      room: "Коридор",
      characteristic: "Включено",
      value: true,
      ref: corridorOn,
    },
    {
      op: "set",
      device: "Свет в коридоре",
      room: "Коридор",
      characteristic: "Яркость",
      value: 15,
      unit: "%",
      ref: corridorBrightness,
    },
  ]);
  assert.deepEqual(rule.else.map(action), [
    {
      op: "set",
      device: "Свет в коридоре",
      room: "Коридор",
      characteristic: "Включено",
      value: false,
      ref: corridorOn,
    },
  ]);

  const motion = await read(client, { entity_ref: `${homeRef}/scenario/3` });
  const motionSummary = motion.entity.summary;
  assert.deepEqual(motionSummary.triggers, [
    "Датчик движения в коридоре / Движение: Обнаружено движение = true",
  ]);
  assert.equal(Object.hasOwn(motionSummary, "clock"), false);
  const [motionRule] = motionSummary.steps;
  assert.deepEqual(
    motionRule.condition.all.map(
      ({ type, trigger, device, characteristic, op, value, ref }) => ({
        type,
        trigger,
        device,
        characteristic,
        op,
        value,
        ref,
      }),
    ),
    [
      {
        type: "characteristic",
        trigger: true,
        device: "Датчик движения в коридоре",
        characteristic: "Обнаружено движение",
        op: "=",
        value: true,
        ref: `${homeRef}/accessory/13/service/13/characteristic/14`,
      },
    ],
  );
  const [turnOn, pause] = motionRule.then;
  assert.deepEqual(action(turnOn), {
    op: "set",
    device: "Свет в коридоре",
    room: "Коридор",
    characteristic: "Включено",
    value: true,
    ref: corridorOn,
  });
  assert.deepEqual(
    { type: pause.type, seconds: pause.seconds, mode: pause.mode },
    { type: "delay", seconds: 120, mode: "RESET" },
  );
  assert.deepEqual(pause.steps.map(action), [
    {
      op: "set",
      device: "Свет в коридоре",
      room: "Коридор",
      characteristic: "Включено",
      value: false,
      ref: corridorOn,
    },
  ]);
  assert.deepEqual(motionRule.else, []);

  // The name promises the study light; the stored action switches the
  // computer outlet. The summary reports the action, not the name.
  const study = await read(client, { entity_ref: `${homeRef}/scenario/8` });
  assert.equal(study.entity.name, "Выключить свет в кабинете");
  assert.deepEqual(study.entity.summary.triggers, []);
  assert.deepEqual(study.entity.summary.steps, [
    {
      op: "set",
      device: "Розетка компьютера",
      room: "Кабинет",
      service: "Розетка",
      characteristic: "Включено",
      characteristic_type: "On",
      value: false,
      ref: `${homeRef}/accessory/33/service/13/characteristic/14`,
    },
  ]);

  const leak = await read(client, { entity_ref: `${homeRef}/scenario/9` });
  assert.equal(leak.entity.type, "LOGIC");
  assert.equal(leak.entity.summary.format, "code");
  assert.equal(leak.entity.summary.type, "LOGIC");
  assert.equal(leak.entity.summary.targets_known, false);
  assert.doesNotMatch(JSON.stringify(leak.entity.summary), /Hub\.getAccessory/);

  // Ten lights are named from one accessory catalog read, not one read each.
  const before = hub.requests.length;
  const allOff = await read(client, { entity_ref: `${homeRef}/scenario/11` });
  assert.deepEqual(
    allOff.entity.summary.steps.map(({ device, value }) => [device, value]),
    [
      ["Свет в прихожей", false],
      ["Свет в коридоре", false],
      ["Люстра", false],
      ["Торшер", false],
      ["Светодиодная лента", false],
      ["Свет на кухне", false],
      ["Ночник", false],
      ["Свет в детской", false],
      ["Настольная лампа", false],
      ["Свет в ванной", false],
    ],
  );
  assert.deepEqual(
    hub.requests
      .slice(before)
      .map(({ method }) => method)
      .filter((method) => method.startsWith("accessory.")),
    ["accessory.list"],
  );

  const withConfiguration = await read(client, {
    entity_ref: `${homeRef}/scenario/5`,
    include: ["configuration"],
  });
  assert.deepEqual(withConfiguration.entity.summary, nightSummary);
  assert.equal(
    withConfiguration.entity.configuration.value.targets[0].if.conditions[0]
      .start.cron,
    "0 0 23 ? * * *",
  );
  assertReadOnly(hub);
});

test("a BLOCK summary decodes time forms and scenario runs and lists unknown nodes", async (t) => {
  const { hub, client } = await setup(t, (hub) => {
    hub.state.scenarios.push({
      index: "40",
      name: "Расписания",
      desc: "",
      type: "BLOCK",
      predefined: false,
      active: true,
      onStart: false,
      sync: false,
      error: false,
      data: JSON.stringify({
        blockId: 0,
        targets: [
          {
            type: "if",
            blockId: 1,
            mode: "ONCE",
            if: {
              type: "condition",
              blockId: 2,
              mode: "OR",
              conditions: [
                {
                  type: "cron",
                  mode: "SUNSET",
                  cron: "0 0 0 ? * MON-FRI *",
                  offset: -1800,
                },
                {
                  type: "cron",
                  mode: "NONE",
                  cron: "0 30 7 ? * SAT,SUN *",
                  offset: 0,
                },
                {
                  type: "cron",
                  mode: "NONE",
                  cron: "0 0 0/2 ? * * *",
                  offset: 0,
                },
                {
                  type: "cron",
                  mode: "NONE",
                  cron: "0 0 9 1 10 ? 2026",
                  offset: 0,
                },
                {
                  type: "cron",
                  mode: "NONE",
                  cron: "*/5 * * * * ? *",
                  offset: 0,
                },
                {
                  type: "characteristic",
                  aId: 11,
                  sId: 13,
                  cId: 14,
                  hs: "ContactSensor",
                  hc: "ContactSensorState",
                  cond: "=",
                  value: "1",
                  trigger: false,
                  timeCond: ">",
                  time: 30000,
                },
                { type: "code", code: "return true;" },
              ],
            },
            // biome-ignore lint/suspicious/noThenProperty: native SprutHub BLOCK key.
            then: [
              {
                type: "service",
                aId: 17,
                sId: 13,
                hs: "Lightbulb",
                characteristics: [
                  { type: "inc", cId: 15, hc: "Brightness", value: "10" },
                  { type: "toggle", cId: 14, hc: "On" },
                ],
              },
              { type: "notify", text: "Проверка", mode: "MESSAGE" },
              { type: "scenario", index: "11", mode: "FIRE" },
              { type: "clear_delay", index: 0 },
            ],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      }),
    });
  });
  const baseline = hub.snapshot();
  const pointer = "/configuration/value/targets/0";

  const result = await read(client, { entity_ref: `${homeRef}/scenario/40` });
  const summary = result.entity.summary;
  assert.deepEqual(summary.triggers, [
    "30 min before sunset MON,TUE,WED,THU,FRI",
    "07:30 SAT,SUN",
    "every 2 h",
    "2026-10-01 09:00",
  ]);
  const [rule] = summary.steps;
  assert.equal(rule.mode, "ONCE");
  const conditions = rule.condition.any;
  assert.deepEqual(
    conditions.slice(0, 4).map(({ text, ...time }) => [text, time]),
    [
      [
        "30 min before sunset MON,TUE,WED,THU,FRI",
        {
          type: "time",
          trigger: true,
          sun: "sunset",
          offset_seconds: -1800,
          days: ["MON", "TUE", "WED", "THU", "FRI"],
        },
      ],
      [
        "07:30 SAT,SUN",
        { type: "time", trigger: true, at: "07:30", days: ["SAT", "SUN"] },
      ],
      [
        "every 2 h",
        {
          type: "time",
          trigger: true,
          every: { hours: 2 },
          days: "every day",
        },
      ],
      [
        "2026-10-01 09:00",
        { type: "time", trigger: true, date: "2026-10-01", at: "09:00" },
      ],
    ],
  );
  assert.deepEqual(conditions[4], {
    type: "unrecognized",
    pointer: `${pointer}/if/conditions/4`,
    native_type: "cron",
  });
  assert.deepEqual(conditions[5], {
    type: "characteristic",
    trigger: false,
    device: "Датчик двери",
    room: "Прихожая",
    service: "Входная дверь",
    characteristic: "Состояние контакта",
    characteristic_type: "ContactSensorState",
    op: "=",
    value: 1,
    value_name: "Открыто",
    held: { op: ">", seconds: 30 },
    ref: `${homeRef}/accessory/11/service/13/characteristic/14`,
  });
  assert.deepEqual(conditions[6], {
    type: "code",
    status: "not_analyzed",
    pointer: `${pointer}/if/conditions/6`,
  });
  assert.deepEqual(
    rule.then.map(({ op, type, characteristic, value, unit, ...rest }) =>
      op ? { op, characteristic, value, unit } : { type, ...rest },
    ),
    [
      { op: "increase", characteristic: "Яркость", value: 10, unit: "%" },
      {
        op: "toggle",
        characteristic: "Включено",
        value: undefined,
        unit: undefined,
      },
      {
        type: "unrecognized",
        pointer: `${pointer}/then/1`,
        native_type: "notify",
      },
      {
        type: "run_scenario",
        mode: "FIRE",
        scenario_ref: `${homeRef}/scenario/11`,
        scenario_name: "Всё выключить",
        active: true,
      },
      { type: "clear_delay", delay: "all" },
    ],
  );
  assert.deepEqual(summary.unrecognized, [
    { pointer: `${pointer}/if/conditions/4`, native_type: "cron" },
    { pointer: `${pointer}/then/1`, native_type: "notify" },
  ]);
  assertReadOnly(hub, baseline);
});

test("entity reads name the home once and offer options once per entity", async (t) => {
  const { hub, client } = await setup(t);
  const motionSensor = `${homeRef}/accessory/13`;
  const motion = `${motionSensor}/service/13/characteristic/14`;

  const accessory = await read(client, { entity_ref: motionSensor });
  assert.equal(accessory.home_ref, homeRef);
  assert.equal(Object.hasOwn(accessory, "home"), false);
  const characteristics = accessory.entity.services.flatMap(
    ({ characteristics: items }) => items,
  );
  assert.deepEqual(
    characteristics
      .filter(({ options_available: available }) => available === true)
      .map(({ ref }) => ref),
    [motion],
  );
  for (const characteristic of characteristics) {
    assert.equal(typeof characteristic.options_available, "boolean");
    assert.equal(Object.hasOwn(characteristic, "option_scope"), false);
  }
  assert.deepEqual(accessory.entity.options_next, {
    tool: "get_entity",
    candidates: [{ entity_ref: motion, include: ["options"] }],
  });
  const [candidate] = accessory.entity.options_next.candidates;
  const options = await read(client, candidate);
  assert.deepEqual(
    options.entity.options.map(({ key, configured_value: value }) => [
      key,
      value,
    ]),
    [
      ["primary", 0],
      ["ShowAllEvents", false],
      ["Inversed", false],
      ["SwitchOffTime", 60],
    ],
  );

  const detail = await read(client, { entity_ref: motion });
  assert.equal(detail.entity.options_available, true);
  assert.deepEqual(detail.entity.options_next, {
    tool: "get_entity",
    arguments: { entity_ref: motion, include: ["options"] },
  });
  assert.equal(Object.hasOwn(options.entity, "options_next"), false);

  const light = await read(client, { entity_ref: corridorOn });
  assert.equal(light.entity.options_available, false);
  assert.equal(Object.hasOwn(light.entity, "options_next"), false);
  const lamp = await read(client, { entity_ref: `${homeRef}/accessory/14` });
  assert.equal(Object.hasOwn(lamp.entity, "options_next"), false);

  const part = await read(client, {
    entity_ref: motionSensor,
    pointer: "/services/1",
  });
  assert.equal(part.home_ref, homeRef);
  assert.equal(Object.hasOwn(part, "home"), false);
  assertReadOnly(hub);
});

test("relations of the corridor light list only its own roles with branch, value and time", async (t) => {
  const { hub, client } = await setup(t);
  const motionScenario = `${homeRef}/scenario/3`;
  const nightScenario = `${homeRef}/scenario/5`;
  const allOffScenario = `${homeRef}/scenario/11`;
  const onMotion =
    "Датчик движения в коридоре / Движение: Обнаружено движение = true";

  const result = await read(client, {
    entity_ref: corridorOn,
    include: ["relations"],
  });
  t.diagnostic(`corridor light On with relations: ${result.bytes} bytes`);
  assert.ok(result.bytes <= 4096, `${result.bytes} bytes`);
  const relations = result.entity.relations;
  assert.deepEqual(
    relations.scenario_roles.map(
      ({ pointer: _pointer, same_device_actions: _same, ...role }) => role,
    ),
    [
      {
        scenario_ref: motionScenario,
        scenario_name: "Свет в коридоре по движению",
        active: true,
        role: "action",
        op: "set",
        value: true,
        branch: "then",
        when: onMotion,
      },
      {
        scenario_ref: motionScenario,
        scenario_name: "Свет в коридоре по движению",
        active: true,
        role: "action",
        op: "set",
        value: false,
        branch: "then",
        when: onMotion,
        delay: { seconds: 120, mode: "RESET" },
      },
      {
        scenario_ref: nightScenario,
        scenario_name: "Ночной режим",
        active: true,
        role: "action",
        op: "set",
        value: true,
        branch: "then",
        when: "23:00–06:00 every day",
      },
      {
        scenario_ref: nightScenario,
        scenario_name: "Ночной режим",
        active: true,
        role: "action",
        op: "set",
        value: false,
        branch: "else",
        when: "not (23:00–06:00 every day)",
      },
      {
        scenario_ref: allOffScenario,
        scenario_name: "Всё выключить",
        active: true,
        role: "action",
        op: "set",
        value: false,
        branch: null,
      },
    ],
  );
  // At 23:00 the same step also dims the light; that is part of this role.
  assert.deepEqual(relations.scenario_roles[2].same_device_actions, [
    { characteristic: "Яркость", op: "set", value: 15, unit: "%" },
  ]);
  // Motion trigger, chandelier, corridor brightness and nine other lights.
  assert.equal(relations.other_roles_count, 12);
  assert.doesNotMatch(
    JSON.stringify(relations.scenario_roles),
    /accessory\/(?!14\/)\d+/,
  );
  for (const role of relations.scenario_roles) {
    const node = await read(client, {
      entity_ref: role.scenario_ref,
      include: ["configuration"],
      pointer: role.pointer,
    });
    assert.deepEqual(
      { type: node.selection.value.type, cId: node.selection.value.cId },
      { type: "set", cId: 14 },
    );
  }
  assert.deepEqual(relations.checked, {
    scenario_accessory_index: "found",
    block_scenarios_read: 3,
    logic_assignments: "checked_empty",
    characteristic_links: "found",
  });
  assert.deepEqual(relations.unchecked, []);
  assert.equal(typeof relations.limitation, "string");
  assert.deepEqual(relations.assigned_logics, []);

  const sensor = await read(client, {
    entity_ref: `${homeRef}/accessory/13`,
    include: ["relations"],
  });
  const sensorRelations = sensor.entity.relations;
  assert.deepEqual(
    sensorRelations.scenario_roles.map(
      ({ pointer: _pointer, scenario_name: _name, ...role }) => role,
    ),
    [
      {
        scenario_ref: motionScenario,
        active: true,
        entity_ref: `${homeRef}/accessory/13/service/13/characteristic/14`,
        characteristic: "Обнаружено движение",
        role: "trigger",
        op: "=",
        value: true,
      },
      // The fixture's evening living-room rule also reads this sensor's light level.
      {
        scenario_ref: `${homeRef}/scenario/14`,
        active: true,
        entity_ref: `${homeRef}/accessory/13/service/20/characteristic/21`,
        characteristic: "Освещенность",
        role: "condition",
        op: "<",
        value: 30,
        unit: "lux",
      },
    ],
  );
  assert.equal(sensorRelations.other_roles_count, 4);
  assert.deepEqual(
    sensorRelations.unchecked.map(({ area, outcome }) => [area, outcome]),
    [["characteristic_links", "not_read"]],
  );
  assertReadOnly(hub);
});

test("a large room gives its size and hands the device list to find_devices", async (t) => {
  const study = `${homeRef}/room/7`;
  const { hub, client } = await setup(t, (hub) => {
    // Seven more desk lamps (information + light service each) take the
    // study from 7 to 21 services.
    const lamp = hub.state.accessories.find(({ id }) => id === 32);
    for (let id = 201; id <= 207; id += 1) {
      const clone = structuredClone(lamp);
      clone.id = id;
      clone.name = `Настольная лампа ${id}`;
      for (const service of clone.services) {
        service.aId = id;
        for (const characteristic of service.characteristics) {
          characteristic.aId = id;
        }
      }
      hub.state.accessories.push(clone);
    }
  });
  const baseline = hub.snapshot();

  const living = await read(client, { entity_ref: `${homeRef}/room/3` });
  assert.deepEqual(
    living.entity.accessories.map(({ name }) => name),
    [
      "Люстра",
      "Торшер",
      "Светодиодная лента",
      "Шторы в гостиной",
      "Кондиционер",
      "Розетка телевизора",
    ],
  );

  const large = await read(client, { entity_ref: study });
  t.diagnostic(`study with 21 services: ${large.bytes} bytes`);
  const catalog = {
    tool: "find_devices",
    arguments: {
      home_ref: homeRef,
      room_ref: study,
    },
  };
  assert.deepEqual(large.entity, {
    kind: "room",
    ref: study,
    name: "Кабинет",
    accessory_count: 10,
    service_count: 21,
    next: catalog,
  });
  const listed = await client.callTool({
    name: catalog.tool,
    arguments: catalog.arguments,
  });
  assert.equal(listed.isError, undefined, listed.content[0]?.text);
  // The seven lamp clones add a light each; device information and
  // battery services stay out of the list.
  assert.equal(listed.structuredContent.total, 10);
  assert.equal(listed.structuredContent.next, null);

  const withRelations = await read(client, {
    entity_ref: study,
    include: ["relations"],
  });
  assert.deepEqual(withRelations.entity.include_resolution.not_applied, [
    { include: "relations", reason: "related_entity_scoped", next: catalog },
  ]);
  assertReadOnly(hub, baseline);
});
