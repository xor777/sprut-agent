import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, redactTelegramSecrets } from "./config.mjs";
import { TELEGRAM_DEVELOPER_INSTRUCTIONS } from "./persona.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SPRUT_AGENT_MCP_SERVER = "sprut-agent";
const TELEGRAM_APPROVAL_POLICY = Object.freeze({
  granular: Object.freeze({
    mcp_elicitations: true,
    request_permissions: false,
    rules: false,
    sandbox_approval: false,
    skill_approval: false,
  }),
});
const V2_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const LEGACY_V1_APPROVAL_METHODS = new Set([
  "execCommandApproval",
  "applyPatchApproval",
]);

export class CodexRpcError extends Error {
  constructor(message, { code = null, method = "" } = {}) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.method = method;
  }
}

export class CodexTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexTransportError";
  }
}

export class CodexTurnTimeoutError extends Error {
  constructor(message = "Codex turn timed out") {
    super(message);
    this.name = "CodexTurnTimeoutError";
  }
}

export class CodexTurnError extends Error {
  constructor(message, { status = "failed" } = {}) {
    super(message);
    this.name = "CodexTurnError";
    this.status = status;
  }
}

export function selectFinalAgentMessage(messages, deltaFallback = "") {
  const nonEmpty = messages.filter(
    (item) => typeof item?.text === "string" && item.text.trim().length > 0,
  );
  for (let i = nonEmpty.length - 1; i >= 0; i -= 1) {
    if (nonEmpty[i].phase === "final_answer") {
      return nonEmpty[i].text.trim();
    }
  }
  for (let i = nonEmpty.length - 1; i >= 0; i -= 1) {
    if (nonEmpty[i].phase !== "commentary") {
      return nonEmpty[i].text.trim();
    }
  }
  if (nonEmpty.length > 0) {
    return nonEmpty[nonEmpty.length - 1].text.trim();
  }
  return String(deltaFallback ?? "").trim();
}

