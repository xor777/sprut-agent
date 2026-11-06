import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";
import {
  loadHomeFixture,
  SIMULATED_HUB_TOKEN,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The owner's hub stopped accepting the saved session and refused every
// request with -666003 "Incorrect token" (2026-10-23); the plugin answered
// request_rejected to every call until the owner intervened. The MCP
// server runs as installed, with the login in connection.env and the
// session in the default session.json.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const login = "owner@example.invalid";
const password = "pāss-secret-🔐";
const newPassword = "nеw-pāss-secret-🗝";
const expiredToken = "expired-session-token";
const homeRef = "spruthub://hub/sim-apartment-01";
const hallLightOn = `${homeRef}/accessory/12/service/13/characteristic/14`;
const floorLampOn = `${homeRef}/accessory/16/service/13/characteristic/14`;

const supportModule = (name) =>
  pathToFileURL(path.join(projectRoot, "test", "support", name)).href;

// onRequest(request, hub) sees each request as it reaches the hub, before
// the hub checks its token.
async function setup(
  t,
  {
    account: accountFields,
    savedToken,
    onRequest,
    // The login, password and hub address in the MCP launch environment:
    // with a login and password there, connection.env is not read at all.
    credentialsInEnvironment = false,
    // startServer's options for the first server.
    firstServer,
  } = {},
) {
  // The hub reads the account at each login: a test may change it later.
  const account = { login, password, ...accountFields };
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"), {
    account,
    onRequest: (request) => onRequest?.(request, hub),
  });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut-session-"));
  const configRoot = path.join(directory, "config");
  const sessionFile = path.join(configRoot, "sprut-agent", "session.json");
  const credentialFile = path.join(path.dirname(sessionFile), "connection.env");
  await mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  // What the owner saves in connection.env.
  const saveCredentials = (fields = {}) => {
    const { password: filePassword, url } = {
      password,
      url: hub.url,
      ...fields,
    };
    return writeFile(
      credentialFile,
      `${credentialsInEnvironment ? "" : `SPRUTHUB_LOGIN=${login}\nSPRUTHUB_PASSWORD=${filePassword}\n`}SPRUTHUB_URL=${url}\n`,
      { mode: 0o600 },
    );
  };
  await saveCredentials();
  if (savedToken) {
    await writeFile(
      sessionFile,
      JSON.stringify({
        version: 1,
        url: hub.url,
        account_sha256: createHash("sha256").update(login).digest("hex"),
        token: savedToken,
        cid: "saved-session-client",
      }),
      { mode: 0o600 },
    );
  }
  const clients = [];
  let stderr = "";
  // Another MCP process on the same files, as in another dialog. clockStepMs
  // lets its shiftClock() pass that time; clockOffsetMs starts it that much
  // later.
  const startServer = async ({ clockStepMs, clockOffsetMs } = {}) => {
    const clockArguments = clockStepMs
      ? ["--import", supportModule("shifted-clock.mjs")]
      : clockOffsetMs
        ? ["--import", supportModule("offset-clock.mjs")]
        : [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...clockArguments, path.join(projectRoot, "src", "server.mjs")],
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        XDG_CONFIG_HOME: configRoot,
        SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
        SPRUT_AGENT_STATE_DIR: path.join(directory, "state"),
        ...(clockStepMs
          ? { SPRUT_TEST_CLOCK_STEP_MS: String(clockStepMs) }
          : {}),
        ...(clockOffsetMs
          ? { SPRUT_TEST_CLOCK_OFFSET_MS: String(clockOffsetMs) }
          : {}),
        ...(credentialsInEnvironment
          ? {
              SPRUTHUB_LOGIN: login,
              SPRUTHUB_PASSWORD: password,
              SPRUTHUB_URL: hub.url,
            }
          : {}),
      },
      stderr: "pipe",
    });
    transport.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const client = new Client({
      name: "session-renewal-test",
      version: "1.0.0",
    });
    await client.connect(transport);
    clients.push(client);
    client.shiftClock = async () => {
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
    return client;
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  });
  // What the server wrote besides its answers: stderr and the files of its
  // state directory, the change journal among them.
  const written = async () => {
    const entries = await readdir(path.join(directory, "state"), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          readFile(path.join(entry.parentPath, entry.name), "utf8"),
        ),
    );
    return [stderr, ...files].join("\n");
  };
  // Files the server put beside the session and the owner's connection.env.
  const filesBesideSession = async () =>
    (await readdir(path.dirname(sessionFile)))
      .filter((name) => !["connection.env", "session.json"].includes(name))
      .map((name) => path.join(path.dirname(sessionFile), name));
  return {
    hub,
    account,
    client: await startServer(firstServer),
    startServer,
    saveCredentials,
    credentialFile,
    sessionFile,
    filesBesideSession,
    written,
  };
}

