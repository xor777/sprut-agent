import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const installedPath = process.argv[2];
const codexBinary = process.env.SPRUT_CODEX_BIN ?? "codex";

if (!installedPath || !path.isAbsolute(installedPath)) {
  console.error(
    "Usage: node <installedPath>/check-install.mjs <installedPath>",
  );
  process.exitCode = 64;
} else {
  await checkEffectiveTransport(installedPath);
}

async function checkEffectiveTransport(expectedRoot) {
  let effective;
  try {
    effective = JSON.parse(
      (
        await run(codexBinary, ["mcp", "get", "sprut-agent", "--json"], {
          env: process.env,
        })
      ).stdout,
    );
  } catch {
    console.error(
      "sprut-agent MCP is not active. Repeat `codex plugin add sprut-agent@sprut-agent`, then run this check again.",
    );
    process.exitCode = 2;
    return;
  }

  const expectedCwd = path.resolve(expectedRoot);
  const transport = effective.transport;
  const isInstalledTransport =
    effective.name === "sprut-agent" &&
    transport?.type === "stdio" &&
    transport.command === "node" &&
    Array.isArray(transport.args) &&
    transport.args.length === 1 &&
    transport.args[0] === "./dist/server.mjs" &&
    typeof transport.cwd === "string" &&
    path.resolve(transport.cwd) === expectedCwd;
  if (!isInstalledTransport) {
    console.error(
      'MCP name "sprut-agent" is already occupied by another configuration. It was left unchanged. Review `codex mcp get sprut-agent --json`; if that entry is obsolete, run `codex mcp remove sprut-agent`, repeat `codex plugin add sprut-agent@sprut-agent`, and run this check again.',
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    JSON.stringify({
      status: "ready",
      mcpServer: "sprut-agent",
      installedPath: expectedCwd,
    }),
  );
}
