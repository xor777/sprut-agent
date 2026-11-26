import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hubStateFingerprint } from "../src/automation-store.mjs";
import {
  loadHomeFixture,
  SIMULATED_HUB_TOKEN,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HOME_REF = "spruthub://hub/sim-apartment-01";
const TELEGRAM_EXTENSION_KEY = "Notification:telegram_1";
const TELEGRAM_WINDOW = "Notification/telegram_1/";
const TELEGRAM_BOT_TOKEN = "987654321:AAFakeBotTokenSecretValueDoNotLeak12345";
const EMBEDDED_SECRET_URL = "https://admin:hunter2SecretPass@cam.local/stream";

function optionEntry(key, name, type, inputType, value, extra = {}) {
  return {
    key,
    name,
    type,
    inputType,
    parent: "",
    read: true,
    write: true,
    disabled: false,
    visible: true,
    value,
    ...extra,
  };
}

function telegramExtension() {
  return {
    extensionKey: TELEGRAM_EXTENSION_KEY,
    type: "telegram",
    index: "telegram_1",
    bundleType: "NOTIFICATION",
    name: "Telegram",
    state: "FAILED",
    enabled: true,
    optionsWindow: TELEGRAM_WINDOW,
    spaces: [],
  };
}

function telegramWindow() {
  return {
    windowKey: TELEGRAM_WINDOW,
    label: { text: "Telegram", error: "Ошибка загрузки", status: "" },
    options: [
      optionEntry("Name", "Имя", "GenericString", "TEXT", {
        stringValue: "Telegram",
      }),
      optionEntry("Token", "Токен бота", "GenericString", "PASSWORD", {
        stringValue: TELEGRAM_BOT_TOKEN,
      }),
      optionEntry("Login", "Войти", "GenericBoolean", "BUTTON", {
        boolValue: true,
      }),
      optionEntry(
        "Logout",
        "Выйти",
        "GenericBoolean",
        "BUTTON",
        { boolValue: true },
        { visible: false },
      ),
    ],
  };
}

async function connectServer(t, { env }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "history-filters-integration-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return { client };
}

async function setup(
  t,
  { timeZone, withTelegram = false, faults, timeoutMs = 2_000 } = {},
) {
  const fixture = await loadHomeFixture("apartment");
  if (timeZone !== undefined) fixture.hub.timeZone = timeZone;
  if (withTelegram) fixture.extensions.push(telegramExtension());
  const hub = await startSimulatedHub(fixture, faults ? { faults } : {});
  if (withTelegram) hub.state.windows[TELEGRAM_WINDOW] = telegramWindow();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-filters-"),
  );
  const env = {
    ...hub.connectionEnv(),
    SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
    SPRUT_AGENT_STATE_DIR: stateDirectory,
  };
  const { client } = await connectServer(t, { env });
  t.after(async () => {
    await hub.close().catch(() => {});
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client, stateDirectory, env };
}

async function callOk(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(
    result.isError,
    undefined,
    `${name} unexpectedly failed: ${result.content[0]?.text}`,
  );
  return result.structuredContent;
}

async function callError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return result.structuredContent;
}

