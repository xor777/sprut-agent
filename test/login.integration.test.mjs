import assert from "node:assert/strict";
import { once } from "node:events";
import {
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

async function withSessionPath(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "sprut-login-test-"));
  t.after(() => rm(directory, { recursive: true }));
  return path.join(directory, "session.json");
}

test("an empty profile returns an executable local credential setup", async (t) => {
  const hub = await startHub(t);
  const directory = await mkdtemp(path.join(tmpdir(), "sprut empty profile-"));
  t.after(() => rm(directory, { recursive: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory },
    stderr: "pipe",
  });
  const client = new Client({ name: "empty-profile-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const result = await client.callTool({ name: "list_homes", arguments: {} });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "configuration");
  assert.equal(result.structuredContent.error.action, "configure_credentials");
  const connectionFile = path.join(
    directory,
    ".config",
    "sprut-agent",
    "connection.env",
  );
  const launch = `'${process.execPath}' --env-file='${connectionFile}' '${path.join(projectRoot, "src", "server.mjs")}'`;
  const credentialSetup = {
    file: connectionFile,
    required_fields: ["SPRUTHUB_LOGIN", "SPRUTHUB_PASSWORD"],
    permissions: "0600",
    launch,
    secret_handling:
      "Create and fill the file locally; do not send credentials in chat.",
  };
  assert.deepEqual(result.structuredContent.credential_setup, credentialSetup);
  assert.equal(
    result.structuredContent.error.message,
    `Configure SprutHub locally: create '${connectionFile}' with SPRUTHUB_LOGIN and SPRUTHUB_PASSWORD, set mode 0600, then restart with ${launch}. Do not send credential values in chat.`,
  );
  assert.equal(JSON.stringify(result).includes("/absolute/path"), false);

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
  const configuredTransport = new StdioClientTransport({
    command: "/bin/sh",
    args: ["-c", credentialSetup.launch],
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory },
    stderr: "pipe",
  });
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
  const publicResult = JSON.stringify(result);
  for (const secret of [login, password, token]) {
    assert.equal(publicResult.includes(secret), false);
  }
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
  const room = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/home%2FA/room/1" },
  });
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.equal(
    room.structuredContent.devices[0].services[0].readings[0].value,
    22.5,
  );

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
  assert.equal(catalog.structuredContent.selection.required, true);

  const room = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/home%20B/room/1" },
  });
  assert.equal(room.isError, undefined, room.content[0]?.text);
  assert.equal(
    room.structuredContent.room.ref,
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

  const inaccessible = await client.callTool({
    name: "read_room",
    arguments: { room_ref: "spruthub://hub/home%20C/room/1" },
  });
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
