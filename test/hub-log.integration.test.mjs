import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { FAKE_HUB_HOST, ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

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
    time: "2026-09-11T12:54:50.710+03:00",
    native_time: 1789120490710,
    level: "debug",
    path: "Scenario.ScenarioLogic",
    message: "Сценарий 7: tick",
  },
  {
    time: "2026-09-11T12:54:50.705+03:00",
    native_time: 1789120490705,
    level: "warn",
    path: "Cloud.Connection",
    message: "[REDACTED]",
  },
  {
    time: "2026-09-11T12:54:50.701+03:00",
    native_time: 1789120490701,
    level: "error",
    path: "API.Account",
    message: "[REDACTED]",
  },
  {
    time: "2026-09-11T12:54:50.700+03:00",
    native_time: 1789120490700,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message: "[REDACTED]",
  },
  {
    time: "2026-09-11T12:54:50.692+03:00",
    native_time: 1789120490692,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message: "Сценарий 23: jTargetDelay_4 time=3000, mode=RESET, index=1",
  },
  {
    time: "2026-09-11T12:54:50.687+03:00",
    native_time: 1789120490687,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message:
      "Сценарий 23: jConditionCharacteristic_3 C[2.13.15 Lightbulb.On 'true'], cond='=', value='true'",
  },
  {
    time: "2026-09-11T12:54:50.684+03:00",
    native_time: 1789120490684,
    level: "info",
    path: "Scenario.ScenarioBlock.Target.jBlock",
    message:
      "Сценарий 23: jConditionCharacteristic_3 (TRIGGER: SCENARIO[23] <- CHARACTERISTIC[Characteristic/2.13.15/] <- CLOUD[0]_1789120490)",
  },
  {
    time: "2026-09-11T12:23:55.092+03:00",
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

// The clock group of the home settings window (window.get with the root key
// "") in the form observed on 2026-09-16; the live window also holds
// network and user settings, left out here.
function settingsWindow(timeZone) {
  return {
    windowKey: "",
    label: { text: "Настройки хаба" },
    options: [
      { key: "clock", inputType: "GROUP", parent: "datetime" },
      {
        key: "TimeZone",
        type: "GenericString",
        inputType: "LIST",
        parent: "clock",
        read: true,
        write: true,
        value: { stringValue: timeZone },
      },
      {
        key: "Time",
        type: "GenericString",
        inputType: "STATUS",
        parent: "clock",
        read: true,
        write: false,
        value: { stringValue: "2026-09-11 - 12:55:00 (GMT+03:00)" },
      },
    ],
  };
}

// settings is the home settings window, null for a hub that refuses
// window.get, or "no_reply" for one that never answers it; settingsDelayMs
// delays its answer. respond may return a promise of the log reply.
async function startHub({
  log = observedLog,
  respond,
  settings = settingsWindow("Europe/Moscow"),
  settingsDelayMs = 0,
} = {}) {
  const requests = [];
  let settingsAnswered;
  const hub = {
    requests,
    settingsAnswered: new Promise((resolve) => {
      settingsAnswered = resolve;
    }),
  };
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");
  hub.connections = 0;
  server.on("connection", (socket) => {
    hub.connections += 1;
    const send = (id, reply) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ id, ...reply }));
      }
    };
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      let reply;
      if (request.params?.log?.list && respond) {
        reply = await respond(request.params.log.list);
      } else if (
        request.params?.window?.get?.windowKey === "" &&
        settingsDelayMs > 0 &&
        settings !== "no_reply"
      ) {
        setTimeout(() => {
          send(request.id, { result: { window: { get: settings } } });
          settingsAnswered();
        }, settingsDelayMs);
        return;
      } else if (request.params?.log?.list) {
        reply = {
          result: {
            log: { list: { log: listLog(log, request.params.log.list) } },
          },
        };
      } else if (
        request.params?.window?.get?.windowKey === "" &&
        settings === "no_reply"
      ) {
        return;
      } else if (
        request.params?.window?.get?.windowKey === "" &&
        settings !== null
      ) {
        reply = { result: { window: { get: settings } } };
      } else {
        reply = { error: { code: -32601, message: "unexpected test request" } };
      }
      send(request.id, reply);
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return Object.assign(hub, {
    server,
    url: `ws://127.0.0.1:${address.port}`,
  });
}

