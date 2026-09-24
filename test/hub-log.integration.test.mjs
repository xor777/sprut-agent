import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/home%2FA";
const otherHomeRef = "spruthub://hub/home%2FB";
const scenarioRef = `${homeRef}/scenario/23`;
const connectionToken = "hub-log-secret-must-not-leak";

// Native console order: oldest first. Times and texts follow the anonymized
// O20260911 Debug-panel observation; the last three lines are synthetic.
const observedLog = [
  {
    time: 1789118635092,
    level: "LOG_LEVEL_ERROR",
    path: "Notifiers.Notifier",
    message: "Сценарий 23 - No index from delay",
  },
  {
    time: 1789120490684,
    level: "LOG_LEVEL_INFO",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message:
      "Сценарий 23: jConditionCharacteristic_3 (TRIGGER: SCENARIO[23] <- CHARACTERISTIC[Characteristic/2.13.15/] <- CLOUD[0]_1789120490)",
  },
  {
    time: 1789120490687,
    level: "LOG_LEVEL_INFO",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message:
      "Сценарий 23: jConditionCharacteristic_3 C[2.13.15 Lightbulb.On 'true'], cond='=', value='true'",
  },
  {
    time: 1789120490692,
    level: "LOG_LEVEL_INFO",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message: "Сценарий 23: jTargetDelay_4 time=3000, mode=RESET, index=1",
  },
  {
    time: 1789120490700,
    level: "LOG_LEVEL_INFO",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message: "Сценарий 230: client_secret=neighbor-secret-must-not-leak",
  },
  {
    time: 1789120490701,
    level: "LOG_LEVEL_ERROR",
    path: "API.Account",
    message: "Сценарий 23 - Authorization: Bearer account-secret-must-not-leak",
  },
  {
    time: 1789120490705,
    level: "LOG_LEVEL_WARN",
    path: "Cloud.Connection",
    message: `reconnect with ${connectionToken}`,
  },
  {
    time: 1789120490710,
    level: "LOG_LEVEL_DEBUG",
    path: "Scenario.ScenarioLogic",
    message: "Сценарий 7: tick",
  },
];

const expectedNewestFirst = [
  {
    time: "2026-09-11T09:54:50.710Z",
    native_time: 1789120490710,
    level: "debug",
    path: "Scenario.ScenarioLogic",
    message: "Сценарий 7: tick",
  },
  {
    time: "2026-09-11T09:54:50.705Z",
    native_time: 1789120490705,
    level: "warn",
    path: "Cloud.Connection",
    message: "[REDACTED]",
  },
  {
    time: "2026-09-11T09:54:50.701Z",
    native_time: 1789120490701,
    level: "error",
    path: "API.Account",
    message: "[REDACTED]",
  },
  {
    time: "2026-09-11T09:54:50.700Z",
    native_time: 1789120490700,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message: "[REDACTED]",
  },
  {
    time: "2026-09-11T09:54:50.692Z",
    native_time: 1789120490692,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message: "Сценарий 23: jTargetDelay_4 time=3000, mode=RESET, index=1",
  },
  {
    time: "2026-09-11T09:54:50.687Z",
    native_time: 1789120490687,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message:
      "Сценарий 23: jConditionCharacteristic_3 C[2.13.15 Lightbulb.On 'true'], cond='=', value='true'",
  },
  {
    time: "2026-09-11T09:54:50.684Z",
    native_time: 1789120490684,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message:
      "Сценарий 23: jConditionCharacteristic_3 (TRIGGER: SCENARIO[23] <- CHARACTERISTIC[Characteristic/2.13.15/] <- CLOUD[0]_1789120490)",
  },
  {
    time: "2026-09-11T09:23:55.092Z",
    native_time: 1789118635092,
    level: "error",
    path: "Notifiers.Notifier",
    message: "Сценарий 23 - No index from delay",
  },
];

// Live hub, firmware 3.0.0 (2026-09-24): log.list keeps a ring buffer of its
// newest 128 entries, a larger count returns the same buffer, and lastTime
// returns only entries newer than it.
const BUFFER_SIZE = 128;
function listLog(log, { lastTime, count }) {
  return log
    .slice(-BUFFER_SIZE)
    .filter(({ time }) => lastTime === undefined || time > lastTime)
    .slice(-count);
}

