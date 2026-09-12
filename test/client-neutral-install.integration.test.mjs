import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  assert.equal(tools.tools.length, 19);
  assert.equal(tools.tools.some(({ name }) => name === "list_homes"), true);

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