function readPackageVersion(repoRoot) {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    return typeof pkg?.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function ensureSymlink(linkPath, targetPath) {
  try {
    const info = await lstat(linkPath);
    if (info.isSymbolicLink() && (await readlink(linkPath)) === targetPath) {
      return;
    }
    await unlink(linkPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(targetPath, linkPath);
}

function buildCodexConfigToml({
  model,
  effort,
  serviceTier,
  nodeExecutable,
  mcpServerEntry,
}) {
  return [
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `service_tier = ${JSON.stringify(serviceTier)}`,
    `web_search = ${JSON.stringify("live")}`,
    "",
    "[features]",
    "ultrafast_mode = true",
    "fast_mode = true",
    "apps = false",
    "",
    "[mcp_servers.sprut-agent]",
    `command = ${JSON.stringify(nodeExecutable)}`,
    `args = [${JSON.stringify(mcpServerEntry)}]`,
    "",
  ].join("\n");
}

class CodexAppServerClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #activeTurns = new Map();
  #token;
  #logger;
  #onExit;
  #rl;
  #stderrTail = [];
  closed = false;
  loadedThreads = new Set();

  constructor({ codexBin, cwd, env, token, logger, onExit }) {
    this.#token = token;
    this.#logger = logger;
    this.#onExit = onExit;

    const child = spawn(codexBin, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdin.on("error", () => {
      // Broken pipe errors are surfaced via the child exit/close handlers.
    });

    this.#rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.#rl.on("line", (line) => this.#handleLine(line));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const scrubbed = redactTelegramSecrets(chunk, this.#token).trim();
      if (!scrubbed) return;
      this.#stderrTail.push(scrubbed);
      if (this.#stderrTail.length > 20) this.#stderrTail.shift();
    });

    child.once("error", (error) => {
      this.#handleTermination(
        `codex app-server spawn error: ${error?.code ?? error?.message ?? "unknown"}`,
      );
    });

    child.once("exit", (code, signal) => {
      this.#handleTermination(
        `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
    });
  }

  async initialize({ version }) {
    await this.request("initialize", {
      clientInfo: {
        name: "sprut-telegram-bot",
        version,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
  }

  #write(message) {
    if (this.closed || !this.#child.stdin.writable) {
      throw new CodexTransportError("codex app-server stdin is not writable");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.closed) {
      return Promise.reject(
        new CodexTransportError("codex app-server connection is closed"),
      );
    }
    const id = this.#nextId;
    this.#nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CodexTransportError(
            `codex RPC ${method} timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async runTurn({
    threadId,
    model,
    effort,
    serviceTier,
    input,
    timeoutMs,
    interruptGraceMs = 2000,
    onProgress = null,
  }) {
    let resolveCompletion;
    let rejectCompletion;
    const completionPromise = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Prevent unhandled rejection if the child exits before turn/start resolves.
    completionPromise.catch(() => {});

    const turnCtx = {
      threadId,
      turnId: null,
      ready: false,
      earlyEvents: [],
      messages: [],
      deltaBuffer: "",
      settled: false,
      onProgress: typeof onProgress === "function" ? onProgress : null,
      resolve(outcome) {
        if (this.settled) return;
        this.settled = true;
        resolveCompletion(outcome);
      },
      reject(error) {
        if (this.settled) return;
        this.settled = true;
        rejectCompletion(error);
      },
    };

    // Register before turn/start so fast notifications arriving in the same
    // stdout burst as the RPC reply are buffered until turnId is known.
    this.#activeTurns.set(threadId, turnCtx);

    const startedAt = Date.now();
    const startTimeoutMs = Math.min(30_000, timeoutMs);
    let startResult;
    try {
      startResult = await this.request(
        "turn/start",
        {
          threadId,
          model,
          effort,
          serviceTier,
          input,
        },
        { timeoutMs: startTimeoutMs },
      );
    } catch (error) {
      this.#activeTurns.delete(threadId);
      // Recycle the child on transport errors (such as turn/start timeout) so
      // an uncertain or orphaned turn cannot bleed into the next message.
      if (error instanceof CodexTransportError && !this.closed) {
        await this.close();
      }
      throw error;
    }

    turnCtx.turnId = startResult?.turn?.id ?? startResult?.turnId ?? null;
    turnCtx.ready = true;
    const buffered = turnCtx.earlyEvents;
    turnCtx.earlyEvents = [];
    for (const event of buffered) {
      this.#applyTurnNotification(turnCtx, event.method, event.params);
    }

    let timedOut = false;
    let timeoutTimer;
    const remainingTimeoutMs = Math.max(
      1,
      timeoutMs - (Date.now() - startedAt),
    );
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        reject(
          new CodexTurnTimeoutError(
            `Codex turn timed out after ${timeoutMs} ms`,
          ),
        );
      }, remainingTimeoutMs);
      timeoutTimer.unref?.();
    });

    try {
      const outcome = await Promise.race([completionPromise, timeoutPromise]);
      clearTimeout(timeoutTimer);
      this.#activeTurns.delete(threadId);

      if (outcome.status === "failed") {
        const message =
          outcome.error?.message ?? outcome.message ?? "Codex turn failed";
        throw new CodexTurnError(redactTelegramSecrets(message, this.#token), {
          status: "failed",
        });
      }
      if (outcome.status === "interrupted") {
        throw new CodexTurnTimeoutError("Codex turn was interrupted");
      }
      return selectFinalAgentMessage(turnCtx.messages, turnCtx.deltaBuffer);
    } catch (error) {
      clearTimeout(timeoutTimer);
      if (timedOut) {
        await this.#interruptTurn(
          threadId,
          turnCtx,
          completionPromise,
          interruptGraceMs,
        );
      }
      this.#activeTurns.delete(threadId);
      throw error;
    }
  }

  async #interruptTurn(threadId, turnCtx, completionPromise, interruptGraceMs) {
    if (!this.closed) {
      const params = turnCtx.turnId
        ? { threadId, turnId: turnCtx.turnId }
        : { threadId };
      await this.request("turn/interrupt", params, {
        timeoutMs: interruptGraceMs,
      }).catch(() => {});
    }

    if (!turnCtx.settled && !this.closed) {
      let graceTimer;
      const grace = new Promise((resolve) => {
        graceTimer = setTimeout(resolve, interruptGraceMs);
        graceTimer.unref?.();
      });
      await Promise.race([completionPromise.catch(() => {}), grace]);
      clearTimeout(graceTimer);
    }

    // If the turn refused to stop after interrupt, recycle the child process so
    // the next user message does not collide with a wedged turn.
    if (!turnCtx.settled && !this.closed) {
      await this.close();
    }
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.#logger(
        redactTelegramSecrets(
          `[telegram] ignored non-JSON line from codex app-server`,
          this.#token,
        ),
      );
      return;
    }

    // Server-to-client request: never hang or permit host escalation.
    if (msg.id != null && typeof msg.method === "string") {
      this.#handleServerRequest(msg);
      return;
    }

    // Response to a client JSON-RPC request.
    if (msg.id != null && msg.method === undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new CodexRpcError(
            redactTelegramSecrets(
              msg.error.message ?? `RPC ${pending.method} failed`,
              this.#token,
            ),
            { code: msg.error.code ?? null, method: pending.method },
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server-to-client notification.
    if (typeof msg.method === "string") {
      this.#handleNotification(msg.method, msg.params ?? {});
    }
  }

  #handleServerRequest(msg) {
    try {
      if (msg.method === "mcpServer/elicitation/request") {
        const isSprutToolApproval =
          msg.params?.serverName === SPRUT_AGENT_MCP_SERVER &&
          msg.params?.mode === "form" &&
          msg.params?._meta?.codex_approval_kind === "mcp_tool_call";
        this.#write({
          jsonrpc: "2.0",
          id: msg.id,
          result: isSprutToolApproval
            ? { action: "accept", content: {}, _meta: { persist: "session" } }
            : { action: "decline" },
        });
      } else if (V2_APPROVAL_METHODS.has(msg.method)) {
        this.#write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { decision: "decline" },
        });
      } else if (LEGACY_V1_APPROVAL_METHODS.has(msg.method)) {
        this.#write({
          jsonrpc: "2.0",
          id: msg.id,
          result: { decision: "abort" },
        });
      } else {
        this.#write({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: "Not permitted in Telegram bot mode",
          },
        });
      }
    } catch {
      // Child already closed; termination handler will reject active calls.
    }
  }

  #matchActiveTurn(params) {
    const threadId = params?.threadId ?? params?.turn?.threadId;
    if (threadId && this.#activeTurns.has(threadId)) {
      return this.#activeTurns.get(threadId);
    }
    if (!threadId && this.#activeTurns.size === 1) {
      return this.#activeTurns.values().next().value;
    }
    return null;
  }

  #handleNotification(method, params) {
    const turnCtx = this.#matchActiveTurn(params);
    if (!turnCtx) return;

    if (!turnCtx.ready) {
      turnCtx.earlyEvents.push({ method, params });
      return;
    }

    this.#applyTurnNotification(turnCtx, method, params);
  }

  #applyTurnNotification(turnCtx, method, params) {
    const notifTurnId = params?.turnId ?? params?.turn?.id ?? null;
    if (turnCtx.turnId && notifTurnId && turnCtx.turnId !== notifTurnId) {
      return;
    }

    if (method === "item/completed") {
      const item = params?.item;
      if (
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0
      ) {
        const text = item.text.trim();
        const phase = item.phase ?? null;
        turnCtx.messages.push({ phase, text });
        if (phase === "commentary" && !turnCtx.settled && turnCtx.onProgress) {
          try {
            turnCtx.onProgress(text);
          } catch {
            // Never let progress listener errors break an active Codex turn.
          }
        }
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (typeof params?.delta === "string") {
        turnCtx.deltaBuffer += params.delta;
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = params?.turn ?? {};
      turnCtx.resolve({
        status: turn.status ?? "completed",
        error: turn.error ?? null,
        message: turn.message ?? null,
      });
    }
  }

  #handleTermination(reason) {
    if (this.closed) return;
    this.closed = true;
    this.#rl.close();
    const detail =
      this.#stderrTail.length > 0
        ? `${reason}; stderr: ${this.#stderrTail.slice(-3).join(" | ")}`
        : reason;
    const error = new CodexTransportError(
      redactTelegramSecrets(detail, this.#token),
    );
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const [, turnCtx] of this.#activeTurns) {
      turnCtx.reject(error);
    }
    this.#activeTurns.clear();
    this.#onExit?.(this, error);
  }

  async close() {
    if (this.closed) return;
    const exitPromise = new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        resolve();
        return;
      }
      this.#child.once("exit", resolve);
    });
    this.#handleTermination("codex app-server closed by bot");
    try {
      this.#child.stdin.end();
    } catch {}
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (this.#child.exitCode === null && this.#child.signalCode === null) {
          this.#child.kill("SIGKILL");
        }
      }, 2000);
      killTimer.unref?.();
      await exitPromise;
      clearTimeout(killTimer);
    }
  }
}

