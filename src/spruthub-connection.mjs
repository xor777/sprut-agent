import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { argon2id } from "hash-wasm";
import { WebSocket } from "ws";
import {
  parseSprutHubMessage,
  SprutHubClient,
  SprutHubError,
} from "./spruthub-client.mjs";

export const DEFAULT_SPRUTHUB_URL = "wss://beta.spruthub.ru/spruthub";

const SESSION_VERSION = 1;
const MAX_AUTH_STEPS = 8;
const MAX_ARGON_MEMORY_KIB = 256 * 1024;
const MAX_ARGON_ITERATIONS = 10;
const MAX_ARGON_PARALLELISM = 8;
const CONNECTION_ENV_FIELDS = [
  "SPRUTHUB_LOGIN",
  "SPRUTHUB_PASSWORD",
  "SPRUTHUB_TOKEN",
  "SPRUTHUB_URL",
  "SPRUTHUB_SERIAL",
  "SPRUTHUB_CID",
  "SPRUTHUB_TIMEOUT_MS",
];
const localCredentialConfigurationErrors = new WeakSet();

export function isLocalCredentialConfigurationError(error) {
  return localCredentialConfigurationErrors.has(error);
}

export class SprutHubConnection {
  #clientPromise;
  #env;
  #homeSelectionSource;
  #secrets = new Set();

