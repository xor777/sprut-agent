import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
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
const legacyCommit = "be527a92ed00c0f41b14d2e399bec2dc7891be33";

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
    stat(path.join(installedRoot, "dist", "read.mjs")),
    stat(path.join(installedRoot, "check-install.mjs")),
    stat(path.join(installedRoot, "skills", "spruthub-master", "SKILL.md")),
  ]);

  const effectiveTransport = await getEffectiveTransport(cli, installedRoot);
  const preservedNeighbor = JSON.parse(
    (await cli(["mcp", "get", "sprut", "--json"])).stdout,
  );
  assert.equal(preservedNeighbor.transport.command, "neighbor-command");
  assert.deepEqual(preservedNeighbor.transport.args, ["--keep-me"]);

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

  const firstClient = await startInstalledClient(effectiveTransport, userHome);
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

  const restartedTransport = await getEffectiveTransport(cli, installedRoot);
  const secondClient = await startInstalledClient(restartedTransport, userHome);
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

test("installation reports an occupied product MCP name and works after explicit recovery", {
  timeout: 30_000,
}, async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-plugin-conflict-"));
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

  const occupiedConfig = [
    "[mcp_servers.sprut-agent]",
    'command = "neighbor-command"',
    'args = ["--keep-me"]',
    'env = { SPRUTHUB_PASSWORD = "occupied-secret-must-stay-local" }',
    "",
  ].join("\n");
  const configFile = path.join(codexHome, "config.toml");
  await writeFile(configFile, occupiedConfig);
  const environment = {
    PATH: process.env.PATH,
    HOME: userHome,
    CODEX_HOME: codexHome,
    SPRUT_CODEX_BIN: codexBinary,
  };
  const cli = (args) =>
    run(codexBinary, args, {
      cwd: workspace,
      env: environment,
    });

  await cli(["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
  const installation = JSON.parse(
    (await cli(["plugin", "add", "sprut-agent@sprut-agent", "--json"])).stdout,
  );
  const checkScript = path.join(
    installation.installedPath,
    "check-install.mjs",
  );
  await assert.rejects(
    run(process.execPath, [checkScript, installation.installedPath], {
      cwd: workspace,
      env: environment,
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /MCP name "sprut-agent" is already occupied/);
      assert.match(error.stderr, /codex mcp remove sprut-agent/);
      assert.doesNotMatch(error.stderr, /occupied-secret-must-stay-local/);
      assert.doesNotMatch(error.stderr, /mcp get sprut-agent --json/);
      return true;
    },
  );
  assert.equal(
    (await readFile(configFile, "utf8")).includes(occupiedConfig),
    true,
  );

  await cli(["mcp", "remove", "sprut-agent"]);
  await run(process.execPath, [checkScript, installation.installedPath], {
    cwd: workspace,
    env: environment,
  });

  const installedRuntime = path.join(
    installation.installedPath,
    "dist",
    "server.mjs",
  );
  await rm(installedRuntime);
  await assert.rejects(
    run(process.execPath, [checkScript, installation.installedPath], {
      cwd: workspace,
      env: environment,
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /runtime is incomplete/);
      return true;
    },
  );
  await cp(
    path.join(marketplaceRoot, "dist", "plugin", "dist", "server.mjs"),
    installedRuntime,
  );

  const hub = await startHub(t);
  const connectionDirectory = path.join(userHome, ".config", "sprut-agent");
  await mkdir(connectionDirectory, { recursive: true });
  await writeFile(
    path.join(connectionDirectory, "connection.env"),
    [
      "SPRUTHUB_LOGIN=owner@example.invalid",
      "SPRUTHUB_PASSWORD=local-only-password",
      `SPRUTHUB_URL=${hub.url}`,
      "SPRUTHUB_TIMEOUT_MS=1000",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const effectiveTransport = await getEffectiveTransport(
    cli,
    installation.installedPath,
  );
  const client = await startInstalledClient(effectiveTransport, userHome);
  const homes = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.equal(homes.structuredContent.homes[0].name, "Дом");
  await client.close();
});

test("Codex completes the transition from the prior manual skill without removing it", {
  timeout: 30_000,
}, async (t) => {
  // Codex reports canonical paths; macOS tmpdir can use the /var symlink.
  const scratch = await realpath(
    await mkdtemp(path.join(tmpdir(), "sprut-plugin-transition-")),
  );
  const marketplaceRoot = path.join(scratch, "marketplace");
  const codexHome = path.join(scratch, "codex-home");
  const userHome = path.join(scratch, "user-home");
  const workspace = path.join(scratch, "workspace");
  const legacyCheckout = path.join(scratch, "legacy-checkout");
  const legacySkillDirectory = path.join(
    legacyCheckout,
    "skills",
    "spruthub-master",
  );
  const legacySkillFile = path.join(legacySkillDirectory, "SKILL.md");
  const userSkillDirectory = path.join(
    userHome,
    ".agents",
    "skills",
    "spruthub-master",
  );
  t.after(() => rm(scratch, { recursive: true }));
  await Promise.all([
    copyPluginSource(marketplaceRoot),
    mkdir(codexHome, { recursive: true }),
    mkdir(userHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(legacySkillDirectory, { recursive: true }),
    mkdir(path.dirname(userSkillDirectory), { recursive: true }),
  ]);
  const legacySkill = (
    await run(
      "git",
      ["show", `${legacyCommit}:skills/spruthub-master/SKILL.md`],
      { cwd: projectRoot },
    )
  ).stdout;
  await writeFile(legacySkillFile, legacySkill);
  await symlink(legacySkillDirectory, userSkillDirectory, "dir");

  const legacyConfig = [
    "[mcp_servers.sprut]",
    'command = "node"',
    'args = ["legacy-server.mjs"]',
    'env = { SPRUTHUB_PASSWORD = "legacy-secret-must-stay-local" }',
    "",
  ].join("\n");
  const configFile = path.join(codexHome, "config.toml");
  await writeFile(configFile, legacyConfig);
  const environment = {
    PATH: process.env.PATH,
    HOME: userHome,
    CODEX_HOME: codexHome,
    SPRUT_CODEX_BIN: codexBinary,
  };
  const cli = (args) =>
    run(codexBinary, args, {
      cwd: workspace,
      env: environment,
    });

  await cli(["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
  const installation = JSON.parse(
    (await cli(["plugin", "add", "sprut-agent@sprut-agent", "--json"])).stdout,
  );
  const checkScript = path.join(
    installation.installedPath,
    "check-install.mjs",
  );
  const before = await listCodexSkills(environment, workspace);
  const legacyBefore = before.find(
    (skill) => skill.name === "spruthub-master" && skill.pluginId == null,
  );
  const productBefore = before.find(
    (skill) => skill.pluginId === "sprut-agent@sprut-agent",
  );
  assert.equal(legacyBefore?.enabled, true);
  assert.equal(legacyBefore?.path, legacySkillFile);
  assert.equal(productBefore?.enabled, true);

  await assert.rejects(
    run(process.execPath, [checkScript, installation.installedPath], {
      cwd: workspace,
      env: environment,
    }),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /active prior manual skill/);
      assert.match(error.stderr, new RegExp(escapeRegExp(legacySkillFile)));
      assert.doesNotMatch(error.stderr, /legacy-secret-must-stay-local/);
      assert.equal(error.stdout.includes('"status":"ready"'), false);
      return true;
    },
  );

  await assert.rejects(
    run(
      process.execPath,
      [
        checkScript,
        installation.installedPath,
        "--disable-legacy-skill",
        productBefore.path,
      ],
      { cwd: workspace, env: environment },
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /selected path is not the prior manual/);
      return true;
    },
  );
  const unchangedAfterWrongSelection = await listCodexSkills(
    environment,
    workspace,
  );
  assert.equal(
    unchangedAfterWrongSelection.find(
      (skill) => skill.path === legacyBefore.path,
    )?.enabled,
    true,
  );
  assert.equal(
    unchangedAfterWrongSelection.find(
      (skill) => skill.path === productBefore.path,
    )?.enabled,
    true,
  );

  const recovery = await run(
    process.execPath,
    [
      checkScript,
      installation.installedPath,
      "--disable-legacy-skill",
      legacyBefore.path,
    ],
    { cwd: workspace, env: environment },
  );
  assert.match(recovery.stdout, /"status":"ready"/);
  const after = await listCodexSkills(environment, workspace);
  assert.equal(
    after.find((skill) => skill.path === legacyBefore.path)?.enabled,
    false,
  );
  assert.equal(
    after.find((skill) => skill.pluginId === "sprut-agent@sprut-agent")
      ?.enabled,
    true,
  );
  assert.equal((await lstat(userSkillDirectory)).isSymbolicLink(), true);
  assert.equal(await readlink(userSkillDirectory), legacySkillDirectory);
  assert.equal(await readFile(legacySkillFile, "utf8"), legacySkill);
  assert.equal(
    (await readFile(configFile, "utf8")).includes(legacyConfig),
    true,
  );

  const repeat = await run(
    process.execPath,
    [checkScript, installation.installedPath],
    { cwd: workspace, env: environment },
  );
  assert.match(repeat.stdout, /"status":"ready"/);

  const hub = await startHub(t);
  const connectionDirectory = path.join(userHome, ".config", "sprut-agent");
  await mkdir(connectionDirectory, { recursive: true });
  await writeFile(
    path.join(connectionDirectory, "connection.env"),
    [
      "SPRUTHUB_LOGIN=owner@example.invalid",
      "SPRUTHUB_PASSWORD=local-only-password",
      `SPRUTHUB_URL=${hub.url}`,
      "SPRUTHUB_TIMEOUT_MS=1000",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const effectiveTransport = await getEffectiveTransport(
    cli,
    installation.installedPath,
  );
  const client = await startInstalledClient(effectiveTransport, userHome);
  const homes = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(homes.isError, undefined, homes.content[0]?.text);
  assert.equal(
    homes.structuredContent.homes[0].ref,
    "spruthub://hub/installed-home",
  );
  await client.close();
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

async function getEffectiveTransport(cli, installedRoot) {
  const effective = JSON.parse(
    (await cli(["mcp", "get", "sprut-agent", "--json"])).stdout,
  );
  assert.equal(effective.name, "sprut-agent");
  assert.equal(effective.transport.type, "stdio");
  assert.equal(effective.transport.command, "node");
  assert.deepEqual(effective.transport.args, ["./dist/server.mjs"]);
  assert.equal(
    path.resolve(effective.transport.cwd),
    path.resolve(installedRoot),
    "Codex must resolve the product MCP to the installed plugin copy",
  );
  return effective.transport;
}

async function listCodexSkills(environment, cwd) {
  const child = spawn(codexBinary, ["app-server", "--stdio"], {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    child.stdin.write(
      `${JSON.stringify({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "sprut-install-test", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
    await readAppServerResponse(iterator, 0, stderr);
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "skills/list",
        params: { cwds: [cwd], forceReload: true },
      })}\n`,
    );
    const response = await readAppServerResponse(iterator, 1, stderr);
    return response.result.data.flatMap((entry) => entry.skills);
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

async function readAppServerResponse(iterator, id, stderr) {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) throw new Error(`Codex app-server stopped: ${stderr}`);
    const message = JSON.parse(value);
    if (message.id !== id) continue;
    if (message.error) {
      throw new Error(
        `Codex app-server request failed: ${message.error.message}`,
      );
    }
    return message;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function startInstalledClient(effectiveTransport, userHome) {
  const transport = new StdioClientTransport({
    command: effectiveTransport.command,
    args: effectiveTransport.args,
    cwd: effectiveTransport.cwd,
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