const loginsOf = (hub) =>
  hub.requests.filter(({ method }) => method === "account.auth").length;

async function savedToken(sessionFile) {
  return JSON.parse(await readFile(sessionFile, "utf8")).token;
}

function lampOn(hub, aId) {
  return hub.state.accessories
    .find(({ id }) => id === aId)
    .services.find(({ sId }) => sId === 13)
    .characteristics.find(({ control }) => control.type === "On").control.value
    .boolValue;
}

function sendCommands(client, commands) {
  return client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: commands.map(([target_ref, value]) => ({ target_ref, value })),
      reason: "test",
    },
  });
}

// The login, the password and every session token, the hub's own and
// those it issued, stay out of the tool results and what the server wrote.
function assertNoSecrets(text) {
  for (const secret of [
    login,
    password,
    newPassword,
    expiredToken,
    SIMULATED_HUB_TOKEN,
    "simulated-session-",
  ]) {
    assert.equal(text.includes(secret), false, "a credential leaked");
  }
}

test("a saved session the hub no longer accepts is replaced by one login", async (t) => {
  const { hub, client, sessionFile, written } = await setup(t, {
    savedToken: expiredToken,
  });

  const overview = await client.callTool({
    name: "home_overview",
    arguments: {},
  });

  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  assert.equal(overview.structuredContent.home.ref, homeRef);
  assert.ok(
    hub.requests.some(({ error }) => error?.code === -666003),
    "the saved session was tried first",
  );
  assert.equal(loginsOf(hub), 1);
  const renewed = await savedToken(sessionFile);
  assert.notEqual(renewed, expiredToken);
  assert.equal(hub.acceptsToken(renewed), true);
  assertNoSecrets(JSON.stringify(overview) + (await written()));
});

test("a session that expires while the server runs is renewed once and the commands go through", async (t) => {
  const { hub, client, sessionFile, written } = await setup(t);
  const first = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(loginsOf(hub), 1);
  const firstToken = await savedToken(sessionFile);

  hub.expireTokens();
  const result = await sendCommands(client, [
    [hallLightOn, true],
    [floorLampOn, false],
  ]);

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(
    result.structuredContent.results.map(({ status }) => status),
    ["applied", "applied"],
  );
  assert.equal(lampOn(hub, 12), true);
  assert.equal(lampOn(hub, 16), false);
  assert.equal(loginsOf(hub), 2, "one login for the expired session");
  // The reads before the commands met the expired session; each command
  // went out once, with the new session.
  const applied = hub.requests.filter(
    ({ method, error, params }) =>
      method === "characteristic.update" &&
      !error &&
      params.characteristic.update.control,
  );
  assert.deepEqual(
    applied.map(({ params }) => params.characteristic.update.aId).sort(),
    [12, 16],
  );
  const renewed = await savedToken(sessionFile);
  assert.notEqual(renewed, firstToken);
  assert.equal(hub.acceptsToken(renewed), true);
  assertNoSecrets(JSON.stringify(result) + (await written()));
});