  constructor({ env = process.env } = {}) {
    this.#env = env;
    this.#homeSelectionSource =
      (Object.hasOwn(env, "SPRUTHUB_SERIAL") &&
        env.SPRUTHUB_SERIAL !== undefined) ||
      hasCompleteExplicitConnection(env)
        ? "environment"
        : "file";
    this.#remember(
      env.SPRUTHUB_LOGIN,
      env.SPRUTHUB_PASSWORD,
      env.SPRUTHUB_TOKEN,
    );
  }

  get secrets() {
    return [...this.#secrets];
  }

  async localHubIdentity() {
    let env = this.#env;
    if (!hasCompleteExplicitConnection(env)) {
      env = await loadCredentialFile(env, credentialSetup(env));
    }
    return {
      url: env.SPRUTHUB_URL ?? DEFAULT_SPRUTHUB_URL,
      serial: hasValue(env.SPRUTHUB_SERIAL) ? env.SPRUTHUB_SERIAL : null,
    };
  }

  homeSelectionSetup() {
    if (this.#homeSelectionSource === "environment") {
      return {
        source: "environment",
        field: "SPRUTHUB_SERIAL",
        restart:
          "Set SPRUTHUB_SERIAL in the same MCP launch environment, then restart the MCP application.",
      };
    }
    const setup = credentialSetup(this.#env);
    return {
      file: setup.file,
      field: "SPRUTHUB_SERIAL",
      permissions: setup.permissions,
      restart: setup.restart,
    };
  }

  getClient() {
    if (!this.#clientPromise) {
      const attempt = this.#createClient();
      this.#clientPromise = attempt;
      void attempt.catch((error) => {
        if (
          this.#clientPromise === attempt &&
          isRetryableConnectionError(error)
        ) {
          this.#clientPromise = undefined;
        }
      });
    }
    return this.#clientPromise;
  }

  async #createClient() {
    const setup = credentialSetup(this.#env);
    if (!hasCompleteExplicitConnection(this.#env)) {
      this.#env = await loadCredentialFile(this.#env, setup);
    }
    this.#remember(
      this.#env.SPRUTHUB_LOGIN,
      this.#env.SPRUTHUB_PASSWORD,
      this.#env.SPRUTHUB_TOKEN,
    );
    const timeoutMs = parseTimeout(this.#env.SPRUTHUB_TIMEOUT_MS);
    if (this.#env.SPRUTHUB_TOKEN) {
      return new SprutHubClient({
        url: this.#env.SPRUTHUB_URL,
        token: this.#env.SPRUTHUB_TOKEN,
        serial: this.#env.SPRUTHUB_SERIAL,
        configuredSerial: this.#env.SPRUTHUB_SERIAL,
        cid: this.#env.SPRUTHUB_CID,
        timeoutMs,
      });
    }

    const login = requiredCredential(
      this.#env.SPRUTHUB_LOGIN,
      "SPRUTHUB_LOGIN",
      setup,
    );
    const password = requiredCredential(
      this.#env.SPRUTHUB_PASSWORD,
      "SPRUTHUB_PASSWORD",
      setup,
    );
    const url = this.#env.SPRUTHUB_URL ?? DEFAULT_SPRUTHUB_URL;
    const sessionFile = resolveSessionFile(this.#env);
    const accountSha256 = createHash("sha256").update(login).digest("hex");
    const saved = await loadSession(sessionFile, { url, accountSha256 });
    if (saved) {
      this.#remember(saved.token);
      const client = new SprutHubClient({
        url,
        token: saved.token,
        serial: null,
        configuredSerial: this.#env.SPRUTHUB_SERIAL,
        cid: saved.cid,
        timeoutMs,
      });
      try {
        const catalog = await client.listHomes();
        client.serial = selectSerial(catalog.homes, this.#env.SPRUTHUB_SERIAL);
        return client;
      } catch (error) {
        await client.close();
        if (
          !(error instanceof SprutHubError) ||
          error.code !== "authentication_failed"
        ) {
          throw error;
        }
      }
    }

    const authenticated = await authenticate({
      url,
      login,
      password,
      timeoutMs,
      remember: (...values) => this.#remember(...values),
    });
    await saveSession(sessionFile, {
      version: SESSION_VERSION,
      url,
      account_sha256: accountSha256,
      token: authenticated.token,
      cid: authenticated.cid,
    });
    const serial = selectSerial(authenticated.homes, this.#env.SPRUTHUB_SERIAL);
    return new SprutHubClient({
      url,
      token: authenticated.token,
      serial,
      configuredSerial: this.#env.SPRUTHUB_SERIAL,
      availableHomeCount: authenticated.homes.length,
      cid: authenticated.cid,
      timeoutMs,
    });
  }

  #remember(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) {
        this.#secrets.add(value);
      }
    }
  }
}

async function authenticate({ url, login, password, timeoutMs, remember }) {
  const deadline = Date.now() + timeoutMs;
  const cid = randomUUID();
  const socket = await connect(url, deadline);
  let nextId = 1;
  const request = (params) =>
    sendRequest(socket, { id: nextId++, cid, params }, deadline);
  const answered = new Set();
  try {
    let response = await request({ account: { auth: { params: [] } } });
    for (let step = 0; step < MAX_AUTH_STEPS; step += 1) {
      const account = extractAccountResponse(response);
      if (typeof account.token === "string" && account.token.length > 0) {
        if (account.status !== "ACCOUNT_RESPONSE_SUCCESS") {
          throw incompatibleAuthResponse();
        }
        remember(account.token);
        const homesResponse = await requestWithSession(
          socket,
          {
            id: nextId++,
            cid,
            token: account.token,
            params: { hub: { list: {} } },
          },
          deadline,
        );
        const homes = homesResponse.result?.hub?.list?.hubs;
        if (!Array.isArray(homes)) throw incompatibleAuthResponse();
        return { cid, token: account.token, homes };
      }
      rejectAccountStatus(account);
      const question = account.question;
      if (!question || typeof question.type !== "string") {
        throw incompatibleAuthResponse();
      }
      const delay = question.delay ?? 0;
      if (!Number.isInteger(delay) || delay < 0) {
        throw incompatibleAuthResponse();
      }
      if (delay > 0) throw authenticationDelayed(delay);
      if (answered.has(question.type)) throw incompatibleAuthResponse();

      let data;
      if (question.type === "QUESTION_TYPE_EMAIL") data = login;
      else if (question.type === "QUESTION_TYPE_PASSWORD") data = password;
      else if (question.type === "QUESTION_TYPE_CHALLENGE") {
        data = await answerChallenge(question.data, password);
      } else {
        throw unsupportedQuestion(question.type);
      }
      answered.add(question.type);
      remember(data);
      response = await request({ account: { answer: { data } } });
    }
    throw new SprutHubError(
      "authentication_steps_exceeded",
      "SprutHub authentication did not finish within the supported step limit.",
      "retry_login",
    );
  } finally {
    closeSocket(socket);
  }
}

function rejectAccountStatus(account) {
  if (account.status === "ACCOUNT_RESPONSE_SUCCESS") return;
  if (account.status === "ACCOUNT_RESPONSE_TOO_FAST") {
    throw authenticationDelayed(account.question?.delay ?? 0);
  }
  if (
    [
      "ACCOUNT_RESPONSE_FAILED",
      "ACCOUNT_RESPONSE_NOT_CONFIRMED",
      "ACCOUNT_RESPONSE_FORMAT",
      "ACCOUNT_RESPONSE_NOT_CONNECTED",
      "ACCOUNT_RESPONSE_NO_MORE_TRIES",
    ].includes(account.status)
  ) {
    throw new SprutHubError(
      "authentication_failed",
      "SprutHub rejected the supplied account credentials.",
      "check_credentials",
      { capability_status: "insufficient_access" },
    );
  }
  throw incompatibleAuthResponse();
}

function unsupportedQuestion(type) {
  if (type === "QUESTION_TYPE_ENROLL") {
    return new SprutHubError(
      "password_enrollment_required",
      "SprutHub requires password enrollment in the official application.",
      "complete_login_in_official_app",
    );
  }
  return new SprutHubError(
    "authentication_step_unsupported",
    "SprutHub requires an authentication step that this client cannot answer safely.",
    "complete_login_in_official_app",
  );
}

function authenticationDelayed(delay) {
  return new SprutHubError(
    "authentication_delayed",
    "SprutHub requires waiting before a new authentication flow.",
    "retry_login_later",
    {
      retry_after_seconds: Number.isInteger(delay) && delay > 0 ? delay : null,
    },
  );
}

async function answerChallenge(data, password) {
  let challenge;
  try {
    challenge = JSON.parse(data);
  } catch {
    throw incompatibleAuthResponse();
  }
  if (!challenge || typeof challenge !== "object") {
    throw incompatibleAuthResponse();
  }
  const salt = decodeBase64(challenge.rootSalt);
  const message = decodeBase64(challenge.challenge);
  const { memorySize, iterations, parallelism } = parseKdfParams(
    challenge.kdfParams,
  );
  if (salt.length === 0 || message.length === 0) {
    throw incompatibleAuthResponse();
  }
  const seed = await argon2id({
    password,
    salt,
    parallelism,
    iterations,
    memorySize,
    hashLength: 32,
    outputType: "binary",
  });
  return Buffer.from(ed25519.sign(message, seed)).toString("base64");
}

function parseKdfParams(value) {
  if (typeof value !== "string") throw incompatibleAuthResponse();
  const entries = value.split(",").map((part) => part.split("="));
  if (
    entries.length !== 3 ||
    entries.some(([key, item, ...extra]) => !key || !item || extra.length > 0)
  ) {
    throw incompatibleAuthResponse();
  }
  const parsed = Object.fromEntries(entries);
  if (
    !["m", "t", "p"].every((key) => Object.hasOwn(parsed, key)) ||
    Object.keys(parsed).length !== 3
  ) {
    throw incompatibleAuthResponse();
  }
  const memorySize = positiveInteger(parsed.m);
  const iterations = positiveInteger(parsed.t);
  const parallelism = positiveInteger(parsed.p);
  if (
    memorySize > MAX_ARGON_MEMORY_KIB ||
    iterations > MAX_ARGON_ITERATIONS ||
    parallelism > MAX_ARGON_PARALLELISM
  ) {
    throw new SprutHubError(
      "authentication_parameters_unsupported",
      "SprutHub requested authentication parameters above the local safety limit.",
      "complete_login_in_official_app",
    );
  }
  return { memorySize, iterations, parallelism };
}

function positiveInteger(value) {
  if (!/^\d+$/.test(value)) throw incompatibleAuthResponse();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw incompatibleAuthResponse();
  }
  return parsed;
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw incompatibleAuthResponse();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw incompatibleAuthResponse();
  return decoded;
}

function connect(url, deadline) {
  return new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      reject(timeoutError(false));
      return;
    }
    const socket = new WebSocket(url, "json-rpc");
    socket.on("error", () => undefined);
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(timeoutError(false));
    }, remainingMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", opened);
      socket.off("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve(socket);
    };
    const failed = () => {
      cleanup();
      reject(
        new SprutHubError(
          "connection_failed",
          "Could not connect to SprutHub.",
          "retry",
          { capability_status: "unknown" },
        ),
      );
    };
    socket.once("open", opened);
    socket.once("error", failed);
  });
}

