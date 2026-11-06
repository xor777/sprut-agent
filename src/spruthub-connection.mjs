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
  extractNativeList,
  parseSprutHubMessage,
  SprutHubClient,
  SprutHubError,
} from "./spruthub-client.mjs";

export const DEFAULT_SPRUTHUB_URL = "wss://beta.spruthub.ru/spruthub";

const SESSION_VERSION = 1;
const LOGIN_HOLD_VERSION = 1;
const LOGIN_HOLD_FILE = "login-hold.json";
// How long a refused login is not tried again unless connection.env changes:
// the owner may have fixed the cause outside the file.
const REFUSAL_HOLD_MS = 60 * 60 * 1000;
const TOO_FAST = "ACCOUNT_RESPONSE_TOO_FAST";
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
  #launchEnv;
  #homeSelectionSource;
  // The renewal of a session the hub refused, by the refused token.
  #renewal;
  // The login hold when no file keeps it: credentials from the launch
  // environment, or a file that could not be written.
  #loginHold;
  #secrets = new Set();

  constructor({ env = process.env } = {}) {
    env = withoutBlankConnectionValues(env);
    this.#env = env;
    this.#launchEnv = env;
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
      ({ env } = await loadCredentialFile(env, credentialSetup(env)));
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
        if (this.#clientPromise === attempt && mayChangeByNextCall(error)) {
          this.#clientPromise = undefined;
        }
      });
    }
    return this.#clientPromise;
  }

  async #createClient() {
    const connection = await this.#readConnection();
    const { env } = connection;
    this.#env = env;
    if (env.SPRUTHUB_TOKEN) {
      return new SprutHubClient({
        url: env.SPRUTHUB_URL,
        token: env.SPRUTHUB_TOKEN,
        serial: env.SPRUTHUB_SERIAL,
        configuredSerial: env.SPRUTHUB_SERIAL,
        cid: env.SPRUTHUB_CID,
        timeoutMs: parseTimeout(env.SPRUTHUB_TIMEOUT_MS),
      });
    }

    const account = accountOf(connection);
    const { url, sessionFile, timeoutMs } = account;
    const renewSession = (rejectedToken) =>
      this.#renewSession(rejectedToken, url);
    const saved = await loadSession(sessionFile, account);
    if (saved) {
      this.#remember(saved.token);
      // A saved session the hub no longer accepts is renewed by the client
      // on its first request.
      const client = new SprutHubClient({
        url,
        token: saved.token,
        serial: null,
        configuredSerial: env.SPRUTHUB_SERIAL,
        cid: saved.cid,
        timeoutMs,
        renewSession,
      });
      try {
        const catalog = await client.listHomes();
        client.serial = selectSerial(catalog.homes, env.SPRUTHUB_SERIAL);
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    }

    const authenticated = await this.#logIn(account);
    const serial = selectSerial(authenticated.homes, env.SPRUTHUB_SERIAL);
    return new SprutHubClient({
      url,
      token: authenticated.token,
      serial,
      configuredSerial: env.SPRUTHUB_SERIAL,
      availableHomeCount: authenticated.homes.length,
      cid: authenticated.cid,
      timeoutMs,
      renewSession,
    });
  }

  // What this process would use now: the launch environment wins, and the
  // file is read anew, as the owner may have changed it since the last login.
  async #readConnection() {
    const setup = credentialSetup(this.#launchEnv);
    const { env, credentialFile } = hasCompleteExplicitConnection(
      this.#launchEnv,
    )
      ? { env: this.#launchEnv, credentialFile: null }
      : await loadCredentialFile(this.#launchEnv, setup);
    this.#remember(
      env.SPRUTHUB_LOGIN,
      env.SPRUTHUB_PASSWORD,
      env.SPRUTHUB_TOKEN,
    );
    return { env, setup, credentialFile };
  }

  // One renewal per refused session: the requests that lost it wait for the
  // same one. A failure a later call may see differently is not kept: the
  // login hold, not this, stops repeated logins.
  #renewSession(rejectedToken, connectedUrl) {
    if (this.#renewal?.rejectedToken !== rejectedToken) {
      const renewal = {
        rejectedToken,
        login: this.#replaceSession(rejectedToken, connectedUrl),
      };
      this.#renewal = renewal;
      renewal.login.catch((error) => {
        if (this.#renewal === renewal && mayChangeByNextCall(error)) {
          this.#renewal = undefined;
        }
      });
    }
    return this.#renewal.login;
  }

  // A session another process saved in the meantime spares a login.
  async #replaceSession(rejectedToken, connectedUrl) {
    const connection = await this.#readConnection();
    const { env, setup } = connection;
    if (
      env.SPRUTHUB_TOKEN ||
      (env.SPRUTHUB_URL ?? DEFAULT_SPRUTHUB_URL) !== connectedUrl
    ) {
      throw connectionChanged(setup);
    }
    const account = accountOf(connection);
    const saved = await loadSession(account.sessionFile, account);
    if (saved && saved.token !== rejectedToken) {
      this.#remember(saved.token);
      return saved;
    }
    return this.#logIn(account);
  }

  async #logIn(account) {
    const { url, login, password, timeoutMs, sessionFile, accountSha256 } =
      account;
    const held = await this.#activeLoginHold(account);
    if (held) throw loginHeld(held, account);
    let authenticated;
    try {
      authenticated = await authenticate({
        url,
        login,
        password,
        timeoutMs,
        remember: (...values) => this.#remember(...values),
      });
    } catch (error) {
      const hold = loginHoldAfter(error, account);
      if (!hold) throw error;
      await this.#keepLoginHold(hold, account);
      throw loginHeld(hold, account);
    }
    await writePrivateFile(sessionFile, {
      version: SESSION_VERSION,
      url,
      account_sha256: accountSha256,
      token: authenticated.token,
      cid: authenticated.cid,
    });
    this.#loginHold = undefined;
    if (account.holdFile) await unlink(account.holdFile).catch(() => {});
    return authenticated;
  }

  // The hub blocks an account after repeated attempts
  // (ACCOUNT_RESPONSE_NO_MORE_TRIES), whichever process makes them.
  async #activeLoginHold({ holdFile, credentialFile }) {
    const hold =
      (holdFile && (await readLoginHold(holdFile))) ?? this.#loginHold;
    if (!hold || Date.now() >= Date.parse(hold.not_before)) return null;
    // The delay is the hub's own and holds for any credentials.
    if (hold.status === TOO_FAST) return hold;
    return hold.file?.mtime_ms === credentialFile?.mtime_ms &&
      hold.file?.size === credentialFile?.size
      ? hold
      : null;
  }

  // If the file cannot be written, this process still keeps the hold; a later
  // process may then try one login. The refusal stays the answer either way.
  async #keepLoginHold(hold, { holdFile }) {
    this.#loginHold = hold;
    if (!holdFile) return;
    await writePrivateFile(holdFile, hold).then(
      () => {
        this.#loginHold = undefined;
      },
      () => {},
    );
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
        const homes = extractNativeList(
          homesResponse,
          ["hub", "list", "hubs"],
          incompatibleAuthResponse,
        );
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

