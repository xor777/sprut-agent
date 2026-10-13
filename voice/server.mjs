// Voice assistant prototype server. It serves the PWA, mints short-lived
// OpenAI Realtime keys with the home catalog in the instructions, and runs
// the model's tool calls through HomeTools. Audio goes straight between the
// phone and OpenAI over WebRTC; the OpenAI key and SprutHub access stay here.
//
//   node voice/server.mjs            # listen on 127.0.0.1:8787
//   node voice/server.mjs --tunnel   # also open a Cloudflare quick tunnel
//
// Settings live in voice.env next to connection.env: OPENAI_API_KEY and the
// generated VOICE_ACCESS_TOKEN that the invite link carries.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sessionConfig } from "./assistant.mjs";
import { HomeTools } from "./home-tools.mjs";

const publicDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "public",
);
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": [
    "manifest.webmanifest",
    "application/manifest+json",
  ],
  "/icon-192.png": ["icon-192.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
};
const MAX_BODY_BYTES = 64 * 1024;
const VOICE_SECRETS = ["OPENAI_API_KEY", "VOICE_ACCESS_TOKEN"];

export async function loadVoiceEnv(env = process.env) {
  const file = env.SPRUT_VOICE_ENV_FILE
    ? path.resolve(env.SPRUT_VOICE_ENV_FILE)
    : path.join(configRoot(env), "sprut-agent", "voice.env");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const values = parseDotenv(text);
  if (!values.VOICE_ACCESS_TOKEN && !env.VOICE_ACCESS_TOKEN) {
    values.VOICE_ACCESS_TOKEN = randomBytes(24).toString("base64url");
    const lines = [
      text.trimEnd(),
      "OPENAI_API_KEY" in values ? "" : "OPENAI_API_KEY=",
      `VOICE_ACCESS_TOKEN=${values.VOICE_ACCESS_TOKEN}`,
    ].filter(Boolean);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  }
  const merged = { ...values };
  for (const [name, value] of Object.entries(env)) {
    if (value !== "") merged[name] = value;
  }
  return { file, env: merged };
}

