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

// Each notification of a preview with its warnings as code and service.
function withWarningCodes(preview) {
  return preview.notifications.map(({ warnings = [], ...notification }) => ({
    ...notification,
    warnings: warnings.map(({ code, service_ref }) => ({ code, service_ref })),
  }));
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
  assert.deepEqual(withWarningCodes(prepared.block_action_preview), [
    {
      configuration_pointer: "/targets/0/then/0",
      mode: "PUSH",
      text: "Протечка в ванной!",
      delivery: "all_notification_services",
      services: [
        { ...services.telegram, recipients: "all", recipient_count: 0 },
        { ...services.web, recipients: "all", recipient_count: 1 },
      ],
      // Telegram is FAILED and has no one to send to: the agent must not
      // promise this notification through it.
      warnings: [
        { code: "service_not_ready", service_ref: services.telegram.ref },
        { code: "no_recipients", service_ref: services.telegram.ref },
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
      warnings: [],
    },
  ]);
  // The hub keeps a PUSH to every service without to.
  const { to: _all, ...storedEverywhere } = everywhere;
  assert.deepEqual(storedData(hub, index), {
    targets: [whenLeak([storedEverywhere, browser])],
  });

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

// The owner's Telegram service is FAILED and has no recipients
// (2026-09-24). A notification sent through it alone reaches no one, and the
// preview says so instead of "all" recipients.
test("a notification through a service without recipients is named in the preview", async (t) => {
  const { client } = await setup(t, withNotificationServices);
  const telegramRef = `${homeRef}/extension/Notification%3Atelegram`;
  const { prepared } = await createBlock(client, {
    targets: [
      whenLeak([
        {
          type: "notify",
          text: "Протечка в ванной!",
          mode: "PUSH",
          to: [{ index: "telegram", clients: null }],
        },
      ]),
    ],
  });
  assert.deepEqual(withWarningCodes(prepared.block_action_preview), [
    {
      configuration_pointer: "/targets/0/then/0",
      mode: "PUSH",
      text: "Протечка в ванной!",
      delivery: "listed_services",
      services: [
        {
          ref: telegramRef,
          name: "Telegram",
          enabled: true,
          state: "FAILED",
          recipients: "all",
          recipient_count: 0,
        },
      ],
      warnings: [
        { code: "service_not_ready", service_ref: telegramRef },
        { code: "no_recipients", service_ref: telegramRef },
      ],
    },
  ]);
});

test("a scenario makes an HTTP request and answers name only its scheme and host", async (t) => {
  const { hub, client } = await setup(t);
  const secret = "S3CRET-KEY-VALUE";
  // «Если протечка — включи реле по HTTP и дёрни вебхук.»
  const relay = {
    type: "http",
    method: "GET",
    url: "http://192.168.1.50/relay/0?turn=on",
  };
  const webhook = {
    type: "http",
    method: "POST",
    url: `https://maker.ifttt.com/trigger/leak/json?api_key=${secret}`,
  };
  const data = { targets: [whenLeak([relay, webhook])] };
  const { prepared, index } = await createBlock(client, data);
  assert.deepEqual(prepared.block_action_preview.http_requests, [
    {
      configuration_pointer: "/targets/0/then/0",
      method: "GET",
      url: "http://192.168.1.50",
      path: "not_shown",
      query: "not_shown",
    },
    {
      configuration_pointer: "/targets/0/then/1",
      method: "POST",
      url: "https://maker.ifttt.com",
      path: "not_shown",
      query: "not_shown",
    },
  ]);
  // The hub gets the whole URL; answers never repeat the key.
  assert.deepEqual(storedData(hub, index), data);
  const change = await call(client, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  const summary = (
    await call(client, "get_entity", { entity_ref: scenarioRef(index) })
  ).entity.summary;
  for (const answer of [prepared, change, summary]) {
    assert.equal(JSON.stringify(answer).includes(secret), false);
  }
  assert.deepEqual(summary.steps[0].then, [
    {
      type: "http",
      method: "GET",
      url: "http://192.168.1.50",
      path: "not_shown",
      query: "not_shown",
    },
    {
      type: "http",
      method: "POST",
      url: "https://maker.ifttt.com",
      path: "not_shown",
      query: "not_shown",
    },
  ]);

  // The agent edits the BLOCK from what get_entity shows, the hidden URL
  // included; the stored request stays as it is.
  const edited = await prepareUpdate(client, index, (read) => {
    read.targets[0].then.push(fanOn());
  });
  assert.equal(edited.status, "prepared", JSON.stringify(edited));
  assert.equal(JSON.stringify(edited).includes(secret), false);
  const applied = await call(client, "apply_native_change", {
    change_ref: edited.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(storedData(hub, index).targets[0].then.slice(0, 2), [
    relay,
    webhook,
  ]);

  const http = (fields) => ({ type: "http", method: "GET", ...fields });
  const refused = await prepareCreate(client, {
    targets: [
      whenLeak([
        http({ url: "ftp://192.168.1.50/file" }),
        // A user name and password would be repeated in every answer.
        http({ url: "http://admin:password1@192.168.1.1/reboot" }),
        http({ url: "relay/0?turn=on" }),
        http({ url: "http://192.168.1.50/", method: "FETCH" }),
        http({ url: "[REDACTED]" }),
      ]),
    ],
  });
  assert.deepEqual(problemsOf(refused), [
    "/targets/0/then/0/url",
    "/targets/0/then/1/url",
    "/targets/0/then/2/url",
    "/targets/0/then/3/method",
    "/targets/0/then/4/url",
  ]);
  assert.equal(JSON.stringify(refused).includes("password1"), false);
});

// Services put the key in the path as often as in the query: Telegram
// /bot<token>/, IFTTT /with/key/<key>, Slack, Discord and Home Assistant
// webhook ids. A query name the redaction does not know (?key=) and a
// password without a user name are keys too. No answer repeats any of them.
test("answers name only the scheme and host of a request, whatever part of its URL holds the key", async (t) => {
  const { hub, client } = await setup(t);
  const token = "123456789:AAHsecretTelegramToken";
  const key = "k3y-in-the-query";
  const password = "r0uter-pass";
  const telegram = {
    type: "http",
    method: "GET",
    url: `https://api.telegram.org/bot${token}/sendMessage?chat_id=1&text=leak`,
  };
  const socket = {
    type: "http",
    method: "GET",
    url: `http://192.168.1.60/cm?key=${key}&cmnd=Power%20On`,
  };
  const secrets = [token, key, password];
  const leaks = (answer) =>
    secrets.filter((secret) => JSON.stringify(answer).includes(secret));

  const { prepared, index } = await createBlock(client, {
    targets: [whenLeak([fanOn(), telegram, socket])],
  });
  assert.deepEqual(prepared.block_action_preview.http_requests, [
    {
      configuration_pointer: "/targets/0/then/1",
      method: "GET",
      url: "https://api.telegram.org",
      path: "not_shown",
      query: "not_shown",
    },
    {
      configuration_pointer: "/targets/0/then/2",
      method: "GET",
      url: "http://192.168.1.60",
      path: "not_shown",
      query: "not_shown",
    },
  ]);
  // The owner added a reboot of the router in the SprutHub interface, with
  // the password and no user name in the URL.
  const scenario = hub.state.scenarios.find((item) => item.index === index);
  const stored = JSON.parse(scenario.data);
  stored.targets[0].then.push({
    type: "http",
    blockId: 99,
    method: "GET",
    url: `http://:${password}@192.168.1.1/reboot`,
  });
  scenario.data = JSON.stringify(stored);

  const summary = (
    await call(client, "get_entity", { entity_ref: scenarioRef(index) })
  ).entity.summary;
  assert.deepEqual(summary.steps[0].then.slice(1), [
    {
      type: "http",
      method: "GET",
      url: "https://api.telegram.org",
      path: "not_shown",
      query: "not_shown",
    },
    {
      type: "http",
      method: "GET",
      url: "http://192.168.1.60",
      path: "not_shown",
      query: "not_shown",
    },
    {
      type: "http",
      method: "GET",
      url: "http://192.168.1.1",
      path: "not_shown",
    },
  ]);
  const configuration = (
    await call(client, "get_entity", {
      entity_ref: scenarioRef(index),
      include: ["configuration"],
    })
  ).entity.configuration.value;
  assert.deepEqual(
    configuration.targets[0].then.slice(1).map(({ url }) => url),
    ["[REDACTED]", "[REDACTED]", "[REDACTED]"],
  );

  // An edit made from that read keeps the three stored requests.
  const edited = await prepareUpdate(client, index, (read) => {
    read.targets[0].then.push({
      type: "http",
      method: "POST",
      url: "http://192.168.1.50/",
    });
  });
  assert.equal(edited.status, "prepared", JSON.stringify(edited));
  const applied = await call(client, "apply_native_change", {
    change_ref: edited.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(
    storedData(hub, index)
      .targets[0].then.slice(1)
      .map(({ url }) => url),
    [
      telegram.url,
      socket.url,
      `http://:${password}@192.168.1.1/reboot`,
      "http://192.168.1.50/",
    ],
  );

  const answers = {
    prepared,
    created: await call(client, "get_native_change", {
      change_ref: prepared.change_ref,
    }),
    summary,
    configuration,
    edited,
    applied,
    history: await call(client, "list_native_changes", { home_ref: homeRef }),
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(answers).map(([name, answer]) => [name, leaks(answer)]),
    ),
    Object.fromEntries(Object.keys(answers).map((name) => [name, []])),
  );
});

// Copying a request read from get_entity into another branch would copy the
// owner's hidden URL with it: the hidden URL is kept only where exactly one
// node of the edit carries the stored node's blockId.
test("an edit that copies a request with a hidden URL is refused where the copies are", async (t) => {
  const { hub, client } = await setup(t);
  const token = "123456789:AAHsecretTelegramToken";
  const { index } = await createBlock(client, {
    targets: [
      whenLeak([
        fanOn(),
        {
          type: "http",
          method: "GET",
          url: `https://api.telegram.org/bot${token}/sendMessage`,
        },
      ]),
    ],
  });
  const before = hub.state.scenarios.find((item) => item.index === index).data;

  const copied = await prepareUpdate(client, index, (read) => {
    read.targets[0].else = [structuredClone(read.targets[0].then[1])];
  });
  assert.deepEqual(problemsOf(copied), [
    "/targets/0/then/1/url",
    "/targets/0/else/0/url",
  ]);
  assert.equal(JSON.stringify(copied).includes(token), false);
  assert.equal(
    hub.state.scenarios.find((item) => item.index === index).data,
    before,
  );
});

// «Ночник — такой же яркости, как свет в коридоре, когда тот меняется»,
// with the from action as the web client writes it (value "").
const corridorBrightness = `${homeRef}/accessory/14/service/13/characteristic/15`;
const nightLightBrightness = `${homeRef}/accessory/26/service/13/characteristic/15`;

function fromCorridor(fields = {}) {
  return {
    type: "from",
    cId: 15,
    hc: "Brightness",
    value: "",
    from_aId: 14,
    from_sId: 13,
    from_cId: 15,
    from_hs: "Lightbulb",
    from_hc: "Brightness",
    ...fields,
  };
}

// The from action as SprutHub 3.0.0 stores it: without the empty value
// (research/protocol/2026-09-25-live-conformance-4.md).
function storedFromCorridor() {
  const { value: _empty, ...stored } = fromCorridor();
  return stored;
}

function nightLight(action) {
  return {
    type: "service",
    aId: 26,
    sId: 13,
    hs: "Lightbulb",
    characteristics: [action],
  };
}

function whenCorridorChanges(then) {
  return {
    type: "if",
    mode: "EVERY",
    if: {
      type: "condition",
      mode: "AND",
      conditions: [
        {
          type: "characteristic",
          aId: 14,
          sId: 13,
          cId: 15,
          hs: "Lightbulb",
          hc: "Brightness",
          trigger: true,
          cond: ">",
          value: "0",
          timeCond: "",
          time: 0,
        },
      ],
    },
    then,
    else: [],
    then_delay: 0,
    else_delay: 0,
  };
}

test("a scenario sets a value from another characteristic", async (t) => {
  const { hub, client } = await setup(t);
  const rule = whenCorridorChanges;
  const data = { targets: [rule([nightLight(fromCorridor())])] };
  const { prepared, index } = await createBlock(client, data, "Ночник");
  assert.deepEqual(prepared.block_action_preview.actions, [
    {
      configuration_pointer: "/targets/0/then/0/characteristics/0",
      characteristic_ref: nightLightBrightness,
      service_type: "Lightbulb",
      characteristic_type: "Brightness",
      command: {
        operation: "from",
        source: {
          characteristic_ref: corridorBrightness,
          service_type: "Lightbulb",
          characteristic_type: "Brightness",
          observation: { status: "available", value: 60, kind: "intValue" },
        },
        kind: "intValue",
        execution: "write_if_action_runs",
      },
      observation: { status: "available", value: 20, kind: "intValue" },
      comparison_to_observation: "not_applicable",
      branch: {
        condition_pointer: "/targets/0/if",
        when: "condition_true",
        coverage: { status: "undisclosed", reason: "inapplicable_form" },
      },
    },
  ]);
  assert.deepEqual(storedData(hub, index), {
    targets: [rule([nightLight(storedFromCorridor())])],
  });

  const summary = (
    await call(client, "get_entity", { entity_ref: scenarioRef(index) })
  ).entity.summary;
  assert.deepEqual(summary.steps[0].then, [
    {
      op: "set_from",
      device: "Ночник",
      room: "Спальня",
      service: "Свет",
      characteristic: "Яркость",
      characteristic_type: "Brightness",
      source: {
        device: "Свет в коридоре",
        room: "Коридор",
        service: "Свет",
        characteristic: "Яркость",
        characteristic_type: "Brightness",
        ref: corridorBrightness,
      },
      ref: nightLightBrightness,
    },
  ]);
  // The corridor light is read by the rule: its relations name it as the
  // trigger and as the source of the night light's value.
  const relations = (
    await call(client, "get_entity", {
      entity_ref: corridorBrightness,
      include: ["relations"],
    })
  ).entity.relations;
  assert.deepEqual(
    relations.scenario_roles
      .filter(({ scenario_ref }) => scenario_ref === scenarioRef(index))
      .map(({ role, pointer }) => ({ role, pointer })),
    [
      {
        role: "trigger",
        pointer: "/configuration/value/targets/0/if/conditions/0",
      },
      {
        role: "source",
        pointer: "/configuration/value/targets/0/then/0/characteristics/0",
      },
    ],
  );

  const each = [];
  for (const action of [
    // On is a yes/no value, Brightness a number.
    fromCorridor({ from_cId: 14, from_hc: "On" }),
    fromCorridor({ from_cId: 99 }),
    fromCorridor({ from_hs: "Fan" }),
    fromCorridor({ value: "5" }),
    // The night light's own brightness.
    fromCorridor({ from_aId: 26 }),
  ]) {
    each.push(
      problemsOf(
        await prepareCreate(client, { targets: [rule([nightLight(action)])] }),
      ),
    );
  }
  assert.deepEqual(each, [
    ["/targets/0/then/0/characteristics/0/from_cId"],
    ["/targets/0/then/0/characteristics/0/from_cId"],
    ["/targets/0/then/0/characteristics/0/from_hs"],
    ["/targets/0/then/0/characteristics/0/value"],
    ["/targets/0/then/0/characteristics/0/from_cId"],
  ]);
});

// SprutHub 3.0.0 drops a from action's value "", a notify's to null and the
// clients null of a recipient entry (live-conformance-4). What the agent
// creates in the web client's form must still read back as its own and be
// deleted by restore.
test("a BLOCK with from and notify reads back as applied and restore deletes it on a hub that drops their empty fields", async (t) => {
  const { hub, client } = await setup(t, withNotificationServices);
  const leakText = "Протечка в ванной!";
  const closeText = "Протечка: закрой воду";
  const data = {
    targets: [
      whenCorridorChanges([nightLight(fromCorridor())]),
      whenLeak([
        { type: "notify", text: leakText, mode: "PUSH", to: null },
        {
          type: "notify",
          text: closeText,
          mode: "PUSH",
          to: [{ index: "web", clients: null }],
        },
      ]),
    ],
  };
  const { prepared, index } = await createBlock(client, data);
  assert.deepEqual(storedData(hub, index), {
    targets: [
      whenCorridorChanges([nightLight(storedFromCorridor())]),
      whenLeak([
        { type: "notify", text: leakText, mode: "PUSH" },
        {
          type: "notify",
          text: closeText,
          mode: "PUSH",
          to: [{ index: "web" }],
        },
      ]),
    ],
  });
  const change = await call(client, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(change.status, "applied", JSON.stringify(change));

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(
    hub.state.scenarios.some((item) => item.index === index),
    false,
  );
});

// «Ночник — как свет в коридоре», made by the owner in the SprutHub
// interface: the hub keeps the from action without value. An unrelated edit
// keeps it as stored, applies, and its restore brings the original back.
test("an owner's BLOCK with a stored from action takes an unrelated edit and its restore", async (t) => {
  const { hub, client } = await setup(t);
  const { index } = await createBlock(client, {
    targets: [whenLeak([fanOn()])],
  });
  hub.state.scenarios.find((item) => item.index === index).data =
    JSON.stringify({
      targets: [whenCorridorChanges([nightLight(storedFromCorridor())])],
    });
  const original = storedData(hub, index);

  const edited = await prepareUpdate(client, index, (read) => {
    read.targets.push(whenLeak([fanOn()]));
  });
  assert.equal(edited.status, "prepared", JSON.stringify(edited));
  const applied = await call(client, "apply_native_change", {
    change_ref: edited.change_ref,
  });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(storedData(hub, index), {
    targets: [...original.targets, whenLeak([fanOn()])],
  });

  const restored = await call(client, "restore_native_change", {
    change_ref: edited.change_ref,
  });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.deepEqual(storedData(hub, index), original);
});

// The owner made these in the SprutHub interface: a request to a router with
// its password in the URL and a notification left without text. The agent
// cannot write either back, so an edit that deletes them says so first.
test("an edit that deletes a request or notification the agent cannot write back names it", async (t) => {
  const { hub, client } = await setup(t);
  const stored = {
    targets: [
      whenLeak([
        fanOn(),
        {
          type: "http",
          method: "GET",
          url: "http://admin:secret@192.168.1.1/reboot",
        },
        { type: "notify", text: "", mode: "MESSAGE" },
        { type: "http", method: "GET", url: "http://192.168.1.50/relay/0" },
      ]),
    ],
  };
  const { index } = await createBlock(client, {
    targets: [whenLeak([fanOn()])],
  });
  hub.state.scenarios.find((item) => item.index === index).data =
    JSON.stringify(stored);

  const edited = await prepareUpdate(client, index, (data) => {
    data.targets[0].then.splice(1);
  });
  assert.equal(edited.status, "prepared", JSON.stringify(edited));
  const warning = edited.limitations.find((text) =>
    text.startsWith(
      "This edit deletes stored nodes this contract cannot write",
    ),
  );
  assert.match(
    warning ?? "",
    /http at \/targets\/0\/then\/1, notify at \/targets\/0\/then\/2\./,
  );
  // The request the agent could add again is not named.
  assert.doesNotMatch(warning, /then\/3/);
  assert.equal(JSON.stringify(edited).includes("secret@"), false);
});