async function startHub({ log = observedLog, respond } = {}) {
  const requests = [];
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      let reply;
      if (request.params?.log?.list && respond) {
        reply = respond(request.params.log.list);
      } else if (request.params?.log?.list) {
        reply = {
          result: {
            log: { list: { log: listLog(log, request.params.log.list) } },
          },
        };
      } else {
        reply = { error: { code: -32601, message: "unexpected test request" } };
      }
      socket.send(JSON.stringify({ id: request.id, ...reply }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return { requests, server, url: `ws://127.0.0.1:${address.port}` };
}

async function startClient(t, hub) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: connectionToken,
      SPRUTHUB_SERIAL: "home/A",
      SPRUTHUB_CID: "hub-log-test",
      SPRUTHUB_TIMEOUT_MS: "500",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "hub-log-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
  });
  await client.connect(transport);
  return client;
}

async function readLog(client, args) {
  return client.callTool({ name: "read_hub_log", arguments: args });
}

function assertOnlyLogListRequests(hub) {
  assert.deepEqual(
    hub.requests.map(({ params }) => Object.keys(params)),
    hub.requests.map(() => ["log"]),
  );
  for (const { params, serial } of hub.requests) {
    assert.deepEqual(Object.keys(params.log), ["list"]);
    assert.equal(serial, "home/A");
  }
}

test("read_hub_log returns the hub execution log newest first with ISO time, level names and redacted text", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const result = await readLog(client, { home_ref: homeRef });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(
    hub.requests.map(({ params }) => params),
    [{ log: { list: { count: 500 } } }],
  );
  assertOnlyLogListRequests(hub);
  const page = result.structuredContent;
  assert.equal(page.status, "ok");
  assert.equal(page.home_ref, homeRef);
  assert.equal(page.order, "newest_first");
  assert.equal(page.content_origin, "spruthub_native_log");
  assert.deepEqual(page.entries, expectedNewestFirst);
  assert.equal(page.buffer_entries, 8);
  assert.equal(page.oldest_entry_at, "2026-09-11T09:23:55.092Z");
  assert.equal(page.page.returned, 8);
  assert.equal(page.page.matched_total, 8);
  assert.equal(page.page.truncated, false);
  assert.equal(page.native.returned_count, 8);
  assert.equal(typeof page.freshness.hubResponseReceivedAt, "string");
  const text = result.content[0].text;
  assert.equal(text.includes("must-not-leak"), false, text);
  assert(Buffer.byteLength(text) <= 16_000);
});

test("read_hub_log filters by level, text and the observed scenario formats without exposing redacted text", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);
  const messages = (result) =>
    result.structuredContent.entries.map(({ native_time: time }) => time);

  const warnings = await readLog(client, {
    home_ref: homeRef,
    min_level: "warn",
  });
  assert.equal(warnings.isError, undefined, warnings.content[0]?.text);
  assert.deepEqual(
    messages(warnings),
    [1789120490705, 1789120490701, 1789118635092],
  );
  assert.equal(warnings.structuredContent.page.matched_total, 3);

  const delay = await readLog(client, {
    home_ref: homeRef,
    contains: "JTARGETDELAY",
  });
  assert.deepEqual(messages(delay), [1789120490692]);

  const notifierPath = await readLog(client, {
    home_ref: homeRef,
    contains: "notifiers.",
  });
  assert.deepEqual(messages(notifierPath), [1789118635092]);

  const scenario = await readLog(client, {
    home_ref: homeRef,
    scenario_ref: scenarioRef,
  });
  assert.deepEqual(
    messages(scenario),
    [1789120490692, 1789120490687, 1789120490684, 1789118635092],
  );
  assert.equal(scenario.structuredContent.page.matched_total, 4);

  const scenarioErrors = await readLog(client, {
    home_ref: homeRef,
    scenario_ref: scenarioRef,
    min_level: "error",
  });
  assert.deepEqual(messages(scenarioErrors), [1789118635092]);

  for (const probe of [
    "account-secret",
    "neighbor-secret",
    connectionToken.slice(0, 12),
  ]) {
    const hidden = await readLog(client, {
      home_ref: homeRef,
      contains: probe,
    });
    assert.equal(hidden.isError, undefined, hidden.content[0]?.text);
    assert.deepEqual(hidden.structuredContent.entries, []);
    assert.equal(hidden.structuredContent.page.matched_total, 0);
  }

  assert.equal(hub.requests.length, 8);
  assertOnlyLogListRequests(hub);
  for (const { params } of hub.requests) {
    assert.deepEqual(params, { log: { list: { count: 500 } } });
  }
});