export async function startVoiceServer({
  env,
  homeTools,
  port = Number(env.VOICE_PORT) || 8787,
  host = "127.0.0.1",
  log = (...parts) => console.log(...parts),
  reloadEnv = null,
}) {
  if (!env.VOICE_ACCESS_TOKEN)
    throw new Error("VOICE_ACCESS_TOKEN is required");
  const accessToken = Buffer.from(env.VOICE_ACCESS_TOKEN);
  const openaiBase = (
    env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  const authorized = (request) => {
    const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? "");
    if (!match) return false;
    const given = Buffer.from(match[1]);
    return (
      given.length === accessToken.length && timingSafeEqual(given, accessToken)
    );
  };

  const mintSession = async () => {
    // A key added to voice.env while the server runs is picked up here, so
    // the tunnel address and the invite link stay the same.
    if (!env.OPENAI_API_KEY && reloadEnv) {
      env.OPENAI_API_KEY = (await reloadEnv()).OPENAI_API_KEY;
    }
    if (!env.OPENAI_API_KEY) {
      log("[voice] OPENAI_API_KEY is not set; add it to voice.env");
      return [
        503,
        error("openai_key_missing", "На сервере не настроен ключ OpenAI."),
      ];
    }
    const catalog = await homeTools.catalog();
    const session = sessionConfig(catalog, env);
    const response = await fetch(`${openaiBase}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.value !== "string") {
      log(
        `[voice] OpenAI refused the session: ${response.status} ${data?.error?.message ?? ""}`,
      );
      return [
        502,
        error(
          "openai_error",
          `OpenAI не открыл разговор (${response.status}).`,
        ),
      ];
    }
    log(
      `[voice] session opened: ${session.model}, ${catalog.devices.size} devices`,
    );
    return [
      200,
      {
        key: data.value,
        expires_at: data.expires_at ?? null,
        calls_url: `${openaiBase}/realtime/calls`,
      },
    ];
  };

  const runTool = async ({ name, arguments: args } = {}) => {
    log(`[voice] → ${name} ${JSON.stringify(args ?? {})}`);
    let output;
    try {
      if (name === "control_devices") output = await homeTools.control(args);
      else if (name === "read_devices") output = await homeTools.read(args);
      else output = { status: "error", problem: `Нет инструмента ${name}.` };
    } catch (failure) {
      log(`[voice] ${name} failed: ${failure.message}`);
      output = {
        status: "error",
        problem: "Не удалось связаться с домом. Ничего не подтверждено.",
        detail: failure.body?.error?.message ?? failure.message,
      };
    }
    log(`[voice] ← ${name} ${summarize(output)}`);
    return output;
  };

  const handle = async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const file = STATIC_FILES[url.pathname];
    if (request.method === "GET" && file) {
      const body = await readFile(path.join(publicDirectory, file[0]));
      response.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-cache",
      });
      return response.end(body);
    }
    if (!url.pathname.startsWith("/api/")) {
      return send(response, 404, error("not_found", "Нет такой страницы."));
    }
    if (request.method !== "POST") {
      return send(response, 405, error("method_not_allowed", "Только POST."));
    }
    if (!authorized(request)) {
      return send(
        response,
        401,
        error("unauthorized", "Нужна ссылка-приглашение."),
      );
    }
    const body = await readJson(request);
    if (url.pathname === "/api/session") {
      return send(response, ...(await mintSession()));
    }
    if (url.pathname === "/api/tool") {
      return send(response, 200, { output: await runTool(body) });
    }
    if (url.pathname === "/api/log") {
      for (const event of Array.isArray(body?.events) ? body.events : []) {
        log(
          `[voice] ${String(event.type)}: ${String(event.text).slice(0, 500)}`,
        );
      }
      return send(response, 204);
    }
    return send(response, 404, error("not_found", "Нет такого вызова."));
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((failure) => {
      log(`[voice] request failed: ${failure.message}`);
      if (!response.headersSent) {
        send(
          response,
          failure.statusCode ?? 500,
          error("internal_error", "Ошибка на сервере."),
        );
      } else {
        response.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Opens a Cloudflare quick tunnel to the local server and resolves with its
// public https address; the address changes on every start.
function openQuickTunnel(localUrl, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", localUrl],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let found = false;
    child.once("error", reject);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk);
      if (match && !found) {
        found = true;
        resolve({ url: match[0], child });
      }
    });
    child.once("exit", (code) => {
      if (!found) reject(new Error(`cloudflared exited with ${code}`));
      else log(`[voice] cloudflared exited with ${code}`);
    });
  });
}

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const name of Object.keys(values)) {
    if (values[name] === "") delete values[name];
  }
  return values;
}

function configRoot(env) {
  if (env.XDG_CONFIG_HOME) return path.resolve(env.XDG_CONFIG_HOME);
  return path.join(env.HOME ? path.resolve(env.HOME) : homedir(), ".config");
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request body too large"), {
        statusCode: 413,
      });
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { statusCode: 400 });
  }
}

function send(response, status, body) {
  if (body === undefined) {
    response.writeHead(status);
    return response.end();
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function error(code, message) {
  return { error: { code, message } };
}

function summarize(output) {
  if (Array.isArray(output?.results)) {
    return `${output.status}: ${output.results.map(({ name, control, status }) => `${name} ${control} ${status}`).join(", ")}`;
  }
  if (Array.isArray(output?.problems)) {
    return `${output.status}: ${output.problems.map(({ problem }) => problem).join("; ")}`;
  }
  if (Array.isArray(output?.devices)) {
    return `${output.status}: ${output.devices.length} devices`;
  }
  return JSON.stringify(output).slice(0, 300);
}

async function main() {
  const { file, env } = await loadVoiceEnv();
  const childEnv = { ...process.env };
  for (const name of VOICE_SECRETS) delete childEnv[name];
  const homeTools = new HomeTools({ env: childEnv });
  const server = await startVoiceServer({
    env,
    homeTools,
    reloadEnv: async () => (await loadVoiceEnv()).env,
  });
  console.log(`[voice] listening on ${server.url}`);
  if (!env.OPENAI_API_KEY) {
    console.log(`[voice] add OPENAI_API_KEY to ${file}; no restart needed`);
  }
  homeTools
    .catalog()
    .then((catalog) =>
      console.log(`[voice] home catalog: ${catalog.devices.size} devices`),
    )
    .catch((failure) =>
      console.log(`[voice] home catalog failed: ${failure.message}`),
    );
  let tunnel = null;
  if (process.argv.includes("--tunnel")) {
    tunnel = await openQuickTunnel(server.url, console.log);
    console.log(`[voice] public address: ${tunnel.url}`);
    console.log(
      `[voice] invite link (open it on the phone once): ${tunnel.url}/#k=${env.VOICE_ACCESS_TOKEN}`,
    );
  }
  const shutdown = async () => {
    tunnel?.child.kill();
    await homeTools.close();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
