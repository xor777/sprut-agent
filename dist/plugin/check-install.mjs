import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);
const [installedPath, action, selectedLegacyPath, ...extraArguments] =
  process.argv.slice(2);
const codexBinary = process.env.SPRUT_CODEX_BIN ?? "codex";
const disableLegacySkill = action === "--disable-legacy-skill";

class InstallCheckError extends Error {}

if (
  !installedPath ||
  !path.isAbsolute(installedPath) ||
  (action !== undefined && !disableLegacySkill) ||
  (disableLegacySkill && !selectedLegacyPath) ||
  extraArguments.length > 0
) {
  console.error(
    "Usage: node <installedPath>/check-install.mjs <installedPath> [--disable-legacy-skill <exact-path-from-this-check>]",
  );
  process.exitCode = 64;
} else {
  await checkInstallation(path.resolve(installedPath));
}

async function checkInstallation(expectedRoot) {
  if (!(await checkEffectiveTransport(expectedRoot))) return;
  if (!(await checkRuntime(expectedRoot))) return;

  let skills;
  try {
    skills = await withCodexAppServer(async (request) => {
      let current = await listSkills(request);
      if (disableLegacySkill) {
        const selected = current.find(
          (skill) =>
            skill.path === selectedLegacyPath && isPriorManualSkill(skill),
        );
        if (!selected) {
          throw new InstallCheckError(
            "The selected path is not the prior manual spruthub-master skill reported by this Codex profile. Nothing was changed; run the check again and use its exact path.",
          );
        }
        if (selected.enabled) {
          await request("skills/config/write", {
            path: selected.path,
            enabled: false,
          });
        }
        current = await listSkills(request);
      }
      return current;
    });
  } catch (error) {
    if (error instanceof InstallCheckError) {
      console.error(error.message);
    } else if (error?.code === "ENOENT") {
      console.error(
        "Codex CLI is unavailable. Install Codex CLI 0.154.0 or newer, make `codex` available in PATH, and run this check again.",
      );
    } else if (disableLegacySkill) {
      console.error(
        "Codex could not confirm the skill state after the explicit transition request. The selected skill may already be disabled; run this check again to read the current state before retrying the change.",
      );
    } else {
      console.error(
        "Codex could not report its active skills. Check that `codex --version` works with this profile, then run this check again. No skill configuration was requested.",
      );
    }
    process.exitCode = 2;
    return;
  }

  const expectedSkillPath = path.join(
    expectedRoot,
    "skills",
    "spruthub-master",
    "SKILL.md",
  );
  const productSkill = skills.find(
    (skill) =>
      skill.pluginId === "sprut-agent@sprut-agent" &&
      path.resolve(skill.path) === expectedSkillPath,
  );
  if (!productSkill?.enabled) {
    console.error(
      "The installed sprut-agent skill is not active. Repeat `codex plugin add sprut-agent@sprut-agent`, then run this check again.",
    );
    process.exitCode = 2;
    return;
  }

  const activePriorSkills = skills.filter(
    (skill) => skill.enabled && isPriorManualSkill(skill),
  );
  if (activePriorSkills.length > 0) {
    const selected = activePriorSkills[0];
    const checkScript = path.join(expectedRoot, "check-install.mjs");
    console.error(
      [
        `An active prior manual skill conflicts with the installed plugin: ${selected.path}`,
        "It was left unchanged. If this is the spruthub-master skill from the prior manual setup, disable only that client entry with:",
        `node ${shellQuote(checkScript)} ${shellQuote(expectedRoot)} --disable-legacy-skill ${shellQuote(selected.path)}`,
        "The skill file, its target, and the prior MCP server remain in place. Then run this check again.",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    JSON.stringify({
      status: "ready",
      mcpServer: "sprut-agent",
      skill: "sprut-agent:spruthub-master",
      installedPath: expectedRoot,
    }),
  );
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
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.error(
        "Codex CLI is unavailable. Install Codex CLI 0.154.0 or newer, make `codex` available in PATH, and run this check again.",
      );
    } else {
      console.error(
        "sprut-agent MCP is not active in this Codex profile. Repeat `codex plugin add sprut-agent@sprut-agent`, then run this check again.",
      );
    }
    process.exitCode = 2;
    return false;
  }

  const transport = effective.transport;
  const isInstalledTransport =
    effective.name === "sprut-agent" &&
    effective.enabled === true &&
    transport?.type === "stdio" &&
    transport.command === "node" &&
    Array.isArray(transport.args) &&
    transport.args.length === 1 &&
    transport.args[0] === "./dist/server.mjs" &&
    typeof transport.cwd === "string" &&
    path.resolve(transport.cwd) === expectedRoot;
  if (!isInstalledTransport) {
    console.error(
      'MCP name "sprut-agent" is already occupied by another configuration or is disabled. It was left unchanged. If that entry is obsolete, run `codex mcp remove sprut-agent`, repeat `codex plugin add sprut-agent@sprut-agent`, and run this check again.',
    );
    process.exitCode = 2;
    return false;
  }
  return true;
}

async function checkRuntime(expectedRoot) {
  try {
    const runtimes = await Promise.all(
      [
        path.join(expectedRoot, "dist", "server.mjs"),
        path.join(expectedRoot, "dist", "read.mjs"),
        path.join(expectedRoot, "dashboard.mjs"),
        path.join(expectedRoot, "examples", "dashboard.json"),
      ].map((runtime) => stat(runtime)),
    );
    if (runtimes.every((runtime) => runtime.isFile())) return true;
  } catch {}
  console.error(
    "The installed sprut-agent runtime is incomplete. Repeat `codex plugin add sprut-agent@sprut-agent`, then run this check again.",
  );
  process.exitCode = 2;
  return false;
}

function isPriorManualSkill(skill) {
  return skill.name === "spruthub-master" && skill.pluginId == null;
}

async function listSkills(request) {
  const response = await request("skills/list", {
    cwds: [process.cwd()],
    forceReload: true,
  });
  return response.data.flatMap((entry) => entry.skills);
}

async function withCodexAppServer(operation) {
  const child = spawn(codexBinary, ["app-server", "--stdio"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let startupError;
  child.on("error", (error) => {
    startupError = error;
  });
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let nextId = 0;
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return readResponse(iterator, id, () => startupError);
  };

  try {
    await request("initialize", {
      clientInfo: { name: "sprut-install-check", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    return await operation(request);
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

async function readResponse(iterator, id, getStartupError) {
  while (true) {
    const { value, done } = await withTimeout(iterator.next(), 10_000);
    if (done) throw getStartupError() ?? new Error("Codex app-server stopped");
    const message = JSON.parse(value);
    if (message.id !== id) continue;
    if (message.error) throw new Error("Codex app-server request failed");
    return message.result;
  }
}

async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codex app-server timed out")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