async function prepareAndApply(client, input) {
  const prepared = await callOk(client, "prepare_native_change", input);
  const applied = await callOk(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  return { prepared, applied };
}

function journalFilePath(stateDirectory, hubUrl, serial) {
  const fp = hubStateFingerprint(hubUrl, serial);
  return path.join(
    stateDirectory,
    `automation-changes-${fp.slice(0, 24)}.json`,
  );
}

function changeIdOf(changeRef) {
  return changeRef.split("/").at(-1);
}

async function rewriteJournal(stateDirectory, hubUrl, serial, mutate) {
  const file = journalFilePath(stateDirectory, hubUrl, serial);
  const state = JSON.parse(await readFile(file, "utf8"));
  mutate(state.changes);
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

function setChangeTimes(change, { appliedAt, restoredAt, updatedAt }) {
  change.created_at = appliedAt;
  change.updated_at = updatedAt ?? restoredAt ?? appliedAt;
  change.history = [
    { status: "prepared", at: appliedAt },
    { status: "applying", at: appliedAt },
    { status: "applied", at: appliedAt },
    ...(restoredAt
      ? [
          { status: "restoring", at: restoredAt },
          { status: "restored", at: restoredAt },
        ]
      : []),
  ];
  if (restoredAt) {
    change.write_intent = {
      direction: "restore",
      phase: "sending",
      acknowledged: true,
      at: restoredAt,
    };
  } else if (change.write_intent) {
    change.write_intent.at = appliedAt;
  }
}

test("since/until resolve hub time zone boundaries, DST days, explicit offsets, and restored changes", async (t) => {
  // 1. Europe/Moscow (+03:00): 2026-11-19T20:30Z is Nov 19 23:30+03, while
  //    2026-11-19T21:30Z (00:30+03) and 2026-11-19T23:30Z (02:30+03) are Nov 20.
  const { hub, client, stateDirectory, env } = await setup(t, {
    timeZone: "Europe/Moscow",
  });

  const beforeMidnight = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор 1",
    reason: "Правка до полуночи по Москве",
  });
  const justAfterMidnight = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/3`,
    value: "Гостиная 1",
    reason: "Правка сразу после полуночи по Москве",
  });
  const lateUtcNov19 = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/4`,
    value: "Кухня 1",
    reason: "Правка в 23:30 UTC (02:30 по Москве)",
  });
  const restoredInWindow = await prepareAndApply(client, {
    operation: "scenario_active",
    target_ref: `${HOME_REF}/scenario/3`,
    value: false,
    reason: "Старая правка, откаченная 20 ноября",
  });
  await callOk(client, "restore_native_change", {
    change_ref: restoredInWindow.prepared.change_ref,
  });

  await rewriteJournal(stateDirectory, hub.url, hub.serial, (changes) => {
    setChangeTimes(changes[changeIdOf(beforeMidnight.prepared.change_ref)], {
      appliedAt: "2026-11-19T20:30:00.000Z",
    });
    setChangeTimes(changes[changeIdOf(justAfterMidnight.prepared.change_ref)], {
      appliedAt: "2026-11-19T21:30:00.000Z",
    });
    setChangeTimes(changes[changeIdOf(lateUtcNov19.prepared.change_ref)], {
      appliedAt: "2026-11-19T23:30:00.000Z",
    });
    setChangeTimes(changes[changeIdOf(restoredInWindow.prepared.change_ref)], {
      appliedAt: "2026-11-10T10:00:00.000Z",
      restoredAt: "2026-11-20T09:00:00.000Z",
    });
  });

  const { client: fresh } = await connectServer(t, { env });

  // Without new filters, response omits `filters` for backward compatibility.
  const unfiltered = await callOk(fresh, "get_native_change", { limit: 50 });
  assert.equal(Object.hasOwn(unfiltered, "filters"), false);
  assert.equal(unfiltered.changes.length, 4);

  // Date-only 2026-11-20 in Europe/Moscow covers 2026-11-19T21:00:00Z .. 2026-11-20T20:59:59.999Z.
  const moscowDay = await callOk(fresh, "get_native_change", {
    since: "2026-11-20",
    until: "2026-11-20",
    limit: 50,
  });
  assert.deepEqual(moscowDay.filters, {
    since: "2026-11-20",
    until: "2026-11-20",
    since_at: "2026-11-20T00:00:00.000+03:00",
    until_at: "2026-11-20T23:59:59.999+03:00",
    time_zone: "Europe/Moscow",
    time_zone_source: "hub",
  });
  assert.deepEqual(
    new Set(moscowDay.changes.map(({ change_ref }) => change_ref)),
    new Set([
      justAfterMidnight.prepared.change_ref,
      lateUtcNov19.prepared.change_ref,
      restoredInWindow.prepared.change_ref,
    ]),
  );

  // Explicit-offset ISO timestamps select exact UTC instants.
  const explicitWindow = await callOk(fresh, "get_native_change", {
    since: "2026-11-19T22:00:00+03:00",
    until: "2026-11-19T21:00:00Z",
    limit: 50,
  });
  assert.deepEqual(explicitWindow.filters, {
    since: "2026-11-19T22:00:00+03:00",
    until: "2026-11-19T21:00:00Z",
    since_at: "2026-11-19T19:00:00.000Z",
    until_at: "2026-11-19T21:00:00.000Z",
    time_zone: "UTC",
    time_zone_source: "explicit",
  });
  assert.deepEqual(
    explicitWindow.changes.map(({ change_ref }) => change_ref),
    [beforeMidnight.prepared.change_ref],
  );

  // 2. DST spring-forward day (2026-03-08 in America/New_York: 23 hours, -05:00 -> -04:00).
  const ny = await setup(t, { timeZone: "America/New_York" });
  const dstChange = await prepareAndApply(ny.client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Hallway DST",
    reason: "Late evening on DST spring-forward day",
  });
  await rewriteJournal(
    ny.stateDirectory,
    ny.hub.url,
    ny.hub.serial,
    (changes) => {
      // 2026-03-09T03:30Z = 2026-03-08T23:30-04:00 (still March 8 in New York!)
      setChangeTimes(changes[changeIdOf(dstChange.prepared.change_ref)], {
        appliedAt: "2026-03-09T03:30:00.000Z",
      });
    },
  );
  const { client: nyFresh } = await connectServer(t, { env: ny.env });
  const dstResult = await callOk(nyFresh, "get_native_change", {
    since: "2026-03-08",
    until: "2026-03-08",
  });
  assert.deepEqual(dstResult.filters, {
    since: "2026-03-08",
    until: "2026-03-08",
    since_at: "2026-03-08T00:00:00.000-05:00",
    until_at: "2026-03-08T23:59:59.999-04:00",
    time_zone: "America/New_York",
    time_zone_source: "hub",
  });
  assert.deepEqual(
    dstResult.changes.map(({ change_ref }) => change_ref),
    [dstChange.prepared.change_ref],
  );
});

test("invalid since/until dates, timezone-less timestamps, and inverted ranges fail with invalid_time_range and zero writes", async (t) => {
  const { hub, client } = await setup(t, { timeZone: "Europe/Moscow" });

  const invalidCases = [
    { since: "2026-02-30" },
    { since: "2026-02-29" },
    { since: "2026-13-01" },
    { since: "2026-00-10" },
    { until: "2026-04-31" },
    { since: "2026-11-20T10:00:00" },
    { until: "2026-11-20T23:59:59" },
    { since: "2026-11-20T24:00:00Z" },
    { since: "2026-11-20T10:60:00Z" },
    { since: "2026-11-20T10:00:60Z" },
    { since: "2026-11-20T10:00:00+25:00" },
    { since: "2026-11-20T10:00:00+03:60" },
    { since: "not-a-date" },
    { since: "2026-11-22", until: "2026-11-20" },
    { since: "2026-11-20T12:00:00Z", until: "2026-11-20T11:59:59Z" },
    { since: "2026-11-20", until: "2026-11-19T20:59:59Z" },
  ];

  for (const args of invalidCases) {
    const failed = await callError(client, "get_native_change", args);
    assert.equal(failed.error.code, "invalid_time_range", JSON.stringify(args));
    assert.equal(
      failed.error.action,
      "get_native_change",
      JSON.stringify(args),
    );
    if (args.since === "2026-11-20T10:00:00") {
      assert.match(failed.error.message, /YYYY-MM-DD/);
      assert.match(failed.error.message, /Z|[+-]HH:MM/);
    }
  }
  assert.equal(
    hub.requests.filter(({ method }) => method !== "window.get").length,
    0,
    "invalid time ranges must never perform hub writes or unrelated RPCs",
  );
});