// The session expires as the write itself reaches the hub: the hub refuses
// that write, and it goes again once after the login.
for (const { method, write } of [
  {
    method: "characteristic.update",
    write: async (client) => {
      const result = await sendCommands(client, [[hallLightOn, true]]);
      assert.equal(result.isError, undefined, result.content[0]?.text);
      assert.deepEqual(
        result.structuredContent.results.map(({ status }) => status),
        ["applied"],
      );
    },
  },
  {
    method: "room.update",
    write: async (client) => {
      const prepared = await client.callTool({
        name: "prepare_native_change",
        arguments: {
          operation: "room_name",
          target_ref: `${homeRef}/room/7`,
          value: "Офис",
          reason: "test",
        },
      });
      assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
      const { change_ref } = prepared.structuredContent;
      const applied = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref },
      });
      assert.equal(applied.isError, undefined, applied.content[0]?.text);
      const change = await client.callTool({
        name: "get_native_change",
        arguments: { change_ref },
      });
      assert.equal(change.structuredContent.status, "applied");
    },
  },
]) {
  test(`a ${method} refused for the expired session is sent again once after one login`, async (t) => {
    let armed = false;
    const { hub, client } = await setup(t, {
      onRequest: (request, simulated) => {
        if (armed && request.method === method) {
          armed = false;
          simulated.expireTokens();
        }
      },
    });
    const first = await client.callTool({
      name: "home_overview",
      arguments: {},
    });
    assert.equal(first.isError, undefined, first.content[0]?.text);
    assert.equal(loginsOf(hub), 1);

    armed = true;
    await write(client);

    const writes = hub.requests.filter((request) => request.method === method);
    assert.deepEqual(
      writes.map(({ error }) => error?.code ?? "carried out"),
      [-666003, "carried out"],
    );
    assert.equal(loginsOf(hub), 2, "one login for the expired session");
  });
}

test("a refused login names the account status without credentials and is not repeated", async (t) => {
  const { hub, client, written } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_NO_MORE_TRIES" },
    savedToken: expiredToken,
  });

  const result = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  const repeated = await client.callTool({
    name: "home_overview",
    arguments: {},
  });

  for (const answer of [result, repeated]) {
    assert.equal(answer.isError, true);
    assert.equal(
      answer.structuredContent.account_status,
      "ACCOUNT_RESPONSE_NO_MORE_TRIES",
    );
    assert.deepEqual(
      {
        code: answer.structuredContent.error.code,
        retryable: answer.structuredContent.error.retryable,
        action: answer.structuredContent.error.action,
      },
      {
        code: "authentication_failed",
        retryable: false,
        action: "retry_login_later",
      },
    );
    assert.match(answer.structuredContent.error.message, /wait/i);
  }
  assert.equal(loginsOf(hub), 1, "no second login after a refusal");
  assertNoSecrets(JSON.stringify([result, repeated]) + (await written()));
});

test("a login refused while the server runs is tried once and tells the owner to check the credentials", async (t) => {
  const { hub, account, client, written } = await setup(t);
  const first = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);

  account.status = "ACCOUNT_RESPONSE_FAILED";
  hub.expireTokens();
  const results = [
    await sendCommands(client, [[hallLightOn, true]]),
    await sendCommands(client, [[floorLampOn, false]]),
  ];

  for (const result of results) {
    const text = JSON.stringify(result.structuredContent);
    assert.match(text, /"code":"authentication_failed"/, text);
    assert.match(text, /"account_status":"ACCOUNT_RESPONSE_FAILED"/, text);
    assert.match(text, /"action":"check_credentials"/, text);
    assert.match(text, /connection\.env/, text);
  }
  assert.equal(lampOn(hub, 12), false);
  assert.equal(lampOn(hub, 16), true);
  assert.equal(loginsOf(hub), 2, "one login for the expired session");
  assertNoSecrets(JSON.stringify(results) + (await written()));
});

// The hub answers ACCOUNT_RESPONSE_TOO_FAST with how long to wait; another
// login before that would only add to the attempts the hub counts.
test("a login the hub asks to delay is not tried again before the delay, in a running server", async (t) => {
  const { hub, account, client } = await setup(t);
  const first = await client.callTool({
    name: "home_overview",
    arguments: {},
  });
  assert.equal(first.isError, undefined, first.content[0]?.text);

  Object.assign(account, { status: "ACCOUNT_RESPONSE_TOO_FAST", delay: 2 });
  hub.expireTokens();
  // The delay runs from the hub's answer, which the first call returns.
  let delayedBy;
  for (let call = 0; call < 3; call += 1) {
    const result = await sendCommands(client, [[hallLightOn, true]]);
    delayedBy ??= Date.now();
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.error.code, "authentication_delayed");
    assert.equal(result.structuredContent.error.retryable, true);
    const wait = result.structuredContent.retry_after_seconds;
    assert.ok(wait === 1 || wait === 2, `retry_after_seconds ${wait}`);
  }
  assert.equal(loginsOf(hub), 2, "no login before the delay ends");

  delete account.status;
  await new Promise((resolve) =>
    setTimeout(resolve, delayedBy + 2_100 - Date.now()),
  );
  const result = await sendCommands(client, [[hallLightOn, true]]);
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(lampOn(hub, 12), true);
  assert.equal(loginsOf(hub), 3);
});