function isRetryableConnectionError(error) {
  return (
    error instanceof SprutHubError &&
    [
      "authentication_delayed",
      "connection_closed",
      "connection_failed",
      "invalid_message",
      "timeout",
    ].includes(error.code)
  );
}

function sendRequest(socket, envelope, deadline) {
  return sendRawRequest(socket, envelope, deadline, false);
}

function requestWithSession(socket, envelope, deadline) {
  return sendRawRequest(socket, envelope, deadline, true);
}

function sendRawRequest(socket, envelope, deadline, sessionRequest) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(
        new SprutHubError(
          "connection_closed",
          "The SprutHub connection closed during authentication.",
          "retry_login",
        ),
      );
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      reject(timeoutError(false));
      return;
    }
    let requestSent = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError(requestSent));
    }, remainingMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", received);
      socket.off("close", closed);
      socket.off("error", closed);
    };
    const closed = () => {
      cleanup();
      reject(
        new SprutHubError(
          "connection_closed",
          "The SprutHub connection closed during authentication.",
          "retry_login",
          { requestSent },
        ),
      );
    };
    const received = (raw) => {
      let response;
      try {
        response = parseSprutHubMessage(raw);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (response.id !== envelope.id) return;
      cleanup();
      if (response.error) {
        reject(
          new SprutHubError(
            response.error.code === 401
              ? "authentication_failed"
              : "request_rejected",
            sessionRequest
              ? "SprutHub rejected the saved session."
              : "SprutHub rejected the authentication request.",
            "check_credentials",
            { requestSent, capability_status: "insufficient_access" },
          ),
        );
        return;
      }
      resolve(response);
    };
    socket.on("message", received);
    socket.once("close", closed);
    socket.once("error", closed);
    try {
      socket.send(JSON.stringify(envelope));
      requestSent = true;
    } catch {
      closed();
    }
  });
}

