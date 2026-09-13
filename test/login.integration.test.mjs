import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const login = "owner@example.invalid";
const password = "pāss🔐";
const token = "session-token-must-not-leak";
const challengeData = {
  rootSalt: "AAECAwQFBgcICQoLDA0ODw==",
  challenge: "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=",
  kdfParams: "m=32,t=2,p=1",
};
const expectedChallengeAnswer =
  "xEijLGI5IgEYvW2hq09rexM1ZdN4NNc8twB6IVEv4i0tSA+BHxN+UWjW4ExPXJ+m9qO3hLBi/6F9M+1upETvBQ==";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function home(serial, name) {
  return {
    serial,
    name,
    online: true,
    owner: true,
    model: "Sprut.hub 2",
    version: { current: { version: "3.0.0b", revision: "20131" } },
  };
}

async function startHub(
  t,
  {
    outcome = "challenge",
    homes,
    dropFirstConnection = false,
    delayFirstConnection = false,
    nullFirstAuth = false,
    nullFirstRoomList = false,
    sendForeignFrames = false,
  } = {},
) {
  const availableHomes = homes ?? [home("home/A", "Основной дом")];
  const requests = [];
  let connectionCount = 0;
  let nullAuthSent = false;
  let nullRoomListSent = false;
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    connectionCount += 1;
    const dropThisConnection = dropFirstConnection && connectionCount === 1;
    const delayThisConnection = delayFirstConnection && connectionCount === 1;
    let stage = "new";
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      if (dropThisConnection) {
        socket.close();
        return;
      }
      const params = request.params;
      if (params.account?.auth) {
        assert.equal("token" in request, false);
        assert.equal("serial" in request, false);
        assert.deepEqual(params.account.auth, { params: [] });
        if (nullFirstAuth && !nullAuthSent) {
          nullAuthSent = true;
          socket.send("null");
          return;
        }
        if (sendForeignFrames) sendUnrelatedFrames(socket, request.id);
        if (delayThisConnection) {
          answer(socket, request.id, "auth", {
            status: "ACCOUNT_RESPONSE_TOO_FAST",
            question: { type: "QUESTION_TYPE_EMAIL", delay: 1 },
          });
          return;
        }
        stage = "email";
        answer(socket, request.id, "auth", {
          status: "ACCOUNT_RESPONSE_SUCCESS",
          question: { type: "QUESTION_TYPE_EMAIL" },
        });
        return;
      }
      if (params.account?.answer) {
        assert.equal("token" in request, false);
        assert.equal("serial" in request, false);
        const data = params.account.answer.data;
        if (stage === "email") {
          assert.equal(data, login);
          stage = "password";
          answer(socket, request.id, "answer", {
            status: "ACCOUNT_RESPONSE_SUCCESS",
            question: { type: "QUESTION_TYPE_PASSWORD" },
          });
          return;
        }
        if (stage === "password") {
          assert.equal(data, password);
          if (outcome === "rejected") {
            stage = "terminal";
            answer(socket, request.id, "answer", {
              status: "ACCOUNT_RESPONSE_FAILED",
              label: `rejected ${password}`,
            });
            return;
          }
          if (outcome === "enroll") {
            stage = "terminal";
            answer(socket, request.id, "answer", {
              status: "ACCOUNT_RESPONSE_SUCCESS",
              question: {
                type: "QUESTION_TYPE_ENROLL",
                data: `private enrollment ${password}`,
              },
              label: `enroll ${login}`,
            });
            return;
          }
          stage = "challenge";
          answer(socket, request.id, "answer", {
            status: "ACCOUNT_RESPONSE_SUCCESS",
            question: {
              type: "QUESTION_TYPE_CHALLENGE",
              data: JSON.stringify(challengeData),
            },
          });
          return;
        }
        assert.equal(stage, "challenge");
        assert.equal(data, expectedChallengeAnswer);
        stage = "authenticated";
        answer(socket, request.id, "answer", {
          status: "ACCOUNT_RESPONSE_SUCCESS",
          token,
        });
        return;
      }
      assert.equal(request.token, token);
      if (params.hub?.list) {
        assert.equal("serial" in request, false);
        reply(socket, request.id, {
          hub: { list: { hubs: availableHomes } },
        });
        return;
      }
      const selected = availableHomes.find(
        ({ serial }) => serial === request.serial,
      );
      assert(selected, `unexpected home serial ${request.serial}`);
      if (params.room?.list) {
        if (nullFirstRoomList && !nullRoomListSent) {
          nullRoomListSent = true;
          socket.send("null");
          return;
        }
        if (sendForeignFrames) sendUnrelatedFrames(socket, request.id);
        reply(socket, request.id, {
          room: { list: { rooms: [{ id: 1, name: "Офис" }] } },
        });
        return;
      }
      if (params.room?.get) {
        reply(socket, request.id, {
          room: { get: { id: 1, name: "Офис" } },
        });
        return;
      }
      if (params.accessory?.list) {
        reply(socket, request.id, {
          accessory: {
            list: {
              accessories: [
                {
                  id: 7,
                  roomId: 1,
                  name: "Термометр",
                  online: true,
                  services: [
                    {
                      aId: 7,
                      sId: 8,
                      name: "Климат",
                      type: "TemperatureSensor",
                      characteristics: [
                        {
                          aId: 7,
                          sId: 8,
                          cId: 9,
                          control: {
                            name: "Температура",
                            type: "CurrentTemperature",
                            read: true,
                            write: false,
                            events: true,
                            unit: "celsius",
                            value: { doubleValue: 22.5 },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        });
        return;
      }
      if (params.scenario?.list) {
        reply(socket, request.id, { scenario: { list: { scenarios: [] } } });
        return;
      }
      if (params.extension?.list) {
        reply(socket, request.id, {
          extension: { list: { extensions: [] } },
        });
        return;
      }
      assert.fail(`unsupported request ${JSON.stringify(params)}`);
    });
  });

  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    get connectionCount() {
      return connectionCount;
    },
  };
}

async function startStalledHandshake(t) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `ws://127.0.0.1:${server.address().port}` };
}

function answer(socket, id, operation, response) {
  reply(socket, id, { account: { [operation]: response } });
}

function reply(socket, id, result) {
  socket.send(JSON.stringify({ id, result }));
}

function sendUnrelatedFrames(socket, requestId) {
  socket.send(JSON.stringify({ params: { event: { update: {} } } }));
  reply(socket, requestId + 10_000, {});
}

async function startClient(
  t,
  hub,
  sessionFile,
  { timeoutMs = "1000", serial } = {},
) {
  const connectionFile = path.join(path.dirname(sessionFile), "connection.env");
  await writeFile(
    connectionFile,
    `SPRUTHUB_LOGIN=${login}\nSPRUTHUB_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      `--env-file=${connectionFile}`,
      path.join(projectRoot, "src", "server.mjs"),
    ],
    cwd: path.dirname(sessionFile),
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUT_AGENT_SESSION_FILE: sessionFile,
      SPRUTHUB_TIMEOUT_MS: timeoutMs,
      SPRUT_AGENT_STATE_DIR: path.join(path.dirname(sessionFile), "changes"),
      ...(serial ? { SPRUTHUB_SERIAL: serial } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "login-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function startInstalledProfileClient(t, configRoot, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "dist", "plugin", "dist", "server.mjs")],
    cwd: path.dirname(configRoot),
    env: {
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: configRoot,
      SPRUTHUB_TIMEOUT_MS: "1000",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "installed-profile-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

async function withSessionPath(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "sprut-login-test-"));
  t.after(() => rm(directory, { recursive: true }));
  return path.join(directory, "session.json");
}

function readRoomServices(client, roomRef) {
  return client.callTool({
    name: "read_services",
    arguments: {
      home_ref: roomRef.replace(/\/room\/\d+$/, ""),
      room_ref: roomRef,
      max_bytes: 32_768,
    },
  });
}

test("the checkout MCP config returns credential setup and reads a configured home", async (t) => {
  const hub = await startHub(t);
  const directory = await mkdtemp(path.join(tmpdir(), "sprut empty profile-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "xdg config");
  const checkoutConfig = JSON.parse(
    await readFile(path.join(projectRoot, ".mcp.json"), "utf8"),
  ).mcpServers["sprut-agent"];
  const launch = {
    command: checkoutConfig.command,
    args: checkoutConfig.args,
    cwd: path.resolve(projectRoot, checkoutConfig.cwd),
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: configRoot,
    },
    stderr: "pipe",
  };
  const transport = new StdioClientTransport(launch);
  const client = new Client({ name: "empty-profile-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const result = await client.callTool({ name: "list_homes", arguments: {} });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "configuration");
  assert.equal(result.structuredContent.error.action, "configure_credentials");
  const connectionFile = path.join(configRoot, "sprut-agent", "connection.env");
  const credentialSetup = {
    file: connectionFile,
    required_fields: ["SPRUTHUB_LOGIN", "SPRUTHUB_PASSWORD"],
    permissions: "0600",
    restart: "Restart the same MCP application after saving the file.",
    secret_handling:
      "Create and fill the file locally; do not send credentials in chat.",
  };
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      `SPRUTHUB_LOGIN='${login}'`,
      `SPRUTHUB_PASSWORD='${password}'`,
      `SPRUTHUB_URL='${hub.url}'`,
      "SPRUTHUB_SERIAL=home/A",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const configuredTransport = new StdioClientTransport(launch);
  const configuredClient = new Client({
    name: "configured-profile-test",
    version: "1.0.0",
  });
  await configuredClient.connect(configuredTransport);
  t.after(() => configuredClient.close());
  const homes = await configuredClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.equal(homes.structuredContent.homes[0].ref, "spruthub://hub/home%2FA");
  const room = await readRoomServices(
    configuredClient,
    "spruthub://hub/home%2FA/room/1",
  );
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.equal(room.structuredContent.services[0].accessory.name, "Термометр");
  assert.equal(room.structuredContent.services[0].readings[0].value, 22.5);
  assert.deepEqual(result.structuredContent.credential_setup, credentialSetup);
  assert.equal(
    result.structuredContent.error.message,
    `Configure SprutHub locally: create '${connectionFile}' with SPRUTHUB_LOGIN and SPRUTHUB_PASSWORD, set mode 0600, then restart the same MCP application. Do not send credential values in chat.`,
  );
  assert.equal(JSON.stringify(result).includes("/absolute/path"), false);

  await client.close();
  const authAnswers = hub.requests.filter(
    ({ params }) => params.account?.answer,
  ).length;
  await configuredClient.close();

  const restartedTransport = new StdioClientTransport(launch);
  const restartedClient = new Client({
    name: "restarted-profile-test",
    version: "1.0.0",
  });
  await restartedClient.connect(restartedTransport);
  t.after(() => restartedClient.close());
  const restartedHomes = await restartedClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(
    restartedHomes.isError,
    undefined,
    restartedHomes.content[0]?.text,
  );
  assert.equal(
    restartedHomes.structuredContent.homes[0].ref,
    "spruthub://hub/home%2FA",
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.answer).length,
    authAnswers,
    "the next process must reuse the saved session instead of logging in again",
  );
  const publicResult = JSON.stringify(result);
  for (const secret of [login, password, token]) {
    assert.equal(publicResult.includes(secret), false);
  }
});

test("an installed multi-home profile explains and completes explicit home selection", async (t) => {
  const hub = await startHub(t, {
    homes: [home("home/A", "Дом A"), home("home B", "Дом B")],
  });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut multi-home-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "config");
  const connectionFile = path.join(configRoot, "sprut-agent", "connection.env");
  await mkdir(path.dirname(connectionFile), { recursive: true });
  const baseProfile = [
    `SPRUTHUB_LOGIN=${login}`,
    `SPRUTHUB_PASSWORD=${password}`,
    `SPRUTHUB_URL=${hub.url}`,
  ];
  await writeFile(connectionFile, `${baseProfile.join("\n")}\n`, {
    mode: 0o600,
  });

  const client = await startInstalledProfileClient(t, configRoot);
  await client.listTools();
  const blocked = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error.code, "home_selection_required");
  assert.equal(blocked.structuredContent.error.action, "list_homes");
  assert.deepEqual(blocked.structuredContent.next, {
    tool: "list_homes",
    arguments: {},
  });

  const homes = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.deepEqual(homes.structuredContent.selection.options, [
    { home_ref: "spruthub://hub/home%2FA", pin_value: "home/A" },
    { home_ref: "spruthub://hub/home%20B", pin_value: "home B" },
  ]);
  assert.deepEqual(homes.structuredContent.selection.pin, {
    file: connectionFile,
    field: "SPRUTHUB_SERIAL",
    permissions: "0600",
    restart: "Restart the same MCP application after saving the file.",
  });
  await client.close();

  await writeFile(
    connectionFile,
    `${[...baseProfile, "SPRUTHUB_SERIAL=home B"].join("\n")}\n`,
    { mode: 0o600 },
  );
  const restarted = await startInstalledProfileClient(t, configRoot);
  const selectedHomes = await restarted.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.deepEqual(selectedHomes.structuredContent.selection, {
    required: false,
    default_home_ref: "spruthub://hub/home%20B",
    options: [
      { home_ref: "spruthub://hub/home%2FA", pin_value: "home/A" },
      { home_ref: "spruthub://hub/home%20B", pin_value: "home B" },
    ],
  });
  const rooms = await restarted.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(rooms.isError, undefined, rooms.content[0]?.text);
  assert.equal(
    rooms.structuredContent.rooms[0].ref,
    "spruthub://hub/home%20B/room/1",
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).at(-1).serial,
    "home B",
  );
});

test("installed list_rooms preserves a delayed login and a later user retry", async (t) => {
  const hub = await startHub(t, { delayFirstConnection: true });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut delayed-login-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "config");
  const connectionFile = path.join(configRoot, "sprut-agent", "connection.env");
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      `SPRUTHUB_LOGIN=${login}`,
      `SPRUTHUB_PASSWORD=${password}`,
      `SPRUTHUB_URL=${hub.url}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const client = await startInstalledProfileClient(t, configRoot);
  await client.listTools();
  const delayed = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(delayed.isError, true);
  assert.equal(delayed.structuredContent.error.code, "authentication_delayed");
  assert.equal(delayed.structuredContent.error.action, "retry_login_later");
  assert.equal(delayed.structuredContent.retry_after_seconds, 1);

  const recovered = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.rooms[0].name, "Офис");
});

test("an invalid file pin keeps the home catalog and explicit reads available", async (t) => {
  const hub = await startHub(t, {
    homes: [home("home/A", "Дом A"), home("home B", "Дом B")],
  });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut invalid-pin-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "config");
  const connectionFile = path.join(configRoot, "sprut-agent", "connection.env");
  await mkdir(path.dirname(connectionFile), { recursive: true });
  const profile = [
    `SPRUTHUB_LOGIN=${login}`,
    `SPRUTHUB_PASSWORD=${password}`,
    `SPRUTHUB_URL=${hub.url}`,
  ];
  await writeFile(
    connectionFile,
    `${[...profile, "SPRUTHUB_SERIAL=missing-home"].join("\n")}\n`,
    { mode: 0o600 },
  );

  const client = await startInstalledProfileClient(t, configRoot);
  const blocked = await client.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.error.code, "home_selection_required");
  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(catalog.structuredContent.selection.options, [
    { home_ref: "spruthub://hub/home%2FA", pin_value: "home/A" },
    { home_ref: "spruthub://hub/home%20B", pin_value: "home B" },
  ]);
  assert.equal(catalog.structuredContent.selection.pin.file, connectionFile);

  const explicit = await client.callTool({
    name: "inspect_home",
    arguments: { home_ref: "spruthub://hub/home%20B" },
  });
  assert.equal(explicit.isError, undefined, explicit.content[0]?.text);
  assert.equal(explicit.structuredContent.home.ref, "spruthub://hub/home%20B");
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).at(-1).serial,
    "home B",
  );
  await client.close();

  await writeFile(
    connectionFile,
    `${[...profile, "SPRUTHUB_SERIAL=home B"].join("\n")}\n`,
    { mode: 0o600 },
  );
  const restarted = await startInstalledProfileClient(t, configRoot);
  const rooms = await restarted.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(rooms.isError, undefined, rooms.content[0]?.text);
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).at(-1).serial,
    "home B",
  );
});

