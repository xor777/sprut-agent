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

// Scenario pieces an owner builds in the SprutHub editor, written by the
// agent through MCP stdio into the simulated apartment. The node shapes are
// the official web client's (research/protocol/2026-09-24-web-client-evidence.md
// and -action-map.md, rows D6, D10, D13, D15, D16, D17).
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const scenarioRef = (index) => `${homeRef}/scenario/${index}`;

async function setup(t, patch = () => {}) {
  const fixture = await loadHomeFixture("apartment");
  patch(fixture);
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-block-nodes-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "5000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "block-nodes-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, stateDirectory };
}

async function call(client, name, args) {
  return (await client.callTool({ name, arguments: args })).structuredContent;
}

// «Протечка в ванной»: the bathroom leak sensor reports a leak.
function leakDetected(aId = 37) {
  return {
    type: "characteristic",
    aId,
    sId: 13,
    cId: 14,
    hs: "LeakSensor",
    hc: "LeakDetected",
    trigger: true,
    cond: "=",
    value: "1",
    timeCond: "",
    time: 0,
  };
}

function whenLeak(then, rest = {}) {
  return {
    type: "if",
    mode: "EVERY",
    if: { type: "condition", mode: "AND", conditions: [leakDetected()] },
    then,
    else: [],
    then_delay: 0,
    else_delay: 0,
    ...rest,
  };
}

function fanOn() {
  return {
    type: "service",
    aId: 36,
    sId: 13,
    hs: "Fan",
    characteristics: [{ type: "set", cId: 14, hc: "On", value: "true" }],
  };
}

function prepareCreate(client, data, name = "Протечка в ванной") {
  return call(client, "prepare_native_change", {
    operation: "block_create",
    target_ref: homeRef,
    name,
    description: "Проверка узлов редактора",
    active: true,
    on_start: false,
    sync: false,
    reason: "Owner asked for this scenario",
    data,
  });
}

async function createBlock(client, data, name) {
  const prepared = await prepareCreate(client, data, name);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  return { prepared, applied, index: applied.scenario_index };
}

// The agent's edit path: read the stored data through get_entity, change
// it and send the whole data back.
async function prepareUpdate(client, index, edit) {
  const read = await call(client, "get_entity", {
    entity_ref: scenarioRef(index),
    include: ["configuration"],
  });
  const data = structuredClone(read.entity.configuration.value);
  edit(data);
  return call(client, "prepare_native_change", {
    operation: "block_data_update",
    target_ref: scenarioRef(index),
    reason: "Owner asked for this change",
    data,
  });
}

function storedData(hub, index) {
  const scenario = hub.state.scenarios.find((item) => item.index === index);
  return withoutHubFields(JSON.parse(scenario.data));
}

// blockId on every node and state on if are what the hub adds.
function withoutHubFields(value) {
  if (Array.isArray(value)) return value.map(withoutHubFields);
  if (value === null || typeof value !== "object") return value;
  const { blockId: _blockId, ...rest } = value;
  if (rest.type === "if") delete rest.state;
  return Object.fromEntries(
    Object.entries(rest).map(([key, child]) => [key, withoutHubFields(child)]),
  );
}

function problemsOf(result) {
  assert.equal(
    result.error?.code,
    "invalid_block_data",
    JSON.stringify(result),
  );
  return result.problems.map(({ pointer }) => pointer);
}

