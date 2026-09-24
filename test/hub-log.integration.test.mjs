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

// The unconfirmed lastTime contract is modelled in each plausible direction,
// so paging is checked against the hub rather than against one guess. Every
// fake answers a plain count with the newest entries.
function listLog(log, { lastTime, count }, lastTimeSemantics) {
  if (lastTime === undefined) return log.slice(-count);
  const window = {
    before_exclusive: () =>
      log.filter(({ time }) => time < lastTime).slice(-count),
    before_inclusive: () =>
      log.filter(({ time }) => time <= lastTime).slice(-count),
    oldest_before_inclusive: () =>
      log.filter(({ time }) => time <= lastTime).slice(0, count),
    after_exclusive: () =>
      log.filter(({ time }) => time > lastTime).slice(0, count),
    ignored: () => log.slice(-count),
  }[lastTimeSemantics];
  assert(window, `unknown lastTime semantics ${lastTimeSemantics}`);
  return window();
}

async function startHub({
  log = observedLog,
  lastTimeSemantics = "before_exclusive",
  respond,
} = {}) {
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
            log: {
              list: {
                log: listLog(log, request.params.log.list, lastTimeSemantics),
              },
            },
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
    [{ log: { list: { count: 100 } } }],
  );
  assertOnlyLogListRequests(hub);
  const page = result.structuredContent;
  assert.equal(page.status, "ok");
  assert.equal(page.home_ref, homeRef);
  assert.equal(page.order, "newest_first");
  assert.equal(page.content_origin, "spruthub_native_log");
  assert.deepEqual(page.entries, expectedNewestFirst);
  assert.equal(page.page.returned, 8);
  assert.equal(page.page.filtered_out, 0);
  assert.equal(page.next, null);
  assert.equal(page.native.returned_count, 8);
  assert.equal(page.native.retention, "unknown");
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
  assert.equal(warnings.structuredContent.page.filtered_out, 5);

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
  assert.equal(scenario.structuredContent.page.filtered_out, 4);

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
    assert.equal(hidden.structuredContent.page.filtered_out, 8);
  }

  assert.equal(hub.requests.length, 8);
  assertOnlyLogListRequests(hub);
  for (const { params } of hub.requests) {
    assert.deepEqual(params, { log: { list: { count: 100 } } });
  }
});

function denseLog() {
  const log = [];
  let time = 1789120000000;
  for (let index = 0; index < 36; index += 1) {
    // Pairs of entries share one millisecond, so page boundaries fall inside
    // same-time groups.
    if (index % 3 !== 1) time += 1;
    log.push({
      time,
      level: "LOG_LEVEL_INFO",
      path: "Scenario.ScenarioBlock.Target.jBlock",
      message: `Сценарий 23: step ${String(index).padStart(2, "0")} ${"x".repeat(90)}`,
    });
  }
  return log;
}

// Pages must show the log newest first down to the oldest time shown, with
// nothing skipped and nothing repeated. Equal native_time keeps the hub order
// only inside one page, so order within a millisecond is not compared.
// Fixture messages are unique.
function assertNoGapOrRepeat(seen, log) {
  const times = seen.map(({ time }) => time);
  assert.deepEqual(
    times,
    times.toSorted((a, b) => b - a),
    "pages are not newest first",
  );
  const messages = seen.map(({ message }) => message);
  assert.equal(new Set(messages).size, messages.length, "an entry repeated");
  const oldest = Math.min(...times);
  assert.deepEqual(
    messages.filter((_, index) => times[index] > oldest).toSorted(),
    log
      .filter(({ time }) => time > oldest)
      .map(({ message }) => message)
      .toSorted(),
    "an entry newer than the oldest one shown was skipped",
  );
}

function allMessages(log) {
  return log.map(({ message }) => message).toSorted();
}

// Follows next the way an agent does and reports how paging ended.
async function pageThrough(client, args) {
  const seen = [];
  let pages = 0;
  for (;;) {
    pages += 1;
    assert(pages <= 60, "paging did not terminate");
    const result = await readLog(client, args);
    if (result.isError) return { seen, pages, error: result.structuredContent };
    const { entries, next, page } = result.structuredContent;
    assert(Buffer.byteLength(result.content[0].text) <= page.max_bytes);
    seen.push(
      ...entries.map(({ native_time: time, message }) => ({ time, message })),
    );
    if (next === null) return { seen, pages, endReason: page.end_reason };
    assert.equal(next.tool, "read_hub_log");
    args = next.arguments;
  }
}

