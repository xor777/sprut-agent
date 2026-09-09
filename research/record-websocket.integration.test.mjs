import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const recorder = fileURLToPath(
  new URL("./record-websocket.mjs", import.meta.url),
);

// CDP is the external boundary. The actual recorder runs as a separate process.
async function startRecorder(t, targetUrl, socketPath) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sprut-recorder-"));
  const output = path.join(directory, "capture.ndjson");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const commands = [];
  const server = createServer((request, response) => {
    assert.equal(request.url, "/json/list");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          type: "page",
          url: targetUrl,
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/test`,
        },
      ]),
    );
  });
  const sockets = new WebSocketServer({ server });
  t.after(() => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    server.close();
  });

  const connected = new Promise((resolve) => {
    sockets.once("connection", (socket) => {
      socket.on("message", (data) => {
        const command = JSON.parse(String(data));
        commands.push(command.method);
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
      resolve(socket);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const child = spawn(
    process.execPath,
    [
      recorder,
      "--cdp-url",
      `http://127.0.0.1:${server.address().port}`,
      "--target-url",
      targetUrl,
      "--socket-path",
      socketPath,
      "--output",
      output,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (data) => {
    errors += data;
  });

  await new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (data) => {
      stdout += data;
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return;
      }
      if (result.status === "recording") resolve();
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(`Recorder exited before ready: ${errors}`)),
    );
  });
  const socket = await connected;
  return {
    output,
    commands,
    send(method, params) {
      socket.send(JSON.stringify({ method, params }));
    },
    async stop() {
      child.kill("SIGINT");
      const [code, signal] = await exited;
      assert.equal(code, 0, errors);
      assert.equal(signal, null);
    },
  };
}

async function recordsFrom(output) {
  return (await readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
}

for (const { name, targetUrl, socketUrl, socketPath, wrongScheme } of [
  {
    name: "cloud HTTPS with an explicit default WebSocket port",
    targetUrl: "https://beta.spruthub.ru/controllers",
    socketUrl: "wss://beta.spruthub.ru:443/spruthub",
    socketPath: "/spruthub",
    wrongScheme: "ws://beta.spruthub.ru/spruthub",
  },
  {
    name: "local HTTP on a custom port and socket path",
    targetUrl: "http://hub.test:8123/",
    socketUrl: "ws://hub.test:8123/events",
    socketPath: "/events",
    wrongScheme: "wss://hub.test:8123/events",
  },
]) {
  test(`recorder captures only the requested hub: ${name}`, {
    timeout: 10_000,
  }, async (t) => {
    const capture = await startRecorder(t, targetUrl, socketPath);
    const expected = new URL(socketUrl);
    const foreignHost = new URL(socketUrl);
    foreignHost.hostname = "unrelated.test";
    const foreignPort = new URL(socketUrl);
    foreignPort.port = "9443";
    const foreignPath = new URL(socketUrl);
    foreignPath.pathname = `${socketPath}/unrelated`;
    for (const [index, url] of [
      foreignHost.href,
      foreignPort.href,
      foreignPath.href,
      wrongScheme,
    ].entries()) {
      const requestId = `unrelated-${index}`;
      capture.send("Network.webSocketCreated", { requestId, url });
      capture.send("Network.webSocketFrameReceived", {
        requestId,
        response: { opcode: 1, payloadData: "PRIVATE_UNRELATED_TRAFFIC" },
      });
    }

    const requestId = "sprut";
    capture.send("Network.webSocketCreated", { requestId, url: socketUrl });
    capture.send("Network.webSocketHandshakeResponseReceived", {
      requestId,
      response: {
        headers: {
          "Sec-WebSocket-Protocol": "json-rpc",
          "Set-Cookie": "PRIVATE_HANDSHAKE_SECRET",
        },
      },
    });
    const sent = '{"id":7,"params":{"room":{"list":{}}}}';
    const received = '{"id":7,"result":{"room":{"list":{"rooms":[]}}}}';
    capture.send("Network.webSocketFrameSent", {
      requestId,
      response: { opcode: 1, payloadData: sent },
    });
    capture.send("Network.webSocketFrameReceived", {
      requestId,
      response: { opcode: 1, payloadData: received },
    });
    capture.send("Network.webSocketClosed", { requestId });

    // Wait for the observable file write, not an assumed processing delay.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (
        (await recordsFrom(capture.output)).some(
          (record) => record.kind === "closed",
        )
      )
        break;
      await delay(10);
    }
    await capture.stop();

    const records = await recordsFrom(capture.output);
    const frames = records.filter((record) => record.kind === "frame");
    assert.deepEqual(
      frames.map(({ direction, opcode, payloadData }) => ({
        direction,
        opcode,
        payloadData,
      })),
      [
        { direction: "sent", opcode: 1, payloadData: sent },
        { direction: "received", opcode: 1, payloadData: received },
      ],
    );
    for (const frame of frames) {
      assert.equal(new URL(frame.socketUrl).href, expected.href);
      assert.equal(frame.subprotocol, "json-rpc");
    }
    assert.equal(records.at(-1).kind, "recorder-stopped");
    assert.equal((await stat(capture.output)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(capture.output, "utf8"), /PRIVATE_/);
    assert.deepEqual(capture.commands, ["Network.enable"]);
  });
}
