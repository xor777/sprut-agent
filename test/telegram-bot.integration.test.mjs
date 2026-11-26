import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BOT_ENTRY = path.join(REPO_ROOT, "telegram", "bot.mjs");
const TEST_TOKEN = "123456789:AAA_fake_test_secret_token_9876543210";

async function loadTelegramModules() {
  const [configMod, botMod, sessionMod] = await Promise.all([
    import("../telegram/config.mjs"),
    import("../telegram/bot.mjs"),
    import("../telegram/codex-session.mjs"),
  ]);
  return { ...configMod, ...botMod, ...sessionMod };
}

function makePrivateMessageUpdate(updateId, userId, text, extra = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: "private" },
      from: { id: userId, is_bot: false, first_name: `User${userId}` },
      text,
      ...extra,
    },
  };
}

function makeGroupMessageUpdate(updateId, chatId, userId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "group", title: "Family" },
      from: { id: userId, is_bot: false, first_name: `User${userId}` },
      text,
    },
  };
}

async function waitFor(predicate, { timeoutMs = 6000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for condition`);
}

async function startMockTelegramServer({ token = TEST_TOKEN } = {}) {
  const calls = [];
  const updates = [];
  const files = new Map();
  const methodFaults = new Map();
  let ackedOffset = 0;
  let pendingPolls = [];

  const notifyPolls = () => {
    const waiting = pendingPolls;
    pendingPolls = [];
    for (const wake of waiting) wake();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const filePrefix = `/file/bot${token}/`;
    if (url.pathname.startsWith(filePrefix)) {
      const filePath = url.pathname.slice(filePrefix.length);
      const entry = files.get(filePath);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      if (entry.hangDownload) {
        entry.onDownloadStarted?.();
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          timer.unref?.();
          res.once("close", () => {
            clearTimeout(timer);
            if (!res.writableEnded) {
              entry.onDownloadAborted?.();
            }
            resolve();
          });
        });
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "image/jpeg" });
          res.end(entry.bytes);
        }
        return;
      }
      res.writeHead(200, {
        "Content-Type": entry.contentType ?? "image/jpeg",
        "Content-Length": String(entry.bytes.length),
      });
      res.end(entry.bytes);
      return;
    }

    const apiPrefix = `/bot${token}/`;
    if (!url.pathname.startsWith(apiPrefix)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
      return;
    }

    const method = url.pathname.slice(apiPrefix.length);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : {};
    calls.push({ method, body, at: Date.now() });

    const faultQueue = methodFaults.get(method);
    if (faultQueue && faultQueue.length > 0) {
      const fault = faultQueue.shift();
      res.writeHead(fault.status ?? 500, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          ok: false,
          error_code: fault.status ?? 500,
          description: fault.description ?? "Injected Telegram error",
        }),
      );
      return;
    }

    const sendOk = (result) => {
      if (res.writableEnded) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    };

    if (method === "getMe") {
      sendOk({
        id: 999000,
        is_bot: true,
        first_name: "SprutBot",
        username: "sprut_test_bot",
      });
      return;
    }
    if (method === "deleteWebhook") {
      sendOk(true);
      return;
    }
    if (method === "sendChatAction") {
      sendOk(true);
      return;
    }
    if (method === "sendMessage") {
      const text = String(body.text ?? "");
      if (text.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            description: "Bad Request: message text is empty",
          }),
        );
        return;
      }
      if (text.length > 4096) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            description: "Bad Request: message is too long",
          }),
        );
        return;
      }
      sendOk({
        message_id: calls.length,
        chat: { id: body.chat_id, type: "private" },
        text,
      });
      return;
    }
    if (method === "getFile") {
      const fileEntry = [...files.values()].find(
        (item) => item.fileId === body.file_id,
      );
      if (!fileEntry) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            description: "Bad Request: invalid file_id",
          }),
        );
        return;
      }
      sendOk({
        file_id: fileEntry.fileId,
        file_size: fileEntry.declaredSize ?? fileEntry.bytes.length,
        file_path: fileEntry.filePath,
      });
      return;
    }
    if (method === "getUpdates") {
      const offset = typeof body.offset === "number" ? body.offset : 0;
      if (offset > ackedOffset) ackedOffset = offset;
      const collect = () => updates.filter((item) => item.update_id >= offset);
      let ready = collect();
      if (ready.length === 0 && Number(body.timeout ?? 0) > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.min(Number(body.timeout) * 1000, 120),
          );
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          pendingPolls.push(wake);
          req.once("close", wake);
        });
        ready = collect();
      }
      sendOk(ready);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ok: false, description: `Unknown method ${method}` }),
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    apiBase: `http://127.0.0.1:${port}`,
    calls,
    getAckedOffset: () => ackedOffset,
    pushUpdate(update) {
      updates.push(update);
      notifyPolls();
    },
    addFile({
      fileId,
      filePath,
      bytes,
      contentType = "image/jpeg",
      declaredSize,
      hangDownload = false,
      onDownloadStarted,
      onDownloadAborted,
    }) {
      files.set(filePath, {
        fileId,
        filePath,
        bytes,
        contentType,
        declaredSize,
        hangDownload,
        onDownloadStarted,
        onDownloadAborted,
      });
    },
    failNext(method, fault) {
      if (!methodFaults.has(method)) methodFaults.set(method, []);
      methodFaults.get(method).push(fault);
    },
    sentMessages(chatId = null) {
      return calls
        .filter(
          (call) =>
            call.method === "sendMessage" &&
            (chatId === null || call.body.chat_id === chatId),
        )
        .map((call) => call.body);
    },
    async close() {
      notifyPolls();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function createFakeCodexBin(dir, { traceFile, controlFile }) {
  const scriptPath = path.join(dir, "fake-codex.mjs");
  const script = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const traceFile = ${JSON.stringify(traceFile)};
const controlFile = ${JSON.stringify(controlFile)};

function trace(entry) {
  appendFileSync(traceFile, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + "\\n");
}

function readControl() {
  if (!existsSync(controlFile)) return {};
  try {
    return JSON.parse(readFileSync(controlFile, "utf8"));
  } catch {
    return {};
  }
}

function writeControl(next) {
  writeFileSync(controlFile, JSON.stringify(next));
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

trace({
  event: "spawn",
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME ?? null,
  hasBotTokenInEnv: Boolean(process.env.TELEGRAM_BOT_TOKEN),
});

let threadSeq = 0;
let turnSeq = 0;
let activeTurnByThread = new Map();
const pendingServerResponses = new Map();

function nextThreadId() {
  const ctrl = readControl();
  const next = (ctrl.threadCounter ?? 0) + 1;
  ctrl.threadCounter = next;
  writeControl(ctrl);
  threadSeq = next;
  return "thr_" + next;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  trace({ event: "recv", msg });

  // Response to a server-to-client request
  if (msg.id != null && msg.method === undefined) {
    const resolver = pendingServerResponses.get(msg.id);
    if (resolver) {
      pendingServerResponses.delete(msg.id);
      resolver(msg);
    }
    return;
  }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex/0.170.0" } });
    return;
  }

  if (msg.method === "initialized") {
    return;
  }

  if (msg.method === "thread/start") {
    const id = nextThreadId();
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id } } });
    return;
  }

  if (msg.method === "thread/resume") {
    const ctrl = readControl();
    if (ctrl.failNextResume) {
      ctrl.failNextResume = false;
      writeControl(ctrl);
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32001, message: "Thread not found" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { thread: { id: msg.params.threadId } },
    });
    return;
  }

  if (msg.method === "turn/interrupt") {
    const active = activeTurnByThread.get(msg.params?.threadId);
    send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
    if (active) {
      active.interrupted = true;
      active.onInterrupt?.();
    }
    return;
  }

  if (msg.method === "turn/start") {
    const { threadId, input = [] } = msg.params;
    const turnId = "turn_" + (++turnSeq);
    const overlapping = activeTurnByThread.has(threadId);
    trace({ event: "turn_begin", threadId, turnId, overlapping, input });
    const textItem = input.find((item) => item.type === "text");
    const imageItem = input.find((item) => item.type === "image");
    const prompt = textItem?.text ?? "";
    const state = { turnId, interrupted: false, onInterrupt: null };
    activeTurnByThread.set(threadId, state);

    if (prompt.includes("[HANG_TURN_START]")) {
      // Simulate an unresponsive turn/start RPC: never send a response.
      return;
    }

    if (prompt.includes("[FAST_EARLY_EVENTS]")) {
      // Emit matching turn notifications BEFORE the turn/start JSON-RPC reply.
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: "Быстрый ранний ответ",
          },
        },
      });
      activeTurnByThread.delete(threadId);
      trace({ event: "turn_end", threadId, turnId, status: "completed" });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
      }, 25);
      return;
    }

    if (prompt.includes("[STALE_BEFORE_START_REPLY]")) {
      // Emit a stale turn's notifications BEFORE the new turn/start RPC reply.
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn_stale_999",
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: "Устаревший ответ прошлого хода",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: "turn_stale_999", status: "completed" } },
      });
      setTimeout(() => {
        send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
        setTimeout(() => {
          send({
            jsonrpc: "2.0",
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: {
                type: "agentMessage",
                phase: "final_answer",
                text: "Свежий ответ нового хода",
              },
            },
          });
          activeTurnByThread.delete(threadId);
          trace({ event: "turn_end", threadId, turnId, status: "completed" });
          send({
            jsonrpc: "2.0",
            method: "turn/completed",
            params: { threadId, turn: { id: turnId, status: "completed" } },
          });
        }, 30);
      }, 30);
      return;
    }

    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });

    const finish = (status, extra = {}) => {
      activeTurnByThread.delete(threadId);
      trace({ event: "turn_end", threadId, turnId, status });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status, ...extra } },
      });
    };

    if (prompt.includes("[CRASH]")) {
      setTimeout(() => process.exit(1), 20);
      return;
    }

    if (prompt.includes("[HANG]")) {
      state.onInterrupt = () => finish("interrupted");
      return;
    }

    if (prompt.includes("[ECHO_SECRET]")) {
      const secretToken = prompt.split("SECRET=")[1]?.trim() ?? "";
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text:
              "Конфиг: " +
              secretToken +
              " и ещё bot987654:AnotherLeakedBotSecretToken123456",
          },
        },
      });
      finish("completed");
      return;
    }

    if (prompt.includes("[LEGACY_V1_APPROVAL]")) {
      const req1 = new Promise((resolve) =>
        pendingServerResponses.set("srv-v1-exec", resolve),
      );
      send({
        jsonrpc: "2.0",
        id: "srv-v1-exec",
        method: "execCommandApproval",
        params: { command: "cat ~/.config/sprut-agent/telegram.env" },
      });
      const res1 = await req1;
      const req2 = new Promise((resolve) =>
        pendingServerResponses.set("srv-v1-patch", resolve),
      );
      send({
        jsonrpc: "2.0",
        id: "srv-v1-patch",
        method: "applyPatchApproval",
        params: { patch: "*** Begin Patch" },
      });
      const res2 = await req2;
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text:
              "v1:" +
              (res1.result?.decision ?? "err") +
              "/" +
              (res2.result?.decision ?? "err"),
          },
        },
      });
      finish("completed");
      return;
    }

    if (prompt.includes("[FAIL_WITH_SECRET]")) {
      const secretToken = prompt.split("SECRET=")[1]?.trim() ?? "";
      finish("failed", {
        message: "Upstream error leaking " + secretToken + " and bot999888:SecretLeakTokenValue1234567890",
      });
      return;
    }

    if (prompt.includes("[SERVER_REQUEST]")) {
      const req1 = new Promise((resolve) => pendingServerResponses.set("srv-approval-1", resolve));
      send({
        jsonrpc: "2.0",
        id: "srv-approval-1",
        method: "item/commandExecution/requestApproval",
        params: { command: "rm -rf /" },
      });
      const res1 = await req1;
      const req2 = new Promise((resolve) => pendingServerResponses.set("srv-input-2", resolve));
      send({
        jsonrpc: "2.0",
        id: "srv-input-2",
        method: "item/tool/requestUserInput",
        params: { question: "secret?" },
      });
      const res2 = await req2;
      trace({ event: "server_requests_answered", res1, res2 });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: "Запросы отклонены: " + (res1.result?.decision ?? "err") + "/" + (res2.error?.code ?? "ok"),
          },
        },
      });
      finish("completed");
      return;
    }

    if (prompt.includes("[LONG_REPLY]")) {
      const paragraphs = [];
      for (let i = 1; i <= 45; i += 1) {
        paragraphs.push(
          "Абзац #" + String(i).padStart(2, "0") + ": " + "Датчик температуры в комнате работает стабильно и без сбоев. ".repeat(4),
        );
      }
      const longText = paragraphs.join("\\n\\n");
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", phase: "final_answer", text: longText },
        },
      });
      finish("completed");
      return;
    }

    if (prompt.includes("[SLOW]")) {
      await new Promise((resolve) => setTimeout(resolve, 140));
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: "Готово после паузы: " + prompt,
          },
        },
      });
      finish("completed");
      return;
    }

    if (imageItem) {
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: "Вижу фото (" + imageItem.url.slice(0, 32) + ") и подпись: " + prompt,
          },
        },
      });
      finish("completed");
      return;
    }

    if (prompt.includes("[NO_FINAL_PHASE]")) {
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: "commentary",
            text: "Черновой шаг…",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            phase: null,
            text: "Финальный текст без фазы",
          },
        },
      });
      finish("completed");
      return;
    }

    // Default: emit a commentary preamble first, then final_answer!
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          phase: "commentary",
          text: "Уточняю число комнат…",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: "Ответ[" + threadId + "]: " + prompt,
        },
      },
    });
    finish("completed");
    return;
  }

  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: "Method not found: " + msg.method },
  });
});
`;
  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function readTrace(traceFile) {
  try {
    const raw = await readFile(traceFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function createTestHarness(t, { allowedUserIds = "1001" } = {}) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "sprut-telegram-test-")),
  );
  const stateDir = path.join(root, "state");
  const envFile = path.join(root, "telegram.env");
  const authFile = path.join(root, "fake-codex-auth.json");
  const traceFile = path.join(root, "codex-trace.jsonl");
  const controlFile = path.join(root, "codex-control.json");

  await writeFile(authFile, JSON.stringify({ token: "fake-codex-auth" }), {
    mode: 0o600,
  });
  const codexBin = await createFakeCodexBin(root, { traceFile, controlFile });
  const tg = await startMockTelegramServer({ token: TEST_TOKEN });

  const envLines = [
    "# Sprut Telegram bot config",
    `TELEGRAM_BOT_TOKEN=${TEST_TOKEN}`,
    ...(allowedUserIds !== null
      ? [`TELEGRAM_ALLOWED_USER_IDS=${allowedUserIds}`]
      : []),
    `TELEGRAM_API_BASE=${tg.apiBase}`,
    `TELEGRAM_CODEX_BIN=${codexBin}`,
    `TELEGRAM_STATE_DIR=${stateDir}`,
  ];
  await writeFile(envFile, `${envLines.join("\n")}\n`, { mode: 0o600 });

  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
    await tg.close();
    await rm(root, { recursive: true, force: true });
  });

  const baseEnv = {
    ...process.env,
    SPRUT_TELEGRAM_ENV: envFile,
    SPRUT_TELEGRAM_CODEX_AUTH_PATH: authFile,
  };

  return {
    root,
    stateDir,
    envFile,
    authFile,
    traceFile,
    controlFile,
    codexBin,
    tg,
    baseEnv,
    onCleanup: (fn) => cleanups.push(fn),
    readTrace: () => readTrace(traceFile),
  };
}

function runCli(args, env, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOT_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `CLI timed out after ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("allowlist and chat-type security refuse empty allowlist, ignore outsiders/groups/bots, and support multi-user allowlists", async (t) => {
  const emptyHarness = await createTestHarness(t, { allowedUserIds: "" });
  const cliResult = await runCli([], emptyHarness.baseEnv);
  assert.notEqual(
    cliResult.code,
    0,
    "bot must refuse to start with empty TELEGRAM_ALLOWED_USER_IDS",
  );
  assert.match(
    `${cliResult.stdout}\n${cliResult.stderr}`,
    /telegram:pair/i,
    "startup refusal should point owner to npm run telegram:pair",
  );
  assert.equal(
    `${cliResult.stdout}\n${cliResult.stderr}`.includes(TEST_TOKEN),
    false,
    "startup error must never leak TELEGRAM_BOT_TOKEN",
  );

  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();
  const emptyConfig = await loadTelegramConfig({ env: emptyHarness.baseEnv });
  assert.deepEqual(emptyConfig.allowedUserIds, []);
  const emptyRunner = new TelegramBotRunner({
    config: emptyConfig,
    env: emptyHarness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await assert.rejects(
    () => emptyRunner.start(),
    /telegram:pair/i,
    "TelegramBotRunner.start must refuse empty allowlist",
  );

  // Multi-user allowlist: 1001 and 2002 allowed; 9999, groups, and bots ignored with 0 Codex turns.
  const harness = await createTestHarness(t, { allowedUserIds: "1001, 2002" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });
  assert.deepEqual(config.allowedUserIds, [1001, 2002]);

  const runner = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runner.start();
  harness.onCleanup(() => runner.stop());

  harness.tg.pushUpdate(
    makePrivateMessageUpdate(1, 9999, "Включи свет от чужого"),
  );
  harness.tg.pushUpdate(
    makeGroupMessageUpdate(2, -5001, 1001, "Сообщение в группе"),
  );
  harness.tg.pushUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1001, type: "private" },
      from: { id: 1001, is_bot: true, first_name: "BotUser" },
      text: "Сообщение от бота",
    },
  });

  // Wait for the runner to poll past update_id 3
  await waitFor(() => harness.tg.getAckedOffset() >= 4);
  assert.equal(
    harness.tg.sentMessages().length,
    0,
    "ignored updates must produce no Telegram replies",
  );
  assert.equal(
    (await harness.readTrace()).length,
    0,
    "ignored updates must spawn 0 Codex turns",
  );

  // Both allowed users get independent persistent threads
  harness.tg.pushUpdate(makePrivateMessageUpdate(4, 1001, "Привет от первого"));
  harness.tg.pushUpdate(makePrivateMessageUpdate(5, 2002, "Привет от второго"));

  await waitFor(
    () =>
      harness.tg.sentMessages(1001).length === 1 &&
      harness.tg.sentMessages(2002).length === 1,
  );

  const reply1 = harness.tg.sentMessages(1001)[0].text;
  const reply2 = harness.tg.sentMessages(2002)[0].text;
  assert.match(reply1, /Ответ\[thr_1\]: Привет от первого/);
  assert.match(reply2, /Ответ\[thr_2\]: Привет от второго/);
});

