#!/usr/bin/env node
// The owner's daily self-check: can the shipped server still log in, read the
// home and does the hub run the verified firmware. See DEVELOPMENT.md.
//
// node scripts/nightly-check.mjs             one run
// node scripts/nightly-check.mjs install     schedule it with launchd
// node scripts/nightly-check.mjs uninstall   remove the schedule
//
// It speaks to dist/plugin/dist/server.mjs as an MCP client and calls only
// home_overview, so a run reads and cannot write to the home. Hub text is not
// trusted: the summary, the output and the notifications take only closed
// fields from the reply, each one checked against its form.
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { stateDirectory } from "../src/automation-store.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const SERVER = path.join(ROOT, "dist", "plugin", "dist", "server.mjs");
const LABEL = "com.sprut-agent.nightly-check";
const SUMMARY_FILE = "nightly-check.json";
const SCHEDULE = { Hour: 9, Minute: 0 };
const CONNECTION_FILE = "~/.config/sprut-agent/connection.env";
const CLOSE_LIMIT_MS = 5000;
const NOTIFY_LIMIT_MS = 10_000;

const run = promisify(execFile);

// Limits of one attempt and the pause before the second; set only to shorten
// them in a test or a manual run.
function limit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && process.env[name]
    ? value
    : fallback;
}

const LOGIN_REFUSED = new Set([
  "authentication_failed",
  "authentication_delayed",
  "authentication_step_unsupported",
  "password_enrollment_required",
]);
const NOT_CONFIGURED = new Set([
  "configuration",
  "credential_file_unavailable",
  "session_permissions",
]);
const UNREACHABLE = new Set([
  "connection_failed",
  "connection_closed",
  "timeout",
]);

const closedField = (value, form) =>
  typeof value === "string" && form.test(value) ? value : undefined;
const errorCode = (value) => closedField(value, /^[a-z_]{1,64}$/) ?? "unknown";
const revisionOf = (value) =>
  closedField(String(value ?? ""), /^[\w.-]{1,40}$/) ?? null;

function classify(body) {
  const code = body?.error?.code;
  if (code !== undefined) {
    const failure = { error_code: errorCode(code) };
    if (LOGIN_REFUSED.has(code)) {
      failure.outcome = "login_refused";
      failure.account_status = closedField(
        body.account_status,
        /^ACCOUNT_[A-Z_]{1,64}$/,
      );
      const nextLogin = closedField(body.next_login_at, /^[\dT:.Z-]{1,40}$/);
      if (nextLogin && !Number.isNaN(Date.parse(nextLogin))) {
        failure.next_login_at = nextLogin;
      }
      // A hub that asks to wait says for how long, not until when.
      const wait = body.retry_after_seconds;
      if (!nextLogin && Number.isSafeInteger(wait) && wait > 0) {
        failure.retry_after_seconds = wait;
      }
    } else if (NOT_CONFIGURED.has(code)) {
      failure.outcome = "login_not_configured";
    } else if (UNREACHABLE.has(code)) {
      failure.outcome = "hub_unreachable";
    } else {
      failure.outcome = "check_failed";
    }
    return failure;
  }
  const { home, tool } = body ?? {};
  if (!home || !tool) {
    return { outcome: "check_failed", error_code: "unexpected_reply" };
  }
  if (home.online === false) {
    return { outcome: "hub_unreachable", error_code: "hub_offline" };
  }
  const firmwareCheck = ["matches", "differs", "unknown"].includes(
    tool.firmware_check,
  )
    ? tool.firmware_check
    : "unknown";
  return {
    outcome: "ok",
    tool_version: closedField(tool.version, /^[\w.+-]{1,40}$/),
    firmware_check: firmwareCheck,
    firmware_revision: revisionOf(home.firmware?.revision),
    verified_revision: revisionOf(tool.verified_revision),
  };
}

