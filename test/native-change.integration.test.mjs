import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "native-change-test-hub";
const characteristicRef = `spruthub://hub/${serial}/accessory/34/service/13/characteristic/15`;

async function startHub() {
  const requests = [];
  const state = {
    characteristic: {
      aId: 34,
      sId: 13,
      cId: 15,
      control: {
        name: "Включена",
        type: "On",
        read: true,
        write: true,
        value: { boolValue: false },
      },
    },
  };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(structuredClone(request.params));
      const params = request.params;
      let result;
      if (params.characteristic?.get) {
        result = {
          characteristic: { get: structuredClone(state.characteristic) },
        };
      } else if (params.characteristic?.update) {
        state.characteristic.control.value = structuredClone(
          params.characteristic.update.control.value,
        );
        result = { characteristic: { update: {} } };
      } else {
        assert.fail(`unsupported test request: ${JSON.stringify(params)}`);
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    server,
    state,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

async function startClient(t, hub, stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "native-change-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "native-change-test-client",
      SPRUTHUB_TIMEOUT_MS: "1000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "native-change-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

test("a characteristic value uses one recoverable native change path", async (t) => {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-native-change-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const firstClient = await startClient(t, hub, stateDirectory);

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Включить офисную лампу",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.match(
    prepared.structuredContent.change_ref,
    /^spruthub-change:\/\/native\/[a-f0-9]{24}$/,
  );
  assert.deepEqual(prepared.structuredContent.diff, {
    value: { from: false, to: true, kind: "boolValue" },
  });
  assert.equal(prepared.structuredContent.native_write_sent, false);
  assert.equal(prepared.structuredContent.restore_supported, false);

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.deepEqual(applied.structuredContent.observed_value, {
    value: true,
    kind: "boolValue",
  });
  assert.equal(applied.structuredContent.command_caused_observation, "unknown");
  assert.equal(applied.structuredContent.physical_effect_reversible, false);
  assert.equal(hub.state.characteristic.control.value.boolValue, true);

  const updates = hub.requests.filter(
    ({ characteristic }) => characteristic?.update,
  );
  assert.deepEqual(updates, [
    {
      characteristic: {
        update: {
          aId: 34,
          sId: 13,
          cId: 15,
          control: { value: { boolValue: true } },
        },
      },
    },
  ]);
  assert.equal(
    hub.requests.at(-1).characteristic?.get?.cId,
    15,
    "a separate readback must follow the native ACK",
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const afterRestart = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(afterRestart.isError, undefined, afterRestart.content[0]?.text);
  assert.equal(afterRestart.structuredContent.status, "applied");
  assert.deepEqual(afterRestart.structuredContent.observed_value, {
    value: true,
    kind: "boolValue",
  });
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});