test("applied_only skips prepared, conflict, and refused not_applied drafts while keeping applied, restored, and uncertain", async (t) => {
  const { hub, client } = await setup(t, { timeoutMs: 800 });

  const preparedDraft = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/1`,
    value: "Черновик прихожей",
    reason: "Неприменённый черновик",
  });

  const conflictDraft = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Конфликтный коридор",
    reason: "Конфликт до отправки",
  });
  hub.state.rooms.find(({ id }) => id === 2).name = "Изменено вручную";
  const conflictApplied = await callOk(client, "apply_native_change", {
    change_ref: conflictDraft.change_ref,
  });
  assert.equal(conflictApplied.status, "conflict");

  const refusedDraft = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/3`,
    value: "Отклонённая гостиная",
    reason: "Отказ хаба при записи",
  });
  hub.refuseNext("room.update", { code: 400, message: "Room rename refused" });
  const refusedErr = await callError(client, "apply_native_change", {
    change_ref: refusedDraft.change_ref,
  });
  assert.equal(refusedErr.hub_effect, "not_applied");

  const applied = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/4`,
    value: "Кухня обновлённая",
    reason: "Применённое изменение",
  });
  assert.equal(applied.applied.status, "applied");

  const restored = await prepareAndApply(client, {
    operation: "scenario_active",
    target_ref: `${HOME_REF}/scenario/3`,
    value: false,
    reason: "Применённое и откаченное",
  });
  await callOk(client, "restore_native_change", {
    change_ref: restored.prepared.change_ref,
  });

  const uncertainPrep = await callOk(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Гардеробная",
    reason: "Потерянный ответ при создании комнаты",
  });
  hub.loseNext("room.create");
  const uncertainApplied = await callOk(client, "apply_native_change", {
    change_ref: uncertainPrep.change_ref,
  });
  assert.equal(uncertainApplied.status, "uncertain");

  const allHistory = await callOk(client, "get_native_change", { limit: 50 });
  assert.equal(allHistory.changes.length, 6);

  const appliedHistory = await callOk(client, "get_native_change", {
    applied_only: true,
    limit: 50,
  });
  assert.deepEqual(appliedHistory.filters, { applied_only: true });
  assert.deepEqual(
    new Set(appliedHistory.changes.map(({ change_ref }) => change_ref)),
    new Set([
      applied.prepared.change_ref,
      restored.prepared.change_ref,
      uncertainPrep.change_ref,
    ]),
  );
  assert.equal(
    appliedHistory.changes.some(({ change_ref }) =>
      [
        preparedDraft.change_ref,
        conflictDraft.change_ref,
        refusedDraft.change_ref,
      ].includes(change_ref),
    ),
    false,
  );
});

test("query matches Russian inflected forms across summary fields, rejects punctuation-only queries, and never searches or leaks secrets", async (t) => {
  const { client } = await setup(t, { withTelegram: true });

  const hallway = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Ночной коридор",
    reason: "Настроить ночную подсветку в коридоре",
  });
  const bedroom = await prepareAndApply(client, {
    operation: "scenario_active",
    target_ref: `${HOME_REF}/scenario/5`,
    value: false,
    reason: "Выключить автосвет в спальне на все выходные",
  });
  // Bridge export of Торшер (accessory 16, service 13) to HomeKit.
  const bridgeChange = await prepareAndApply(client, {
    operation: "window_option",
    target_ref: `${HOME_REF}/window/${encodeURIComponent("Bridge/homekit/Child/16/")}`,
    option_key: "s:13",
    value: true,
    reason: "Добавить торшер для голосового управления",
  });
  // Records with credential-shaped text and connection token in reason + Telegram button.
  await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/7`,
    value: "Кабинет 5",
    reason: `Ссылка камеры ${EMBEDDED_SECRET_URL}`,
  });
  await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/8`,
    value: "Ванная обновлённая",
    reason: `Служебный токен ${SIMULATED_HUB_TOKEN}`,
  });
  await prepareAndApply(client, {
    operation: "window_button",
    target_ref: `${HOME_REF}/window/${encodeURIComponent(TELEGRAM_WINDOW)}`,
    option_key: "Login",
    reason: "Подключить уведомления Telegram",
  });

  // Russian inflected query across reason ("ночная подсветка" -> "ночную подсветку").
  const nightMatch = await callOk(client, "get_native_change", {
    query: "ночная подсветка",
  });
  assert.deepEqual(nightMatch.filters, { query: "ночная подсветка" });
  assert.deepEqual(
    nightMatch.changes.map(({ change_ref }) => change_ref),
    [hallway.prepared.change_ref],
  );

  // Case-insensitive + Russian inflection ("СПАЛЬНЯ" -> "в спальне").
  const bedroomMatch = await callOk(client, "get_native_change", {
    query: "СПАЛЬНЯ",
  });
  assert.deepEqual(
    bedroomMatch.changes.map(({ change_ref }) => change_ref),
    [bedroom.prepared.change_ref],
  );

  // Matches `bridge`, `name`, and `operation` fields.
  const bridgeByName = await callOk(client, "get_native_change", {
    query: "homekit",
  });
  assert.deepEqual(
    bridgeByName.changes.map(({ change_ref }) => change_ref),
    [bridgeChange.prepared.change_ref],
  );
  const bridgeByOp = await callOk(client, "get_native_change", {
    query: "window_option",
  });
  assert.deepEqual(
    bridgeByOp.changes.map(({ change_ref }) => change_ref),
    [bridgeChange.prepared.change_ref],
  );
  const byScenarioName = await callOk(client, "get_native_change", {
    query: "ночной режим",
  });
  assert.deepEqual(
    byScenarioName.changes.map(({ change_ref }) => change_ref),
    [bedroom.prepared.change_ref],
  );

  // Matches `value` text ("Ночной коридор").
  const byValue = await callOk(client, "get_native_change", {
    query: "ночной коридор",
  });
  assert.deepEqual(
    byValue.changes.map(({ change_ref }) => change_ref),
    [hallway.prepared.change_ref],
  );

  // Single-char / stopword fallback ("все", "5").
  const stopwordMatch = await callOk(client, "get_native_change", {
    query: "все",
  });
  assert.deepEqual(
    stopwordMatch.changes.map(({ change_ref }) => change_ref),
    [bedroom.prepared.change_ref],
  );
  const digitMatch = await callOk(client, "get_native_change", {
    query: "5",
  });
  assert.equal(digitMatch.changes.length, 1);

  // Pure punctuation / whitespace query fails with invalid_history_query.
  for (const badQuery of ["   ", "!!!", "... — ???"]) {
    const failed = await callError(client, "get_native_change", {
      query: badQuery,
    });
    assert.equal(failed.error.code, "invalid_history_query", badQuery);
    assert.equal(failed.error.action, "get_native_change", badQuery);
  }

  // Secret strings are NEVER searchable and NEVER leaked in response JSON.
  for (const bareSecret of ["hunter2SecretPass", TELEGRAM_BOT_TOKEN]) {
    const probed = await callOk(client, "get_native_change", {
      query: bareSecret,
      limit: 50,
    });
    assert.deepEqual(probed.changes, [], `bare secret matched: ${bareSecret}`);
  }
  const telegramBotUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`;
  for (const secretProbe of [
    EMBEDDED_SECRET_URL,
    telegramBotUrl,
    SIMULATED_HUB_TOKEN,
    "REDACTED",
  ]) {
    const probed = await callOk(client, "get_native_change", {
      query: secretProbe,
      limit: 50,
    });
    assert.deepEqual(
      probed.changes,
      [],
      `secret probe matched: ${secretProbe}`,
    );
    const serialized = JSON.stringify(probed);
    assert.equal(serialized.includes("hunter2SecretPass"), false);
    assert.equal(serialized.includes(SIMULATED_HUB_TOKEN), false);
    assert.equal(serialized.includes(TELEGRAM_BOT_TOKEN), false);
  }
  const unfilteredSerialized = JSON.stringify(
    await callOk(client, "get_native_change", { limit: 50 }),
  );
  assert.equal(unfilteredSerialized.includes("hunter2SecretPass"), false);
  assert.equal(unfilteredSerialized.includes(SIMULATED_HUB_TOKEN), false);
  assert.equal(unfilteredSerialized.includes(TELEGRAM_BOT_TOKEN), false);
});

