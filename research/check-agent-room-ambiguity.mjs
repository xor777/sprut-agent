import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const mode = process.argv[2] ?? "ambiguous";
if (!["office", "ambiguous", "ambiguous-distinct"].includes(mode)) {
  throw new Error("Mode must be office, ambiguous, or ambiguous-distinct.");
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  await readFile(
    join(root, "research/protocol/2026-09-09-room-reading.json"),
    "utf8",
  ),
);
const observedAccessory = fixture.exchanges.find(
  ({ result }) => result.accessory,
).result.accessory.list.accessories[0];
const rooms = [
  { id: 20, name: "Кухня" },
  { id: 30, name: "Office" },
  ...(mode.startsWith("ambiguous") ? [{ id: 31, name: "1 - Офис" }] : []),
];
const requests = [];
const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => hub.once("listening", resolve));

hub.on("connection", (socket) => {
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const { params } = message;
    requests.push(params);
    let result;

    if (params.room?.list) {
      result = { room: { list: { rooms } } };
    } else if (params.room?.get) {
      result = {
        room: {
          get: rooms.find(({ id }) => id === params.room.get.id) ?? null,
        },
      };
    } else if (params.accessory?.list) {
      const device = structuredClone(observedAccessory);
      device.roomId = params.accessory.list.roomId;
      device.name = "Кондиционер";
      if (mode === "ambiguous-distinct" && device.roomId === 31) {
        for (const service of device.services) {
          for (const reading of service.characteristics ?? []) {
            if (reading.control.type === "CurrentTemperature") {
              reading.control.value = {
                doubleValue: service.type === "Thermostat" ? 26 : 12,
              };
            }
          }
        }
      }
      result = { accessory: { list: { accessories: [device] } } };
    } else {
      throw new Error(
        "Agent attempted an operation outside this read-only check.",
      );
    }

    socket.send(JSON.stringify({ id: message.id, result }));
  });
});

const runDirectory = await mkdtemp(join(tmpdir(), "sprut-agent-acceptance-"));
const answerPath = join(runDirectory, "answer.txt");
const hubEnvironment = {
  SPRUTHUB_URL: `ws://127.0.0.1:${hub.address().port}`,
  SPRUTHUB_TOKEN: "agent-acceptance-token",
  SPRUTHUB_SERIAL: "agent-acceptance-hub",
  SPRUTHUB_CID: "agent-acceptance-client",
  SPRUTHUB_TIMEOUT_MS: "5000",
};
const hubEnvironmentConfig = `{ ${Object.entries(hubEnvironment)
  .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
  .join(", ")} }`;
const args = [
  "exec",
  "--ignore-user-config",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "--json",
  "--cd",
  runDirectory,
  "-c",
  'model="gpt-5.6-sol"',
  "-c",
  'model_reasoning_effort="xhigh"',
  "-c",
  "features.shell_tool=false",
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  'web_search="disabled"',
  "-c",
  'mcp_servers.sprut.command="node"',
  "-c",
  `mcp_servers.sprut.args=${JSON.stringify([join(root, "src/server.mjs")])}`,
  "-c",
  `mcp_servers.sprut.env=${hubEnvironmentConfig}`,
  "-c",
  "mcp_servers.sprut.required=true",
  "--output-last-message",
  answerPath,
  "Какая сейчас температура в офисе и снаружи по его кондиционеру?",
];

try {
  const result = await runCodex(args, process.env);
  if (result.code !== 0) {
    process.stderr.write(result.stderr.slice(-2000));
    throw new Error(`Codex exited with status ${result.code}.`);
  }
  const answer = await readFile(answerPath, "utf8");
  const toolCalls = result.stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        const item = JSON.parse(line).item;
        return item?.type === "mcp_tool_call"
          ? [
              {
                tool: item.tool,
                arguments: item.arguments,
                status: item.status,
              },
            ]
          : [];
      } catch {
        return [];
      }
    });

  console.log(JSON.stringify({ mode, requests, toolCalls }, null, 2));
  console.log("\nAgent answer:\n");
  console.log(answer);
  console.log(
    "\nManual verdict: Office-only must stay correct. With two matching rooms, " +
      "the answer must ask which room or label each result with its original room name.",
  );
} finally {
  hub.close();
  await rm(runDirectory, { recursive: true, force: true });
}

function runCodex(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Agent acceptance exceeded 180 seconds."));
    }, 180_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