function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.terminate();
}

function extractAccountResponse(response) {
  const account = response.result?.account;
  const value = account?.auth ?? account?.answer;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw incompatibleAuthResponse();
  }
  return value;
}

function incompatibleAuthResponse() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned an incompatible authentication response.",
    "complete_login_in_official_app",
  );
}

function timeoutError(requestSent) {
  return new SprutHubError(
    "timeout",
    "SprutHub authentication did not respond before the deadline.",
    "retry_login",
    { requestSent },
  );
}

function parseTimeout(value) {
  const parsed = Number(value ?? 10_000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SprutHubError(
      "configuration",
      "SPRUTHUB_TIMEOUT_MS must be a positive number.",
    );
  }
  return parsed;
}

function requiredCredential(value, name, setup) {
  if (typeof value !== "string" || value.length === 0) {
    const error = new SprutHubError(
      "configuration",
      credentialSetupMessage(setup),
      "configure_credentials",
      { credential_setup: setup, missing_field: name },
    );
    localCredentialConfigurationErrors.add(error);
    throw error;
  }
  return value;
}

function credentialSetup(env) {
  const file = path.join(
    resolveConfigRoot(env),
    "sprut-agent",
    "connection.env",
  );
  return {
    file,
    required_fields: ["SPRUTHUB_LOGIN", "SPRUTHUB_PASSWORD"],
    permissions: "0600",
    restart: "Restart the same MCP application after saving the file.",
    secret_handling:
      "Create and fill the file locally; do not send credentials in chat.",
  };
}