test("cursor pagination preserves filters across pages and rejects cursor reuse with different filters", async (t) => {
  const { client } = await setup(t);

  const appliedRefs = [];
  for (let i = 1; i <= 5; i += 1) {
    const { prepared } = await prepareAndApply(client, {
      operation: "room_name",
      target_ref: `${HOME_REF}/room/2`,
      value: `Коридор шаг ${i}`,
      reason: `Ночная подсветка шаг ${i}`,
    });
    appliedRefs.push(prepared.change_ref);
  }
  // Unapplied draft with same keyword should be skipped when applied_only=true.
  const draft = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор черновик",
    reason: "Ночная подсветка черновик",
  });

  const first = await callOk(client, "get_native_change", {
    since: "2020-01-01",
    until: "2030-12-31",
    applied_only: true,
    query: "ночная подсветка",
    limit: 2,
  });
  assert.equal(first.changes.length, 2);
  assert.equal(first.page.remaining_changes, 3);
  assert.ok(first.page.next_cursor);
  assert.deepEqual(first.next, {
    tool: "get_native_change",
    arguments: {
      home_ref: HOME_REF,
      since: "2020-01-01",
      until: "2030-12-31",
      applied_only: true,
      query: "ночная подсветка",
      limit: 2,
      cursor: first.page.next_cursor,
    },
  });

  const collected = first.changes.map(({ change_ref }) => change_ref);
  let next = first.next;
  while (next) {
    const page = await callOk(client, next.tool, next.arguments);
    collected.push(...page.changes.map(({ change_ref }) => change_ref));
    next = page.next;
  }
  assert.equal(collected.length, 5);
  assert.deepEqual(new Set(collected), new Set(appliedRefs));
  assert.equal(collected.includes(draft.change_ref), false);

  // Changing ANY filter with the same cursor fails with invalid_cursor.
  const mismatchedCalls = [
    {
      since: "2021-01-01",
      until: "2030-12-31",
      applied_only: true,
      query: "ночная подсветка",
    },
    {
      since: "2020-01-01",
      until: "2029-12-31",
      applied_only: true,
      query: "ночная подсветка",
    },
    {
      since: "2020-01-01",
      until: "2030-12-31",
      applied_only: false,
      query: "ночная подсветка",
    },
    {
      since: "2020-01-01",
      until: "2030-12-31",
      applied_only: true,
      query: "другое слово",
    },
    {
      entity_ref: `${HOME_REF}/room/2`,
      since: "2020-01-01",
      until: "2030-12-31",
      applied_only: true,
      query: "ночная подсветка",
    },
  ];
  for (const args of mismatchedCalls) {
    const failed = await callError(client, "get_native_change", {
      ...args,
      limit: 2,
      cursor: first.page.next_cursor,
    });
    assert.equal(failed.error.code, "invalid_cursor", JSON.stringify(args));
  }
});