class DeadlineExceeded extends Error {}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readHome(timeoutMs) {
  const client = new Client({ name: "sprut-agent-nightly", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: ROOT,
    env: process.env,
    // Server output is not ours to repeat: it may quote the hub.
    stderr: "ignore",
  });
  try {
    const reply = await withDeadline(
      (async () => {
        await client.connect(transport);
        return client.callTool(
          { name: "home_overview", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        );
      })(),
      timeoutMs,
    );
    return classify(reply.structuredContent);
  } catch (error) {
    return error instanceof DeadlineExceeded || error?.code === -32001
      ? { outcome: "hub_unreachable", error_code: "timeout" }
      : { outcome: "check_failed", error_code: "server_failed" };
  } finally {
    await withDeadline(client.close(), CLOSE_LIMIT_MS).catch(() => {});
  }
}

// launchd runs a job missed in sleep at wake-up, often before the network is
// back, so an unreachable hub gets one more look before it counts.
async function check() {
  const timeoutMs = limit("SPRUT_AGENT_NIGHTLY_TIMEOUT_MS", 120_000);
  const retryMs = limit("SPRUT_AGENT_NIGHTLY_RETRY_MS", 60_000);
  const result = await readHome(timeoutMs);
  if (result.outcome !== "hub_unreachable") return { ...result, attempts: 1 };
  await new Promise((resolve) => setTimeout(resolve, retryMs));
  return { ...(await readHome(timeoutMs)), attempts: 2 };
}

// What the owner does about each refusal, first by its code: only
// authentication_failed carries an account status. A saved file does not lift
// the wait of authentication_delayed, so these do not send the owner to it.
const LOGIN_ADVICE_BY_CODE = {
  authentication_delayed:
    "Хаб просит подождать перед новым входом: так он отвечает на частые попытки. Пароль менять не нужно, а сохранение файла входа ожидание не снимает. Следующая проверка попробует снова.",
  password_enrollment_required:
    "SprutHub просит завершить настройку пароля в официальном приложении. Сделайте это там: следующая проверка попробует снова.",
  authentication_step_unsupported:
    "SprutHub просит при входе шаг, которого инструмент не умеет. Войдите в официальном приложении и завершите его там: следующая проверка попробует снова.",
};
const LOGIN_ADVICE_BY_STATUS = {
  ACCOUNT_RESPONSE_NO_MORE_TRIES:
    "Хаб временно заблокировал вход после частых попыток. Подождите и проверьте пароль: следующая проверка попробует снова.",
  ACCOUNT_RESPONSE_NOT_CONFIRMED:
    "Хаб просит подтвердить аккаунт. Подтвердите его так, как просит SprutHub, например по письму.",
  ACCOUNT_RESPONSE_NOT_CONNECTED: `SprutHub сообщает, что аккаунт не подключён к хабу. Проверьте в приложении SprutHub, что у аккаунта из ${CONNECTION_FILE} есть доступ к хабу: следующая проверка попробует снова.`,
  ACCOUNT_RESPONSE_FORMAT: `SprutHub не принял формат логина. Исправьте логин в ${CONNECTION_FILE}: следующая проверка войдёт сама.`,
};

function problemNotice(result) {
  switch (result.outcome) {
    case "login_refused":
      return {
        title: "sprut-agent: нет входа в дом",
        text:
          LOGIN_ADVICE_BY_CODE[result.error_code] ??
          LOGIN_ADVICE_BY_STATUS[result.account_status] ??
          `Хаб отклонил логин или пароль. Исправьте их в ${CONNECTION_FILE}: следующая проверка войдёт сама.`,
      };
    case "login_not_configured":
      return {
        title: "sprut-agent: нет входа в дом",
        text: `Вход в дом не настроен или файл входа недоступен. Проверьте ${CONNECTION_FILE}: логин, пароль и права 600.`,
      };
    case "hub_unreachable":
      // No answer in time looks the same from a hung hub, a broken network and
      // a hung server of this tool.
      if (result.error_code === "timeout") {
        return {
          title: "sprut-agent: проверка не дождалась ответа",
          text: "Ответа не было в отведённое время: завис хаб, сеть или сам инструмент. Проверьте, что хаб включён и в сети, а у этого Mac есть интернет. Если всё так, попросите агента открыть обзор дома: ответ покажет причину.",
        };
      }
      return {
        title: "sprut-agent: хаб недоступен",
        text: "Хаб не отвечает. Проверьте, что он включён и в сети, а у этого Mac есть интернет. Следующая проверка завтра.",
      };
    default:
      return {
        title: "sprut-agent: проверка не прошла",
        text: `Инструмент не смог прочитать дом, код ошибки ${result.error_code}. Попросите агента открыть обзор дома: ответ покажет причину.`,
      };
  }
}

function firmwareNotice({ firmware_revision: revision, verified_revision }) {
  return {
    title: "sprut-agent: другая прошивка хаба",
    text: `На хабе ${revision ? `ревизия ${revision}` : "ревизия необычного вида"}, инструмент проверен на ${verified_revision}. Чтение дома работает, запись эта проверка не пробовала, возможны отличия. Проверить на этой прошивке можно через npm run conformance:live: прогон пишет в дом, создаёт и удаляет временные комнаты, сценарии и устройство, см. DEVELOPMENT.md.`,
  };
}

// The text travels as arguments of the script, never as its source, so nothing
// in it can become AppleScript. No shell is involved either.
async function notify({ title, text }) {
  try {
    await run(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 1 of argv) with title (item 2 of argv)",
        "-e",
        "end run",
        "--",
        text,
        title,
      ],
      {
        timeout: Math.min(
          NOTIFY_LIMIT_MS,
          limit("SPRUT_AGENT_NIGHTLY_TIMEOUT_MS", NOTIFY_LIMIT_MS),
        ),
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function readPrevious(file) {
  try {
    const previous = JSON.parse(await readFile(file, "utf8"));
    return previous !== null && typeof previous === "object" ? previous : {};
  } catch {
    return {};
  }
}

async function saveSummary(file, summary) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const draft = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(draft, `${JSON.stringify(summary, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(draft, file);
  } catch (error) {
    await rm(draft, { force: true }).catch(() => {});
    throw error;
  }
}

async function runCheck() {
  const file = path.join(
    stateDirectory(process.env.SPRUT_AGENT_STATE_DIR),
    SUMMARY_FILE,
  );
  const previous = await readPrevious(file);
  const startedAt = Date.now();
  const result = await check();
  const failed = result.outcome !== "ok";

  // What is still owed to the owner. An announcement counts only once
  // delivered, so a failing osascript leaves it for the next run.
  const summary = {
    version: 1,
    checked_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    ...result,
    recovery_owed: failed || previous.recovery_owed === true,
    firmware_notified_revision:
      result.firmware_check === "matches"
        ? null
        : (previous.firmware_notified_revision ?? null),
    notifications: [],
  };

  const due = [];
  if (failed) {
    due.push({ kind: result.outcome, notice: problemNotice(result) });
  } else if (summary.recovery_owed) {
    due.push({
      kind: "recovered",
      notice: {
        title: "sprut-agent: снова работает",
        text: "Вход и чтение дома снова в порядке. Ничего делать не нужно.",
      },
    });
  }
  // A revision that fails its form is never repeated: it counts as one value.
  const firmwareKey = result.firmware_revision ?? "unusual";
  if (
    result.firmware_check === "differs" &&
    summary.firmware_notified_revision !== firmwareKey
  ) {
    due.push({ kind: "firmware_differs", notice: firmwareNotice(result) });
  }

  // Saved first: a notification that goes wrong cannot lose the result.
  let saved = await saveSummary(file, summary).then(
    () => true,
    () => false,
  );
  for (const { kind, notice } of due) {
    const delivered = await notify(notice);
    summary.notifications.push({ kind, delivered });
    if (!delivered) continue;
    if (kind === "recovered") summary.recovery_owed = false;
    if (kind === "firmware_differs") {
      summary.firmware_notified_revision = firmwareKey;
    }
  }
  if (due.length > 0) {
    saved = await saveSummary(file, summary).then(
      () => saved,
      () => false,
    );
  }

  const line = saved ? summary : { ...summary, summary_saved: false };
  await new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(line)}\n`, resolve);
  });
  process.exit(failed || !saved ? 1 : 0);
}