test("a scenario switches another scenario on or off and repeats a branch while its condition holds", async (t) => {
  const { hub, client } = await setup(t);
  // «Пока в ванной протечка — каждые 5 минут включай вытяжку и выключи
  // сценарий вечернего света; когда сухо — включи его обратно.»
  const data = {
    targets: [
      whenLeak(
        [fanOn(), { type: "scenario", index: "14", mode: "DEACTIVATE" }],
        {
          else: [{ type: "scenario", index: "14", mode: "ACTIVATE" }],
          then_delay: 300_000,
        },
      ),
    ],
  };
  const { prepared, index } = await createBlock(client, data);
  assert.deepEqual(
    prepared.block_action_preview.scenario_runs.map((run) => ({
      pointer: run.configuration_pointer,
      mode: run.mode,
      ref: run.scenario.ref,
      name: run.scenario.name,
    })),
    [
      {
        pointer: "/targets/0/then/1",
        mode: "DEACTIVATE",
        ref: scenarioRef("14"),
        name: "Вечерний свет в гостиной",
      },
      {
        pointer: "/targets/0/else/0",
        mode: "ACTIVATE",
        ref: scenarioRef("14"),
        name: "Вечерний свет в гостиной",
      },
    ],
  );
  assert.deepEqual(storedData(hub, index), data);

  const summary = (
    await call(client, "get_entity", { entity_ref: scenarioRef(index) })
  ).entity.summary;
  const [branch] = summary.steps;
  assert.equal(branch.repeat_then_every_seconds, 300);
  assert.deepEqual(
    [branch.then[1], branch.else[0]].map(({ type, mode, scenario_ref }) => ({
      type,
      mode,
      scenario_ref,
    })),
    [
      {
        type: "run_scenario",
        mode: "DEACTIVATE",
        scenario_ref: scenarioRef("14"),
      },
      {
        type: "run_scenario",
        mode: "ACTIVATE",
        scenario_ref: scenarioRef("14"),
      },
    ],
  );

  // A mode the editor does not offer and repeat periods that are not whole
  // milliseconds of at least a second are refused where they are.
  const refused = await prepareCreate(client, {
    targets: [
      whenLeak([{ type: "scenario", index: "14", mode: "STOP" }], {
        then_delay: 500,
        else_delay: 1500.5,
      }),
    ],
  });
  assert.deepEqual(problemsOf(refused).sort(), [
    "/targets/0/else_delay",
    "/targets/0/then/0/mode",
    "/targets/0/then_delay",
  ]);
});

test("switching scenarios is checked for runs back to the edited BLOCK and keeps a switched scenario from restore", async (t) => {
  const { hub, client } = await setup(t);
  // B turns the corridor motion light (3) on and runs it.
  const b = await createBlock(
    client,
    {
      targets: [
        whenLeak([{ type: "scenario", index: "3", mode: "ACTIVATE_AND_FIRE" }]),
      ],
    },
    "Протечка: свет в коридоре",
  );

  // 3 -> B -> 3 would run the two BLOCKs without end.
  const loop = await prepareUpdate(client, "3", (data) => {
    data.targets.push({
      type: "scenario",
      index: b.index,
      mode: "ACTIVATE_AND_FIRE",
    });
  });
  assert.deepEqual(problemsOf(loop), ["/targets/1"]);
  assert.match(loop.problems[0].message, /runs this BLOCK again/);
  const self = await prepareUpdate(client, "3", (data) => {
    data.targets.push({
      type: "scenario",
      index: "3",
      mode: "ACTIVATE_AND_FIRE",
    });
  });
  assert.deepEqual(problemsOf(self), ["/targets/1"]);

  // Turning B off, or 3 itself, runs nothing.
  const switchOff = await prepareUpdate(client, "3", (data) => {
    data.targets.push({ type: "scenario", index: b.index, mode: "DEACTIVATE" });
    data.targets.push({ type: "scenario", index: "3", mode: "DEACTIVATE" });
  });
  assert.equal(switchOff.status, "prepared", JSON.stringify(switchOff));
  const applied = await call(client, "apply_native_change", {
    change_ref: switchOff.change_ref,
  });
  assert.equal(applied.status, "applied");

  // Deleting B would leave 3 switching a scenario that is gone.
  const restored = await call(client, "restore_native_change", {
    change_ref: b.prepared.change_ref,
  });
  assert.equal(restored.conflict_reason, "scenario_targets_present");
  assert.deepEqual(
    restored.referencing_scenario_targets.map(
      ({ scenario_ref, configuration_pointer }) => ({
        scenario_ref,
        configuration_pointer,
      }),
    ),
    [
      {
        scenario_ref: scenarioRef("3"),
        configuration_pointer: "/configuration/value/targets/1",
      },
    ],
  );
  assert.ok(hub.state.scenarios.some((item) => item.index === b.index));
});