export class CodexSessionManager {
  #config;
  #repoRoot;
  #developerInstructions;
  #env;
  #logger;
  #packageVersion;
  #interruptGraceMs;
  #sessions = new Map();
  #chatQueues = new Map();
  #saveQueue = Promise.resolve();
  #client = null;
  #startingClient = null;
  #preparingPromise = null;
  #prepared = false;
  #closed = false;
  #startedAt = Date.now();

  constructor({
    config,
    repoRoot = DEFAULT_REPO_ROOT,
    developerInstructions = TELEGRAM_DEVELOPER_INSTRUCTIONS,
    env = process.env,
    logger = () => {},
    packageVersion = readPackageVersion(repoRoot),
    interruptGraceMs = 2000,
  }) {
    this.#config = config;
    this.#repoRoot = path.resolve(repoRoot);
    this.#developerInstructions = developerInstructions;
    this.#env = env;
    this.#logger = logger;
    this.#packageVersion = packageVersion;
    this.#interruptGraceMs = interruptGraceMs;

    this.stateDir = config.stateDir;
    this.codexHome = path.join(this.stateDir, "codex-home");
    this.workspaceDir = path.join(this.stateDir, "workspace");
    this.sessionsFile = path.join(this.stateDir, "sessions.json");
  }

  async prepareEnvironment() {
    if (this.#prepared) return;
    if (this.#preparingPromise) return this.#preparingPromise;
    const prep = this.#doPrepareEnvironment();
    this.#preparingPromise = prep;
    try {
      await prep;
      this.#prepared = true;
    } finally {
      if (this.#preparingPromise === prep) {
        this.#preparingPromise = null;
      }
    }
  }

  async #doPrepareEnvironment() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
    await chmod(this.codexHome, 0o700);
    await mkdir(path.join(this.codexHome, "skills"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(this.workspaceDir, { recursive: true, mode: 0o700 });
    await chmod(this.workspaceDir, 0o700);
    this.workspaceDir = await realpath(this.workspaceDir);

    await ensureSymlink(
      path.join(this.codexHome, "auth.json"),
      this.#config.codexAuthPath,
    );
    await ensureSymlink(
      path.join(this.codexHome, "skills", "spruthub-master"),
      path.join(this.#repoRoot, "skills", "spruthub-master"),
    );

    const toml = buildCodexConfigToml({
      model: this.#config.codexModel,
      effort: this.#config.codexEffort,
      serviceTier: this.#config.codexServiceTier,
      nodeExecutable: process.execPath,
      mcpServerEntry: path.join(
        this.#repoRoot,
        "dist",
        "plugin",
        "dist",
        "server.mjs",
      ),
    });
    await atomicWriteFile(path.join(this.codexHome, "config.toml"), toml, {
      mode: 0o600,
      dirMode: 0o700,
    });

    await this.#loadSessions();
  }

  async #loadSessions() {
    this.#sessions.clear();
    let raw;
    try {
      raw = await readFile(this.sessionsFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      const chats = parsed?.chats;
      if (chats && typeof chats === "object") {
        for (const [chatId, entry] of Object.entries(chats)) {
          if (
            typeof entry?.threadId === "string" &&
            entry.threadId.length > 0
          ) {
            this.#sessions.set(chatId, {
              threadId: entry.threadId,
              updatedAt:
                typeof entry.updatedAt === "string"
                  ? entry.updatedAt
                  : new Date().toISOString(),
            });
          }
        }
      }
    } catch {
      this.#logger(
        "[telegram] ignored unreadable sessions.json; starting fresh",
      );
    }
  }

  #saveSessions() {
    const run = this.#saveQueue
      .catch(() => {})
      .then(() => {
        const chats = {};
        for (const [chatId, entry] of this.#sessions) {
          chats[chatId] = {
            threadId: entry.threadId,
            updatedAt: entry.updatedAt,
          };
        }
        return atomicWriteFile(
          this.sessionsFile,
          `${JSON.stringify({ version: 1, chats }, null, 2)}\n`,
          { mode: 0o600, dirMode: 0o700 },
        );
      });
    this.#saveQueue = run.catch(() => {});
    return run;
  }

