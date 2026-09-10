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
const homeRef = `spruthub://hub/${serial}`;
const characteristicRef = `spruthub://hub/${serial}/accessory/34/service/13/characteristic/15`;
const scenarioRef = `spruthub://hub/${serial}/scenario/existing-block`;

function setAction({ aId = 34, sId = 13, cId = 15, value = "true" } = {}) {
  return {
    type: "service",
    aId,
    sId,
    hs: "Lightbulb",
    characteristics: [{ type: "set", cId, hc: "On", value }],
  };
}

function characteristicCondition({
  aId = 32,
  sId = 13,
  cId = 15,
  trigger = true,
} = {}) {
  return {
    type: "characteristic",
    aId,
    sId,
    cId,
    hs: "MotionSensor",
    hc: "MotionDetected",
    trigger,
    cond: "=",
    value: "true",
    timeCond: "",
    time: 0,
  };
}

function blockData({ delay = 60_000, nested = false } = {}) {
  const delayedOff = {
    type: "delay",
    index: 1,
    mode: "RESET",
    time: delay,
    targets: [setAction({ value: "false" })],
  };
  return {
    vendorConfiguration: { preserved: true },
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: nested ? "OR" : "AND",
          conditions: [
            characteristicCondition(),
            ...(nested
              ? [
                  {
                    type: "condition",
                    mode: "AND",
                    conditions: [characteristicCondition({ trigger: false })],
                  },
                ]
              : []),
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [setAction(), delayedOff],
        else: nested ? [setAction({ value: "false" })] : [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };
}

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
    accessories: [
      {
        id: 32,
        roomId: 1,
        name: "Датчик",
        online: true,
        services: [
          {
            aId: 32,
            sId: 13,
            name: "Движение",
            type: "MotionSensor",
            characteristics: [
              {
                aId: 32,
                sId: 13,
                cId: 15,
                control: {
                  name: "Движение",
                  type: "MotionDetected",
                  read: true,
                  write: false,
                  value: { boolValue: false },
                },
              },
            ],
          },
        ],
      },
      {
        id: 34,
        roomId: 1,
        name: "Лампа",
        online: true,
        services: [
          {
            aId: 34,
            sId: 13,
            name: "Свет",
            type: "Lightbulb",
            characteristics: [],
          },
        ],
      },
    ],
    scenarios: [
      {
        index: "existing-block",
        name: "Существующий BLOCK",
        desc: "Ручная конфигурация",
        active: false,
        onStart: false,
        sync: false,
        type: "BLOCK",
        data: JSON.stringify(blockData()),
        vendorTopLevel: "preserve-me",
      },
    ],
    nextScenario: 1,
    behavior: {
      closeAfterCreate: false,
      ignoreNextUpdate: false,
    },
  };
  state.accessories[1].services[0].characteristics.push(state.characteristic);
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
      } else if (params.accessory?.get) {
        result = {
          accessory: {
            get:
              structuredClone(
                state.accessories.find(
                  ({ id }) => id === params.accessory.get.id,
                ),
              ) ?? null,
          },
        };
      } else if (params.scenario?.list) {
        result = {
          scenario: {
            list: {
              scenarios: state.scenarios.map(({ data: _data, ...scenario }) =>
                structuredClone(scenario),
              ),
            },
          },
        };
      } else if (params.scenario?.get) {
        result = {
          scenario: {
            get:
              structuredClone(
                state.scenarios.find(
                  ({ index }) => index === params.scenario.get.index,
                ),
              ) ?? null,
          },
        };
      } else if (params.scenario?.create) {
        const created = {
          ...structuredClone(params.scenario.create),
          index: `created-${state.nextScenario++}`,
          predefined: false,
        };
        state.scenarios.push(created);
        if (state.behavior.closeAfterCreate) {
          state.behavior.closeAfterCreate = false;
          socket.close();
          return;
        }
        result = { scenario: { create: structuredClone(created) } };
      } else if (params.scenario?.update) {
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.update.index,
        );
        if (!state.behavior.ignoreNextUpdate) {
          scenario.data = params.scenario.update.data;
        }
        state.behavior.ignoreNextUpdate = false;
        result = {
          scenario: {
            update: {
              index: scenario.index,
              name: scenario.name,
              desc: scenario.desc,
              active: scenario.active,
              onStart: scenario.onStart,
              sync: scenario.sync,
              type: scenario.type,
            },
          },
        };
      } else if (params.scenario?.delete) {
        const index = state.scenarios.findIndex(
          (scenario) => scenario.index === params.scenario.delete.index,
        );
        if (index >= 0) state.scenarios.splice(index, 1);
        result = { scenario: { delete: {} } };
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

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-native-change-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

test("a characteristic value uses one recoverable native change path", async (t) => {
  const { hub, stateDirectory } = await setup(t);
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

test("versioned BLOCK contract prepares different supported compositions", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "block_create" },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.equal(contract.structuredContent.status, "ok");
  assert.equal(contract.structuredContent.contract.version, "2026-09-10");
  assert.equal(
    contract.structuredContent.contract.source.frontend_sha256,
    "81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8",
  );
  assert.deepEqual(contract.structuredContent.contract.supported.target_types, [
    "if",
    "service",
    "delay",
  ]);

  const nestedData = blockData({ nested: true });
  delete nestedData.vendorConfiguration;
  const simpleData = blockData();
  delete simpleData.vendorConfiguration;
  for (const [name, data] of [
    ["Вложенное условие", nestedData],
    ["Сброс таймера", simpleData],
  ]) {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name,
        description: "Проверенная нативная композиция",
        active: false,
        on_start: false,
        sync: false,
        data,
        reason: "Подготовить BLOCK",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
    assert.equal(prepared.structuredContent.status, "prepared");
    assert.equal(prepared.structuredContent.operation, "block_create");
    assert.equal(prepared.structuredContent.native_write_sent, false);
  }
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("BLOCK create survives a lost response and restores only an unchanged result", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData({ nested: true });
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Вложенный свет",
      description: "Два условия и RESET",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Создать нативный BLOCK",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.closeAfterCreate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  const creates = hub.requests.filter(({ scenario }) => scenario?.create);
  assert.equal(creates.length, 1);
  assert.deepEqual(
    {
      active: creates[0].scenario.create.active,
      onStart: creates[0].scenario.create.onStart,
      sync: creates[0].scenario.create.sync,
      type: creates[0].scenario.create.type,
    },
    { active: false, onStart: false, sync: false, type: "BLOCK" },
  );
  assert.match(
    creates[0].scenario.create.desc,
    /sprut-agent:native:[a-f0-9]{24}/,
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );

  const scenario = hub.state.scenarios.find(
    ({ index }) => index === applied.structuredContent.scenario_index,
  );
  scenario.data = JSON.stringify({
    ...JSON.parse(scenario.data),
    manual: true,
  });
  const conflict = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.delete).length,
    0,
  );
});