async function startClient(
  t,
  hub,
  { timeoutMs = ORDINARY_HUB_TIMEOUT_MS } = {},
) {
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
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
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

const LOG_READ = { log: { list: { count: 500 } } };
const ZONE_READ = { window: { get: { windowKey: "" } } };

// Every read of the log is one log.list on the selected home. The home
// settings window, 99 KB on the owner's hub, is read once for its time zone
// and not again on later reads.
function assertOnlyLogReads(hub, calls) {
  assert.deepEqual(
    hub.requests
      .map(({ params }) => JSON.stringify(params))
      .sort()
      .join("\n"),
    [...Array.from({ length: calls }, () => LOG_READ), ZONE_READ]
      .map((params) => JSON.stringify(params))
      .sort()
      .join("\n"),
  );
  for (const { serial } of hub.requests) assert.equal(serial, "home/A");
}

test("read_hub_log returns the hub execution log newest first with hub-local time, level names and redacted text", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const result = await readLog(client, { home_ref: homeRef });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assertOnlyLogReads(hub, 1);
  const page = result.structuredContent;
  assert.equal(page.status, "ok");
  assert.equal(page.home_ref, homeRef);
  assert.equal(page.order, "newest_first");
  assert.equal(page.content_origin, "spruthub_native_log");
  assert.equal(page.time_zone, "Europe/Moscow");
  assert.deepEqual(page.entries, expectedNewestFirst);
  assert.equal(page.buffer_entries, 8);
  assert.equal(page.oldest_entry_at, "2026-09-11T12:23:55.092+03:00");
  assert.equal(page.page.returned, 8);
  assert.equal(page.page.matched_total, 8);
  assert.equal(page.page.truncated, false);
  assert.equal(page.native.returned_count, 8);
  assert.equal(typeof page.freshness.hubResponseReceivedAt, "string");
  const text = result.content[0].text;
  assert.equal(text.includes("must-not-leak"), false, text);
  assert(Buffer.byteLength(text) <= 16_000);
});

test("read_hub_log without home_ref reads the selected home, and a stop without a watch reads nothing", async (t) => {
  const hub = await startHub();
  const client = await startClient(t, hub);

  const stop = await readLog(client, { stop: true });
  assert.equal(stop.isError, true);
  assert.equal(stop.structuredContent.error.code, "observation_ref_required");
  assert.equal(hub.requests.length, 0);

  const result = await readLog(client, {});
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assertOnlyLogReads(hub, 1);
  assert.equal(result.structuredContent.home_ref, homeRef);
  assert.deepEqual(result.structuredContent.entries, expectedNewestFirst);
});

// Agents quoted UTC log times to the owner as local time («с 06:42» at 09:42
// hub time). Each time carries the offset of the hub's zone at that
// instant, so a clock change inside the buffer reads right.
test("read_hub_log gives each time the hub zone's offset at that instant", async (t) => {
  const log = [
    {
      time: Date.parse("2026-10-25T00:59:59.500Z"),
      level: "LOG_LEVEL_INFO",
      path: "Controllers.zigbee",
      message: "before the clock change",
    },
    {
      time: Date.parse("2026-10-25T01:00:00.500Z"),
      level: "LOG_LEVEL_INFO",
      path: "Controllers.zigbee",
      message: "after the clock change",
    },
  ];
  const hub = await startHub({
    log,
    settings: settingsWindow("Europe/Berlin"),
  });
  const client = await startClient(t, hub);

  const result = await readLog(client, { home_ref: homeRef });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const page = result.structuredContent;
  assert.equal(page.time_zone, "Europe/Berlin");
  assert.deepEqual(
    page.entries.map(({ time, message }) => [time, message]),
    [
      ["2026-10-25T02:00:00.500+01:00", "after the clock change"],
      ["2026-10-25T02:59:59.500+02:00", "before the clock change"],
    ],
  );
  assert.equal(page.oldest_entry_at, "2026-10-25T02:59:59.500+02:00");
});

// Without a zone the server can apply, times stay UTC and the page says so
// instead of guessing an offset.
test("read_hub_log keeps UTC and says so when the hub time zone cannot be read", async (t) => {
  const withoutZone = settingsWindow("Europe/Moscow");
  withoutZone.options = withoutZone.options.filter(
    ({ key }) => key !== "TimeZone",
  );
  for (const settings of [
    null,
    withoutZone,
    settingsWindow("Mars/Olympus_Mons"),
  ]) {
    const hub = await startHub({ settings });
    const client = await startClient(t, hub);

    const result = await readLog(client, { home_ref: homeRef });

    assert.equal(result.isError, undefined, result.content[0]?.text);
    const page = result.structuredContent;
    assert.equal(page.time_zone, null);
    assert.deepEqual(
      page.entries.map(({ time }) => time),
      expectedNewestFirst.map(({ native_time: time }) =>
        new Date(time).toISOString(),
      ),
    );
    assert.equal(page.oldest_entry_at, "2026-09-11T09:23:55.092Z");
    assert.ok(
      page.limitations.some((line) => /\bUTC\b/.test(line)),
      JSON.stringify(page.limitations),
    );
  }
});

