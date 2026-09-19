import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("the common delivery starts outside the checkout without Codex", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-client-neutral-"));
  const installedRoot = path.join(scratch, "installed", "sprut-agent");
  const workspace = path.join(scratch, "workspace");
  const configRoot = path.join(scratch, "config");
  t.after(() => rm(scratch, { recursive: true }));
  await Promise.all([
    cp(path.join(projectRoot, "dist", "plugin"), installedRoot, {
      recursive: true,
    }),
    mkdir(workspace, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ]);

  const manifest = JSON.parse(
    await readFile(
      path.join(installedRoot, ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  );
  const configured = manifest.mcpServers["sprut-agent"];
  const args = configured.args.map((argument) =>
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the client placeholder under test.
    argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot),
  );
  const transport = new StdioClientTransport({
    command: configured.command,
    args,
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: configRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "client-neutral-install-test",
    version: "1.0.0",
  });
  t.after(() => client.close());
  await client.connect(transport);

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 22);
  assert.equal(
    tools.tools.some(({ name }) => name === "list_homes"),
    true,
  );

  const rooms = await client.callTool({ name: "list_rooms", arguments: {} });
  assert.equal(rooms.isError, true);
  assert.equal(rooms.structuredContent.error.action, "configure_credentials");
  assert.equal(rooms.structuredContent.missing_field, "SPRUTHUB_LOGIN");

  const homes = await client.callTool({ name: "list_homes", arguments: {} });
  assert.equal(homes.isError, true);
  assert.equal(homes.structuredContent.error.action, "configure_credentials");
  assert.deepEqual(homes.structuredContent.credential_setup, {
    file: path.join(configRoot, "sprut-agent", "connection.env"),
    required_fields: ["SPRUTHUB_LOGIN", "SPRUTHUB_PASSWORD"],
    permissions: "0600",
    restart: "Restart the same MCP application after saving the file.",
    secret_handling:
      "Create and fill the file locally; do not send credentials in chat.",
  });
});

test("MCP initialize reports the published package version from source and a copied plugin", async (t) => {
  const deliveryVersion = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-mcp-version-"));
  const installedRoot = path.join(scratch, "installed", "sprut-agent");
  const workspace = path.join(scratch, "workspace");
  const configRoot = path.join(scratch, "config");
  t.after(() => rm(scratch, { recursive: true }));
  await Promise.all([
    cp(path.join(projectRoot, "dist", "plugin"), installedRoot, {
      recursive: true,
    }),
    mkdir(workspace, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ]);
  // A cwd package.json must not become initialize.serverInfo.version.
  await writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "decoy", version: "0.0.0-decoy" })}\n`,
  );

  const sourceClient = await connectWithoutHub(t, {
    command: process.execPath,
    args: [path.join(projectRoot, "src", "server.mjs")],
    cwd: workspace,
    configRoot,
  });
  assert.deepEqual(sourceClient.getServerVersion(), {
    name: "sprut-agent",
    version: deliveryVersion,
  });

  const manifest = JSON.parse(
    await readFile(
      path.join(installedRoot, ".claude-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.version, deliveryVersion);
  const configured = manifest.mcpServers["sprut-agent"];
  const pluginClient = await connectWithoutHub(t, {
    command: configured.command,
    args: configured.args.map((argument) =>
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the client placeholder under test.
      argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot),
    ),
    cwd: workspace,
    configRoot,
  });
  assert.deepEqual(pluginClient.getServerVersion(), {
    name: "sprut-agent",
    version: deliveryVersion,
  });
});

test("every MCP config shipped in the plugin starts the server from a foreign cwd", async (t) => {
  // Claude-compatible clients (Claude Code, Grok) discover the manifest's
  // inline mcpServers and any root .mcp.json, expand ${CLAUDE_PLUGIN_ROOT},
  // and spawn from the session cwd; a "cwd" field is not applied to the
  // plugin root (observed with grok 1.0.34 on 2026-09-19). Codex spawns the
  // file named by .codex-plugin/plugin.json with cwd at the plugin root.
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-shipped-mcp-"));
  const installedRoot = path.join(scratch, "installed", "sprut-agent");
  const workspace = path.join(scratch, "workspace");
  const configRoot = path.join(scratch, "config");
  t.after(() => rm(scratch, { recursive: true }));
  await Promise.all([
    cp(path.join(projectRoot, "dist", "plugin"), installedRoot, {
      recursive: true,
    }),
    mkdir(workspace, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ]);

  const configs = await shippedMcpConfigs(installedRoot, workspace);
  const sources = configs.map(({ source }) => source);
  assert.ok(sources.includes(".claude-plugin/plugin.json"), sources);
  assert.ok(sources.includes(".codex-plugin/plugin.json"), sources);
  for (const { source, command, args, cwd } of configs) {
    const client = await connectWithoutHub(t, {
      command,
      args,
      cwd,
      configRoot,
    }).catch((error) => {
      throw new Error(
        `${source} does not start the shipped server: ${error.message}`,
      );
    });
    assert.equal(client.getServerVersion().name, "sprut-agent", source);
  }
});

async function shippedMcpConfigs(installedRoot, sessionCwd) {
  const expand = (argument) =>
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the client placeholder under test.
    argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot);
  const readJson = async (relative) =>
    JSON.parse(await readFile(path.join(installedRoot, relative), "utf8"));
  const configs = [];

  const claudeManifest = await readJson(".claude-plugin/plugin.json");
  for (const server of Object.values(claudeManifest.mcpServers ?? {})) {
    configs.push({
      source: ".claude-plugin/plugin.json",
      command: server.command,
      args: server.args.map(expand),
      cwd: sessionCwd,
    });
  }
  const rootConfig = await readJson(".mcp.json").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  for (const server of Object.values(rootConfig?.mcpServers ?? {})) {
    configs.push({
      source: ".mcp.json",
      command: server.command,
      args: server.args.map(expand),
      cwd: sessionCwd,
    });
  }

  const codexManifest = await readJson(".codex-plugin/plugin.json");
  const codexConfig = await readJson(codexManifest.mcpServers);
  for (const server of Object.values(codexConfig.mcpServers)) {
    configs.push({
      source: ".codex-plugin/plugin.json",
      command: server.command,
      args: server.args,
      cwd: path.resolve(installedRoot, server.cwd ?? "."),
    });
  }
  return configs;
}

async function connectWithoutHub(t, { command, args, cwd, configRoot }) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: {
      PATH: process.env.PATH,
      XDG_CONFIG_HOME: configRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "mcp-package-version-test",
    version: "1.0.0",
  });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}
