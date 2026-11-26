import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

export const DEFAULT_CODEX_MODEL = "gpt-6.2-sol";
export const DEFAULT_CODEX_EFFORT = "medium";
export const DEFAULT_CODEX_SERVICE_TIER = "priority";
export const DEFAULT_CODEX_BIN = "codex";
export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";
export const DEFAULT_TURN_TIMEOUT_MS = 180_000;

const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const POSITIVE_INT_PATTERN = /^[1-9]\d*$/;
const GENERIC_BOT_URL_TOKEN_RE = /bot\d{5,}:[A-Za-z0-9_-]{20,}/gi;
const GENERIC_BARE_TOKEN_RE = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

const CONFIG_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_CODEX_MODEL",
  "TELEGRAM_CODEX_EFFORT",
  "TELEGRAM_CODEX_SERVICE_TIER",
  "TELEGRAM_CODEX_BIN",
  "TELEGRAM_API_BASE",
  "TELEGRAM_STATE_DIR",
  "SPRUT_TELEGRAM_CODEX_AUTH_PATH",
  "TELEGRAM_TURN_TIMEOUT_MS",
];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function resolveHomeDir(env = process.env) {
  return isBlank(env.HOME) ? homedir() : path.resolve(String(env.HOME));
}

function resolveConfigRoot(env = process.env) {
  if (!isBlank(env.XDG_CONFIG_HOME)) {
    return path.resolve(String(env.XDG_CONFIG_HOME).trim());
  }
  return path.join(resolveHomeDir(env), ".config");
}

function resolveDefaultSprutStateDir(env = process.env) {
  if (!isBlank(env.SPRUT_AGENT_STATE_DIR)) {
    return path.resolve(String(env.SPRUT_AGENT_STATE_DIR).trim());
  }
  if (process.platform === "darwin") {
    return path.join(
      resolveHomeDir(env),
      "Library",
      "Application Support",
      "sprut-agent",
    );
  }
  const xdgStateHome = env.XDG_STATE_HOME;
  return path.join(
    isBlank(xdgStateHome)
      ? path.join(resolveHomeDir(env), ".local", "state")
      : path.resolve(String(xdgStateHome).trim()),
    "sprut-agent",
  );
}

export function resolveTelegramEnvPath(env = process.env) {
  if (!isBlank(env.SPRUT_TELEGRAM_ENV)) {
    return path.resolve(String(env.SPRUT_TELEGRAM_ENV).trim());
  }
  return path.join(resolveConfigRoot(env), "sprut-agent", "telegram.env");
}

export function resolveTelegramStateDir(env = process.env, configuredStateDir) {
  if (!isBlank(configuredStateDir)) {
    return path.resolve(String(configuredStateDir).trim());
  }
  return path.join(resolveDefaultSprutStateDir(env), "telegram");
}

export function redactTelegramSecrets(text, token = "") {
  let scrubbed = String(text ?? "");
  if (typeof token === "string" && token.length > 0) {
    scrubbed = scrubbed.replaceAll(`bot${token}`, "bot[REDACTED]");
    scrubbed = scrubbed.replaceAll(token, "[REDACTED]");
    const encoded = encodeURIComponent(token);
    if (encoded !== token) {
      scrubbed = scrubbed.replaceAll(encoded, "[REDACTED]");
    }
  }
  scrubbed = scrubbed.replace(GENERIC_BOT_URL_TOKEN_RE, "bot[REDACTED]");
  scrubbed = scrubbed.replace(GENERIC_BARE_TOKEN_RE, "[REDACTED]");
  return scrubbed;
}