test("an invalid pin for one home still exposes the exact replacement", async (t) => {
  const hub = await startHub(t);
  const client = await startClient(t, hub, await withSessionPath(t), {
    serial: "missing-home",
  });

  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(catalog.structuredContent.selection, {
    required: true,
    reason: "configured_home_unavailable",
    options: [{ home_ref: "spruthub://hub/home%2FA", pin_value: "home/A" }],
    pin: {
      source: "environment",
      field: "SPRUTHUB_SERIAL",
      restart:
        "Set SPRUTHUB_SERIAL in the same MCP launch environment, then restart the MCP application.",
    },
  });
});

test("an empty file pin is treated as no selection for a single home", async (t) => {
  const hub = await startHub(t);
  const directory = await mkdtemp(path.join(tmpdir(), "sprut empty-pin-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "config");
  const connectionFile = path.join(configRoot, "sprut-agent", "connection.env");
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      `SPRUTHUB_LOGIN=${login}`,
      `SPRUTHUB_PASSWORD=${password}`,
      `SPRUTHUB_URL=${hub.url}`,
      "SPRUTHUB_SERIAL=",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const client = await startInstalledProfileClient(t, configRoot);
  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(catalog.structuredContent.selection, {
    required: false,
    default_home_ref: "spruthub://hub/home%2FA",
  });
  const rooms = await client.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(rooms.isError, undefined, rooms.content[0]?.text);
});

test("an account without homes returns a terminal catalog outcome", async (t) => {
  const hub = await startHub(t, { homes: [] });
  const client = await startClient(t, hub, await withSessionPath(t));

  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(catalog.structuredContent.selection, {
    required: false,
    reason: "no_available_homes",
  });
  const rooms = await client.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(rooms.isError, true);
  assert.equal(rooms.structuredContent.error.code, "no_homes_available");
  assert.equal(rooms.structuredContent.error.action, "check_home_access");
});

test("a complete MCP environment points home selection back to that environment", async (t) => {
  const hub = await startHub(t, {
    homes: [home("home/A", "Дом A"), home("home B", "Дом B")],
  });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut env-pin-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "config");
  const connectionEnv = {
    SPRUTHUB_LOGIN: login,
    SPRUTHUB_PASSWORD: password,
    SPRUTHUB_URL: hub.url,
  };

  const client = await startInstalledProfileClient(
    t,
    configRoot,
    connectionEnv,
  );
  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(catalog.structuredContent.selection.pin, {
    source: "environment",
    field: "SPRUTHUB_SERIAL",
    restart:
      "Set SPRUTHUB_SERIAL in the same MCP launch environment, then restart the MCP application.",
  });
  await client.close();

  const restarted = await startInstalledProfileClient(t, configRoot, {
    ...connectionEnv,
    SPRUTHUB_SERIAL: "home B",
  });
  const rooms = await restarted.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(rooms.isError, undefined, rooms.content[0]?.text);
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).at(-1).serial,
    "home B",
  );
});