test("restore_supported on changeSummary matches undoability across operations and statuses", async (t) => {
  const { hub, client } = await setup(t, {
    withTelegram: true,
    timeoutMs: 800,
  });

  const appliedSetting = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор новый",
    reason: "Применённая настройка",
  });
  const lampCommands = await callOk(client, "send_device_commands", {
    home_ref: HOME_REF,
    commands: [
      {
        target_ref: `${HOME_REF}/accessory/15/service/13/characteristic/14`,
        value: false,
      },
      {
        target_ref: `${HOME_REF}/accessory/15/service/13/characteristic/15`,
        value: 50,
      },
    ],
    reason: "Команды люстре",
  });
  const lampOnRef = lampCommands.results[0].change_ref;
  const lampBrightnessRef = lampCommands.results[1].change_ref;

  const restoredChange = await prepareAndApply(client, {
    operation: "scenario_active",
    target_ref: `${HOME_REF}/scenario/3`,
    value: false,
    reason: "Откаченная настройка",
  });
  await callOk(client, "restore_native_change", {
    change_ref: restoredChange.prepared.change_ref,
  });

  const preparedDraft = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/1`,
    value: "Черновик",
    reason: "Неприменённый черновик",
  });

  const scenarioRun = await prepareAndApply(client, {
    operation: "scenario_run",
    target_ref: `${HOME_REF}/scenario/11`,
    reason: "Запустить выключение всего света",
  });

  const windowButton = await prepareAndApply(client, {
    operation: "window_button",
    target_ref: `${HOME_REF}/window/${encodeURIComponent(TELEGRAM_WINDOW)}`,
    option_key: "Login",
    reason: "Войти в Telegram",
  });

  const ownedRoom = await prepareAndApply(client, {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Кладовая",
    reason: "Создать кладовую",
  });

  const unownedRoomPrep = await callOk(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Лоджия",
    reason: "Неподтверждённое создание комнаты",
  });
  hub.loseNext("room.create");
  await callOk(client, "apply_native_change", {
    change_ref: unownedRoomPrep.change_ref,
  });

  const history = await callOk(client, "get_native_change", { limit: 50 });
  const byRef = new Map(
    history.changes.map((summary) => [summary.change_ref, summary]),
  );

  assert.equal(
    byRef.get(appliedSetting.prepared.change_ref).restore_supported,
    true,
  );
  assert.equal(byRef.get(lampOnRef).restore_supported, true);
  assert.equal(byRef.get(lampBrightnessRef).restore_supported, false);
  assert.equal(
    byRef.get(restoredChange.prepared.change_ref).restore_supported,
    false,
  );
  assert.equal(byRef.get(preparedDraft.change_ref).restore_supported, false);
  assert.equal(
    byRef.get(scenarioRun.prepared.change_ref).restore_supported,
    false,
  );
  assert.equal(
    byRef.get(windowButton.prepared.change_ref).restore_supported,
    false,
  );
  assert.equal(
    byRef.get(ownedRoom.prepared.change_ref).restore_supported,
    true,
  );
  assert.equal(byRef.get(unownedRoomPrep.change_ref).restore_supported, false);
});

test("change_ref combined with list filters fails with invalid_history_query before hub contact", async (t) => {
  const fixture = await loadHomeFixture("apartment");
  const loginHub = await startSimulatedHub(fixture, {
    account: {
      login: "owner@example.invalid",
      password: "correct-password-123",
    },
  });
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-mutex-"),
  );
  const emptyConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-mutex-cfg-"),
  );
  t.after(async () => {
    await loginHub.close().catch(() => {});
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(emptyConfigRoot, { recursive: true, force: true });
  });
  const { client } = await connectServer(t, {
    env: {
      SPRUTHUB_URL: loginHub.url,
      SPRUTHUB_SERIAL: loginHub.serial,
      SPRUTHUB_LOGIN: "owner@example.invalid",
      SPRUTHUB_PASSWORD: "correct-password-123",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });

  const sampleRef = "spruthub-change://native/0123456789abcdef01234567";
  const combos = [
    { change_ref: sampleRef, since: "2026-11-20" },
    { change_ref: sampleRef, until: "2026-11-26" },
    { change_ref: sampleRef, applied_only: true },
    { change_ref: sampleRef, applied_only: false },
    { change_ref: sampleRef, query: "свет" },
    { change_ref: sampleRef, entity_ref: `${HOME_REF}/room/2` },
    { change_ref: sampleRef, cursor: "eyJ2IjoyfQ" },
  ];
  for (const args of combos) {
    const failed = await callError(client, "get_native_change", args);
    assert.equal(
      failed.error.code,
      "invalid_history_query",
      JSON.stringify(args),
    );
    assert.equal(
      failed.error.action,
      "get_native_change",
      JSON.stringify(args),
    );
  }
  assert.equal(
    loginHub.requests.length,
    0,
    "mutual exclusion must reject before any hub login or RPC",
  );

  // Calling get_native_change({ change_ref }) alone still reconciles normally.
  const live = await setup(t);
  const applied = await prepareAndApply(live.client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор проверка",
    reason: "Проверить get_native_change с change_ref",
  });
  const inspected = await callOk(live.client, "get_native_change", {
    change_ref: applied.prepared.change_ref,
  });
  assert.equal(inspected.status, "applied");
  assert.equal(inspected.change_ref, applied.prepared.change_ref);
});

test("offline history listing works without hub credentials, surfaces unreadable connection.env, and rejects foreign home_ref with 0 hub requests", async (t) => {
  const { hub, client, stateDirectory } = await setup(t);
  const saved = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор офлайн",
    reason: "Сохранённая правка для офлайн-истории",
  });

  // 1. Fresh server with SPRUTHUB_URL + SPRUTHUB_SERIAL and NO credentials.
  const emptyConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-empty-cfg-"),
  );
  t.after(async () => {
    await rm(emptyConfigRoot, { recursive: true, force: true });
  });
  const offline = await connectServer(t, {
    env: {
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: hub.serial,
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  const listedOffline = await callOk(offline.client, "get_native_change", {
    since: "2020-01-01",
    applied_only: true,
    query: "офлайн",
  });
  assert.equal(listedOffline.status, "ok");
  assert.equal(listedOffline.home_ref, HOME_REF);
  assert.deepEqual(listedOffline.filters, {
    since: "2020-01-01",
    since_at: "2020-01-01T00:00:00.000Z",
    time_zone: "UTC",
    time_zone_source: "utc_fallback",
    applied_only: true,
    query: "офлайн",
  });
  assert.deepEqual(
    listedOffline.changes.map(({ change_ref }) => change_ref),
    [saved.prepared.change_ref],
  );
  assert.equal(listedOffline.changes[0].restore_supported, true);

  // 1b. Unreachable hub (closed port) with SPRUTHUB_LOGIN/SPRUTHUB_PASSWORD still lists local journal.
  const closedHubUrl = hub.url;
  const closedSerial = hub.serial;
  await hub.close();
  const unreachable = await connectServer(t, {
    env: {
      SPRUTHUB_URL: closedHubUrl,
      SPRUTHUB_SERIAL: closedSerial,
      SPRUTHUB_LOGIN: "owner@example.invalid",
      SPRUTHUB_PASSWORD: "correct-password-123",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  const listedUnreachable = await callOk(
    unreachable.client,
    "get_native_change",
    {
      since: "2020-01-01",
      applied_only: true,
    },
  );
  assert.equal(listedUnreachable.status, "ok");
  assert.equal(listedUnreachable.filters.time_zone, "UTC");
  assert.equal(listedUnreachable.filters.time_zone_source, "utc_fallback");
  assert.deepEqual(
    listedUnreachable.changes.map(({ change_ref }) => change_ref),
    [saved.prepared.change_ref],
  );

  // 2. Unreadable / wrong-mode connection.env (0o644) still surfaces credential_file_unavailable.
  const badConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-bad-cfg-"),
  );
  t.after(async () => {
    await rm(badConfigRoot, { recursive: true, force: true });
  });
  const badEnvDir = path.join(badConfigRoot, "sprut-agent");
  await mkdir(badEnvDir, { recursive: true });
  const badEnvFile = path.join(badEnvDir, "connection.env");
  await writeFile(badEnvFile, "SPRUTHUB_LOGIN=owner@example.invalid\n", {
    mode: 0o644,
  });
  await chmod(badEnvFile, 0o644);
  const badConfigServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: hub.serial,
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: badConfigRoot,
    },
  });
  const badConfigErr = await callError(
    badConfigServer.client,
    "get_native_change",
    {},
  );
  assert.equal(badConfigErr.error.code, "credential_file_unavailable");

  // 3. Foreign or malformed home_ref under SPRUTHUB_LOGIN/SPRUTHUB_PASSWORD rejects with 0 hub requests.
  const loginFixture = await loadHomeFixture("apartment");
  const loginHub = await startSimulatedHub(loginFixture, {
    account: {
      login: "owner@example.invalid",
      password: "correct-password-123",
    },
  });
  t.after(async () => {
    await loginHub.close().catch(() => {});
  });
  const loginServer = await connectServer(t, {
    env: {
      SPRUTHUB_URL: loginHub.url,
      SPRUTHUB_SERIAL: loginHub.serial,
      SPRUTHUB_LOGIN: "owner@example.invalid",
      SPRUTHUB_PASSWORD: "correct-password-123",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });
  for (const [args, expectedCode] of [
    [{ home_ref: "spruthub://hub/foreign-home" }, "unsupported_home_write"],
    [{ home_ref: "not-a-home-ref" }, "invalid_home_ref"],
    [{ home_ref: `${HOME_REF}/room/1` }, "invalid_home_ref"],
    [
      { entity_ref: "spruthub://hub/foreign-home/room/1" },
      "unsupported_home_write",
    ],
  ]) {
    const failed = await callError(
      loginServer.client,
      "get_native_change",
      args,
    );
    assert.equal(failed.error.code, expectedCode, JSON.stringify(args));
  }
  assert.equal(
    loginHub.requests.length,
    0,
    "foreign/malformed home_ref must reject locally before any hub login or RPC",
  );
});

test("MCP surface keeps 13 tools, <= 2048 char instructions, <= 1000 char tool descriptions, and exposes history filter schema", async (t) => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 13, "must keep exactly 13 MCP tools");

  const oversized = tools
    .filter(({ description }) => description.length > 1_000)
    .map(({ name, description }) => `${name}: ${description.length}`);
  assert.deepEqual(oversized, []);

  const instructions = client.getInstructions();
  assert.ok(
    instructions.length <= 2_048,
    `instructions exceeded 2048 chars: ${instructions.length}`,
  );

  const historyTool = tools.find(({ name }) => name === "get_native_change");
  assert.ok(historyTool);
  for (const prop of ["since", "until", "applied_only", "query"]) {
    assert.ok(
      Object.hasOwn(historyTool.inputSchema.properties, prop),
      `get_native_change missing inputSchema property ${prop}`,
    );
  }
});

test("credential-shaped query returns empty matches and never embeds raw secret in next_cursor", async (t) => {
  const { client } = await setup(t);

  // Ordinary non-secret reasons containing both "кухня" and "key", so dropping
  // 1-char tokens ("x", "S") from "кухня /x?key=S" would otherwise match both.
  await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/4`,
    value: "Кухня 1",
    reason: "Настроить key в кухне шаг 1",
  });
  await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/4`,
    value: "Кухня 2",
    reason: "Настроить key в кухне шаг 2",
  });

  const secretQuery = "кухня /x?key=S";
  const result = await callOk(client, "get_native_change", {
    query: secretQuery,
    limit: 1,
  });
  assert.deepEqual(result.changes, []);
  assert.equal(result.page.next_cursor, null);
  assert.equal(result.next, null);
  assert.equal(result.filters.query, "[REDACTED]");
  assert.equal(JSON.stringify(result).includes("/x?key=S"), false);

  // Even when a bad cursor is supplied alongside a secret query, invalid_cursor's
  // restart next call never embeds the raw secret.
  const badCursor = await callError(client, "get_native_change", {
    query: secretQuery,
    limit: 1,
    cursor: "not-a-valid-cursor",
  });
  assert.equal(badCursor.error.code, "invalid_cursor");
  assert.equal(badCursor.next.arguments.query, "[REDACTED]");
  assert.equal(JSON.stringify(badCursor).includes("/x?key=S"), false);
});

test("summary restore_supported stays true for recoverable post-apply conflicts and false for permanent or unsent conflicts", async (t) => {
  const { hub, client } = await setup(t);

  // 1. later_owned_change on a native value (room_name): recoverable once later change is undone.
  const firstRename = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор А",
    reason: "Первое переименование коридора",
  });
  const secondRename = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор Б",
    reason: "Второе переименование коридора",
  });
  const laterBlocked = await callOk(client, "restore_native_change", {
    change_ref: firstRename.prepared.change_ref,
  });
  assert.equal(laterBlocked.status, "conflict");
  assert.equal(laterBlocked.conflict_reason, "later_owned_change");
  assert.equal(laterBlocked.restore_supported, true);

  // 2. room_not_empty on owned room_create: recoverable once room is emptied.
  const createdRoom = await prepareAndApply(client, {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Кладовая",
    reason: "Создать кладовую",
  });
  const createdRoomRef = createdRoom.applied.room.ref;
  await prepareAndApply(client, {
    operation: "accessory_placement",
    target_ref: `${HOME_REF}/accessory/16`,
    name: "Торшер",
    room_ref: createdRoomRef,
    reason: "Перенести торшер в кладовую",
  });
  const roomNotEmpty = await callOk(client, "restore_native_change", {
    change_ref: createdRoom.prepared.change_ref,
  });
  assert.equal(roomNotEmpty.status, "conflict");
  assert.equal(roomNotEmpty.conflict_reason, "room_not_empty");
  assert.equal(roomNotEmpty.restore_supported, true);

  // 3. later_owned_change on accessory_placement: recoverable once later placement is undone.
  const firstPlace = await prepareAndApply(client, {
    operation: "accessory_placement",
    target_ref: `${HOME_REF}/accessory/15`,
    name: "Люстра А",
    room_ref: `${HOME_REF}/room/3`,
    reason: "Первое имя люстры",
  });
  await prepareAndApply(client, {
    operation: "accessory_placement",
    target_ref: `${HOME_REF}/accessory/15`,
    name: "Люстра Б",
    room_ref: `${HOME_REF}/room/3`,
    reason: "Второе имя люстры",
  });
  const placeBlocked = await callOk(client, "restore_native_change", {
    change_ref: firstPlace.prepared.change_ref,
  });
  assert.equal(placeBlocked.status, "conflict");
  assert.equal(placeBlocked.conflict_reason, "later_owned_change");
  assert.equal(placeBlocked.restore_supported, true);

  // 4. Permanent manual_change_observed conflict on room_name -> false.
  const manualEdited = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/4`,
    value: "Кухня агента",
    reason: "Переименование кухни до ручной правки",
  });
  hub.state.rooms.find(({ id }) => id === 4).name = "Кухня владельца";
  const manualConflict = await callOk(client, "restore_native_change", {
    change_ref: manualEdited.prepared.change_ref,
  });
  assert.equal(manualConflict.status, "conflict");
  assert.equal(manualConflict.conflict_reason, "manual_change");
  assert.equal(manualConflict.manual_change_observed, true);

  // 5. Unsent pre-apply baseline_changed conflict -> false.
  const unsentConflict = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/1`,
    value: "Прихожая агента",
    reason: "Конфликт до отправки",
  });
  hub.state.rooms.find(({ id }) => id === 1).name = "Прихожая владельца";
  const preApplyConflict = await callOk(client, "apply_native_change", {
    change_ref: unsentConflict.change_ref,
  });
  assert.equal(preApplyConflict.status, "conflict");
  assert.equal(preApplyConflict.conflict_reason, "baseline_changed");

  const history = await callOk(client, "get_native_change", { limit: 50 });
  const byRef = new Map(
    history.changes.map((summary) => [summary.change_ref, summary]),
  );

  assert.equal(
    byRef.get(firstRename.prepared.change_ref).restore_supported,
    true,
  );
  assert.equal(
    byRef.get(createdRoom.prepared.change_ref).restore_supported,
    true,
  );
  assert.equal(
    byRef.get(firstPlace.prepared.change_ref).restore_supported,
    true,
  );
  assert.equal(
    byRef.get(manualEdited.prepared.change_ref).restore_supported,
    false,
  );
  assert.equal(byRef.get(unsentConflict.change_ref).restore_supported, false);

  // Confirm the recoverable later_owned_change record actually restores once its blocker is undone.
  await callOk(client, "restore_native_change", {
    change_ref: secondRename.prepared.change_ref,
  });
  const recovered = await callOk(client, "restore_native_change", {
    change_ref: firstRename.prepared.change_ref,
  });
  assert.equal(recovered.status, "restored");
});

test("query uses whole-word fallback for stopwords/single chars and preserves numeric tokens", async (t) => {
  const { client } = await setup(t);

  await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/8`,
    value: "Ванная новая",
    reason: "Настроить свет",
  });
  await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/7`,
    value: "Кабинет 77",
    reason: "Номер 77",
  });
  const hallway1 = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор 1",
    reason: "Зона коридор 1",
  });
  const hallway2 = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор 2",
    reason: "Зона коридор 2",
  });
  const hallway20 = await prepareAndApply(client, {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/2`,
    value: "Коридор 20",
    reason: "Зона коридор 20",
  });
  const bedroomWords = await prepareAndApply(client, {
    operation: "scenario_active",
    target_ref: `${HOME_REF}/scenario/5`,
    value: false,
    reason: "Выключить в спальне на ночь",
  });

  // Stopword-only fallback "в на" matches whole words, never prefixes like "Ванная / Настроить".
  const stopwordQuery = await callOk(client, "get_native_change", {
    query: "в на",
    limit: 50,
  });
  assert.deepEqual(
    stopwordQuery.changes.map(({ change_ref }) => change_ref),
    [bedroomWords.prepared.change_ref],
  );

  // Single digit "7" must not prefix-match "77".
  const digit7 = await callOk(client, "get_native_change", {
    query: "7",
    limit: 50,
  });
  assert.deepEqual(digit7.changes, []);

  // Mixed query "коридор 2" preserves "2" as an exact numeric word (not "1" or "20").
  const corridor2 = await callOk(client, "get_native_change", {
    query: "коридор 2",
    limit: 50,
  });
  assert.deepEqual(
    corridor2.changes.map(({ change_ref }) => change_ref),
    [hallway2.prepared.change_ref],
  );
  assert.equal(
    corridor2.changes.some(({ change_ref }) =>
      [hallway1.prepared.change_ref, hallway20.prepared.change_ref].includes(
        change_ref,
      ),
    ),
    false,
  );
});