test("a login the hub asks to delay at start is not tried again before the delay", async (t) => {
  const { hub, client } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_TOO_FAST", delay: 60 },
    savedToken: expiredToken,
  });

  for (let call = 0; call < 3; call += 1) {
    const result = await client.callTool({
      name: "home_overview",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "authentication_delayed");
    const wait = result.structuredContent.retry_after_seconds;
    assert.ok(wait > 55 && wait <= 60, `retry_after_seconds ${wait}`);
  }
  assert.equal(loginsOf(hub), 1, "no login before the delay ends");
});

test("a refused login points to where the credentials were set", async (t) => {
  const { client } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_FAILED" },
    credentialsInEnvironment: true,
  });

  const result = await client.callTool({
    name: "home_overview",
    arguments: {},
  });

  assert.equal(result.structuredContent.error.code, "authentication_failed");
  const { message } = result.structuredContent.error;
  assert.match(message, /MCP launch environment/);
  assert.doesNotMatch(message, /connection\.env/);
});

test("a refusal unrelated to the session stays request_rejected without a login", async (t) => {
  const { hub, client } = await setup(t, { savedToken: SIMULATED_HUB_TOKEN });
  hub.refuseNext("characteristic.update", {
    code: -32603,
    message: "Internal error",
  });

  const result = await sendCommands(client, [[hallLightOn, true]]);

  const text = JSON.stringify(result.structuredContent);
  assert.match(text, /"code":"request_rejected"/, text);
  assert.equal(lampOn(hub, 12), false);
  assert.equal(loginsOf(hub), 0);
});

const HOUR_S = 60 * 60;

function overview(client) {
  return client.callTool({ name: "home_overview", arguments: {} });
}

// The refusal answered without the hub or with it is the same answer: the
// status, what to do and when the next login is possible.
function assertLoginRefused(result, { status, action, credentialFile }) {
  assert.equal(result.isError, true, JSON.stringify(result));
  const { error, account_status, retry_after_seconds, next_login_at } =
    result.structuredContent;
  assert.equal(error.code, "authentication_failed");
  assert.equal(error.retryable, false);
  assert.equal(error.action, action);
  assert.equal(account_status, status);
  assert.ok(
    retry_after_seconds > HOUR_S - 120 && retry_after_seconds <= HOUR_S,
    `retry_after_seconds ${retry_after_seconds}`,
  );
  const untilNext = Date.parse(next_login_at) - Date.now();
  assert.ok(
    untilNext > (HOUR_S - 120) * 1000 && untilNext <= HOUR_S * 1000,
    `next_login_at ${next_login_at}`,
  );
  assert.ok(
    error.message.includes(credentialFile),
    `the file to change: ${error.message}`,
  );
  assert.ok(
    error.message.includes(next_login_at),
    `the time of the next login: ${error.message}`,
  );
  assert.doesNotMatch(error.message, /restart/i);
}

// The owner changed the password in the SprutHub app: every session is gone
// and the password in connection.env is old.
function changePasswordOnHub(hub, account) {
  account.password = newPassword;
  hub.expireTokens();
}

