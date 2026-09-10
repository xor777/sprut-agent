import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const run = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const codexBinary = process.env.SPRUT_TEST_CODEX_BIN ?? "codex";

test("Codex installs the complete plugin, reads the office, and keeps the connection on repeat", {
  timeout: 30_000,
}, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-plugin-install-"));
  const marketplaceRoot = path.join(scratch, "marketplace");
  const codexHome = path.join(scratch, "codex-home");
  const userHome = path.join(scratch, "user-home");
  const workspace = path.join(scratch, "workspace");
  t.after(() => rm(scratch, { recursive: true }));
  await Promise.all([
    copyPluginSource(marketplaceRoot),
    mkdir(codexHome, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);

  const neighboringConfig = [
    "[mcp_servers.sprut]",
    'command = "neighbor-command"',
    'args = ["--keep-me"]',
    "",
  ].join("\n");
  const configFile = path.join(codexHome, "config.toml");
  await writeFile(configFile, neighboringConfig);
  const cli = (args) =>
    run(codexBinary, args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: userHome,
        CODEX_HOME: codexHome,
      },
    });

  const addedMarketplace = JSON.parse(
    (await cli(["plugin", "marketplace", "add", marketplaceRoot, "--json"]))
      .stdout,
  );
  assert.equal(addedMarketplace.marketplaceName, "sprut-agent");
  assert.equal(
    (await cli(["plugin", "list", "--json"])).stdout.includes(
      '"pluginId": "sprut-agent@sprut-agent"',
    ),
    false,
    "a process stopped after adding the marketplace must remain resumable",
  );

  const firstInstall = JSON.parse(
    (await cli(["plugin", "add", "sprut-agent@sprut-agent", "--json"])).stdout,
  );
  const installedRoot = firstInstall.installedPath;
  assert.notEqual(path.resolve(installedRoot), path.resolve(marketplaceRoot));
  await Promise.all([
    stat(path.join(installedRoot, ".codex-plugin", "plugin.json")),
    stat(path.join(installedRoot, ".mcp.json")),
    stat(path.join(installedRoot, "dist", "server.mjs")),
    stat(path.join(installedRoot, "skills", "spruthub-master", "SKILL.md")),
  ]);

  const hub = await startHub(t);
  const configRoot = path.join(userHome, ".config");
  const connectionDirectory = path.join(configRoot, "sprut-agent");
  const connectionFile = path.join(connectionDirectory, "connection.env");
  await mkdir(connectionDirectory, { recursive: true });
  await writeFile(
    connectionFile,
    [
      "SPRUTHUB_LOGIN=owner@example.invalid",
      "SPRUTHUB_PASSWORD=local-only-password",
      `SPRUTHUB_URL=${hub.url}`,
      "SPRUTHUB_TIMEOUT_MS=1000",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await chmod(connectionFile, 0o600);

  const firstClient = await startInstalledClient(installedRoot, userHome);
  const homes = await firstClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.equal(
    homes.structuredContent.homes[0].ref,
    "spruthub://hub/installed-home",
  );
  const rooms = await firstClient.callTool({
    name: "list_rooms",
    arguments: {},
  });
  assert.equal(rooms.isError, undefined, rooms.content[0]?.text);
  assert.deepEqual(rooms.structuredContent.rooms, [
    { ref: "spruthub://hub/installed-home/room/1", name: "Офис" },
  ]);
  const office = await firstClient.callTool({
    name: "read_room",
    arguments: { room_ref: rooms.structuredContent.rooms[0].ref },
  });
  assert.equal(office.isError, undefined, office.content[0]?.text);
  assert.equal(
    office.structuredContent.devices[0].services[0].readings[0].value,
    22.5,
  );
  assert.equal(
    office.structuredContent.devices[0].services[0].readings[0].unit,
    "celsius",
  );
  await firstClient.close();

  const secondInstall = JSON.parse(
    (await cli(["plugin", "add", "sprut-agent@sprut-agent", "--json"])).stdout,
  );
  assert.equal(secondInstall.installedPath, installedRoot);
  const configAfterRepeat = await readFile(configFile, "utf8");
  assert.equal(configAfterRepeat.includes(neighboringConfig), true);
  assert.equal(
    configAfterRepeat.match(/\[plugins\."sprut-agent@sprut-agent"\]/g)?.length,
    1,
  );

  const secondClient = await startInstalledClient(installedRoot, userHome);
  const restartedHomes = await secondClient.callTool({
    name: "list_homes",
    arguments: {},
  });
  assert.equal(
    restartedHomes.isError,
    undefined,
    restartedHomes.content[0]?.text,
  );
  await secondClient.close();
  assert.equal(
    hub.requests.filter(({ params }) => params.account?.auth).length,
    1,
    "the next process must reuse the saved session",
  );
  const session = await readFile(
    path.join(configRoot, "sprut-agent", "session.json"),
    "utf8",
  );
  assert.equal(session.includes("local-only-password"), false);
});

async function copyPluginSource(destination) {
  await cp(projectRoot, destination, {
    recursive: true,
    filter(source) {
      const [topLevel] = path.relative(projectRoot, source).split(path.sep);
      return ![".git", "node_modules", "reports", "coverage"].includes(
        topLevel,
      );
    },
  });
}

async function startInstalledClient(installedRoot, userHome) {
  const manifest = JSON.parse(
    await readFile(path.join(installedRoot, ".mcp.json"), "utf8"),
  );
  const launch = manifest.mcpServers.sprut;
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    cwd: path.resolve(installedRoot, launch.cwd),
    env: {
      PATH: process.env.PATH,
      HOME: userHome,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "plugin-install-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function startHub(t) {
  const requests = [];
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      const params = request.params;
      if (params.account?.auth) {
        reply(socket, request.id, {
          account: {
            auth: {
              status: "ACCOUNT_RESPONSE_SUCCESS",
              token: "installed-session-token",
            },
          },
        });
        return;
      }
      assert.equal(request.token, "installed-session-token");
      if (params.hub?.list) {
        reply(socket, request.id, {
          hub: {
            list: {
              hubs: [
                {
                  serial: "installed-home",
                  name: "Дом",
                  online: true,
                  owner: true,
                  model: "Sprut.hub 2",
                  version: { current: { version: "3.0.0", revision: "1" } },
                },
              ],
            },
          },
        });
        return;
      }
      assert.equal(request.serial, "installed-home");
      if (params.room?.list) {
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
      assert.fail(`unsupported SprutHub request: ${JSON.stringify(params)}`);
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function reply(socket, id, result) {
  socket.send(JSON.stringify({ id, result }));
}