test("an environment home pin wins over credentials loaded from the profile", async (t) => {
  const hub = await startHub(t, {
    homes: [home("home/A", "Дом A"), home("home B", "Дом B")],
  });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut mixed-pin-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, "config");
  const connectionFile = path.join(configRoot, "sprut-agent", "connection.env");
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      `SPRUTHUB_LOGIN=${login}`,
      `SPRUTHUB_PASSWORD=${password}`,
      `SPRUTHUB_URL=${hub.url}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const client = await startInstalledProfileClient(t, configRoot, {
    SPRUTHUB_SERIAL: "missing-home",
  });
  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.equal(
    catalog.structuredContent.selection.reason,
    "configured_home_unavailable",
  );
  assert.deepEqual(catalog.structuredContent.selection.pin, {
    source: "environment",
    field: "SPRUTHUB_SERIAL",
    restart:
      "Set SPRUTHUB_SERIAL in the same MCP launch environment, then restart the MCP application.",
  });
  await client.close();

  const restarted = await startInstalledProfileClient(t, configRoot, {
    SPRUTHUB_SERIAL: "home B",
  });
  const rooms = await restarted.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(rooms.isError, undefined, rooms.content[0]?.text);
  assert.equal(
    rooms.structuredContent.rooms[0].ref,
    "spruthub://hub/home%20B/room/1",
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.room?.list).at(-1).serial,
    "home B",
  );
});

test("a partial profile preserves safe credential guidance without reflecting credentials", async (t) => {
  const hub = await startHub(t);
  const cases = [
    {
      missingField: "SPRUTHUB_LOGIN",
      partialFile: "SPRUTHUB_PASSWORD=sprut\n",
      remainingCredential: "sprut",
    },
    {
      missingField: "SPRUTHUB_PASSWORD",
      partialFile: "SPRUTHUB_LOGIN=credential_setup\n",
      remainingCredential: "credential_setup",
    },
  ];

  for (const { missingField, partialFile, remainingCredential } of cases) {
    const directory = await mkdtemp(
      path.join(tmpdir(), `sprut agent's partial ${missingField}-`),
    );
    t.after(() => rm(directory, { recursive: true }));
    const connectionFile = path.join(
      directory,
      ".config",
      "sprut-agent",
      "connection.env",
    );
    await mkdir(path.dirname(connectionFile), { recursive: true });
    await writeFile(connectionFile, partialFile, { mode: 0o600 });
    const launch = {
      command: process.execPath,
      args: [path.join(projectRoot, "src", "server.mjs")],
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory },
      stderr: "pipe",
    };
    const transport = new StdioClientTransport(launch);
    const client = new Client({
      name: `partial-${missingField.toLowerCase()}-test`,
      version: "1.0.0",
    });
    await client.connect(transport);
    t.after(() => client.close());

    const result = await client.callTool({
      name: "list_homes",
      arguments: {},
    });
    const credentialSetup = {
      file: connectionFile,
      required_fields: ["SPRUTHUB_LOGIN", "SPRUTHUB_PASSWORD"],
      permissions: "0600",
      restart: "Restart the same MCP application after saving the file.",
      secret_handling:
        "Create and fill the file locally; do not send credentials in chat.",
    };
    const expected = {
      status: "error",
      credential_setup: credentialSetup,
      missing_field: missingField,
      error: {
        code: "configuration",
        message: `Configure SprutHub locally: create ${shellQuote(connectionFile)} with SPRUTHUB_LOGIN and SPRUTHUB_PASSWORD, set mode 0600, then restart the same MCP application. Do not send credential values in chat.`,
        retryable: false,
        action: "configure_credentials",
      },
    };

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, expected);
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    assert.equal(
      responseStringValues(result.structuredContent).includes(
        remainingCredential,
      ),
      false,
      "the configured credential value must not be reflected as response data",
    );

    await client.close();
    await mkdir(path.dirname(connectionFile), { recursive: true });
    await writeFile(
      connectionFile,
      [
        `SPRUTHUB_LOGIN=${login}`,
        `SPRUTHUB_PASSWORD=${password}`,
        `SPRUTHUB_URL=${hub.url}`,
        "SPRUTHUB_SERIAL=home/A",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const configuredTransport = new StdioClientTransport(launch);
    const configuredClient = new Client({
      name: `completed-${missingField.toLowerCase()}-test`,
      version: "1.0.0",
    });
    await configuredClient.connect(configuredTransport);
    t.after(() => configuredClient.close());
    const homes = await configuredClient.callTool({
      name: "list_homes",
      arguments: {},
    });
    assert.equal(homes.isError, undefined, homes.content[0]?.text);
    assert.equal(
      homes.structuredContent.homes[0].ref,
      "spruthub://hub/home%2FA",
    );
  }
});

function responseStringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(responseStringValues);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(responseStringValues);
}

test("explicit connection environment wins over conflicting file values", async (t) => {
  const hub = await startHub(t);
  const directory = await mkdtemp(path.join(tmpdir(), "sprut env precedence-"));
  t.after(() => rm(directory, { recursive: true }));
  const connectionFile = path.join(
    directory,
    ".config",
    "sprut-agent",
    "connection.env",
  );
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      "SPRUTHUB_LOGIN=file-login@example.invalid",
      "SPRUTHUB_PASSWORD=file-password",
      "SPRUTHUB_TOKEN=file-token",
      "SPRUTHUB_URL=ws://127.0.0.1:1",
      "SPRUTHUB_SERIAL=file-home",
      "SPRUTHUB_CID=file-client",
      "UNSUPPORTED_CONNECTION_KEY=must-not-be-applied",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      SPRUTHUB_LOGIN: login,
      SPRUTHUB_PASSWORD: password,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: "home/A",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "env-precedence-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  t.after(() => client.close());

  const homes = await client.callTool({ name: "list_homes", arguments: {} });

  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.equal(homes.structuredContent.homes[0].ref, "spruthub://hub/home%2FA");
  const room = await readRoomServices(client, "spruthub://hub/home%2FA/room/1");
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.equal(room.structuredContent.services[0].readings[0].value, 22.5);
});

