import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../src/dashboard-server.mjs";
import { createSprutHubReader } from "../src/read-api.mjs";
import { validateReadSelection } from "../src/read-selection.mjs";

const [command, configArgument] = process.argv.slice(2);
const publicCommands = new Set(["start", "status", "open", "stop"]);
const HELP = `Usage: node dashboard.mjs <start|open|status|stop> <dashboard.json>

Config:
{
  "title": "Мой дом",
  "home_ref": "spruthub://hub/<serial>",
  "port": 4173,
  "readings": [{
    "label": "Температура в офисе",
    "ref": "spruthub://hub/<serial>/accessory/<id>/service/<id>/characteristic/<id>"
  }]
}

start   Start this screen, or replace it after a valid config change.
open    Open the running screen in the default browser.
status  Print its current local URL and process id.
stop    Stop only this screen.
`;

if (command === "--help" || command === "help") {
  process.stdout.write(HELP);
} else if (
  (!publicCommands.has(command) && command !== "serve") ||
  !configArgument
) {
  console.error(
    "Usage: node dashboard.mjs <start|status|open|stop> <dashboard.json>",
  );
  process.exitCode = 64;
} else {
  try {
    await main(command, configArgument);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dashboard failed.");
    process.exitCode = 1;
  }
}

async function main(action, configArgument) {
  const configPath = path.resolve(configArgument);
  const configText = await readFile(configPath, "utf8");
  const key = digest(configPath);
  const stateDirectory =
    process.env.SPRUT_AGENT_DASHBOARD_STATE_DIR ??
    path.join(homedir(), ".config", "sprut-agent", "dashboards");
  const stateFile = path.join(stateDirectory, `${key}.json`);

  if (action === "serve") {
    const config = parseConfig(configText);
    const instanceId = digest(`${configPath}\0${configText}`);
    await serve({ config, configPath, instanceId, stateDirectory, stateFile });
    return;
  }

  const state = await readState(stateFile);
  const health = state ? await readHealth(state.url) : null;
  const isOwned =
    health?.product === "sprut-agent-dashboard" &&
    health.instance_id === state?.instance_id;

  if (action === "stop") {
    if (!state || !isOwned) {
      await removeState(stateFile);
      print({ status: "stopped", running: false });
      return;
    }
    await stopOwned(state, stateFile);
    print({ status: "stopped", running: false, url: state.url });
    return;
  }

  if (action === "status") {
    print({
      status: isOwned ? "running" : "stopped",
      running: isOwned,
      ...(isOwned ? { url: state.url, pid: state.pid } : {}),
    });
    return;
  }

  if (action === "open") {
    if (!isOwned) throw new Error("Dashboard is not running. Start it first.");
    await openBrowser(state.url);
    print({ status: "opened", url: state.url, pid: state.pid });
    return;
  }

  parseConfig(configText);
  const instanceId = digest(`${configPath}\0${configText}`);
  if (isOwned && state.instance_id === instanceId) {
    print({
      status: "running",
      running: true,
      already_running: true,
      url: state.url,
      pid: state.pid,
    });
    return;
  }
  if (isOwned) await stopOwned(state, stateFile);
  else await removeState(stateFile);

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "serve", configPath],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.unref();
  const started = await waitForInstance(stateFile, instanceId);
  print({
    status: "running",
    running: true,
    already_running: false,
    url: started.url,
    pid: started.pid,
  });
}

async function serve({
  config,
  configPath,
  instanceId,
  stateDirectory,
  stateFile,
}) {
  const reader = createSprutHubReader();
  const app = await createDashboardServer({
    reader,
    config,
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 4173,
    instanceId,
  });
  try {
    const url = await app.start();
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeState(stateFile, {
      pid: process.pid,
      url,
      config_path: configPath,
      instance_id: instanceId,
      started_at: new Date().toISOString(),
    });
    await new Promise((resolve) => {
      const shutdown = () => resolve();
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    await app.close();
    const current = await readState(stateFile);
    if (current?.pid === process.pid) await removeState(stateFile);
  }
}

function parseConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("Dashboard config must be valid JSON.");
  }
  if (
    !config ||
    typeof config.title !== "string" ||
    config.title.length === 0 ||
    typeof config.home_ref !== "string" ||
    !Array.isArray(config.readings) ||
    config.readings.length === 0 ||
    (config.host !== undefined && config.host !== "127.0.0.1") ||
    (config.port !== undefined &&
      (!Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65535))
  ) {
    throw new Error(
      "Dashboard config needs title, home_ref, readings, and an optional local port.",
    );
  }
  validateReadSelection({
    homeRef: config.home_ref,
    readings: config.readings,
  });
  return config;
}

async function waitForInstance(stateFile, instanceId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await readState(stateFile);
    if (state?.instance_id === instanceId) {
      const health = await readHealth(state.url);
      if (health?.instance_id === instanceId) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Dashboard did not start. Check that its local port is free and the SprutHub profile is configured.",
  );
}

async function stopOwned(state, stateFile) {
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await readHealth(state.url))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await removeState(stateFile);
}

async function readHealth(url) {
  if (typeof url !== "string") return null;
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(500),
      cache: "no-store",
    });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function readState(stateFile) {
  try {
    const stateFileInfo = await stat(stateFile);
    if (!stateFileInfo.isFile()) return null;
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeState(stateFile, state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, stateFile);
}

async function removeState(stateFile) {
  try {
    await unlink(stateFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise((resolve, reject) => {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