// Notification services as on the owner's hub on 2026-09-24: a Telegram
// service in state FAILED without recipients and a web service with one.
function withNotificationServices(fixture) {
  const telegram = fixture.extensions.find(
    (extension) => extension.extensionKey === "Notification:telegram",
  );
  Object.assign(telegram, { enabled: true, state: "FAILED" });
  fixture.extensions.push({
    extensionKey: "Notification:web",
    type: "web",
    index: "web",
    bundleType: "NOTIFICATION",
    name: "Веб-уведомления",
    optionsWindow: "Notification/web/",
    enabled: true,
    state: "LOADED",
    children: [{ id: "2", name: "Браузер владельца" }],
  });
}

test("a scenario sends a notification when the bathroom leaks", async (t) => {
  const { hub, client } = await setup(t, withNotificationServices);
  // «Пришли уведомление, если протечка»: through every notification service,
  // and to the owner's browser by name.
  const everywhere = {
    type: "notify",
    text: "Протечка в ванной!",
    mode: "PUSH",
    to: null,
  };
  const browser = {
    type: "notify",
    text: "Протечка: закрой воду",
    mode: "PUSH",
    to: [{ index: "web", clients: ["2"] }],
  };
  const data = { targets: [whenLeak([everywhere, browser])] };
  const { prepared, index } = await createBlock(client, data);
  const services = {
    telegram: {
      ref: `${homeRef}/extension/Notification%3Atelegram`,
      name: "Telegram",
      enabled: true,
      state: "FAILED",
    },
    web: {
      ref: `${homeRef}/extension/Notification%3Aweb`,
      name: "Веб-уведомления",
      enabled: true,
      state: "LOADED",
    },
  };
  assert.deepEqual(prepared.block_action_preview.notifications, [
    {
      configuration_pointer: "/targets/0/then/0",
      mode: "PUSH",
      text: "Протечка в ванной!",
      delivery: "all_notification_services",
      services: [
        { ...services.telegram, recipients: "all" },
        { ...services.web, recipients: "all" },
      ],
    },
    {
      configuration_pointer: "/targets/0/then/1",
      mode: "PUSH",
      text: "Протечка: закрой воду",
      delivery: "listed_services",
      services: [
        {
          ...services.web,
          recipients: [
            {
              ref: `${homeRef}/extension/Notification%3Aweb/child/2`,
              name: "Браузер владельца",
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(storedData(hub, index), data);

  const summary = (
    await call(client, "get_entity", { entity_ref: scenarioRef(index) })
  ).entity.summary;
  assert.deepEqual(summary.steps[0].then, [
    { type: "notify", mode: "PUSH", text: "Протечка в ванной!", to: "all" },
    {
      type: "notify",
      mode: "PUSH",
      text: "Протечка: закрой воду",
      to: [{ service_index: "web", clients: ["2"] }],
    },
  ]);
  // A notification names no device: the leak sensor is the only one used.
  const relations = (
    await call(client, "get_entity", {
      entity_ref: `${homeRef}/accessory/37/service/13/characteristic/14`,
      include: ["relations"],
    })
  ).entity.relations;
  assert.deepEqual(
    relations.scenario_roles.map(({ scenario_ref, role }) => ({
      scenario_ref,
      role,
    })),
    [{ scenario_ref: scenarioRef(index), role: "trigger" }],
  );
  assert.equal(relations.other_roles_count, 0);

  // Each wrong part is refused where it is.
  const notify = (fields) => ({
    type: "notify",
    text: "Протечка",
    mode: "PUSH",
    to: null,
    ...fields,
  });
  const refused = await prepareCreate(client, {
    targets: [
      whenLeak([
        notify({ text: "" }),
        notify({ mode: "SMS" }),
        notify({ mode: "MESSAGE", to: [{ index: "web", clients: null }] }),
        notify({ to: [{ index: "sms", clients: null }] }),
        notify({ to: [{ index: "web", clients: ["99"] }] }),
        notify({ to: [] }),
        // What sprut-agent shows in place of credential-shaped text is not
        // the owner's text.
        notify({ text: "[REDACTED]" }),
      ]),
    ],
  });
  assert.deepEqual(problemsOf(refused).sort(), [
    "/targets/0/then/0/text",
    "/targets/0/then/1/mode",
    "/targets/0/then/2/to",
    "/targets/0/then/3/to/0/index",
    "/targets/0/then/4/to/0/clients/0",
    "/targets/0/then/5/to",
    "/targets/0/then/6/text",
  ]);
});