// A hub that never answers window.get must not hold back a log that
// already arrived until the request timeout.
test("read_hub_log returns the log in UTC without waiting out a hub that does not answer for its time zone", async (t) => {
  const hub = await startHub({ settings: "no_reply" });
  const client = await startClient(t, hub);

  const began = Date.now();
  const result = await readLog(client, { home_ref: homeRef });
  const elapsed = Date.now() - began;

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert(elapsed < ORDINARY_HUB_TIMEOUT_MS / 2, `${elapsed} ms`);
  const page = result.structuredContent;
  assert.equal(page.time_zone, null);
  assert.deepEqual(
    page.entries.map(({ time }) => time),
    expectedNewestFirst.map(({ native_time: time }) =>
      new Date(time).toISOString(),
    ),
  );
  assert.ok(
    page.limitations.some((line) => /\bUTC\b/.test(line)),
    JSON.stringify(page.limitations),
  );
});

// A hub that gives its settings window later than a read waits for it, as
// through a slow cloud relay: the read stops waiting, but the window read
// keeps its connection and the other requests on it, and its late answer
// serves the next reads.
test("read_hub_log stops waiting for a slow hub time zone without closing the requests beside it", async (t) => {
  const log = { result: { log: { list: { log: observedLog } } } };
  let logReads = 0;
  const hub = await startHub({
    settingsDelayMs: 3_000,
    // The second log read is still on the connection when the first read
    // stops waiting for the zone: the hub answers it after the window.
    respond: async () => {
      logReads += 1;
      if (logReads === 2) await hub.settingsAnswered;
      return log;
    },
  });
  const client = await startClient(t, hub);

  const began = Date.now();
  const first = readLog(client, { home_ref: homeRef });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = readLog(client, { home_ref: homeRef });
  const firstResult = await first;
  const firstElapsed = Date.now() - began;
  const secondResult = await second;
  const later = await readLog(client, { home_ref: homeRef });

  const outcome = (result) =>
    result.isError
      ? result.structuredContent?.error?.code
      : result.structuredContent.time_zone;
  assert.deepEqual([firstResult, secondResult, later].map(outcome), [
    null,
    "Europe/Moscow",
    "Europe/Moscow",
  ]);
  assert(firstElapsed < 3_000, `${firstElapsed} ms`);
  assert.ok(
    firstResult.structuredContent.limitations.some((line) =>
      /\bUTC\b/.test(line),
    ),
    JSON.stringify(firstResult.structuredContent.limitations),
  );
  assert.equal(
    later.structuredContent.entries[0].time,
    expectedNewestFirst[0].time,
  );
  assertOnlyLogReads(hub, 3);
  assert.equal(hub.connections, 1);
});