test("persistent session, isolated CODEX_HOME, commentary filtering, restart resume/fallback, and built-in commands", async (t) => {
  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();
  const harness = await createTestHarness(t, { allowedUserIds: "1001" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });

  const runner1 = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runner1.start();
  harness.onCleanup(() => runner1.stop());

  // First user message -> thread/start, commentary filtered out, final_answer returned
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(10, 1001, "Сколько комнат в доме?"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 1);
  assert.equal(
    harness.tg.sentMessages(1001)[0].text,
    "Ответ[thr_1]: Сколько комнат в доме?",
  );
  assert.equal(
    harness.tg.sentMessages(1001)[0].text.includes("Уточняю число комнат"),
    false,
    "commentary preamble must not be sent as final Telegram reply",
  );

  // Verify isolated CODEX_HOME setup
  const codexHome = path.join(harness.stateDir, "codex-home");
  const configToml = await readFile(
    path.join(codexHome, "config.toml"),
    "utf8",
  );
  assert.match(configToml, /model = "gpt-6\.2-sol"/);
  assert.match(configToml, /model_reasoning_effort = "medium"/);
  assert.match(configToml, /service_tier = "priority"/);
  assert.match(configToml, /web_search = "live"/);
  assert.match(configToml, /\[features\][\s\S]*ultrafast_mode = true/);
  assert.match(configToml, /\[features\][\s\S]*apps = false/);
  assert.match(configToml, /\[mcp_servers\.sprut-agent\]/);
  assert.ok(
    configToml.includes(JSON.stringify(process.execPath)),
    "config.toml must reference node executable cleanly",
  );
  assert.ok(
    configToml.includes(
      JSON.stringify(
        path.join(REPO_ROOT, "dist", "plugin", "dist", "server.mjs"),
      ),
    ),
    "config.toml must reference dist/plugin/dist/server.mjs",
  );

  const authLink = await lstat(path.join(codexHome, "auth.json"));
  assert.equal(authLink.isSymbolicLink(), true, "auth.json must be a symlink");
  assert.equal(
    await readlink(path.join(codexHome, "auth.json")),
    harness.authFile,
  );

  const skillLink = await lstat(
    path.join(codexHome, "skills", "spruthub-master"),
  );
  assert.equal(
    skillLink.isSymbolicLink(),
    true,
    "skills/spruthub-master must be a symlink",
  );
  assert.equal(
    await readlink(path.join(codexHome, "skills", "spruthub-master")),
    path.join(REPO_ROOT, "skills", "spruthub-master"),
  );

  // Verify thread/start parameters and child env isolation
  let trace = await harness.readTrace();
  const spawnEvent = trace.find((e) => e.event === "spawn");
  assert.equal(spawnEvent.codexHome, codexHome);
  assert.equal(spawnEvent.cwd, path.join(harness.stateDir, "workspace"));
  assert.equal(
    spawnEvent.hasBotTokenInEnv,
    false,
    "codex app-server child process must not inherit TELEGRAM_BOT_TOKEN",
  );

  const threadStartReq = trace.find(
    (e) => e.event === "recv" && e.msg.method === "thread/start",
  );
  assert.ok(threadStartReq, "first message must call thread/start");
  assert.equal(threadStartReq.msg.params.model, "gpt-6.2-sol");
  assert.equal(threadStartReq.msg.params.serviceTier, "priority");
  assert.equal(threadStartReq.msg.params.sandbox, "read-only");
  assert.equal(threadStartReq.msg.params.approvalPolicy, "never");
  assert.equal(
    threadStartReq.msg.params.cwd,
    path.join(harness.stateDir, "workspace"),
  );
  assert.match(
    threadStartReq.msg.params.developerInstructions,
    /Полосатый Кот|дом/i,
  );

  const turnStartReq = trace.find(
    (e) => e.event === "recv" && e.msg.method === "turn/start",
  );
  assert.equal(turnStartReq.msg.params.model, "gpt-6.2-sol");
  assert.equal(turnStartReq.msg.params.effort, "medium");
  assert.equal(turnStartReq.msg.params.serviceTier, "priority");

  // Second message reuses the exact same threadId (no second thread/start)
  // and verifies fallback to non-commentary message when phase === null.
  harness.tg.pushUpdate(makePrivateMessageUpdate(11, 1001, "[NO_FINAL_PHASE]"));
  await waitFor(() => harness.tg.sentMessages(1001).length === 2);
  assert.equal(
    harness.tg.sentMessages(1001)[1].text,
    "Финальный текст без фазы",
  );
  const threadStartsAfterSecond = (await harness.readTrace()).filter(
    (e) => e.event === "recv" && e.msg.method === "thread/start",
  ).length;
  assert.equal(
    threadStartsAfterSecond,
    1,
    "second message in same chat must reuse threadId without another thread/start",
  );

  // /start and /status must not call Codex and must not reset the session
  const turnsBeforeCommands = (await harness.readTrace()).filter(
    (e) => e.event === "recv" && e.msg.method === "turn/start",
  ).length;
  harness.tg.pushUpdate(makePrivateMessageUpdate(12, 1001, "/start"));
  harness.tg.pushUpdate(makePrivateMessageUpdate(13, 1001, "/status"));
  await waitFor(() => harness.tg.sentMessages(1001).length === 4);

  const startReply = harness.tg.sentMessages(1001)[2].text;
  const statusReply = harness.tg.sentMessages(1001)[3].text;
  assert.ok(startReply.length > 0, "/start should send a greeting");
  assert.match(statusReply, /gpt-6\.2-sol/);
  assert.match(statusReply, /medium/);
  assert.match(statusReply, /priority/);
  assert.equal(
    statusReply.includes(TEST_TOKEN),
    false,
    "/status must never include secrets",
  );

  const turnsAfterCommands = (await harness.readTrace()).filter(
    (e) => e.event === "recv" && e.msg.method === "turn/start",
  ).length;
  assert.equal(
    turnsAfterCommands,
    turnsBeforeCommands,
    "/start and /status must start 0 Codex turns",
  );

  await runner1.stop();

  // Verify sessions.json mode is 0600
  const sessionsStat = await stat(path.join(harness.stateDir, "sessions.json"));
  assert.equal(
    sessionsStat.mode & 0o777,
    0o600,
    "sessions.json must have 0600 permissions",
  );

  // Simulated restart #1: must call thread/resume with persisted thr_1
  const runner2 = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runner2.start();
  harness.onCleanup(() => runner2.stop());
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(14, 1001, "Продолжаем после рестарта"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 5);
  assert.equal(
    harness.tg.sentMessages(1001)[4].text,
    "Ответ[thr_1]: Продолжаем после рестарта",
  );

  trace = await harness.readTrace();
  const resumeReqs = trace.filter(
    (e) => e.event === "recv" && e.msg.method === "thread/resume",
  );
  assert.equal(resumeReqs.length, 1);
  assert.equal(resumeReqs[0].msg.params.threadId, "thr_1");
  await runner2.stop();

  // Simulated restart #2: thread/resume fails (deleted/corrupt thread) -> falls back to thread/start
  const ctrl = JSON.parse(await readFile(harness.controlFile, "utf8"));
  ctrl.failNextResume = true;
  await writeFile(harness.controlFile, JSON.stringify(ctrl));

  const runner3 = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runner3.start();
  harness.onCleanup(() => runner3.stop());

  harness.tg.pushUpdate(makePrivateMessageUpdate(15, 1001, "Если тред пропал"));
  await waitFor(() => harness.tg.sentMessages(1001).length === 6);
  assert.equal(
    harness.tg.sentMessages(1001)[5].text,
    "Ответ[thr_2]: Если тред пропал",
  );

  // /new resets thread so next message allocates thr_3
  harness.tg.pushUpdate(makePrivateMessageUpdate(16, 1001, "/new"));
  await waitFor(() => harness.tg.sentMessages(1001).length === 7);
  harness.tg.pushUpdate(makePrivateMessageUpdate(17, 1001, "Новый разговор"));
  await waitFor(() => harness.tg.sentMessages(1001).length === 8);
  assert.equal(
    harness.tg.sentMessages(1001)[7].text,
    "Ответ[thr_3]: Новый разговор",
  );
});