function credentialSetupMessage(setup) {
  return `Configure SprutHub locally: create ${shellQuote(setup.file)} with ${setup.required_fields.join(" and ")}, set mode ${setup.permissions}, then restart the same MCP application. Do not send credential values in chat.`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function resolveConfigRoot(env) {
  if (env.XDG_CONFIG_HOME) return path.resolve(env.XDG_CONFIG_HOME);
  return path.join(env.HOME ? path.resolve(env.HOME) : homedir(), ".config");
}

function hasCompleteExplicitConnection(env) {
  if (hasValue(env.SPRUTHUB_TOKEN)) {
    return hasValue(env.SPRUTHUB_URL) && hasValue(env.SPRUTHUB_CID);
  }
  return hasValue(env.SPRUTHUB_LOGIN) && hasValue(env.SPRUTHUB_PASSWORD);
}

function hasValue(value) {
  return typeof value === "string" && value.length > 0;
}

async function loadCredentialFile(env, setup) {
  let info;
  try {
    info = await stat(setup.file);
  } catch (error) {
    if (error.code === "ENOENT") return env;
    throw credentialFileError(setup);
  }
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw credentialFileError(setup);
  }

  let parsed;
  try {
    parsed = parseEnv(await readFile(setup.file, "utf8"));
  } catch {
    throw credentialFileError(setup);
  }
  const merged = { ...env };
  for (const name of CONNECTION_ENV_FIELDS) {
    if (
      (!Object.hasOwn(env, name) || env[name] === undefined) &&
      Object.hasOwn(parsed, name)
    ) {
      merged[name] = parsed[name];
    }
  }
  return merged;
}

function credentialFileError(setup) {
  const error = new SprutHubError(
    "credential_file_unavailable",
    `Cannot use local SprutHub credential file ${shellQuote(setup.file)}. Make it a regular readable file with mode ${setup.permissions}, then restart the same MCP application.`,
    "fix_credential_file",
    { credential_setup: setup },
  );
  localCredentialConfigurationErrors.add(error);
  return error;
}

function resolveSessionFile(env) {
  if (env.SPRUT_AGENT_SESSION_FILE)
    return path.resolve(env.SPRUT_AGENT_SESSION_FILE);
  return path.join(resolveConfigRoot(env), "sprut-agent", "session.json");
}

async function loadSession(file, expected) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if ((info.mode & 0o077) !== 0) {
    throw new SprutHubError(
      "session_permissions",
      "The saved SprutHub session must not be readable by other users.",
      "restrict_session_file",
    );
  }
  let session;
  try {
    session = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw invalidSession();
  }
  if (
    session.url !== expected.url ||
    session.account_sha256 !== expected.accountSha256
  ) {
    return null;
  }
  if (
    session.version !== SESSION_VERSION ||
    typeof session.token !== "string" ||
    session.token.length === 0 ||
    typeof session.cid !== "string" ||
    session.cid.length === 0
  ) {
    throw invalidSession();
  }
  return session;
}

function invalidSession() {
  return new SprutHubError(
    "session_invalid",
    "The saved SprutHub session is invalid.",
    "remove_saved_session",
  );
}

async function saveSession(file, session) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.session-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(session)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function selectSerial(homes, requestedSerial) {
  const serials = homes.map((home) => {
    if (typeof home.serial === "string" && home.serial.length > 0) {
      return home.serial;
    }
    return decodeHomeRef(home.ref);
  });
  if (requestedSerial) {
    return serials.includes(requestedSerial) ? requestedSerial : null;
  }
  return serials.length === 1 ? serials[0] : null;
}

function decodeHomeRef(ref) {
  try {
    const url = new URL(ref);
    return decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw incompatibleAuthResponse();
  }
}