for (const { start, savedToken: tokenAtStart, runsFirst } of [
  { start: "a running server that lost its session", runsFirst: true },
  {
    start: "a server started with a refused session",
    savedToken: expiredToken,
  },
  { start: "a server started without a session" },
]) {
  test(`after a refused login, ${start} logs in with the password the owner saved, without a restart`, async (t) => {
    const {
      hub,
      account,
      client,
      credentialFile,
      saveCredentials,
      sessionFile,
      written,
    } = await setup(t, { savedToken: tokenAtStart });
    if (runsFirst) {
      const first = await overview(client);
      assert.equal(first.isError, undefined, first.content[0]?.text);
    }
    changePasswordOnHub(hub, account);
    const loginsBefore = loginsOf(hub);

    const refused = await overview(client);
    const repeated = await overview(client);
    for (const answer of [refused, repeated]) {
      assertLoginRefused(answer, {
        status: "ACCOUNT_RESPONSE_FAILED",
        action: "check_credentials",
        credentialFile,
      });
    }
    assert.equal(loginsOf(hub), loginsBefore + 1, "one login for the refusal");

    await saveCredentials({ password: newPassword });
    const recovered = await overview(client);

    assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
    assert.equal(recovered.structuredContent.home.ref, homeRef);
    assert.equal(loginsOf(hub), loginsBefore + 2);
    assert.equal(hub.acceptsToken(await savedToken(sessionFile)), true);
    assertNoSecrets(
      JSON.stringify([refused, repeated, recovered]) + (await written()),
    );
  });
}

for (const [status, action] of [
  ["ACCOUNT_RESPONSE_FAILED", "check_credentials"],
  ["ACCOUNT_RESPONSE_FORMAT", "check_credentials"],
  ["ACCOUNT_RESPONSE_NOT_CONFIRMED", "confirm_login"],
  ["ACCOUNT_RESPONSE_NOT_CONNECTED", "check_credentials"],
  ["ACCOUNT_RESPONSE_NO_MORE_TRIES", "retry_login_later"],
]) {
  test(`${status} stops logins in this process and a later one until connection.env is saved again`, async (t) => {
    const {
      hub,
      account,
      client,
      credentialFile,
      saveCredentials,
      startServer,
    } = await setup(t, { account: { status }, savedToken: expiredToken });
    const refusal = { status, action, credentialFile };

    assertLoginRefused(await overview(client), refusal);
    assertLoginRefused(await overview(client), refusal);
    const later = await startServer();
    assertLoginRefused(await overview(later), refusal);
    assert.equal(loginsOf(hub), 1, "one login for all of them");

    // The owner fixed the cause on the hub's side, and saved the file as it
    // was: its contents and size are the same.
    delete account.status;
    await saveCredentials();
    const recovered = await overview(later);
    assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
    assert.equal(loginsOf(hub), 2);
    // The first server finds the session the later one saved.
    const first = await overview(client);
    assert.equal(first.isError, undefined, first.content[0]?.text);
    assert.equal(loginsOf(hub), 2);
  });
}

test("a refusal ends after an hour for a server started later, without any change of the file", async (t) => {
  const { hub, account, client, credentialFile, startServer } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_NOT_CONFIRMED" },
  });
  const refusal = {
    status: "ACCOUNT_RESPONSE_NOT_CONFIRMED",
    action: "confirm_login",
    credentialFile,
  };
  assertLoginRefused(await overview(client), refusal);
  delete account.status;

  const almost = await startServer({ clockOffsetMs: 59 * 60_000 });
  const held = await overview(almost);
  assert.equal(held.structuredContent.error.code, "authentication_failed");
  assert.equal(
    held.structuredContent.account_status,
    "ACCOUNT_RESPONSE_NOT_CONFIRMED",
  );
  assert.ok(
    held.structuredContent.retry_after_seconds <= 60,
    "the time left, not a new hour",
  );
  assert.equal(loginsOf(hub), 1);

  const after = await startServer({ clockOffsetMs: 61 * 60_000 });
  const recovered = await overview(after);
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
});

test("a refusal ends after an hour in the running server that met it", async (t) => {
  const { hub, account, client, credentialFile } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_FAILED" },
    firstServer: { clockStepMs: 61 * 60_000 },
  });
  assertLoginRefused(await overview(client), {
    status: "ACCOUNT_RESPONSE_FAILED",
    action: "check_credentials",
    credentialFile,
  });
  delete account.status;

  await client.shiftClock();
  const recovered = await overview(client);

  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
});