test("concurrency serialization, long message split, photos, ServerRequest refusal, offset persistence, crash recovery, timeout, and secret redaction", async (t) => {
  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();
  const harness = await createTestHarness(t, { allowedUserIds: "1001" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });

  const logs = [];
  const runner = new TelegramBotRunner({
    config: { ...config, turnTimeoutMs: 350 },
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    typingIntervalMs: 50,
    interruptGraceMs: 300,
    logger: (line) => logs.push(String(line)),
  });
  await runner.start();
  harness.onCleanup(() => runner.stop());

  // 1. Two rapid messages serialize sequentially without interleaving + typing indicator fires
  harness.tg.pushUpdate(makePrivateMessageUpdate(20, 1001, "[SLOW] Первое"));
  harness.tg.pushUpdate(makePrivateMessageUpdate(21, 1001, "[SLOW] Второе"));
  await waitFor(() => harness.tg.sentMessages(1001).length === 2);

  assert.equal(
    harness.tg.sentMessages(1001)[0].text,
    "Готово после паузы: [SLOW] Первое",
  );
  assert.equal(
    harness.tg.sentMessages(1001)[1].text,
    "Готово после паузы: [SLOW] Второе",
  );

  const traceAfterSlow = await harness.readTrace();
  const overlappingTurns = traceAfterSlow.filter(
    (e) => e.event === "turn_begin" && e.overlapping,
  );
  assert.equal(
    overlappingTurns.length,
    0,
    "rapid messages in the same chat must never overlap",
  );
  const typingCalls = harness.tg.calls.filter(
    (c) => c.method === "sendChatAction" && c.body.action === "typing",
  );
  assert.ok(
    typingCalls.length >= 2,
    "bot should keep sendChatAction(typing) alive during turns",
  );

  // 2. > 4096-char reply splits cleanly into multiple messages with all content preserved
  const countBeforeLong = harness.tg.sentMessages(1001).length;
  harness.tg.pushUpdate(makePrivateMessageUpdate(22, 1001, "[LONG_REPLY]"));
  await waitFor(() => {
    const msgs = harness.tg.sentMessages(1001).slice(countBeforeLong);
    return msgs.some((m) => m.text.includes("Абзац #45"));
  });
  const longChunks = harness.tg.sentMessages(1001).slice(countBeforeLong);
  assert.ok(
    longChunks.length >= 2,
    "reply > 4096 chars must split into multiple messages",
  );
  for (const chunk of longChunks) {
    assert.ok(chunk.text.length > 0 && chunk.text.length <= 4096);
  }
  const combinedLong = longChunks.map((c) => c.text).join("\n\n");
  assert.ok(combinedLong.includes("Абзац #01:"), "first paragraph preserved");
  assert.ok(combinedLong.includes("Абзац #45:"), "last paragraph preserved");

  // 3. Photo message downloads via getFile (choosing <= 5 MB photo) and sends image data URL + caption
  const jpegBytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  ]);
  harness.tg.addFile({
    fileId: "photo_ok_id",
    filePath: "photos/lamp.jpg",
    bytes: jpegBytes,
  });
  const countBeforePhoto = harness.tg.sentMessages(1001).length;
  harness.tg.pushUpdate({
    update_id: 23,
    message: {
      message_id: 23,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1001, type: "private" },
      from: { id: 1001, is_bot: false, first_name: "Owner" },
      caption: "Что это за датчик?",
      photo: [
        { file_id: "photo_small_id", width: 90, height: 90, file_size: 1000 },
        {
          file_id: "photo_ok_id",
          width: 800,
          height: 600,
          file_size: jpegBytes.length,
        },
        {
          file_id: "photo_huge_id",
          width: 4000,
          height: 3000,
          file_size: 8 * 1024 * 1024,
        },
      ],
    },
  });
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforePhoto + 1,
  );
  const photoReply = harness.tg.sentMessages(1001)[countBeforePhoto].text;
  const expectedPrefix =
    `data:image/jpeg;base64,${jpegBytes.toString("base64")}`.slice(0, 32);
  assert.ok(
    photoReply.includes(expectedPrefix),
    `photo data URL expected in turn/start, got: ${photoReply}`,
  );
  assert.ok(photoReply.includes("Что это за датчик?"));

  // 4. Unexpected ServerRequest receives immediate decline/refusal without hanging
  const countBeforeSrvReq = harness.tg.sentMessages(1001).length;
  harness.tg.pushUpdate(makePrivateMessageUpdate(24, 1001, "[SERVER_REQUEST]"));
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforeSrvReq + 1,
  );
  assert.equal(
    harness.tg.sentMessages(1001)[countBeforeSrvReq].text,
    "Запросы отклонены: decline/-32000",
  );

  // 5. Turn failure with secret in error + Telegram API error with secret NEVER leak token
  harness.tg.failNext("sendChatAction", {
    status: 502,
    description: `Bad Gateway for /bot${TEST_TOKEN}/sendChatAction`,
  });
  const countBeforeFail = harness.tg.sentMessages(1001).length;
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(
      25,
      1001,
      `[FAIL_WITH_SECRET] SECRET=${TEST_TOKEN}`,
    ),
  );
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforeFail + 1,
  );
  const failReply = harness.tg.sentMessages(1001)[countBeforeFail].text;
  assert.equal(
    failReply.includes(TEST_TOKEN),
    false,
    "error reply must never leak bot token",
  );
  assert.equal(
    failReply.includes("SecretLeakTokenValue"),
    false,
    "error reply must scrub any bot token",
  );

  // 6. Turn timeout sends turn/interrupt and replies honestly, bot stays alive
  const countBeforeHang = harness.tg.sentMessages(1001).length;
  harness.tg.pushUpdate(makePrivateMessageUpdate(26, 1001, "[HANG]"));
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforeHang + 1,
  );
  const traceAfterHang = await harness.readTrace();
  assert.ok(
    traceAfterHang.some(
      (e) => e.event === "recv" && e.msg.method === "turn/interrupt",
    ),
    "timeout must send turn/interrupt to codex app-server",
  );

  // 7. Unexpected codex app-server crash mid-turn -> error reply, next message respawns + thread/resume
  const countBeforeCrash = harness.tg.sentMessages(1001).length;
  harness.tg.pushUpdate(makePrivateMessageUpdate(27, 1001, "[CRASH]"));
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforeCrash + 1,
  );

  harness.tg.pushUpdate(
    makePrivateMessageUpdate(28, 1001, "Жив после падения?"),
  );
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforeCrash + 2,
  );
  assert.equal(
    harness.tg.sentMessages(1001)[countBeforeCrash + 1].text,
    "Ответ[thr_1]: Жив после падения?",
    "after app-server crash, next message must respawn and resume persisted thread",
  );

  // Check logs never leaked the token anywhere
  const allLogs = logs.join("\n");
  assert.equal(
    allLogs.includes(TEST_TOKEN),
    false,
    "logs must never contain TELEGRAM_BOT_TOKEN",
  );
  assert.equal(
    allLogs.includes("SecretLeakTokenValue"),
    false,
    "logs must scrub bot<id>:<secret> patterns",
  );

  await runner.stop();

  // 8. Offset persistence: offset.json has 0600 perms and restarting does not replay update 28
  const offsetPath = path.join(harness.stateDir, "offset.json");
  const offsetStat = await stat(offsetPath);
  assert.equal(
    offsetStat.mode & 0o777,
    0o600,
    "offset.json must have 0600 permissions",
  );
  const savedOffset = JSON.parse(await readFile(offsetPath, "utf8"));
  assert.equal(savedOffset.lastUpdateId, 28);

  const countBeforeRestart = harness.tg.sentMessages(1001).length;
  const runnerAfterRestart = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runnerAfterRestart.start();
  harness.onCleanup(() => runnerAfterRestart.stop());

  // Push update 29; runner must NOT replay 20..28, only handle 29
  harness.tg.pushUpdate(makePrivateMessageUpdate(29, 1001, "Только свежее"));
  await waitFor(
    () => harness.tg.sentMessages(1001).length === countBeforeRestart + 1,
  );
  assert.equal(
    harness.tg.sentMessages(1001)[countBeforeRestart].text,
    "Ответ[thr_1]: Только свежее",
  );
});