for (const [lastTimeSemantics, pagesToTheEnd] of [
  ["before_exclusive", true],
  ["before_inclusive", true],
  ["oldest_before_inclusive", false],
  ["after_exclusive", false],
  ["ignored", false],
]) {
  test(`read_hub_log shows every entry once or refuses paging when log.list lastTime is ${lastTimeSemantics}`, async (t) => {
    const log = denseLog();
    const hub = await startHub({ log, lastTimeSemantics });
    const client = await startClient(t, hub);
    const firstPage = { home_ref: homeRef, count: 5, max_bytes: 2_048 };

    const { seen, pages, error, endReason } = await pageThrough(
      client,
      firstPage,
    );

    // Whatever lastTime means, pages never skip or repeat an entry.
    assertNoGapOrRepeat(seen, log);
    assert.equal(hub.requests.length, pages);
    assertOnlyLogListRequests(hub);
    if (pagesToTheEnd) {
      assert.equal(error, undefined, JSON.stringify(error));
      assert.deepEqual(
        seen.map(({ message }) => message).toSorted(),
        allMessages(log),
      );
      assert.equal(endReason, "hub_returned_fewer_than_requested");
      assert(pages > 2, `expected several pages, got ${pages}`);
    } else {
      assert.equal(
        error?.error.code,
        "unsupported_log_paging",
        `paging ended with ${endReason} after ${seen.length} of ${log.length} entries`,
      );
      assert.equal(error.entries, undefined);
      assert.deepEqual(error.next, {
        tool: "read_hub_log",
        arguments: firstPage,
      });
    }
  });
}

test("read_hub_log does not present unreachable older entries as the end of the log", async (t) => {
  const log = [];
  let time = 1789120000000;
  const add = (message) =>
    log.push({
      time,
      level: "LOG_LEVEL_INFO",
      path: "Scenario.ScenarioBlock.Target.jBlock",
      message: `Сценарий 23: ${message}`,
    });
  for (let index = 0; index < 3; index += 1) {
    time += 1;
    add(`before burst ${index}`);
  }
  time += 1;
  for (let index = 0; index < 70; index += 1) add(`burst ${index}`);
  for (let index = 0; index < 2; index += 1) {
    time += 10;
    add(`after burst ${index}`);
  }
  const hub = await startHub({ log });
  const client = await startClient(t, hub);

  const { seen, error, endReason } = await pageThrough(client, {
    home_ref: homeRef,
    count: 5,
  });

  assert.equal(error, undefined, JSON.stringify(error));
  assertNoGapOrRepeat(seen, log);
  assert.equal(
    endReason,
    seen.length < log.length
      ? "older_entries_unreachable"
      : "hub_returned_fewer_than_requested",
    `${seen.length} of ${log.length} entries shown`,
  );
});

test("read_hub_log keeps progress when one message is larger than the page", async (t) => {
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

  const first = await readLog(client, { home_ref: homeRef, max_bytes: 2_048 });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert(Buffer.byteLength(first.content[0].text) <= 2_048);
  const [large] = first.structuredContent.entries;
  assert.equal(first.structuredContent.entries.length, 1);
  assert.equal(large.native_time, 1789120000002);
  assert.equal(large.message_truncated, true);
  assert.equal(large.message_chars, log[1].message.length);
  assert(log[1].message.startsWith(large.message));
  assert(large.message.length > 100);

  const second = await readLog(client, first.structuredContent.next.arguments);
  assert.equal(second.isError, undefined, second.content[0]?.text);
  assert.deepEqual(
    second.structuredContent.entries.map(({ message }) => message),
    ["Сценарий 23 - old"],
  );
  assert.equal(second.structuredContent.next, null);
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
    assert.equal(result.structuredContent.next, null);
    assert.equal(result.structuredContent.native.returned_count, 0);
    assert.equal(result.structuredContent.native.retention, "unknown");
    assert.equal(
      result.structuredContent.page.end_reason,
      "hub_returned_fewer_than_requested",
    );
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

test("read_hub_log rejects another home, a foreign scenario, a secret filter and a foreign cursor before reading the log", async (t) => {
  const hub = await startHub({ log: denseLog() });
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

  // The filter is echoed in filters and next, so text the result would have
  // to redact is refused; redacted log text could not match it anyway.
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

  const garbage = await readLog(client, {
    home_ref: homeRef,
    before: "not-a-cursor",
  });
  assert.equal(garbage.isError, true);
  assert.equal(garbage.structuredContent.error.code, "invalid_cursor");
  assert.equal(hub.requests.length, 0);

  const first = await readLog(client, { home_ref: homeRef, count: 2 });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(hub.requests.length, 1);
  const otherScope = await readLog(client, {
    ...first.structuredContent.next.arguments,
    contains: "step",
  });
  assert.equal(otherScope.isError, true);
  assert.equal(otherScope.structuredContent.error.code, "invalid_cursor");
  assert.deepEqual(otherScope.structuredContent.next, {
    tool: "read_hub_log",
    arguments: {
      home_ref: homeRef,
      count: 2,
      max_bytes: 16_000,
      contains: "step",
    },
  });
  assert.equal(hub.requests.length, 1);
  assertOnlyLogListRequests(hub);
});