test("BLOCK data update verifies readback and restores its complete baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const requestedData = blockData({ delay: 45_000 });
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requestedData,
      reason: "Уменьшить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.equal(prepared.structuredContent.diff.data.changed, true);
  assert.equal(prepared.structuredContent.restore_supported, true);

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, true);
  assert.equal(applied.structuredContent.configuration_matches, true);
  const updates = hub.requests.filter(({ scenario }) => scenario?.update);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0].scenario.update).sort(), [
    "data",
    "index",
  ]);
  assert.equal(updates[0].scenario.update.index, "existing-block");
  assert.equal(hub.state.scenarios[0].name, "Существующий BLOCK");
  assert.equal(hub.state.scenarios[0].vendorTopLevel, "preserve-me");

  const appliedData = hub.state.scenarios[0].data;
  hub.state.scenarios[0].data = JSON.stringify({
    ...JSON.parse(appliedData),
    manual: "keep",
  });
  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );

  hub.state.scenarios[0].data = appliedData;
  const restored = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.deepEqual(
    JSON.parse(hub.state.scenarios[0].data),
    blockData({ delay: 60_000 }),
  );
});

test("ACK without the requested BLOCK result stays uncertain and is not resent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 30_000 }),
      reason: "Изменить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  hub.state.behavior.ignoreNextUpdate = true;
  const first = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(first.structuredContent.status, "uncertain");
  assert.equal(
    first.structuredContent.conflict_reason,
    "ack_without_requested_result",
  );

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("history discovers changes by home and entity after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Изменить RESET delay",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.deepEqual(history.structuredContent.changes, [
    {
      change_ref: prepared.structuredContent.change_ref,
      operation: "block_data_update",
      status: "prepared",
      target_refs: [scenarioRef],
      created_at: history.structuredContent.changes[0].created_at,
      updated_at: history.structuredContent.changes[0].updated_at,
      next: {
        tool: "get_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      },
    },
  ]);
  assert.equal(history.structuredContent.truncated, false);
});