// A read whose log took most of its time starts the zone read late. The
// window read has a request timeout of its own, not what that read has left:
// the read keeps UTC once its time runs out, and the window read answered
// after it does not close the connection under the next read.
test("read_hub_log that reaches the hub time zone late in its time does not close the requests beside it", async (t) => {
  const log = { result: { log: { list: { log: observedLog } } } };
  let logReads = 0;
  const hub = await startHub({
    settingsDelayMs: 2_000,
    respond: async () => {
      logReads += 1;
      // 3 s of the 4 s request timeout: the zone read starts with 1 s left.
      if (logReads === 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      // The second read's log is still on the connection when the first
      // read's time runs out; the hub answers it after the window.
      if (logReads === 2) await hub.settingsAnswered;
      return log;
    },
  });
  const client = await startClient(t, hub, { timeoutMs: 4_000 });

  const first = readLog(client, { home_ref: homeRef });
  await new Promise((resolve) => setTimeout(resolve, 3_300));
  const second = readLog(client, { home_ref: homeRef });
  const firstResult = await first;
  const secondResult = await second;
  const later = await readLog(client, { home_ref: homeRef });

  const outcome = (result) =>
    result.isError
      ? result.structuredContent?.error?.code
      : result.structuredContent.time_zone;
  assert.deepEqual([firstResult, secondResult, later].map(outcome), [
    null,
    "Europe/Moscow",
    "Europe/Moscow",
  ]);
  assertOnlyLogReads(hub, 3);
  assert.equal(hub.connections, 1);
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

  assertOnlyLogReads(hub, 8);
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
  assert.equal(Date.parse(page.oldest_entry_at), oldestRetained);
  assert(Date.parse(page.oldest_entry_at) > log[10].time);
  assertOnlyLogReads(hub, 1);
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

// The eval apartment at noon hub time (UTC+3): its buffer runs from 09:42
// to 11:57 on the hub clock, and the settings window's Time names the date.
const simulatedHomeRef = "spruthub://hub/sim-apartment-01";

// The eval apartment at noon hub time behind a server. With shiftedClock
// the server runs with test/support/shifted-clock.mjs, and shiftClock
// moves its clock 5 minutes forward.
async function startSimulated(t, { shiftedClock = false } = {}) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"), {
    hubTime: "12:00",
  });
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "sprut-hub-log-"));
  const clockModule = pathToFileURL(
    path.join(projectRoot, "test/support/shifted-clock.mjs"),
  ).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(shiftedClock ? ["--import", clockModule] : []),
      "src/server.mjs",
    ],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "hub-log-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const shiftClock = async () => {
    const shifted = new Promise((resolve) => {
      const onData = (chunk) => {
        if (!String(chunk).includes("clock shifted")) return;
        transport.stderr.off("data", onData);
        resolve();
      };
      transport.stderr.on("data", onData);
    });
    process.kill(transport.pid, "SIGUSR2");
    await shifted;
  };
  // The zone the owner sets in the SprutHub app.
  const setHubZone = (zone) => {
    hub.state.windows[""].options.find(
      ({ key }) => key === "TimeZone",
    ).value.stringValue = zone;
  };
  const zoneReads = () =>
    hub.requests.filter(
      ({ method, params }) =>
        method === "window.get" && params.window.get.windowKey === "",
    ).length;
  const logZone = async () => {
    const result = await readLog(client, { home_ref: simulatedHomeRef });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return result.structuredContent.time_zone;
  };
  return { hub, client, shiftClock, setHubZone, zoneReads, logZone };
}

test("read_hub_log on the simulated home states times on the hub's own clock", async (t) => {
  const { hub, client } = await startSimulated(t);

  const result = await readLog(client, {
    home_ref: simulatedHomeRef,
    max_bytes: 32_768,
  });

  assert.equal(result.isError, undefined, result.content[0]?.text);
  const page = result.structuredContent;
  const hubDate = hub.state.windows[""].options
    .find(({ key }) => key === "Time")
    .value.stringValue.slice(0, 10);
  assert.equal(page.time_zone, "Europe/Moscow");
  assert.equal(page.oldest_entry_at, `${hubDate}T09:42:00.118+03:00`);
  assert.equal(page.entries[0].time, `${hubDate}T11:57:00.811+03:00`);
  for (const { time, native_time: nativeTime } of page.entries) {
    assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+03:00$/);
    assert.equal(Date.parse(time), nativeTime);
  }
  assert.deepEqual(
    hub.requests
      .filter(({ method }) => method !== "log.list")
      .map(({ method, params }) => [method, params]),
    [["window.get", { window: { get: { windowKey: "" } } }]],
  );
});

// The kept zone serves reads for 5 minutes and until a write of this
// process; a zone the owner changes in the SprutHub app shows up after
// either.
test("read_hub_log reads the hub time zone again after a write of this process", async (t) => {
  const { client, setHubZone, zoneReads, logZone } = await startSimulated(t);

  assert.equal(await logZone(), "Europe/Moscow");
  setHubZone("Europe/Berlin");
  assert.equal(await logZone(), "Europe/Moscow");
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "service_name",
      target_ref: `${simulatedHomeRef}/accessory/17/service/13`,
      value: "Лента над диваном",
      reason: "Переименовать ленту",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");

  assert.equal(await logZone(), "Europe/Berlin");
  assert.equal(zoneReads(), 2);
});

test("read_hub_log reads the hub time zone again once the kept one is 5 minutes old", async (t) => {
  const { shiftClock, setHubZone, zoneReads, logZone } = await startSimulated(
    t,
    { shiftedClock: true },
  );

  assert.equal(await logZone(), "Europe/Moscow");
  setHubZone("Europe/Berlin");
  assert.equal(await logZone(), "Europe/Moscow");
  await shiftClock();

  assert.equal(await logZone(), "Europe/Berlin");
  assert.equal(zoneReads(), 2);
});