// About three hours of a quiet home: mostly Zigbee controller lines, one
// scenario run before the retained buffer and one inside it.
function ringLog() {
  const log = [];
  for (let index = 0; index < 200; index += 1) {
    const time = 1789120000000 + index * 60_000;
    log.push(
      index === 10 || index === 150
        ? {
            time,
            level: "LOG_LEVEL_INFO",
            path: "Scenario.ScenarioBlock.Target.jBlock",
            message: `Сценарий 23: jTargetDelay_4 time=3000, mode=RESET, index=${index}`,
          }
        : {
            time,
            level: index % 40 === 0 ? "LOG_LEVEL_WARN" : "LOG_LEVEL_INFO",
            path: "Controllers.zigbee",
            message: `Zigbee 0x00158d00${String(index).padStart(8, "0")}: attribute report ${"x".repeat(60)}`,
          },
    );
  }
  return log;
}

test("read_hub_log reports what the hub still retains, so an older run reads as not retained rather than absent", async (t) => {
  const log = ringLog();
  const hub = await startHub({ log });
  const client = await startClient(t, hub);

  const result = await readLog(client, {
    home_ref: homeRef,
    scenario_ref: scenarioRef,
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const page = result.structuredContent;
  assert.deepEqual(
    page.entries.map(({ native_time: time }) => time),
    [log[150].time],
  );
  assert.equal(page.page.matched_total, 1);
  assert.equal(page.page.truncated, false);
  assert.equal(page.buffer_entries, BUFFER_SIZE);
  // The run at index 10 is older than everything the hub kept.
  const oldestRetained = log.at(-BUFFER_SIZE).time;
  assert.equal(page.oldest_entry_at, new Date(oldestRetained).toISOString());
  assert(Date.parse(page.oldest_entry_at) > log[10].time);
  assert.deepEqual(
    hub.requests.map(({ params }) => params),
    [{ log: { list: { count: 500 } } }],
  );
});

test("read_hub_log returns the newest matches that fit max_bytes and says how many matched", async (t) => {
  const log = ringLog();
  const hub = await startHub({ log });
  const client = await startClient(t, hub);
  const retainedNewestFirst = log
    .slice(-BUFFER_SIZE)
    .map(({ time }) => time)
    .reverse();

  const result = await readLog(client, { home_ref: homeRef, max_bytes: 4_096 });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert(Buffer.byteLength(result.content[0].text) <= 4_096);
  const page = result.structuredContent;
  const shown = page.entries.map(({ native_time: time }) => time);
  assert(shown.length > 0);
  assert.deepEqual(shown, retainedNewestFirst.slice(0, shown.length));
  assert.equal(page.page.returned, shown.length);
  assert.equal(page.page.matched_total, BUFFER_SIZE);
  assert.equal(page.page.truncated, true);
  assert.equal(page.buffer_entries, BUFFER_SIZE);

  const warnings = await readLog(client, {
    home_ref: homeRef,
    min_level: "warn",
    max_bytes: 4_096,
  });
  assert.equal(warnings.isError, undefined, warnings.content[0]?.text);
  assert.deepEqual(
    warnings.structuredContent.entries.map(({ native_time: time }) => time),
    [log[160].time, log[120].time, log[80].time],
  );
  assert.equal(warnings.structuredContent.page.truncated, false);
});

test("read_hub_log shortens one message larger than max_bytes instead of returning nothing", async (t) => {
  const log = [
    {
      time: 1789120000001,
      level: "LOG_LEVEL_ERROR",
      path: "Notifiers.Notifier",
      message: "Сценарий 23 - old",
    },
    {
      time: 1789120000002,
      level: "LOG_LEVEL_ERROR",
      path: "Notifiers.Notifier",
      message: `Сценарий 23 - ${"стек ".repeat(1_500)}`,
    },
  ];
  const hub = await startHub({ log });
  const client = await startClient(t, hub);

  const result = await readLog(client, { home_ref: homeRef, max_bytes: 2_048 });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert(Buffer.byteLength(result.content[0].text) <= 2_048);
  const [large] = result.structuredContent.entries;
  assert.equal(result.structuredContent.entries.length, 1);
  assert.equal(large.native_time, 1789120000002);
  assert.equal(large.message_truncated, true);
  assert.equal(large.message_chars, log[1].message.length);
  assert(log[1].message.startsWith(large.message));
  assert(large.message.length > 100);
  assert.equal(result.structuredContent.page.matched_total, 2);
  assert.equal(result.structuredContent.page.truncated, true);
});

test("read_hub_log reports an empty hub answer as returned entries, not as a quiet home", async (t) => {
  for (const list of [{ log: [] }, {}]) {
    const hub = await startHub({
      respond: () => ({ result: { log: { list } } }),
    });
    const client = await startClient(t, hub);

    const result = await readLog(client, { home_ref: homeRef });

    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.deepEqual(result.structuredContent.entries, []);
    assert.equal(result.structuredContent.native.returned_count, 0);
    assert.equal(result.structuredContent.buffer_entries, 0);
    assert.equal(result.structuredContent.oldest_entry_at, null);
    assert.equal(result.structuredContent.page.matched_total, 0);
  }
});

test("read_hub_log reports a native rejection as an unavailable log, not an empty list", async (t) => {
  for (const [code, capability] of [
    [-32601, "unsupported"],
    [-32000, "unknown"],
  ]) {
    const hub = await startHub({
      respond: () => ({ error: { code, message: "log unavailable" } }),
    });
    const client = await startClient(t, hub);

    const result = await readLog(client, { home_ref: homeRef });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "hub_log_unavailable");
    assert.equal(result.structuredContent.capability_status, capability);
    assert.equal(result.structuredContent.native_error_code, code);
    assert.equal(result.structuredContent.entries, undefined);
  }
});

test("read_hub_log rejects an incompatible native log shape", async (t) => {
  for (const result of [
    {},
    { log: { list: { log: {} } } },
    {
      log: {
        list: {
          log: [
            {
              time: "1789120490684",
              level: "LOG_LEVEL_INFO",
              path: "Scenario.ScenarioBlock.Target.jBlock",
              message: "Сценарий 23: step",
            },
          ],
        },
      },
    },
    {
      log: {
        list: {
          log: [
            {
              time: 1789120490684,
              level: 3,
              path: "Scenario.ScenarioBlock.Target.jBlock",
              message: "Сценарий 23: step",
            },
          ],
        },
      },
    },
  ]) {
    const hub = await startHub({ respond: () => ({ result }) });
    const client = await startClient(t, hub);

    const answer = await readLog(client, { home_ref: homeRef });

    assert.equal(answer.isError, true, JSON.stringify(result));
    assert.equal(answer.structuredContent.error.code, "incompatible_response");
    assert.equal(answer.structuredContent.entries, undefined);
  }
});

test("read_hub_log rejects another home, a foreign scenario and a secret filter before reading the log", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const otherHome = await readLog(client, { home_ref: otherHomeRef });
  assert.equal(otherHome.isError, true);
  assert.equal(otherHome.structuredContent.error.code, "wrong_home");

  const foreignScenario = await readLog(client, {
    home_ref: homeRef,
    scenario_ref: `${otherHomeRef}/scenario/23`,
  });
  assert.equal(foreignScenario.isError, true);
  assert.equal(
    foreignScenario.structuredContent.error.code,
    "invalid_log_filter",
  );

  // The page echoes contains in filters, so text the result would have to
  // redact is refused; redacted log text could not match it anyway.
  for (const contains of [
    connectionToken,
    "Authorization: Bearer account-secret-must-not-leak",
  ]) {
    const secretFilter = await readLog(client, { home_ref: homeRef, contains });
    assert.equal(secretFilter.isError, true, secretFilter.content[0].text);
    assert.equal(
      secretFilter.structuredContent.error.code,
      "invalid_log_filter",
    );
    assert.equal(secretFilter.content[0].text.includes("must-not-leak"), false);
  }

  assert.equal(hub.requests.length, 0);
});