test("complete explicit credentials ignore an unsafe default file", async (t) => {
  for (const source of [
    "login environment",
    "login node --env-file",
    "token environment",
  ]) {
    await t.test(source, async (t) => {
      const hub = await startHub(t);
      const directory = await mkdtemp(
        path.join(tmpdir(), "sprut explicit profile-"),
      );
      t.after(() => rm(directory, { recursive: true }));
      const connectionFile = path.join(
        directory,
        ".config",
        "sprut-agent",
        "connection.env",
      );
      await mkdir(path.dirname(connectionFile), { recursive: true });
      await writeFile(
        connectionFile,
        [
          "SPRUTHUB_TOKEN=unrelated-file-token",
          "SPRUTHUB_URL=ws://127.0.0.1:1",
          "SPRUTHUB_SERIAL=unrelated-file-home",
          "SPRUTHUB_CID=unrelated-file-client",
          "",
        ].join("\n"),
      );
      await chmod(connectionFile, 0o644);

      const explicitEnvironment = source.startsWith("token")
        ? {
            SPRUTHUB_TOKEN: token,
            SPRUTHUB_URL: hub.url,
            SPRUTHUB_SERIAL: "home/A",
            SPRUTHUB_CID: "explicit-token-client",
          }
        : {
            SPRUTHUB_LOGIN: login,
            SPRUTHUB_PASSWORD: password,
            SPRUTHUB_URL: hub.url,
            SPRUTHUB_SERIAL: "home/A",
          };
      const args = [path.join(projectRoot, "src", "server.mjs")];
      if (source.endsWith("node --env-file")) {
        const explicitFile = path.join(directory, "explicit.env");
        await writeFile(
          explicitFile,
          Object.entries(explicitEnvironment)
            .map(([name, value]) => `${name}=${value}`)
            .join("\n"),
        );
        await chmod(explicitFile, 0o600);
        args.unshift(`--env-file=${explicitFile}`);
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          ...(source.endsWith("environment") ? explicitEnvironment : {}),
        },
        stderr: "pipe",
      });
      const client = new Client({
        name: "explicit-profile-test",
        version: "1.0.0",
      });
      await client.connect(transport);
      t.after(() => client.close());

      const homes = await client.callTool({
        name: "list_homes",
        arguments: {},
      });
      assert.equal(homes.isError, undefined, homes.content[0]?.text);
      const room = await readRoomServices(
        client,
        "spruthub://hub/home%2FA/room/1",
      );
      assert.equal(room.isError, undefined, room.content[0]?.text);
      assert.equal(room.structuredContent.services[0].readings[0].value, 22.5);
    });
  }
});