test("the delay the hub asks for holds in a later process and is not lifted by saving the file", async (t) => {
  const { hub, account, client, saveCredentials, startServer } = await setup(
    t,
    {
      account: { status: "ACCOUNT_RESPONSE_TOO_FAST", delay: 60 },
      savedToken: expiredToken,
    },
  );
  const delayed = await overview(client);
  assert.equal(delayed.structuredContent.error.code, "authentication_delayed");
  assert.equal(loginsOf(hub), 1);

  await saveCredentials({ password: newPassword });
  const later = await startServer();
  for (const server of [later, client]) {
    const result = await overview(server);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "authentication_delayed");
    assert.equal(result.structuredContent.error.retryable, true);
    const wait = result.structuredContent.retry_after_seconds;
    assert.ok(wait > 50 && wait <= 60, `retry_after_seconds ${wait}`);
  }
  assert.equal(loginsOf(hub), 1, "no login before the delay ends");

  account.password = newPassword;
  delete account.status;
  const afterDelay = await startServer({ clockOffsetMs: 61_000 });
  const recovered = await overview(afterDelay);
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
});

test("a session another process saved replaces the refused one without a login", async (t) => {
  const { hub, client, sessionFile, startServer } = await setup(t);
  const first = await overview(client);
  assert.equal(first.isError, undefined, first.content[0]?.text);

  hub.expireTokens();
  const other = await startServer();
  const logged = await overview(other);
  assert.equal(logged.isError, undefined, logged.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
  const savedByOther = await savedToken(sessionFile);

  const result = await sendCommands(client, [[hallLightOn, true]]);

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(lampOn(hub, 12), true);
  assert.equal(loginsOf(hub), 2, "no login of its own");
  assert.equal(await savedToken(sessionFile), savedByOther);
});

// Each dialog may hold its own session, so the saved one need not be this
// server's when the password changes and the hub drops them all.
test("a saved session the hub refuses too ends in one login within the same call", async (t) => {
  const { hub, client, sessionFile, startServer } = await setup(t);
  const first = await overview(client);
  assert.equal(first.isError, undefined, first.content[0]?.text);
  hub.expireTokens();
  const other = await startServer();
  const logged = await overview(other);
  assert.equal(logged.isError, undefined, logged.content[0]?.text);
  hub.expireTokens();

  const result = await sendCommands(client, [[hallLightOn, true]]);

  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.equal(lampOn(hub, 12), true);
  assert.equal(loginsOf(hub), 3);
  assert.equal(hub.acceptsToken(await savedToken(sessionFile)), true);
});

test("the refusal kept on disk is private and holds only the file's facts, the status and the time", async (t) => {
  const { client, credentialFile, filesBesideSession } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_FAILED" },
  });
  await overview(client);

  const files = await filesBesideSession();
  assert.equal(files.length, 1, `one file, no temporary left: ${files}`);
  const [file] = files;
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  const { size, mtimeMs } = await stat(credentialFile);
  for (const secret of [
    login,
    password,
    SIMULATED_HUB_TOKEN,
    "simulated-session-",
    createHash("sha256").update(password).digest("hex"),
    createHash("sha256").update(password).digest("base64"),
    createHash("sha256").update(login).digest("hex"),
  ]) {
    assert.equal(text.includes(secret), false, "a credential in the file");
  }
  const leaves = (value) =>
    typeof value === "object" && value !== null
      ? Object.values(value).flatMap(leaves)
      : [value];
  const values = leaves(JSON.parse(text));
  assert.ok(values.includes(size), "the size of connection.env");
  assert.ok(values.includes(mtimeMs), "the change time of connection.env");
  for (const value of values.filter((item) => typeof item === "string")) {
    assert.ok(
      value === "ACCOUNT_RESPONSE_FAILED" || !Number.isNaN(Date.parse(value)),
      `only a status or a time as text, not ${value}`,
    );
  }
});

test("a damaged refusal file costs one login, not a lockout", async (t) => {
  const { hub, account, client, filesBesideSession, startServer } = await setup(
    t,
    { account: { status: "ACCOUNT_RESPONSE_FAILED" } },
  );
  await overview(client);
  const [file] = await filesBesideSession();
  assert.ok(file, "the refusal is kept in a file");
  await writeFile(file, "{not json");
  delete account.status;

  const later = await startServer();
  const recovered = await overview(later);

  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
});