  #buildChildEnv() {
    const childEnv = { ...this.#env, CODEX_HOME: this.codexHome };
    // Never expose Telegram bot credentials to codex app-server or MCP children.
    delete childEnv.TELEGRAM_BOT_TOKEN;
    delete childEnv.TELEGRAM_ALLOWED_USER_IDS;
    delete childEnv.SPRUT_TELEGRAM_ENV;
    return childEnv;
  }

  async #ensureClient() {
    if (this.#closed) {
      throw new CodexTransportError("CodexSessionManager is closed");
    }
    if (!this.#prepared) {
      await this.prepareEnvironment();
    }
    if (this.#client && !this.#client.closed) {
      return this.#client;
    }
    if (this.#startingClient) {
      return this.#startingClient;
    }

    const starting = (async () => {
      const client = new CodexAppServerClient({
        codexBin: this.#config.codexBin,
        cwd: this.workspaceDir,
        env: this.#buildChildEnv(),
        token: this.#config.token,
        logger: this.#logger,
        onExit: (exitedClient, error) => {
          if (this.#client === exitedClient) {
            this.#client = null;
          }
          if (!this.#closed) {
            this.#logger(`[telegram] ${error.message}`);
          }
        },
      });
      try {
        await client.initialize({ version: this.#packageVersion });
        this.#client = client;
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    })();

    this.#startingClient = starting;
    try {
      return await starting;
    } finally {
      if (this.#startingClient === starting) {
        this.#startingClient = null;
      }
    }
  }

  #threadParams() {
    return {
      model: this.#config.codexModel,
      serviceTier: this.#config.codexServiceTier,
      cwd: this.workspaceDir,
      sandbox: "read-only",
      approvalPolicy: TELEGRAM_APPROVAL_POLICY,
      developerInstructions: this.#developerInstructions,
    };
  }

  async #ensureThread(client, chatKey) {
    const existing = this.#sessions.get(chatKey);
    if (existing?.threadId) {
      if (client.loadedThreads.has(existing.threadId)) {
        return existing.threadId;
      }
      try {
        const result = await client.request("thread/resume", {
          threadId: existing.threadId,
          ...this.#threadParams(),
        });
        const resolvedId = result?.thread?.id || existing.threadId;
        client.loadedThreads.add(resolvedId);
        this.#sessions.set(chatKey, {
          threadId: resolvedId,
          updatedAt: new Date().toISOString(),
        });
        await this.#saveSessions();
        return resolvedId;
      } catch (error) {
        if (!(error instanceof CodexRpcError)) {
          throw error;
        }
        this.#logger(
          `[telegram] thread/resume failed for chat ${chatKey}, starting a fresh thread: ${error.message}`,
        );
      }
    }

    const result = await client.request("thread/start", this.#threadParams());
    const threadId = result?.thread?.id ?? result?.threadId ?? result?.id;
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new CodexTurnError("codex thread/start did not return a thread id");
    }
    client.loadedThreads.add(threadId);
    this.#sessions.set(chatKey, {
      threadId,
      updatedAt: new Date().toISOString(),
    });
    await this.#saveSessions();
    return threadId;
  }

  #enqueueChat(chatKey, task) {
    const previous = this.#chatQueues.get(chatKey) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run
      .catch(() => {})
      .finally(() => {
        if (this.#chatQueues.get(chatKey) === tail) {
          this.#chatQueues.delete(chatKey);
        }
      });
    this.#chatQueues.set(chatKey, tail);
    return run;
  }

  sendTurn(chatId, input, { onProgress } = {}) {
    const chatKey = String(chatId);
    return this.#enqueueChat(chatKey, async () => {
      let client = await this.#ensureClient();
      let threadId;
      try {
        threadId = await this.#ensureThread(client, chatKey);
      } catch (error) {
        if (!(error instanceof CodexTransportError) || this.#closed) {
          throw error;
        }
        // App-server died while idle right before thread setup; respawn once.
        client = await this.#ensureClient();
        threadId = await this.#ensureThread(client, chatKey);
      }

      const reply = await client.runTurn({
        threadId,
        model: this.#config.codexModel,
        effort: this.#config.codexEffort,
        serviceTier: this.#config.codexServiceTier,
        input,
        timeoutMs: this.#config.turnTimeoutMs,
        interruptGraceMs: this.#interruptGraceMs,
        onProgress,
      });

      this.#sessions.set(chatKey, {
        threadId,
        updatedAt: new Date().toISOString(),
      });
      await this.#saveSessions();
      return reply;
    });
  }

  resetThread(chatId) {
    const chatKey = String(chatId);
    return this.#enqueueChat(chatKey, async () => {
      if (!this.#prepared) {
        await this.prepareEnvironment();
      }
      const existing = this.#sessions.get(chatKey);
      if (existing?.threadId && this.#client) {
        this.#client.loadedThreads.delete(existing.threadId);
      }
      this.#sessions.delete(chatKey);
      await this.#saveSessions();
    });
  }

  getStatus(chatId) {
    const chatKey = String(chatId);
    const session = this.#sessions.get(chatKey) ?? null;
    return {
      model: this.#config.codexModel,
      effort: this.#config.codexEffort,
      serviceTier: this.#config.codexServiceTier,
      hasActiveSession: Boolean(session?.threadId),
      sessionUpdatedAt: session?.updatedAt ?? null,
      appServerRunning: Boolean(this.#client && !this.#client.closed),
      startedAt: this.#startedAt,
    };
  }

  async close() {
    this.#closed = true;
    const pendingClient = this.#startingClient;
    if (pendingClient) {
      await pendingClient.catch(() => {});
    }
    const client = this.#client;
    this.#client = null;
    if (client) {
      await client.close();
    }
    await this.#saveQueue.catch(() => {});
  }
}