test("an incomplete explicit profile uses the file without replacing an empty value", async (t) => {
  const hub = await startHub(t);
  const directory = await mkdtemp(
    path.join(tmpdir(), "sprut incomplete profile-"),
  );
  t.after(() => rm(directory, { recursive: true }));
  const connectionFile = path.join(
    directory,
    ".config",
    "sprut-agent",
    "connection.env",
  );
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      `SPRUTHUB_LOGIN=${login}`,
      `SPRUTHUB_PASSWORD=${password}`,
      "SPRUTHUB_URL=ws://127.0.0.1:1",
      "SPRUTHUB_SERIAL=file-home",
      "",
    ].join("\n"),
  );
  await chmod(connectionFile, 0o600);
  const launch = (extraEnv = {}) => ({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_SERIAL: "home/A",
      ...extraEnv,
    },
    stderr: "pipe",
  });

  const partialClient = new Client({
    name: "incomplete-profile-test",
    version: "1.0.0",
  });
  await partialClient.connect(new StdioClientTransport(launch()));
  const homes = await partialClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  await partialClient.close();

  const connectionCount = hub.connectionCount;
  const emptyClient = new Client({
    name: "empty-explicit-value-test",
    version: "1.0.0",
  });
  await emptyClient.connect(
    new StdioClientTransport(
      launch({
        SPRUTHUB_LOGIN: "",
        SPRUT_AGENT_SESSION_FILE: path.join(directory, "empty-session.json"),
      }),
    ),
  );
  t.after(() => emptyClient.close());
  const rejected = await emptyClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "configuration");
  assert.equal(
    rejected.structuredContent.error.action,
    "configure_credentials",
  );
  assert.equal(rejected.structuredContent.missing_field, "SPRUTHUB_LOGIN");
  assert.equal(hub.connectionCount, connectionCount);
});

