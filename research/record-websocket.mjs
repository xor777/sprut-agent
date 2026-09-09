#!/usr/bin/env node

import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const DEFAULT_TARGET_URL = "https://beta.spruthub.ru/";
const DEFAULT_SOCKET_PATH = "/spruthub";

function parseArguments(argv) {
  const options = {
    cdpUrl: DEFAULT_CDP_URL,
    targetUrl: DEFAULT_TARGET_URL,
    socketPath: DEFAULT_SOCKET_PATH,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cdp-url") {
      options.cdpUrl = argv[++index];
    } else if (argument === "--target-url") {
      options.targetUrl = argv[++index];
    } else if (argument === "--socket-path") {
      options.socketPath = argv[++index];
    } else if (argument === "--output") {
      options.output = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.output) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    options.output = `research/captures/raw/${timestamp}.ndjson`;
  }

  options.cdpUrl = new URL(options.cdpUrl).href;
  options.targetUrl = new URL(options.targetUrl).href;
  return options;
}

export function selectTarget(targets, targetUrl) {
  const expected = new URL(targetUrl);
  return targets.find((target) => {
    if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
    const actual = new URL(target.url);
    return actual.origin === expected.origin;
  });
}

export function toFrameRecord(event, sockets, capturedAt = new Date()) {
  const socket = sockets.get(event.params.requestId);
  if (!socket) return null;

  const directions = {
    "Network.webSocketFrameSent": "sent",
    "Network.webSocketFrameReceived": "received",
  };
  const direction = directions[event.method];
  if (!direction) return null;

  const frame = event.params.response;
  return {
    capturedAt: capturedAt.toISOString(),
    kind: "frame",
    direction,
    requestId: event.params.requestId,
    socketUrl: socket.url,
    subprotocol: socket.subprotocol ?? null,
    opcode: frame.opcode,
    payloadData: frame.payloadData,
  };
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message));
        } else {
          pending.resolve(payload.result);
        }
        return;
      }
      this.onEvent(payload);
    });

    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error(`Unable to connect to CDP: ${this.url}`)),
        { once: true },
      );
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function getTargets(cdpUrl) {
  const endpoint = new URL("/json/list", cdpUrl);
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Unable to list CDP targets: HTTP ${response.status}`);
  }
  return response.json();
}

function selectSubprotocol(headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "sec-websocket-protocol") {
      return String(value);
    }
  }
  return null;
}

function matchesSocket(url, targetUrl, socketPath) {
  const socket = new URL(url);
  const target = new URL(targetUrl);
  return socket.origin === target.origin && socket.pathname === socketPath;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const targets = await getTargets(options.cdpUrl);
  const target = selectTarget(targets, options.targetUrl);
  if (!target) {
    throw new Error(
      `No debuggable Sprut.hub page found for ${options.targetUrl}`,
    );
  }

  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  const handle = await open(output, "a", 0o600);
  await chmod(output, 0o600);

  let writeQueue = Promise.resolve();
  const writeRecord = (record) => {
    writeQueue = writeQueue.then(() =>
      handle.write(`${JSON.stringify(record)}\n`, null, "utf8"),
    );
    return writeQueue;
  };

  const session = new CdpSession(target.webSocketDebuggerUrl);
  const sockets = new Map();
  session.onEvent = (event) => {
    if (event.method === "Network.webSocketCreated") {
      if (
        !matchesSocket(event.params.url, options.targetUrl, options.socketPath)
      )
        return;

      sockets.set(event.params.requestId, {
        url: event.params.url,
        subprotocol: null,
      });
      void writeRecord({
        capturedAt: new Date().toISOString(),
        kind: "socket-created",
        requestId: event.params.requestId,
        socketUrl: event.params.url,
      });
      return;
    }

    if (event.method === "Network.webSocketHandshakeResponseReceived") {
      const socket = sockets.get(event.params.requestId);
      if (!socket) return;
      socket.subprotocol = selectSubprotocol(event.params.response?.headers);
      void writeRecord({
        capturedAt: new Date().toISOString(),
        kind: "handshake",
        requestId: event.params.requestId,
        socketUrl: socket.url,
        subprotocol: socket.subprotocol,
      });
      return;
    }

    const frame = toFrameRecord(event, sockets);
    if (frame) {
      void writeRecord(frame);
      return;
    }

    if (
      event.method === "Network.webSocketFrameError" ||
      event.method === "Network.webSocketClosed"
    ) {
      const socket = sockets.get(event.params.requestId);
      if (!socket) return;
      void writeRecord({
        capturedAt: new Date().toISOString(),
        kind: event.method === "Network.webSocketClosed" ? "closed" : "error",
        requestId: event.params.requestId,
        socketUrl: socket.url,
        errorMessage: event.params.errorMessage ?? null,
      });
      if (event.method === "Network.webSocketClosed") {
        sockets.delete(event.params.requestId);
      }
    }
  };

  await session.connect();
  await session.send("Network.enable");
  await writeRecord({
    capturedAt: new Date().toISOString(),
    kind: "recorder-started",
    targetUrl: target.url,
    socketPath: options.socketPath,
    note: "Reload the page after this record to capture socket creation.",
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "recording",
        output,
        target: target.url,
        instruction:
          "Reload Sprut.hub, reproduce one read-only experiment, then press Ctrl-C.",
      },
      null,
      2,
    )}\n`,
  );

  const stop = async () => {
    await writeRecord({
      capturedAt: new Date().toISOString(),
      kind: "recorder-stopped",
    });
    await writeQueue;
    session.close();
    await handle.close();
    process.exitCode = 0;
  };

  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