export function parseAllowedUserIds(raw) {
  if (isBlank(raw)) return [];
  const seen = new Set();
  const ids = [];
  for (const part of String(raw).split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (!POSITIVE_INT_PATTERN.test(trimmed)) {
      throw new Error(
        "Invalid TELEGRAM_ALLOWED_USER_IDS: expected comma-separated positive integer Telegram user IDs",
      );
    }
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        "Invalid TELEGRAM_ALLOWED_USER_IDS: user ID is out of safe integer range",
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export async function atomicWriteFile(
  filePath,
  content,
  { mode = 0o600, dirMode = 0o700 } = {},
) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: dirMode });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, content, { mode });
    await chmod(tmpPath, mode);
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function loadTelegramConfig({ env = process.env, envPath } = {}) {
  const resolvedEnvPath = envPath
    ? path.resolve(envPath)
    : resolveTelegramEnvPath(env);

  let fileValues = {};
  try {
    const raw = await readFile(resolvedEnvPath, "utf8");
    fileValues = parseEnv(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(
        `Could not read Telegram config file ${resolvedEnvPath}: ${error?.code ?? error?.message ?? "read error"}`,
      );
    }
  }

  const merged = {};
  for (const key of CONFIG_KEYS) {
    if (!isBlank(env[key])) {
      merged[key] = String(env[key]).trim();
    } else if (!isBlank(fileValues[key])) {
      merged[key] = String(fileValues[key]).trim();
    }
  }

  const token = merged.TELEGRAM_BOT_TOKEN ?? "";
  if (token.length === 0) {
    throw new Error(
      `TELEGRAM_BOT_TOKEN is required (configure it in ${resolvedEnvPath} or the environment)`,
    );
  }
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
    throw new Error(
      "Invalid TELEGRAM_BOT_TOKEN format (expected <digits>:<secret> from @BotFather)",
    );
  }

  const allowedUserIds = parseAllowedUserIds(merged.TELEGRAM_ALLOWED_USER_IDS);
  const apiBaseRaw = merged.TELEGRAM_API_BASE || DEFAULT_TELEGRAM_API_BASE;
  let parsedApiBase;
  try {
    parsedApiBase = new URL(apiBaseRaw);
  } catch {
    throw new Error("Invalid TELEGRAM_API_BASE URL");
  }
  if (
    parsedApiBase.protocol !== "http:" &&
    parsedApiBase.protocol !== "https:"
  ) {
    throw new Error("TELEGRAM_API_BASE must use http:// or https://");
  }
  const apiBase = apiBaseRaw.replace(/\/+$/, "");

  let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS;
  if (merged.TELEGRAM_TURN_TIMEOUT_MS !== undefined) {
    if (!POSITIVE_INT_PATTERN.test(merged.TELEGRAM_TURN_TIMEOUT_MS)) {
      throw new Error("TELEGRAM_TURN_TIMEOUT_MS must be a positive integer");
    }
    turnTimeoutMs = Number(merged.TELEGRAM_TURN_TIMEOUT_MS);
  }

  const stateDir = resolveTelegramStateDir(env, merged.TELEGRAM_STATE_DIR);
  const codexAuthPath = !isBlank(merged.SPRUT_TELEGRAM_CODEX_AUTH_PATH)
    ? path.resolve(merged.SPRUT_TELEGRAM_CODEX_AUTH_PATH)
    : path.join(resolveHomeDir(env), ".codex", "auth.json");

  return {
    envPath: resolvedEnvPath,
    token,
    allowedUserIds,
    codexModel: merged.TELEGRAM_CODEX_MODEL || DEFAULT_CODEX_MODEL,
    codexEffort: merged.TELEGRAM_CODEX_EFFORT || DEFAULT_CODEX_EFFORT,
    codexServiceTier:
      merged.TELEGRAM_CODEX_SERVICE_TIER || DEFAULT_CODEX_SERVICE_TIER,
    codexBin: merged.TELEGRAM_CODEX_BIN || DEFAULT_CODEX_BIN,
    apiBase,
    stateDir,
    codexAuthPath,
    turnTimeoutMs,
  };
}

export async function saveAllowedUserIds(envPath, token, userIds) {
  const deduped = parseAllowedUserIds(
    Array.isArray(userIds) ? userIds.join(",") : String(userIds ?? ""),
  );

  let existingText = "";
  try {
    existingText = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(
        `Could not read ${envPath} before updating allowlist: ${error?.code ?? "read error"}`,
      );
    }
  }

  const lines =
    existingText.length > 0
      ? existingText.replace(/\r?\n$/, "").split(/\r?\n/)
      : [];
  const allowedRe = /^\s*(?:export\s+)?TELEGRAM_ALLOWED_USER_IDS\s*=/;
  const tokenRe = /^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=/;

  let wroteAllowed = false;
  let hasToken = false;
  const nextLines = [];

  for (const line of lines) {
    if (tokenRe.test(line)) {
      hasToken = true;
      nextLines.push(line);
      continue;
    }
    if (allowedRe.test(line)) {
      if (!wroteAllowed) {
        nextLines.push(`TELEGRAM_ALLOWED_USER_IDS=${deduped.join(",")}`);
        wroteAllowed = true;
      }
      continue;
    }
    nextLines.push(line);
  }

  if (!hasToken && !isBlank(token)) {
    nextLines.push(`TELEGRAM_BOT_TOKEN=${String(token).trim()}`);
  }
  if (!wroteAllowed) {
    nextLines.push(`TELEGRAM_ALLOWED_USER_IDS=${deduped.join(",")}`);
  }

  await atomicWriteFile(envPath, `${nextLines.join("\n")}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  return deduped;
}