test("an unsafe credential file returns one fixable local error", async (t) => {
  const hub = await startHub(t);
  const directory = await mkdtemp(path.join(tmpdir(), "sprut unsafe profile-"));
  t.after(() => rm(directory, { recursive: true }));
  const connectionFile = path.join(
    directory,
    ".config",
    "sprut-agent",
    "connection.env",
  );
  await mkdir(path.dirname(connectionFile), { recursive: true });
  await writeFile(
    connectionFile,
    [
      `SPRUTHUB_LOGIN=${login}`,
      `SPRUTHUB_PASSWORD=${password}`,
      `SPRUTHUB_URL=${hub.url}`,
      "",
    ].join("\n"),
  );
  await chmod(connectionFile, 0o644);
  const launch = {
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory },
    stderr: "pipe",
  };
  const transport = new StdioClientTransport(launch);
  const client = new Client({ name: "unsafe-profile-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const failed = await client.callTool({ name: "list_homes", arguments: {} });

  assert.equal(failed.isError, true);
  assert.equal(
    failed.structuredContent.error.code,
    "credential_file_unavailable",
  );
  assert.equal(failed.structuredContent.error.action, "fix_credential_file");
  assert.equal(failed.structuredContent.credential_setup.file, connectionFile);
  assert.match(failed.structuredContent.error.message, /mode 0600/);
  assert.equal(hub.connectionCount, 0);

  await client.close();
  await chmod(connectionFile, 0o600);
  const repairedTransport = new StdioClientTransport(launch);
  const repairedClient = new Client({
    name: "repaired-profile-test",
    version: "1.0.0",
  });
  await repairedClient.connect(repairedTransport);
  t.after(() => repairedClient.close());
  const repaired = await repairedClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(repaired.isError, undefined, repaired.content[0]?.text);
  assert.equal(
    repaired.structuredContent.homes[0].ref,
    "spruthub://hub/home%2FA",
  );
});

test("challenge login serves concurrent public reads and a restart reuses the session", async (t) => {
  const hub = await startHub(t, { sendForeignFrames: true });
  const sessionFile = await withSessionPath(t);
  const client = await startClient(t, hub, sessionFile);

  const [catalog, overview] = await Promise.all([
    client.callTool({ name: "list_homes", arguments: {} }),
    client.callTool({
      name: "inspect_home",
      arguments: { home_ref: "spruthub://hub/home%2FA" },
    }),
  ]);
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.equal(overview.isError, undefined, overview.content[0]?.text);
  const room = await readRoomServices(client, "spruthub://hub/home%2FA/room/1");
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.equal(room.structuredContent.services[0].readings[0].value, 22.5);

  const authRequests = hub.requests.filter(({ params }) => params.account);
  assert.equal(
    authRequests.filter(({ params }) => params.account.auth).length,
    1,
  );
  assert.equal(
    authRequests.filter(({ params }) => params.account.answer).length,
    3,
  );
  const saved = await readFile(sessionFile, "utf8");
  assert.equal(saved.includes(login), false);
  assert.equal(saved.includes(password), false);
  assert.equal(saved.includes(expectedChallengeAnswer), false);
  assert.equal(saved.includes(token), true);
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

  await client.close();
  const restarted = await startClient(t, hub, sessionFile);
  const restartedCatalog = await restarted.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(
    restartedCatalog.isError,
    undefined,
    restartedCatalog.content[0]?.text,
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.auth).length,
    1,
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.answer).length,
    3,
  );
});

test("a rejected password stops once without exposing authentication data", async (t) => {
  const hub = await startHub(t, { outcome: "rejected" });
  const client = await startClient(t, hub, await withSessionPath(t));
  const result = await client.callTool({ name: "list_homes", arguments: {} });
  const repeated = await client.callTool({
    name: "list_homes",
    arguments: {},
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "authentication_failed");
  assert.equal(repeated.structuredContent.error.code, "authentication_failed");
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.auth).length,
    1,
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.answer).length,
    2,
  );
  const publicResult = JSON.stringify(result);
  for (const secret of [login, password, token]) {
    assert.equal(publicResult.includes(secret), false);
  }
});