test("--pair mode pairs private user, persists 0600 telegram.env without duplicates, and preserves other keys", async (t) => {
  const harness = await createTestHarness(t, { allowedUserIds: "" });
  await writeFile(
    harness.envFile,
    [
      "# Owner custom comment",
      `TELEGRAM_BOT_TOKEN=${TEST_TOKEN}`,
      "TELEGRAM_CODEX_MODEL=gpt-6.2-sol",
      `TELEGRAM_API_BASE=${harness.tg.apiBase}`,
      `TELEGRAM_STATE_DIR=${harness.stateDir}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  // First pairing: group message should be ignored, private message from 424242 pairs
  let pair1Exited = null;
  const pair1Promise = runCli(["--pair"], harness.baseEnv).then((res) => {
    pair1Exited = res;
    return res;
  });
  await waitFor(() => {
    if (pair1Exited) {
      throw new Error(
        `--pair exited early with code ${pair1Exited.code}: ${pair1Exited.stderr}`,
      );
    }
    return harness.tg.calls.some((c) => c.method === "getUpdates");
  });
  harness.tg.pushUpdate(makeGroupMessageUpdate(100, -777, 88888, "Не в личку"));
  harness.tg.pushUpdate(makePrivateMessageUpdate(101, 424242, "/start"));

  const pair1 = await pair1Promise;
  assert.equal(
    pair1.code,
    0,
    `first --pair must exit 0, stderr: ${pair1.stderr}`,
  );
  assert.equal(
    `${pair1.stdout}\n${pair1.stderr}`.includes(TEST_TOKEN),
    false,
    "--pair output must never leak token",
  );
  assert.equal(
    harness.tg.sentMessages(424242).length,
    1,
    "--pair must send confirmation",
  );

  const envStat1 = await stat(harness.envFile);
  assert.equal(envStat1.mode & 0o777, 0o600, "telegram.env must remain 0600");
  const envText1 = await readFile(harness.envFile, "utf8");
  assert.match(envText1, /^# Owner custom comment$/m);
  assert.match(envText1, new RegExp(`^TELEGRAM_BOT_TOKEN=${TEST_TOKEN}$`, "m"));
  assert.match(envText1, /^TELEGRAM_CODEX_MODEL=gpt-6\.2-sol$/m);
  assert.match(envText1, /^TELEGRAM_ALLOWED_USER_IDS=424242$/m);

  // Re-run --pair for same user (must deduplicate)
  const pairDupPromise = runCli(["--pair"], harness.baseEnv);
  await waitFor(() => harness.tg.getAckedOffset() >= 102);
  harness.tg.pushUpdate(makePrivateMessageUpdate(102, 424242, "Ещё раз"));
  const pairDup = await pairDupPromise;
  assert.equal(pairDup.code, 0);
  const envTextDup = await readFile(harness.envFile, "utf8");
  assert.match(envTextDup, /^TELEGRAM_ALLOWED_USER_IDS=424242$/m);

  // Re-run --pair for second user 535353 (must append without losing 424242)
  const pair2Promise = runCli(["--pair"], harness.baseEnv);
  await waitFor(() => harness.tg.getAckedOffset() >= 103);
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(103, 535353, "Второй владелец"),
  );
  const pair2 = await pair2Promise;
  assert.equal(pair2.code, 0);

  const envStat2 = await stat(harness.envFile);
  assert.equal(
    envStat2.mode & 0o777,
    0o600,
    "telegram.env must stay 0600 after second pair",
  );
  const envText2 = await readFile(harness.envFile, "utf8");
  assert.match(envText2, new RegExp(`^TELEGRAM_BOT_TOKEN=${TEST_TOKEN}$`, "m"));
  assert.match(envText2, /^TELEGRAM_ALLOWED_USER_IDS=424242,535353$/m);
});

test("outgoing successful Codex replies scrub TELEGRAM_BOT_TOKEN and bot<id>:<secret> before sending to Telegram", async (t) => {
  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();
  const harness = await createTestHarness(t, { allowedUserIds: "1001" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });

  const runner = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runner.start();
  harness.onCleanup(() => runner.stop());

  harness.tg.pushUpdate(
    makePrivateMessageUpdate(200, 1001, `[ECHO_SECRET] SECRET=${TEST_TOKEN}`),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 1);

  const reply = harness.tg.sentMessages(1001)[0].text;
  assert.equal(
    reply.includes(TEST_TOKEN),
    false,
    "successful Codex reply must scrub exact TELEGRAM_BOT_TOKEN",
  );
  assert.equal(
    reply.includes("AnotherLeakedBotSecretToken123456"),
    false,
    "successful Codex reply must scrub generic bot<id>:<secret> patterns",
  );
  assert.match(reply, /\[REDACTED\]/);
});

test("pre-turnId buffering preserves fast matching turns, blocks stale-turn hijacking, and recycles child on turn/start timeout", async (t) => {
  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();
  const harness = await createTestHarness(t, { allowedUserIds: "1001" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });

  const runner = new TelegramBotRunner({
    config: { ...config, turnTimeoutMs: 250 },
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    interruptGraceMs: 200,
    logger: () => {},
  });
  await runner.start();
  harness.onCleanup(() => runner.stop());

  // 1. Fast matching events arriving before turn/start RPC response must still succeed
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(300, 1001, "[FAST_EARLY_EVENTS]"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 1);
  assert.equal(harness.tg.sentMessages(1001)[0].text, "Быстрый ранний ответ");

  // 2. Stale non-matching events arriving before turn/start RPC response must NOT hijack the turn
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(301, 1001, "[STALE_BEFORE_START_REPLY]"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 2);
  assert.equal(
    harness.tg.sentMessages(1001)[1].text,
    "Свежий ответ нового хода",
    "stale pre-turnId notifications must not hijack the new turn",
  );

  // 3. Hanging turn/start RPC must time out promptly, recycle child process, and resume on next message
  const pidsBefore = (await harness.readTrace())
    .filter((e) => e.event === "spawn")
    .map((e) => e.pid);
  assert.equal(pidsBefore.length, 1);

  harness.tg.pushUpdate(
    makePrivateMessageUpdate(302, 1001, "[HANG_TURN_START]"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 3, {
    timeoutMs: 2500,
  });

  harness.tg.pushUpdate(
    makePrivateMessageUpdate(303, 1001, "После зависания turn/start"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 4, {
    timeoutMs: 3000,
  });
  assert.equal(
    harness.tg.sentMessages(1001)[3].text,
    "Ответ[thr_1]: После зависания turn/start",
  );

  const traceAfter = await harness.readTrace();
  const spawnPids = traceAfter
    .filter((e) => e.event === "spawn")
    .map((e) => e.pid);
  assert.equal(
    spawnPids.length,
    2,
    "turn/start transport timeout must recycle codex app-server child process",
  );
  assert.notEqual(spawnPids[0], spawnPids[1]);
});

test("stop() returns promptly on a wedged turn or photo download without running queued messages or sending shutdown errors", async (t) => {
  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();

  // Case A: wedged turn + queued message
  const harness = await createTestHarness(t, { allowedUserIds: "1001" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });
  const runner = new TelegramBotRunner({
    config: { ...config, turnTimeoutMs: 3500 },
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    interruptGraceMs: 200,
    logger: () => {},
  });
  await runner.start();
  harness.onCleanup(() => runner.stop());

  harness.tg.pushUpdate(makePrivateMessageUpdate(400, 1001, "[HANG]"));
  harness.tg.pushUpdate(
    makePrivateMessageUpdate(401, 1001, "Не должно запускаться после stop"),
  );

  await waitFor(async () =>
    (await harness.readTrace()).some((e) => e.event === "turn_begin"),
  );

  const startedStopAt = Date.now();
  await runner.stop();
  const stopElapsedMs = Date.now() - startedStopAt;

  assert.ok(
    stopElapsedMs < 1500,
    `stop() must return promptly on a wedged turn (took ${stopElapsedMs} ms)`,
  );
  const turnStarts = (await harness.readTrace()).filter(
    (e) => e.event === "recv" && e.msg.method === "turn/start",
  );
  assert.equal(
    turnStarts.length,
    1,
    "queued messages must not start new Codex turns after stop()",
  );
  assert.equal(
    harness.tg.sentMessages(1001).length,
    0,
    "shutdown cancellation must not send error replies to Telegram",
  );

  // Case B: hanging photo download aborts promptly on stop()
  const photoHarness = await createTestHarness(t, { allowedUserIds: "1001" });
  const photoConfig = await loadTelegramConfig({ env: photoHarness.baseEnv });
  let downloadStarted = false;
  let downloadAborted = false;
  photoHarness.tg.addFile({
    fileId: "photo_hang_id",
    filePath: "photos/slow.jpg",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    hangDownload: true,
    onDownloadStarted: () => {
      downloadStarted = true;
    },
    onDownloadAborted: () => {
      downloadAborted = true;
    },
  });

  const photoRunner = new TelegramBotRunner({
    config: photoConfig,
    env: photoHarness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await photoRunner.start();
  photoHarness.onCleanup(() => photoRunner.stop());

  photoHarness.tg.pushUpdate({
    update_id: 410,
    message: {
      message_id: 410,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 1001, type: "private" },
      from: { id: 1001, is_bot: false, first_name: "Owner" },
      caption: "Зависшее фото",
      photo: [
        { file_id: "photo_hang_id", width: 800, height: 600, file_size: 4 },
      ],
    },
  });

  await waitFor(() => downloadStarted);
  const photoStopAt = Date.now();
  await photoRunner.stop();
  const photoStopElapsed = Date.now() - photoStopAt;

  assert.ok(
    photoStopElapsed < 1500,
    `stop() must abort hanging photo downloads promptly (took ${photoStopElapsed} ms)`,
  );
  await waitFor(() => downloadAborted, { timeoutMs: 1000 });
  assert.equal(photoHarness.tg.sentMessages(1001).length, 0);
});

test("concurrent prepareEnvironment() and multi-chat session persistence never race or lose threads", async (t) => {
  const { loadTelegramConfig, CodexSessionManager } =
    await loadTelegramModules();
  const harness = await createTestHarness(t, {
    allowedUserIds: "2001,2002,2003,2004,2005,2006",
  });
  const config = await loadTelegramConfig({ env: harness.baseEnv });

  const manager = new CodexSessionManager({
    config,
    env: harness.baseEnv,
    logger: () => {},
  });
  harness.onCleanup(() => manager.close());

  // Concurrent prepareEnvironment calls on fresh stateDir must not race on ensureSymlink (EEXIST)
  await Promise.all([
    manager.prepareEnvironment(),
    manager.prepareEnvironment(),
    manager.prepareEnvironment(),
    manager.prepareEnvironment(),
  ]);

  // Concurrent multi-chat turns followed by concurrent reset + turns must persist every surviving chat
  const chatIds = [2001, 2002, 2003, 2004, 2005, 2006];
  await Promise.all(
    chatIds.map((chatId) =>
      manager.sendTurn(chatId, [{ type: "text", text: `Чат ${chatId}` }]),
    ),
  );

  // Reset chat 2003 concurrently while other chats run turns
  await Promise.all([
    manager.resetThread(2003),
    manager.sendTurn(2001, [{ type: "text", text: "Второй ход 2001" }]),
    manager.sendTurn(2006, [{ type: "text", text: "Второй ход 2006" }]),
  ]);

  const saved = JSON.parse(
    await readFile(path.join(harness.stateDir, "sessions.json"), "utf8"),
  );
  assert.equal(
    Object.hasOwn(saved.chats, "2003"),
    false,
    "resetThread chat must not be resurrected by concurrent saves",
  );
  for (const chatId of [2001, 2002, 2004, 2005, 2006]) {
    assert.ok(
      typeof saved.chats[String(chatId)]?.threadId === "string" &&
        saved.chats[String(chatId)].threadId.length > 0,
      `chat ${chatId} threadId must be persisted in sessions.json`,
    );
  }
});

test("legacy v1 approval requests receive abort while v2 approvals receive decline", async (t) => {
  const { loadTelegramConfig, TelegramBotRunner } = await loadTelegramModules();
  const harness = await createTestHarness(t, { allowedUserIds: "1001" });
  const config = await loadTelegramConfig({ env: harness.baseEnv });

  const runner = new TelegramBotRunner({
    config,
    env: harness.baseEnv,
    pollTimeoutSec: 1,
    logger: () => {},
  });
  await runner.start();
  harness.onCleanup(() => runner.stop());

  harness.tg.pushUpdate(
    makePrivateMessageUpdate(500, 1001, "[LEGACY_V1_APPROVAL]"),
  );
  await waitFor(() => harness.tg.sentMessages(1001).length === 1);
  assert.equal(
    harness.tg.sentMessages(1001)[0].text,
    "v1:abort/abort",
    "legacy v1 execCommandApproval and applyPatchApproval must reply with decision: abort",
  );
});