// What the owner does about each account status that ends a login
// (Account.proto, AccountResponseStatus).
const ACCOUNT_REFUSALS = {
  ACCOUNT_RESPONSE_FAILED: [
    "check_credentials",
    (where) =>
      `SprutHub rejected the login or password. Check SPRUTHUB_LOGIN and SPRUTHUB_PASSWORD in ${where}`,
  ],
  ACCOUNT_RESPONSE_FORMAT: [
    "check_credentials",
    (where) =>
      `SprutHub did not accept the format of the login. Check SPRUTHUB_LOGIN in ${where}`,
  ],
  ACCOUNT_RESPONSE_NOT_CONFIRMED: [
    "confirm_login",
    () =>
      "SprutHub has not confirmed this account or login yet. Confirm it as SprutHub asks, for example from its e-mail",
  ],
  ACCOUNT_RESPONSE_NOT_CONNECTED: [
    "check_credentials",
    (where) =>
      `SprutHub reports this account as not connected. Check in SprutHub that the account in ${where} has access to the hub`,
  ],
  ACCOUNT_RESPONSE_NO_MORE_TRIES: [
    "retry_login_later",
    () =>
      "SprutHub blocked logins to this account after too many attempts. Wait before logging in again",
  ],
};

function rejectAccountStatus(account) {
  if (account.status === "ACCOUNT_RESPONSE_SUCCESS") return;
  if (account.status === TOO_FAST) {
    throw authenticationDelayed(account.question?.delay ?? 0);
  }
  if (!Object.hasOwn(ACCOUNT_REFUSALS, account.status)) {
    throw incompatibleAuthResponse();
  }
  throw new SprutHubError(
    "authentication_failed",
    "SprutHub refused the login.",
    ACCOUNT_REFUSALS[account.status][0],
    { account_status: account.status },
  );
}

// What keeps a further login from going out, when the hub's answer to this
// one calls for it. No credential or hash of one: only the facts of the file
// that tell the owner changed it, the status and the times.
function loginHoldAfter(error, { credentialFile }) {
  const now = Date.now();
  const hold = (status, waitMs, file) => ({
    version: LOGIN_HOLD_VERSION,
    status,
    refused_at: new Date(now).toISOString(),
    not_before: new Date(now + waitMs).toISOString(),
    file,
  });
  const delay = error.details?.retry_after_seconds;
  if (error.code === "authentication_delayed" && delay) {
    return hold(TOO_FAST, delay * 1000);
  }
  const status = error.details?.account_status;
  return status ? hold(status, REFUSAL_HOLD_MS, credentialFile) : null;
}

