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
// so paging is checked against the hub rather than against one guess.
function listLog(log, { lastTime, count }, lastTimeSemantics) {
  let candidates = log;
  if (lastTime !== undefined) {
    if (lastTimeSemantics === "before_exclusive") {
      candidates = log.filter(({ time }) => time < lastTime);
    } else if (lastTimeSemantics === "before_inclusive") {
      candidates = log.filter(({ time }) => time <= lastTime);
    } else if (lastTimeSemantics !== "ignored") {
      assert.fail(`unknown lastTime semantics ${lastTimeSemantics}`);
    }
  }
  return candidates.slice(-count);
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

for (const lastTimeSemantics of ["before_exclusive", "before_inclusive"]) {
  test(`read_hub_log pages toward older entries without loss or repeats when lastTime is ${lastTimeSemantics}`, async (t) => {
    const log = denseLog();
    const hub = await startHub({ log, lastTimeSemantics });
    const client = await startClient(t, hub);
    const expected = log
      .map((entry, position) => ({ ...entry, position }))
      .sort((a, b) => b.time - a.time || a.position - b.position)
      .map(({ message }) => message);

    const seen = [];
    let args = { home_ref: homeRef, count: 5, max_bytes: 2_048 };
    let pages = 0;
    while (args) {
      pages += 1;
      assert(pages <= 60, "paging did not terminate");
      const alreadySeen = [...seen];
      const result = await readLog(client, args);
      assert.equal(result.isError, undefined, result.content[0]?.text);
      assert(Buffer.byteLength(result.content[0].text) <= 2_048);
      const { lastTime, count } = hub.requests.at(-1).params.log.list;
      if (pages === 1) {
        assert.deepEqual(hub.requests.at(-1).params.log.list, { count: 5 });
      } else {
        // A continuation asks for the entries at or before the oldest one
        // already returned and refetches that boundary so it can drop it.
        const boundary = alreadySeen.filter(
          ({ time }) => time === lastTime || time === lastTime - 1,
        );
        assert.equal(
          Math.min(...alreadySeen.map(({ time }) => time)),
          lastTime - 1,
        );
        assert.equal(count, 5 + boundary.length);
      }
      seen.push(
        ...result.structuredContent.entries.map((entry) => ({
          time: entry.native_time,
          message: entry.message,
        })),
      );
      args = result.structuredContent.next?.arguments;
      if (result.structuredContent.next) {
        assert.equal(result.structuredContent.next.tool, "read_hub_log");
      }
    }

    assert.deepEqual(
      seen.map(({ message }) => message),
      expected,
    );
    assert(pages > 2, `expected several pages, got ${pages}`);
    assert.equal(hub.requests.length, pages);
    assertOnlyLogListRequests(hub);
  });
}

test("read_hub_log refuses a continuation when the hub does not page toward older entries", async (t) => {
  const hub = await startHub({
    log: denseLog(),
    lastTimeSemantics: "ignored",
  });
  const client = await startClient(t, hub);

  const first = await readLog(client, { home_ref: homeRef, count: 5 });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.notEqual(first.structuredContent.next, null);

  const second = await readLog(client, first.structuredContent.next.arguments);
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.error.code, "unsupported_log_paging");
  assert.equal(second.structuredContent.entries, undefined);
  assert.deepEqual(second.structuredContent.next, {
    tool: "read_hub_log",
    arguments: { home_ref: homeRef, count: 5, max_bytes: 16_000 },
  });
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

test("read_hub_log rejects another home, a foreign scenario and a foreign cursor before reading the log", async (t) => {
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