test("with credentials in the launch environment a refusal stays in the process and names the environment", async (t) => {
  const { hub, client, filesBesideSession, startServer } = await setup(t, {
    account: { status: "ACCOUNT_RESPONSE_FAILED" },
    credentialsInEnvironment: true,
  });

  for (const result of [await overview(client), await overview(client)]) {
    assert.equal(
      result.structuredContent.account_status,
      "ACCOUNT_RESPONSE_FAILED",
    );
    const { message } = result.structuredContent.error;
    assert.match(message, /MCP launch environment/);
    assert.match(message, /restart/i);
    assert.doesNotMatch(message, /connection\.env/);
    assert.ok(result.structuredContent.next_login_at);
  }
  assert.equal(loginsOf(hub), 1);
  assert.deepEqual(await filesBesideSession(), [], "nothing kept on disk");

  // The owner's fix of the environment needs a restart, which must log in.
  const restarted = await startServer();
  await overview(restarted);
  assert.equal(loginsOf(hub), 2);
});

test("a mistyped new password gets one login per save, however many calls follow", async (t) => {
  const { hub, account, client, saveCredentials } = await setup(t, {
    savedToken: expiredToken,
  });
  changePasswordOnHub(hub, account);
  await overview(client);
  assert.equal(loginsOf(hub), 1);

  await saveCredentials({ password: "mistyped-new-password" });
  const refused = await overview(client);
  const repeated = await overview(client);

  for (const answer of [refused, repeated]) {
    assert.equal(
      answer.structuredContent.account_status,
      "ACCOUNT_RESPONSE_FAILED",
    );
  }
  assert.equal(loginsOf(hub), 2);
  assert.equal(
    JSON.stringify([refused, repeated]).includes("mistyped-new-password"),
    false,
    "a password the owner saved after the start leaked",
  );
});

test("a login cut by the connection is no refusal and the next call logs in", async (t) => {
  let cut = true;
  const { hub, client, filesBesideSession } = await setup(t, {
    savedToken: expiredToken,
    onRequest: (request, simulated) => {
      if (cut && request.method === "account.answer") {
        cut = false;
        void simulated.dropConnections();
      }
    },
  });

  const failed = await overview(client);
  assert.equal(failed.structuredContent.error.code, "connection_closed");
  assert.equal(failed.structuredContent.error.retryable, true);
  assert.equal(failed.structuredContent.account_status, undefined);
  assert.deepEqual(await filesBesideSession(), []);

  const recovered = await overview(client);
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
});

test("a credential file broken while the owner edits it does not outlive the edit", async (t) => {
  const { hub, account, client, credentialFile, saveCredentials } = await setup(
    t,
    { savedToken: expiredToken },
  );
  changePasswordOnHub(hub, account);
  const refused = await overview(client);
  assert.equal(
    refused.structuredContent.account_status,
    "ACCOUNT_RESPONSE_FAILED",
  );

  await writeFile(credentialFile, `SPRUTHUB_URL=${hub.url}\n`, { mode: 0o600 });
  const unfinished = await overview(client);
  assert.equal(unfinished.structuredContent.error.code, "configuration");
  assert.equal(unfinished.structuredContent.missing_field, "SPRUTHUB_LOGIN");

  await saveCredentials({ password: newPassword });
  await chmod(credentialFile, 0o644);
  const unsafe = await overview(client);
  assert.equal(
    unsafe.structuredContent.error.code,
    "credential_file_unavailable",
  );
  assert.doesNotMatch(unsafe.structuredContent.error.message, /restart/i);
  assert.equal(unsafe.structuredContent.credential_setup.restart, undefined);
  assert.equal(loginsOf(hub), 1, "no login from a file it cannot trust");

  await chmod(credentialFile, 0o600);
  const recovered = await overview(client);
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(loginsOf(hub), 2);
});

test("a running server does not move to another hub address: it asks for the restart that needs", async (t) => {
  const { hub, client, saveCredentials } = await setup(t);
  const first = await overview(client);
  assert.equal(first.isError, undefined, first.content[0]?.text);
  const otherHub = await startSimulatedHub(await loadHomeFixture("apartment"), {
    account: { login, password: newPassword },
  });
  t.after(() => otherHub.close());

  hub.expireTokens();
  await saveCredentials({ password: newPassword, url: otherHub.url });
  const result = await overview(client);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "connection_changed");
  assert.match(result.structuredContent.error.message, /restart/i);
  assert.equal(loginsOf(hub), 1);
  assert.equal(loginsOf(otherHub), 0, "no credentials sent from this process");
  assertNoSecrets(JSON.stringify(result));
});