test("a password loaded from the default file stays hidden in a hub rejection", async (t) => {
  const hub = await startHub(t, { outcome: "rejected" });
  const directory = await mkdtemp(path.join(tmpdir(), "sprut file redaction-"));
  t.after(() => rm(directory, { recursive: true }));
  const configRoot = path.join(directory, ".config");
  await mkdir(path.join(configRoot, "sprut-agent"), { recursive: true });
  await writeFile(
    path.join(configRoot, "sprut-agent", "connection.env"),
    `SPRUTHUB_LOGIN=${login}\nSPRUTHUB_PASSWORD=${password}\nSPRUTHUB_URL=${hub.url}\n`,
    { mode: 0o600 },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: configRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "file-redaction-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const result = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "authentication_failed");
  for (const secret of [login, password, token]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("password enrollment stops without answering on the user's behalf", async (t) => {
  const hub = await startHub(t, { outcome: "enroll" });
  const client = await startClient(t, hub, await withSessionPath(t));
  const result = await client.callTool({ name: "list_homes", arguments: {} });

  assert.equal(result.isError, true);
  assert.equal(
    result.structuredContent.error.code,
    "password_enrollment_required",
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.answer).length,
    2,
  );
  const publicResult = JSON.stringify(result);
  assert.equal(publicResult.includes("private enrollment"), false);
  assert.equal(publicResult.includes(login), false);
  assert.equal(publicResult.includes(password), false);
});

test("a write-bound home does not restrict explicit reads or follow their selection", async (t) => {
  const hub = await startHub(t, {
    homes: [home("home/A", "Дом A"), home("home B", "Дом B")],
  });
  const client = await startClient(t, hub, await withSessionPath(t), {
    serial: "home/A",
  });
  const catalog = await client.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);
  assert.deepEqual(catalog.structuredContent.selection, {
    required: false,
    default_home_ref: "spruthub://hub/home%2FA",
    options: [
      { home_ref: "spruthub://hub/home%2FA", pin_value: "home/A" },
      { home_ref: "spruthub://hub/home%20B", pin_value: "home B" },
    ],
  });

  const room = await readRoomServices(client, "spruthub://hub/home%20B/room/1");
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.equal(
    room.structuredContent.scope.room.ref,
    "spruthub://hub/home%20B/room/1",
  );
  assert.deepEqual(
    hub.requests
      .filter(
        ({ params }) => params.room?.get || params.accessory?.list?.roomId,
      )
      .map(({ serial }) => serial),
    ["home B", "home B"],
  );

  const defaultRooms = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(defaultRooms.isError, undefined, defaultRooms.content[0]?.text);
  assert.equal(
    defaultRooms.structuredContent.rooms[0].ref,
    "spruthub://hub/home%2FA/room/1",
  );

  const inaccessible = await readRoomServices(
    client,
    "spruthub://hub/home%20C/room/1",
  );
  assert.equal(inaccessible.isError, true);
  assert.equal(inaccessible.structuredContent.error.code, "home_not_found");
  assert.equal(
    hub.requests.some(
      ({ serial, params }) => serial === "home C" && params.room?.get,
    ),
    false,
  );

  const requestCount = hub.requests.length;
  const preview = await client.callTool({
    name: "preview_boolean_automation",
    arguments: {
      name: "Не создавать",
      reason: "Проверка границы",
      source_room_ref: "spruthub://hub/home%20B/room/1",
      source_characteristic_ref:
        "spruthub://hub/home%20B/accessory/7/service/8/characteristic/9",
      source_value: true,
      target_room_ref: "spruthub://hub/home%20B/room/1",
      target_characteristic_ref:
        "spruthub://hub/home%20B/accessory/7/service/8/characteristic/9",
      target_value: false,
    },
  });
  assert.equal(preview.isError, true);
  assert.equal(preview.structuredContent.error.code, "unsupported_home_write");
  assert.equal(hub.requests.length, requestCount);
});

test("a stalled WebSocket handshake returns a bounded error without killing MCP", async (t) => {
  const hub = await startStalledHandshake(t);
  const client = await startClient(t, hub, await withSessionPath(t), {
    timeoutMs: "150",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await client.callTool({ name: "list_homes", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "timeout");
    assert.equal(result.structuredContent.error.retryable, true);
  }
});

test("a new MCP call starts a fresh auth flow after transport recovery", async (t) => {
  const hub = await startHub(t, { dropFirstConnection: true });
  const client = await startClient(t, hub, await withSessionPath(t));

  const failed = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.error.code, "connection_closed");
  assert.equal(failed.structuredContent.error.retryable, true);

  const recovered = await client.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.homes.length, 1);
  assert.equal(hub.connectionCount, 3);
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.auth).length,
    2,
  );
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.answer).length,
    3,
  );
});

test("a server delay allows a fresh user-initiated auth flow", async (t) => {
  const hub = await startHub(t, { delayFirstConnection: true });
  const client = await startClient(t, hub, await withSessionPath(t));

  const delayed = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(delayed.isError, true);
  assert.equal(delayed.structuredContent.error.code, "authentication_delayed");
  assert.equal(delayed.structuredContent.error.retryable, true);
  assert.equal(delayed.structuredContent.retry_after_seconds, 1);

  const recovered = await client.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.auth).length,
    2,
  );
});

test("a null auth frame is contained and a later MCP call can recover", async (t) => {
  const hub = await startHub(t, { nullFirstAuth: true });
  const client = await startClient(t, hub, await withSessionPath(t));

  const invalid = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "invalid_message");
  assert.equal(invalid.structuredContent.error.retryable, true);

  const recovered = await client.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.homes.length, 1);
});

test("a null ordinary RPC frame does not kill MCP or block the next read", async (t) => {
  const hub = await startHub(t, { nullFirstRoomList: true });
  const client = await startClient(t, hub, await withSessionPath(t));
  const catalog = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(catalog.isError, undefined, catalog.content[0]?.text);

  const invalid = await client.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "invalid_message");
  assert.equal(invalid.structuredContent.error.retryable, true);

  const recovered = await client.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.rooms[0].name, "Офис");
});