function loginHeld(hold, { credentialFile, credentialsAt }) {
  const waitSeconds = Math.ceil(
    (Date.parse(hold.not_before) - Date.now()) / 1000,
  );
  if (hold.status === TOO_FAST) return authenticationDelayed(waitSeconds);
  const [action, advice] = ACCOUNT_REFUSALS[hold.status];
  const reason = advice(credentialsAt);
  return new SprutHubError(
    "authentication_failed",
    credentialFile
      ? `${reason}. No new login goes to SprutHub until ${credentialsAt} is saved again or until ${hold.not_before}, so the attempts that block an account do not add up. The next request after that logs in by itself; this MCP process keeps running.`
      : `${reason}, then restart the MCP application. Until then no new login goes to SprutHub before ${hold.not_before}.`,
    action,
    {
      capability_status: "insufficient_access",
      account_status: hold.status,
      retry_after_seconds: waitSeconds,
      next_login_at: hold.not_before,
    },
  );
}

function connectionChanged(setup) {
  return new SprutHubError(
    "connection_changed",
    `${setup.file} now sets another hub address or a ready session. This MCP process stays with the hub it connected to and sent it nothing: restart the MCP application to use the new one.`,
    "restart_mcp_application",
  );
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

// Failures a later call works out anew: the connection and the hub's delay;
// a refusal, which the login hold then answers without the hub; and what the
// owner can fix in the local files. Other answers of the hub to a login
// (enrollment and the like) stay until a restart, as each login counts.
function mayChangeByNextCall(error) {
  return (
    error instanceof SprutHubError &&
    (error.details?.account_status !== undefined ||
      [
        "authentication_delayed",
        "connection_changed",
        "connection_closed",
        "connection_failed",
        "invalid_message",
        "timeout",
        "configuration",
        "credential_file_unavailable",
        "session_invalid",
        "session_permissions",
      ].includes(error.code))
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

function accountOf({ env, setup, credentialFile }) {
  const login = requiredCredential(env.SPRUTHUB_LOGIN, "SPRUTHUB_LOGIN", setup);
  const password = requiredCredential(
    env.SPRUTHUB_PASSWORD,
    "SPRUTHUB_PASSWORD",
    setup,
  );
  const sessionFile = resolveSessionFile(env);
  return {
    url: env.SPRUTHUB_URL ?? DEFAULT_SPRUTHUB_URL,
    login,
    password,
    timeoutMs: parseTimeout(env.SPRUTHUB_TIMEOUT_MS),
    sessionFile,
    accountSha256: createHash("sha256").update(login).digest("hex"),
    // Where the owner set the login: with it in the launch environment the
    // file is not read, and only a restart can change it, so a refusal stays
    // in the process.
    credentialsAt: credentialFile ? setup.file : "the MCP launch environment",
    credentialFile,
    holdFile: credentialFile
      ? path.join(path.dirname(sessionFile), LOGIN_HOLD_FILE)
      : null,
  };
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

// MCP clients often pass an unfilled config placeholder as an empty string.
// Treat it as unset, so connection.env or the default still applies instead
// of a blank value that no edit of the file could replace.
function withoutBlankConnectionValues(env) {
  const normalized = { ...env };
  for (const name of CONNECTION_ENV_FIELDS) {
    if (normalized[name] === "") delete normalized[name];
  }
  return normalized;
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
    if (error.code === "ENOENT") return { env, credentialFile: null };
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
  return {
    env: merged,
    credentialFile: { mtime_ms: info.mtimeMs, size: info.size },
  };
}

function credentialFileError({ restart: _restart, ...setup }) {
  const error = new SprutHubError(
    "credential_file_unavailable",
    `Cannot use local SprutHub credential file ${shellQuote(setup.file)}. Make it a regular readable file with mode ${setup.permissions}; the next request reads it again.`,
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

// A hold that cannot be read counts as none: losing it costs one login,
// keeping a damaged one could lock the owner out.
async function readLoginHold(file) {
  let hold;
  try {
    hold = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  return hold?.version === LOGIN_HOLD_VERSION &&
    (hold.status === TOO_FAST ||
      Object.hasOwn(ACCOUNT_REFUSALS, hold.status)) &&
    !Number.isNaN(Date.parse(hold.not_before))
    ? hold
    : null;
}

async function writePrivateFile(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
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