test("applied_only includes synthetic lamp-On conflict and excludes restored hub-refused not_owned records", async (t) => {
  const { hub, client } = await setup(t, {
    faults: { lampLogic: [{ aId: 15, sId: 13 }] },
  });

  // 1. Switch lamp 15 off, then set Brightness=60 so the lamp switches On
  //    (creating a synthetic caused_by_change_id record with native_write_sent=false).
  await callOk(client, "send_device_commands", {
    home_ref: HOME_REF,
    commands: [
      {
        target_ref: `${HOME_REF}/accessory/15/service/13/characteristic/14`,
        value: false,
      },
    ],
    reason: "Выключить люстру перед яркостью",
  });
  const brightnessCmd = await callOk(client, "send_device_commands", {
    home_ref: HOME_REF,
    commands: [
      {
        target_ref: `${HOME_REF}/accessory/15/service/13/characteristic/15`,
        value: 60,
      },
    ],
    reason: "Задать яркость выключенной люстре",
  });
  const brightnessRef = brightnessCmd.results[0].change_ref;

  // Locate the synthetic lamp-On change caused by the brightness write.
  const allAfterLamp = await callOk(client, "get_native_change", { limit: 50 });
  const syntheticOnSummary = allAfterLamp.changes.find(
    (entry) =>
      entry.operation === "characteristic_value" &&
      entry.target_ref ===
        `${HOME_REF}/accessory/15/service/13/characteristic/14` &&
      entry.change_ref !== brightnessRef &&
      entry.reason === "Задать яркость выключенной люстре",
  );
  assert.ok(syntheticOnSummary, "expected synthetic lamp-On change in journal");

  // Apply a later command to the same On characteristic, then attempt restore on the synthetic record.
  await callOk(client, "send_device_commands", {
    home_ref: HOME_REF,
    commands: [
      {
        target_ref: `${HOME_REF}/accessory/15/service/13/characteristic/14`,
        value: false,
      },
    ],
    reason: "Позже выключить люстру",
  });
  const syntheticConflict = await callOk(client, "restore_native_change", {
    change_ref: syntheticOnSummary.change_ref,
  });
  assert.equal(syntheticConflict.status, "conflict");
  assert.equal(syntheticConflict.conflict_reason, "later_owned_change");

  // 2. Hub-refused writes (not_applied) that transition to not_owned on restore attempt.
  const refusedRename = await callOk(client, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${HOME_REF}/room/6`,
    value: "Отклонённая детская",
    reason: "Отклонённое переименование комнаты",
  });
  hub.refuseNext("room.update", { code: 400, message: "Refused" });
  await callError(client, "apply_native_change", {
    change_ref: refusedRename.change_ref,
  });
  const refusedRenameRestored = await callOk(client, "restore_native_change", {
    change_ref: refusedRename.change_ref,
  });
  assert.equal(refusedRenameRestored.status, "not_owned");
  assert.equal(refusedRenameRestored.conflict_reason, "change_was_not_applied");

  const refusedRoomCreate = await callOk(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: HOME_REF,
    name: "Отклонённая комната",
    reason: "Отклонённое создание комнаты",
  });
  hub.refuseNext("room.create", { code: 400, message: "Refused" });
  await callError(client, "apply_native_change", {
    change_ref: refusedRoomCreate.change_ref,
  });
  const refusedCreateRestored = await callOk(client, "restore_native_change", {
    change_ref: refusedRoomCreate.change_ref,
  });
  assert.equal(refusedCreateRestored.status, "not_owned");
  assert.equal(
    refusedCreateRestored.conflict_reason,
    "room_creation_not_confirmed",
  );

  const appliedHistory = await callOk(client, "get_native_change", {
    applied_only: true,
    limit: 50,
  });
  const appliedRefs = new Set(
    appliedHistory.changes.map(({ change_ref }) => change_ref),
  );
  assert.equal(appliedRefs.has(syntheticOnSummary.change_ref), true);
  assert.equal(
    appliedHistory.changes.find(
      ({ change_ref }) => change_ref === syntheticOnSummary.change_ref,
    ).restore_supported,
    true,
  );
  assert.equal(appliedRefs.has(refusedRename.change_ref), false);
  assert.equal(appliedRefs.has(refusedRoomCreate.change_ref), false);
});

test("multi-home/unpinned live client rejects get_native_change with home_selection_required even when home_ref is passed", async (t) => {
  const fixture = await loadHomeFixture("apartment");
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-unpinned-"),
  );
  const emptyConfigRoot = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-history-unpinned-cfg-"),
  );
  t.after(async () => {
    await hub.close().catch(() => {});
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(emptyConfigRoot, { recursive: true, force: true });
  });

  // Live token client with NO SPRUTHUB_SERIAL -> client.serial === null.
  const { SPRUTHUB_SERIAL: _omitted, ...unpinnedEnv } = hub.connectionEnv();
  const { client } = await connectServer(t, {
    env: {
      ...unpinnedEnv,
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_CONFIG_HOME: emptyConfigRoot,
    },
  });

  for (const args of [
    {},
    { home_ref: HOME_REF },
    { home_ref: "spruthub://hub/nonexistent-home" },
  ]) {
    const failed = await callError(client, "get_native_change", args);
    assert.equal(
      failed.error.code,
      "home_selection_required",
      JSON.stringify(args),
    );
    assert.equal(failed.error.action, "home_overview", JSON.stringify(args));
  }
});