const launchAgentFile = () =>
  path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

// launchd's PATH is short, so the job names node by an absolute path. A name
// on PATH that leads to this node outlives upgrades; execPath may be a
// versioned directory (Homebrew's Cellar) that the next upgrade removes.
async function stableNodePath() {
  const current = await realpath(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "node");
    const target = await realpath(candidate).catch(() => null);
    if (target === current) return candidate;
  }
  return process.execPath;
}

const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function plist(node, log) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(SCRIPT)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${SCHEDULE.Hour}</integer>
    <key>Minute</key>
    <integer>${SCHEDULE.Minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

const launchDomain = () => `gui/${process.getuid()}`;

// A job that is not loaded answers with an error; that is what bootout wants.
const bootOut = () =>
  run("launchctl", ["bootout", `${launchDomain()}/${LABEL}`]).catch(() => {});

async function install() {
  const file = launchAgentFile();
  const log = path.join(
    homedir(),
    "Library",
    "Logs",
    "sprut-agent",
    "nightly-check.log",
  );
  await mkdir(path.dirname(log), { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, plist(await stableNodePath(), log));
  await bootOut();
  await run("launchctl", ["bootstrap", launchDomain(), file]);
  console.log(`Installed ${file}. Runs daily, output in ${log}.`);
}

async function uninstall() {
  const file = launchAgentFile();
  await bootOut();
  await rm(file, { force: true });
  console.log(`Removed ${file}.`);
}

const command = process.argv[2];
if (command === undefined) {
  await runCheck();
} else if (command === "install" || command === "uninstall") {
  if (process.platform !== "darwin") {
    console.error("The schedule uses launchd, which only macOS has.");
    process.exit(64);
  }
  await (command === "install" ? install() : uninstall());
} else {
  console.error("Usage: node scripts/nightly-check.mjs [install|uninstall]");
  process.exit(64);
}
