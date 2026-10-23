import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
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
const expiredToken = "expired-session-token";
const homeRef = "spruthub://hub/sim-apartment-01";
const hallLightOn = `${homeRef}/accessory/12/service/13/characteristic/14`;
const floorLampOn = `${homeRef}/accessory/16/service/13/characteristic/14`;

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
  await mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(configRoot, "sprut-agent", "connection.env"),
    `${credentialsInEnvironment ? "" : `SPRUTHUB_LOGIN=${login}\nSPRUTHUB_PASSWORD=${password}\n`}SPRUTHUB_URL=${hub.url}\n`,
    { mode: 0o600 },
  );
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: configRoot,
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: path.join(directory, "state"),
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
  let stderr = "";
  transport.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "session-renewal-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
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
  return { hub, account, client, sessionFile, written };
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
