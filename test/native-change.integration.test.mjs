import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
const deviceWindowRef = `${homeRef}/window/Controller%2Fzigbee_demo%2FChild%2FDEVICE_A%2F`;
const startupOptionKey = "/11/0006_OnOff/4003_StartUpOnOff/255";

function setAction({
  aId = 34,
  sId = 13,
  cId = 15,
  hc = "On",
  value = "true",
} = {}) {
  return {
    type: "service",
    aId,
    sId,
    hs: "Lightbulb",
    characteristics: [{ type: "set", cId, hc, value }],
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

function withRuntimeBlockFields(data) {
  let nextBlockId = 1;
  const childFields = {
    root: ["targets"],
    if: ["if", "then", "else"],
    condition: ["conditions"],
    service: ["characteristics"],
    delay: ["targets"],
  };
  const visit = (value, kind) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return structuredClone(value);
    const normalized = structuredClone(value);
    if (kind !== "root") {
      normalized.blockId = nextBlockId++;
      if (kind === "if") normalized.state = false;
    }
    for (const key of childFields[kind] ?? []) {
      normalized[key] = Array.isArray(value[key])
        ? value[key].map((child) => visit(child, child?.type))
        : visit(value[key], value[key]?.type);
    }
    return normalized;
  };
  return visit(data, "root");
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
    window: {
      windowKey: "Controller/zigbee_demo/Child/DEVICE_A/",
      label: { text: "Настройки лампы" },
      options: [
        {
          key: startupOptionKey,
          name: "После восстановления питания",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 255 },
          validValues: [
            { name: "Выключена", value: { intValue: 0 }, checked: true },
            { name: "Включена", value: { intValue: 1 }, checked: true },
            {
              name: "Предыдущее состояние",
              value: { intValue: 255 },
              checked: true,
            },
          ],
        },
        {
          key: "/11/0008_Level/4000_Transition/0",
          name: "Плавность включения",
          type: "GenericInteger",
          inputType: "LIST",
          read: true,
          write: true,
          disabled: false,
          value: { intValue: 1 },
          validValues: [
            { name: "Сразу", value: { intValue: 0 } },
            { name: "Плавно", value: { intValue: 1 } },
          ],
        },
      ],
    },
    nextScenario: 1,
    behavior: {
      closeAfterCreate: false,
      closeAfterCharacteristicUpdate: false,
      closeAfterWindowUpdate: false,
      dropNextWindowUpdate: false,
      holdNextWindowUpdate: false,
      failNextCharacteristicGet: false,
      failNextWindowGet: false,
      failWindowGetAfterUpdate: false,
      failNextScenarioGet: false,
      rejectNextWindowUpdate: false,
      ignoreNextUpdate: false,
      invalidNextScenarioList: false,
      missingScenarioGetAsNotFoundError: false,
      rejectScenarioGetAsInternalError: false,
    },
  };
  state.accessories[1].services[0].characteristics.push(state.characteristic);
  state.accessories[1].services[0].characteristics.push(
    {
      aId: 34,
      sId: 13,
      cId: 16,
      control: {
        name: "Яркость",
        type: "Brightness",
        read: true,
        write: true,
        minValue: 0,
        maxValue: 100,
        minStep: 1,
        value: { intValue: 20 },
      },
    },
    {
      aId: 34,
      sId: 13,
      cId: 17,
      control: {
        name: "Только чтение",
        type: "StatusActive",
        read: true,
        write: false,
        value: { boolValue: true },
      },
    },
    {
      aId: 34,
      sId: 13,
      cId: 18,
      control: {
        name: "Режим",
        type: "TargetMode",
        read: true,
        write: true,
        value: { stringValue: "home" },
        validValues: [
          {
            key: "home",
            name: "Дома",
            value: { stringValue: "home" },
          },
          {
            key: "away",
            name: "Вне дома",
            value: { stringValue: "away" },
          },
        ],
      },
    },
  );
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(structuredClone(request.params));
      const params = request.params;
      if (
        (params.characteristic?.get &&
          state.behavior.failNextCharacteristicGet) ||
        (params.window?.get && state.behavior.failNextWindowGet) ||
        (params.scenario?.get && state.behavior.failNextScenarioGet)
      ) {
        state.behavior.failNextCharacteristicGet = false;
        state.behavior.failNextWindowGet = false;
        state.behavior.failNextScenarioGet = false;
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: 500, message: "temporary read failure" },
          }),
        );
        return;
      }
      let result;
      if (params.characteristic?.get) {
        const selected = state.accessories
          .find(({ id }) => id === params.characteristic.get.aId)
          ?.services.find(({ sId }) => sId === params.characteristic.get.sId)
          ?.characteristics.find(
            ({ cId }) => cId === params.characteristic.get.cId,
          );
        result = {
          characteristic: { get: structuredClone(selected) ?? null },
        };
      } else if (params.window?.get) {
        result = { window: { get: structuredClone(state.window) } };
      } else if (params.window?.update) {
        if (state.behavior.rejectNextWindowUpdate) {
          state.behavior.rejectNextWindowUpdate = false;
          socket.send(
            JSON.stringify({
              id: request.id,
              error: { code: 400, message: "window update rejected" },
            }),
          );
          return;
        }
        if (!state.behavior.dropNextWindowUpdate) {
          for (const update of params.window.update.options) {
            const option = state.window.options.find(
              ({ key }) => key === update.key,
            );
            if (option) option.value = structuredClone(update.value);
          }
        }
        state.behavior.dropNextWindowUpdate = false;
        if (state.behavior.holdNextWindowUpdate) {
          state.behavior.holdNextWindowUpdate = false;
          return;
        }
        if (state.behavior.failWindowGetAfterUpdate) {
          state.behavior.failWindowGetAfterUpdate = false;
          state.behavior.failNextWindowGet = true;
        }
        if (state.behavior.closeAfterWindowUpdate) {
          state.behavior.closeAfterWindowUpdate = false;
          socket.close();
          return;
        }
        result = { window: { update: {} } };
      } else if (params.characteristic?.update) {
        state.characteristic.control.value = structuredClone(
          params.characteristic.update.control.value,
        );
        if (state.behavior.closeAfterCharacteristicUpdate) {
          state.behavior.closeAfterCharacteristicUpdate = false;
          socket.close();
          return;
        }
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
        if (state.behavior.invalidNextScenarioList) {
          state.behavior.invalidNextScenarioList = false;
          result = { scenario: { list: { scenarios: {} } } };
        } else {
          result = {
            scenario: {
              list: {
                scenarios: state.scenarios.map(({ data: _data, ...scenario }) =>
                  structuredClone(scenario),
                ),
              },
            },
          };
        }
      } else if (params.scenario?.get) {
        const scenario = state.scenarios.find(
          ({ index }) => index === params.scenario.get.index,
        );
        if (
          state.behavior.rejectScenarioGetAsInternalError ||
          (!scenario && state.behavior.missingScenarioGetAsNotFoundError)
        ) {
          socket.send(
            JSON.stringify({
              id: request.id,
              error: {
                code: -32603,
                message: `Not found: 'Scenario ${params.scenario.get.index}'`,
              },
            }),
          );
          return;
        }
        result = {
          scenario: {
            get: structuredClone(scenario) ?? null,
          },
        };
      } else if (params.scenario?.create) {
        const created = {
          ...structuredClone(params.scenario.create),
          data: JSON.stringify(
            withRuntimeBlockFields(JSON.parse(params.scenario.create.data)),
          ),
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
          scenario.data = JSON.stringify(
            withRuntimeBlockFields(JSON.parse(params.scenario.update.data)),
          );
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
      for (const [matches, callbackName] of [
        [params.scenario?.create, "afterCreate"],
        [params.scenario?.update, "afterUpdate"],
        [params.scenario?.delete, "afterDelete"],
      ]) {
        if (matches && state.behavior[callbackName]) {
          const callback = state.behavior[callbackName];
          state.behavior[callbackName] = undefined;
          await callback();
        }
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

test("a window option applies one native setting and restores its baseline after restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);

  const contract = await firstClient.callTool({
    name: "get_native_change_contract",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
    },
  });
  assert.equal(contract.isError, undefined, contract.content[0]?.text);
  assert.deepEqual(contract.structuredContent.contract, {
    type: "GenericInteger",
    input_type: "LIST",
    kind: "intValue",
    valid_values: [
      { name: "Выключена", value: 0, kind: "intValue" },
      { name: "Включена", value: 1, kind: "intValue" },
      { name: "Предыдущее состояние", value: 255, kind: "intValue" },
    ],
    confirmation: "separate_window_get_readback",
  });

  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.equal(prepared.structuredContent.status, "prepared");
  assert.deepEqual(prepared.structuredContent.diff, {
    value: { from: 255, to: 0, kind: "intValue" },
  });
  assert.equal(prepared.structuredContent.restore_supported, true);

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.deepEqual(applied.structuredContent.observed_value, {
    value: 0,
    kind: "intValue",
  });
  assert.equal(
    applied.structuredContent.limitations.some((limitation) =>
      limitation.includes("physical power cycle remain unverified"),
    ),
    true,
  );
  assert.equal(hub.state.window.options[1].value.intValue, 1);
  assert.deepEqual(
    hub.requests.filter(({ window }) => window?.update),
    [
      {
        window: {
          update: {
            windowKey: "Controller/zigbee_demo/Child/DEVICE_A/",
            options: [{ key: startupOptionKey, value: { intValue: 0 } }],
          },
        },
      },
    ],
  );
  assert.ok(hub.requests.at(-1).window?.get);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.deepEqual(
    history.structuredContent.changes.map(({ change_ref }) => change_ref),
    [prepared.structuredContent.change_ref],
  );
  const discoveredChangeRef = history.structuredContent.changes[0].change_ref;

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: discoveredChangeRef },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.deepEqual(restored.structuredContent.observed_value, {
    value: 255,
    kind: "intValue",
  });
  assert.equal(hub.state.window.options[1].value.intValue, 1);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);

  const repeated = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: discoveredChangeRef },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) =>
        characteristic?.update ||
        scenario?.create ||
        scenario?.update ||
        scenario?.delete,
    ),
    false,
  );
});

test("an already desired window option creates no owned change or write", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  hub.state.window.options[0].value = { intValue: 0 };
  const client = await startClient(t, hub, stateDirectory);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0]?.text);
  assert.deepEqual(prepared.structuredContent, {
    status: "already_desired",
    operation: "window_option",
    target_ref: deviceWindowRef,
    option_key: startupOptionKey,
    observed_value: { value: 0, kind: "intValue" },
    native_write_sent: false,
    owned_change_created: false,
  });
  const history = await client.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });
  assert.deepEqual(history.structuredContent.changes, []);
  assert.equal(
    hub.requests.some(({ window }) => window?.update),
    false,
  );
});

test("a lost unexecuted window write can retry without losing the baseline", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.dropNextWindowUpdate = true;
  hub.state.behavior.closeAfterWindowUpdate = true;

  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.deepEqual(uncertain.structuredContent.observed_value, {
    value: 255,
    kind: "intValue",
  });

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const applied = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
});

test("a lost executed window write is reconciled without another update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.closeAfterWindowUpdate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.verification.fresh, false);
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a lost apply readback can be restored without a preliminary get", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "apply");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.applied_value_observed, true);
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a baseline read does not discard a delayed window apply", async (t) => {
  for (const readBeforeRestore of [false, true]) {
    await t.test(
      readBeforeRestore ? "after get" : "without get",
      async (scenario) => {
        const { hub, stateDirectory } = await setup(scenario);
        const firstClient = await startClient(scenario, hub, stateDirectory);
        const prepared = await firstClient.callTool({
          name: "prepare_native_change",
          arguments: {
            operation: "window_option",
            target_ref: deviceWindowRef,
            option_key: startupOptionKey,
            value: 0,
            reason: "Не включать лампу после восстановления питания",
          },
        });
        hub.state.behavior.dropNextWindowUpdate = true;

        const applied = await firstClient.callTool({
          name: "apply_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(applied.structuredContent.status, "uncertain");
        assert.equal(applied.structuredContent.write_intent.direction, "apply");
        assert.equal(hub.state.window.options[0].value.intValue, 255);

        if (readBeforeRestore) {
          const observed = await firstClient.callTool({
            name: "get_native_change",
            arguments: { change_ref: prepared.structuredContent.change_ref },
          });
          assert.equal(observed.structuredContent.status, "uncertain");
          assert.equal(
            observed.structuredContent.write_intent.direction,
            "apply",
          );
        }

        const waitingRestore = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(
          waitingRestore.isError,
          undefined,
          waitingRestore.content[0]?.text,
        );
        assert.equal(waitingRestore.structuredContent.status, "uncertain");
        assert.equal(
          waitingRestore.structuredContent.write_intent.direction,
          "apply",
        );
        assert.deepEqual(waitingRestore.structuredContent.observed_value, {
          value: 255,
          kind: "intValue",
        });
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          1,
        );

        hub.state.behavior.failNextWindowGet = true;
        const unreadableRestore = await firstClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });
        assert.equal(
          unreadableRestore.isError,
          undefined,
          unreadableRestore.content[0]?.text,
        );
        assert.equal(unreadableRestore.structuredContent.status, "uncertain");
        assert.equal(
          unreadableRestore.structuredContent.write_intent.direction,
          "apply",
        );
        assert.equal(
          unreadableRestore.structuredContent.verification.fresh,
          false,
        );
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          1,
        );

        hub.state.window.options[0].value = { intValue: 0 };
        await firstClient.close();
        const secondClient = await startClient(scenario, hub, stateDirectory);
        const restored = await secondClient.callTool({
          name: "restore_native_change",
          arguments: { change_ref: prepared.structuredContent.change_ref },
        });

        assert.equal(restored.isError, undefined, restored.content[0]?.text);
        assert.equal(restored.structuredContent.status, "restored");
        assert.equal(restored.structuredContent.applied_value_observed, true);
        assert.equal(hub.state.window.options[0].value.intValue, 255);
        assert.equal(
          hub.requests.filter(({ window }) => window?.update).length,
          2,
        );
      },
    );
  }
});

test("window option contract rejects controls outside the reversible setting slice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const option = hub.state.window.options[0];
  const unsupported = [
    { type: "GenericInteger", inputType: "BUTTON" },
    { type: "GenericBoolean", inputType: "LIST" },
    { type: "GenericInteger", inputType: "LIST", validValues: undefined },
    { type: "GenericInteger", inputType: "LIST", disabled: true },
  ];

  for (const fields of unsupported) {
    Object.assign(option, {
      type: "GenericInteger",
      inputType: "LIST",
      disabled: false,
      validValues: [
        { name: "Выключена", value: { intValue: 0 } },
        { name: "Предыдущее состояние", value: { intValue: 255 } },
      ],
      ...fields,
    });
    const contract = await client.callTool({
      name: "get_native_change_contract",
      arguments: {
        operation: "window_option",
        target_ref: deviceWindowRef,
        option_key: startupOptionKey,
      },
    });
    assert.equal(contract.isError, true);
    assert.match(
      contract.structuredContent.error.code,
      /unsupported_window_option|insufficient_rights/,
    );
  }
  assert.equal(
    hub.requests.some(({ window }) => window?.update),
    false,
  );
});

test("window option restore preserves a third value chosen after apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  for (const validValue of hub.state.window.options[0].validValues) {
    validValue.name = `Актуально: ${validValue.name}`;
  }
  delete hub.state.window.options[0].validValues.find(
    ({ value }) => value.intValue === 1,
  ).name;
  hub.state.window.options[0].value = { intValue: 1 };

  const conflict = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.conflict_reason, "manual_change");
  assert.deepEqual(conflict.structuredContent.value_choices, {
    baseline: {
      value: 255,
      kind: "intValue",
      name: "Актуально: Предыдущее состояние",
    },
    requested: {
      value: 0,
      kind: "intValue",
      name: "Актуально: Выключена",
    },
    observed: {
      value: 1,
      kind: "intValue",
    },
  });
  assert.deepEqual(conflict.structuredContent.conflict_resolution, {
    requires_user_decision: true,
    action_if_authorized: "prepare_new_window_option_change",
    effect: {
      replace: {
        value: 1,
        kind: "intValue",
      },
      with: {
        value: 255,
        kind: "intValue",
        name: "Актуально: Предыдущее состояние",
      },
    },
  });
  assert.equal(hub.state.window.options[0].value.intValue, 1);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);
});

test("a prepared window change cannot restore a matching manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.window.options[0].value = { intValue: 0 };
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const observed = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: deviceWindowRef },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(observed.structuredContent.status, "not_owned");
  assert.equal(
    history.structuredContent.changes[0].recorded_status,
    "not_owned",
  );
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 0);
});

test("a rejected window apply never earns the right to restore a matching manual value", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  hub.state.behavior.rejectNextWindowUpdate = true;
  const rejected = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  hub.state.window.options[0].value = { intValue: 0 };
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "not_owned");
  assert.equal(hub.state.window.options[0].value.intValue, 0);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 1);
});

test("an uncertain restore cannot be turned back into apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.failWindowGetAfterUpdate = true;
  const uncertain = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.write_intent.direction, "restore");
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const reconciled = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(reconciled.structuredContent.status, "restored");
  assert.equal(reconciled.structuredContent.write_intent.direction, "restore");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a restore interrupted before readback cannot be turned back into apply", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.holdNextWindowUpdate = true;
  const interruptedRestore = firstClient
    .callTool({
      name: "restore_native_change",
      arguments: { change_ref: prepared.structuredContent.change_ref },
    })
    .catch((error) => error);
  await waitFor(
    () => hub.requests.filter(({ window }) => window?.update).length === 2,
  );
  await firstClient.close();
  await interruptedRestore;
  assert.equal(hub.state.window.options[0].value.intValue, 255);

  const secondClient = await startClient(t, hub, stateDirectory);
  const reconciled = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(reconciled.isError, undefined, reconciled.content[0]?.text);
  assert.equal(reconciled.structuredContent.status, "restored");
  assert.equal(reconciled.structuredContent.write_intent.direction, "restore");
  assert.equal(hub.state.window.options[0].value.intValue, 255);
  assert.equal(hub.requests.filter(({ window }) => window?.update).length, 2);
});

test("a terminal window restore is explicit that no fresh readback occurred", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "window_option",
      target_ref: deviceWindowRef,
      option_key: startupOptionKey,
      value: 0,
      reason: "Не включать лампу после восстановления питания",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const readsBeforeRepeat = hub.requests.filter(
    ({ window }) => window?.get,
  ).length;

  const repeated = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "restored");
  assert.equal(repeated.structuredContent.verification.fresh, false);
  assert.equal(
    hub.requests.filter(({ window }) => window?.get).length,
    readsBeforeRepeat,
  );
});

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

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

async function blockStateDirectory(t, stateDirectory) {
  const backupDirectory = `${stateDirectory}-backup`;
  await rename(stateDirectory, backupDirectory);
  await writeFile(stateDirectory, "local state storage unavailable\n");
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await rm(stateDirectory, { force: true });
    await rename(backupDirectory, stateDirectory);
    restored = true;
  };
  t.after(async () => {
    if (!restored) await rm(stateDirectory, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  });
  return restore;
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

test("a lost characteristic response is reconciled without another command", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Включить лампу",
    },
  });
  hub.state.behavior.closeAfterCharacteristicUpdate = true;

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.isError, undefined, applied.content[0]?.text);
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(applied.structuredContent.native_acknowledged, false);
  assert.equal(applied.structuredContent.recovered_after_uncertain_write, true);

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const repeated = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(repeated.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ characteristic }) => characteristic?.update).length,
    1,
  );
});

test("apply revalidates the current characteristic contract and BLOCK bindings", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const characteristicChange = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 30,
      reason: "Изменить яркость",
    },
  });
  hub.state.accessories[1].services[0].characteristics.find(
    ({ cId }) => cId === 16,
  ).control.maxValue = 25;

  const rejectedCharacteristic = await client.callTool({
    name: "apply_native_change",
    arguments: {
      change_ref: characteristicChange.structuredContent.change_ref,
    },
  });
  assert.equal(rejectedCharacteristic.isError, true);
  assert.equal(
    hub.requests.some(({ characteristic }) => characteristic?.update),
    false,
  );

  const data = blockData();
  delete data.vendorConfiguration;
  const blockChange = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Проверка topology drift",
      description: "Не применять при изменившейся привязке",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить свежую привязку",
    },
  });
  hub.state.accessories[1].services[0].type = "Outlet";

  const rejectedBlock = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: blockChange.structuredContent.change_ref },
  });
  assert.equal(rejectedBlock.isError, true);
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create),
    false,
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
    assert.equal(prepared.structuredContent.diff.configuration.from, null);
    assert.equal(prepared.structuredContent.diff.configuration.to.name, name);
    assert.equal(
      prepared.structuredContent.diff.configuration.to.type,
      "BLOCK",
    );
    assert.deepEqual(
      prepared.structuredContent.diff.configuration.to.data,
      data,
    );
    assert.match(
      prepared.structuredContent.diff.configuration.to.desc,
      /sprut-agent:native:[a-f0-9]{24}/,
    );
  }
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.update),
    false,
  );
});

test("BLOCK grammar rejects known nodes in unsupported child slots before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const cases = [
    [
      "set in root.targets",
      (data) => {
        data.targets.push({ type: "set", cId: 15, hc: "On", value: "true" });
      },
    ],
    [
      "characteristic in if.then",
      (data) => {
        data.targets[0].then.unshift(
          characteristicCondition({ trigger: false }),
        );
      },
    ],
    [
      "set in condition.conditions",
      (data) => {
        data.targets[0].if.conditions.push({
          type: "set",
          cId: 15,
          hc: "On",
          value: "true",
        });
      },
    ],
    [
      "characteristic in delay.targets",
      (data) => {
        data.targets[0].then[1].targets.push(
          characteristicCondition({ trigger: false }),
        );
      },
    ],
    [
      "single object in if.then",
      (data) => {
        Reflect.set(data.targets[0], "then", data.targets[0].then[0]);
      },
    ],
  ];
  const results = [];

  for (const [name, mutate] of cases) {
    const data = blockData({ nested: true });
    delete data.vendorConfiguration;
    mutate(data);
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "block_create",
        target_ref: homeRef,
        name: `Неверная позиция: ${name}`,
        description: "Не отправлять неподдержанный BLOCK",
        active: false,
        on_start: false,
        sync: false,
        data,
        reason: "Проверить грамматику BLOCK",
      },
    });
    results.push({
      name,
      isError: prepared.isError,
      code: prepared.structuredContent?.error?.code,
    });
    if (!prepared.isError) {
      await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      });
    }
  }

  assert.deepEqual(
    results,
    cases.map(([name]) => ({
      name,
      isError: true,
      code: "invalid_block_data",
    })),
  );
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
  const appliedData = scenario.data;
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

  scenario.data = appliedData;
  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === applied.structuredContent.scenario_index,
    ),
    false,
  );
  assert.equal(
    hub.requests.filter(({ scenario: request }) => request?.delete).length,
    1,
  );
});

test("BLOCK create restore confirms real SprutHub not-found after restart without another delete", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с реальным not-found",
      description: "Подтвердить удаление полным каталогом",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить восстановление после рестарта",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const scenarioListsBeforeRestore = hub.requests.filter(
    ({ scenario }) => scenario?.list,
  ).length;
  const unrelatedScenarioReadsBeforeRestore = hub.requests.filter(
    ({ scenario }) => scenario?.get?.index === "existing-block",
  ).length;
  hub.state.behavior.missingScenarioGetAsNotFoundError = true;

  const restored = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(recovered.isError, undefined, recovered.content[0]?.text);
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  assert.ok(
    hub.requests.filter(({ scenario }) => scenario?.list).length -
      scenarioListsBeforeRestore >=
      2,
    "restore and post-restart observations must use fresh full catalogs",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) => scenario?.get?.index === "existing-block",
    ).length,
    unrelatedScenarioReadsBeforeRestore,
    "marker lookup must not read unrelated scenario configurations",
  );
});

test("scenario get rejection needs a valid catalog absence before it changes lifecycle state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с проверкой каталога",
      description: "Не считать произвольный отказ отсутствием",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить отрицательные исходы чтения",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const writesBeforeReads = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  hub.state.behavior.rejectScenarioGetAsInternalError = true;
  const presentButRejected = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.behavior.rejectScenarioGetAsInternalError = false;

  const createdIndex = applied.structuredContent.scenario_index;
  hub.state.scenarios = hub.state.scenarios.filter(
    ({ index }) => index !== createdIndex,
  );
  hub.state.behavior.missingScenarioGetAsNotFoundError = true;
  hub.state.behavior.invalidNextScenarioList = true;
  const missingWithInvalidCatalog = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  for (const observation of [presentButRejected, missingWithInvalidCatalog]) {
    assert.equal(observation.isError, undefined, observation.content[0]?.text);
    assert.equal(observation.structuredContent.status, "applied");
    assert.equal(observation.structuredContent.verification.fresh, false);
    assert.equal(
      "configuration_matches" in observation.structuredContent,
      false,
    );
  }
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeReads,
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
  assert.deepEqual(prepared.structuredContent.diff.data.from, blockData());
  assert.deepEqual(prepared.structuredContent.diff.data.to, requestedData);
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
  const restoredData = JSON.parse(hub.state.scenarios[0].data);
  assert.equal(restoredData.targets[0].then[1].time, 60_000);
  assert.deepEqual(restoredData.vendorConfiguration, { preserved: true });
});

test("restore preserves unknown vendor blockId and state fields", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const baseline = blockData();
  baseline.vendorConfiguration = {
    type: "if",
    blockId: "vendor-baseline",
    state: "configured",
  };
  hub.state.scenarios[0].data = JSON.stringify(baseline);
  const requested = structuredClone(baseline);
  requested.targets[0].then[1].time = 45_000;
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Сохранить vendor configuration",
    },
  });
  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  manuallyEdited.vendorConfiguration.blockId = "manual-change";
  manuallyEdited.vendorConfiguration.state = "manual-state";
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.configuration_matches, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).vendorConfiguration.blockId,
    "manual-change",
  );
});

test("BLOCK data restore revalidates current bindings before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить topology drift перед restore",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.accessories[1].services[0].type = "Outlet";

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.isError, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
  );
});

test("a restored BLOCK change is terminal and recovers a lost final save", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Временный BLOCK",
      description: "Проверить восстановление журнала",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить терминальный restore",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterDelete = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const restoredWithoutSave = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restoredWithoutSave.structuredContent.status, "restored");
  assert.deepEqual(restoredWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  assert.equal(
    restoredWithoutSave.structuredContent.write_intent.direction,
    "restore",
  );
  assert.equal(
    restoredWithoutSave.structuredContent.write_intent.acknowledged,
    true,
  );
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedApply = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeatedRestore = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "restored");
  assert.equal(recovered.structuredContent.native_acknowledged, false);
  assert.equal(recovered.structuredContent.write_intent.direction, "restore");
  assert.equal(recovered.structuredContent.write_intent.phase, "reconciled");
  assert.equal(repeatedApply.structuredContent.status, "restored");
  assert.equal(repeatedRestore.structuredContent.status, "restored");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("BLOCK create recovers when its applied result cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "BLOCK с потерянным journal save",
      description: "Восстановить результат после рестарта",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить create recovery",
    },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterCreate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutSave.structuredContent.status, "applied");
  assert.deepEqual(appliedWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: {
      home_ref: homeRef,
      entity_ref: appliedWithoutSave.structuredContent.scenario_ref,
    },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.equal(
    history.structuredContent.changes[0].change_ref,
    prepared.structuredContent.change_ref,
  );
  assert.equal(history.structuredContent.changes[0].recorded_status, "applied");
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("BLOCK update recovers when its applied result cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить update recovery",
    },
  });
  let restoreStateDirectory;
  hub.state.behavior.afterUpdate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const appliedWithoutSave = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(appliedWithoutSave.structuredContent.status, "applied");
  assert.deepEqual(appliedWithoutSave.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.verification.fresh, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
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

test("a changed BLOCK baseline is preserved before any update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Изменить RESET delay",
    },
  });
  hub.state.scenarios[0].data = JSON.stringify(blockData({ delay: 55_000 }));

  const applied = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(applied.structuredContent.status, "conflict");
  assert.equal(applied.structuredContent.conflict_reason, "baseline_changed");
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.update),
    false,
  );
  assert.equal(
    JSON.parse(hub.state.scenarios[0].data).targets[0].then[1].time,
    55_000,
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
      recorded_status: "prepared",
      target_refs: [
        scenarioRef,
        `${homeRef}/accessory/32`,
        `${homeRef}/accessory/32/service/13`,
        `${homeRef}/accessory/32/service/13/characteristic/15`,
        `${homeRef}/accessory/34`,
        `${homeRef}/accessory/34/service/13`,
        characteristicRef,
      ],
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

test("history labels a saved conflict before its next tool verifies current applied state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Отличить сохранённый конфликт от текущего состояния",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const appliedData = hub.state.scenarios[0].data;
  const manuallyEdited = JSON.parse(appliedData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  hub.state.scenarios[0].data = appliedData;
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const requestsBeforeHistory = hub.requests.length;
  const history = await secondClient.callTool({
    name: "list_native_changes",
    arguments: { home_ref: homeRef, entity_ref: scenarioRef },
  });
  assert.equal(history.isError, undefined, history.content[0]?.text);
  assert.equal(history.structuredContent.changes.length, 1);
  const [saved] = history.structuredContent.changes;
  assert.equal(saved.recorded_status, "conflict");
  assert.equal("status" in saved, false);
  assert.equal(typeof saved.updated_at, "string");
  assert.deepEqual(saved.next, {
    tool: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(
    hub.requests.length,
    requestsBeforeHistory,
    "listing saved history must not poll the live hub",
  );

  const current = await secondClient.callTool({
    name: saved.next.tool,
    arguments: saved.next.arguments,
  });
  assert.equal(current.isError, undefined, current.content[0]?.text);
  assert.equal(current.structuredContent.status, "applied");
  assert.equal(current.structuredContent.configuration_matches, true);
  assert.equal(current.structuredContent.verification.fresh, true);
});

test("history indexes created scenarios and BLOCK bindings before and after update", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const data = blockData();
  delete data.vendorConfiguration;
  const create = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Индексируемый BLOCK",
      description: "Найти после рестарта",
      active: false,
      on_start: false,
      sync: false,
      data,
      reason: "Проверить историю",
    },
  });
  const created = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  const requested = blockData();
  requested.targets[0].then[0] = setAction({
    cId: 16,
    hc: "Brightness",
    value: "30",
  });
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: requested,
      reason: "Сменить действие",
    },
  });
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);

  for (const [entityRef, expectedChange] of [
    [created.structuredContent.scenario_ref, create],
    [`${homeRef}/accessory/32`, create],
    [characteristicRef, update],
    [`${homeRef}/accessory/34/service/13/characteristic/16`, update],
  ]) {
    const history = await secondClient.callTool({
      name: "list_native_changes",
      arguments: { home_ref: homeRef, entity_ref: entityRef },
    });
    assert.equal(history.isError, undefined, history.content[0]?.text);
    assert.equal(
      history.structuredContent.changes.some(
        ({ change_ref }) =>
          change_ref === expectedChange.structuredContent.change_ref,
      ),
      true,
      entityRef,
    );
  }
});

test("status exposes failed fresh reads and clears stale configuration matches", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const block = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить freshness",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  hub.state.behavior.failNextScenarioGet = true;
  const unavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  assert.equal(unavailable.isError, undefined, unavailable.content[0]?.text);
  assert.equal(unavailable.structuredContent.status, "applied");
  assert.equal(unavailable.structuredContent.verification.fresh, false);
  assert.equal("configuration_matches" in unavailable.structuredContent, false);

  const manuallyEdited = JSON.parse(hub.state.scenarios[0].data);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: block.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.configuration_matches, false);
  assert.equal(conflict.structuredContent.verification.fresh, true);

  const characteristic = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: characteristicRef,
      value: true,
      reason: "Проверить freshness значения",
    },
  });
  await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: characteristic.structuredContent.change_ref },
  });
  hub.state.behavior.failNextCharacteristicGet = true;
  const characteristicUnavailable = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: characteristic.structuredContent.change_ref },
  });
  assert.equal(
    characteristicUnavailable.structuredContent.verification.fresh,
    false,
  );
});

test("fresh BLOCK match recovers from an earlier conflict before restore", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить возврат к applied snapshot",
    },
  });
  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  const appliedData = hub.state.scenarios[0].data;

  const manuallyEdited = JSON.parse(appliedData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const conflict = await firstClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(conflict.structuredContent.configuration_matches, false);

  hub.state.scenarios[0].data = appliedData;
  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const matchedAgain = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(matchedAgain.isError, undefined, matchedAgain.content[0]?.text);
  assert.equal(matchedAgain.structuredContent.status, "applied");
  assert.equal(matchedAgain.structuredContent.configuration_matches, true);
  assert.equal(matchedAgain.structuredContent.verification.fresh, true);
  assert.equal("conflict_reason" in matchedAgain.structuredContent, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    1,
    "get must only observe the returned applied configuration",
  );

  const restored = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(restored.isError, undefined, restored.content[0]?.text);
  assert.equal(restored.structuredContent.status, "restored");
  assert.equal(restored.structuredContent.configuration_matches, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.update).length,
    2,
  );
  assert.deepEqual(
    JSON.parse(hub.state.scenarios[0].data),
    withRuntimeBlockFields(blockData()),
  );
});

test("restored BLOCK observations keep terminal status and consistent snapshot facts", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const update = await firstClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_data_update",
      target_ref: scenarioRef,
      data: blockData({ delay: 45_000 }),
      reason: "Проверить наблюдение restored update",
    },
  });
  await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  const restoredUpdate = await firstClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(restoredUpdate.structuredContent.status, "restored");
  const restoredData = hub.state.scenarios[0].data;
  const manuallyEdited = JSON.parse(restoredData);
  manuallyEdited.manual = true;
  hub.state.scenarios[0].data = JSON.stringify(manuallyEdited);
  const writesBeforeGet = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  await firstClient.close();
  const secondClient = await startClient(t, hub, stateDirectory);
  const driftedUpdate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(driftedUpdate.structuredContent.status, "restored");
  assert.equal(driftedUpdate.structuredContent.configuration_matches, false);
  assert.equal(driftedUpdate.structuredContent.verification.fresh, true);
  assert.equal(
    driftedUpdate.structuredContent.verification.result,
    "baseline_configuration_missing",
  );

  hub.state.scenarios[0].data = restoredData;
  const matchingUpdate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: update.structuredContent.change_ref },
  });
  assert.equal(matchingUpdate.structuredContent.status, "restored");
  assert.equal(matchingUpdate.structuredContent.configuration_matches, true);
  assert.equal(
    matchingUpdate.structuredContent.verification.result,
    "baseline_configuration",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeGet,
  );

  const createData = blockData({ nested: true });
  delete createData.vendorConfiguration;
  const create = await secondClient.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Восстановленный create",
      description: "Проверить повторное появление",
      active: false,
      on_start: false,
      sync: false,
      data: createData,
      reason: "Проверить observation после удаления",
    },
  });
  const appliedCreate = await secondClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  const createdScenario = structuredClone(
    hub.state.scenarios.find(
      ({ index }) => index === appliedCreate.structuredContent.scenario_index,
    ),
  );
  const restoredCreate = await secondClient.callTool({
    name: "restore_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(restoredCreate.structuredContent.status, "restored");
  hub.state.scenarios.push(createdScenario);
  const writesBeforeCreateGet = hub.requests.filter(
    ({ scenario }) => scenario?.create || scenario?.update || scenario?.delete,
  ).length;

  const reappearedCreate = await secondClient.callTool({
    name: "get_native_change",
    arguments: { change_ref: create.structuredContent.change_ref },
  });
  assert.equal(reappearedCreate.structuredContent.status, "restored");
  assert.equal(reappearedCreate.structuredContent.configuration_matches, false);
  assert.equal(reappearedCreate.structuredContent.verification.fresh, true);
  assert.equal(
    reappearedCreate.structuredContent.verification.result,
    "baseline_configuration_missing",
  );
  assert.equal(
    hub.requests.filter(
      ({ scenario }) =>
        scenario?.create || scenario?.update || scenario?.delete,
    ).length,
    writesBeforeCreateGet,
  );
});

test("native preparation rejects unsafe targets and values before send", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const brightnessRef = `${homeRef}/accessory/34/service/13/characteristic/16`;
  const readOnlyRef = `${homeRef}/accessory/34/service/13/characteristic/17`;
  const modeRef = `${homeRef}/accessory/34/service/13/characteristic/18`;

  const contract = await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "characteristic_value", target_ref: brightnessRef },
  });
  assert.deepEqual(contract.structuredContent.contract, {
    type: "Brightness",
    kind: "intValue",
    min: 0,
    max: 100,
    step: 1,
  });

  for (const arguments_ of [
    {
      operation: "characteristic_value",
      target_ref: brightnessRef,
      value: 101,
      reason: "Недопустимый диапазон",
    },
    {
      operation: "characteristic_value",
      target_ref: readOnlyRef,
      value: false,
      reason: "Недоступная запись",
    },
    {
      operation: "characteristic_value",
      target_ref: modeRef,
      value: "vacation",
      reason: "Неизвестное enum-значение",
    },
    {
      operation: "characteristic_value",
      target_ref:
        "spruthub://hub/other-home/accessory/34/service/13/characteristic/15",
      value: true,
      reason: "Чужой дом",
    },
  ]) {
    const rejected = await client.callTool({
      name: "prepare_native_change",
      arguments: arguments_,
    });
    assert.equal(rejected.isError, true);
  }

  const unknownData = blockData();
  delete unknownData.vendorConfiguration;
  unknownData.targets[0].then[0].unsupportedAction = true;
  const unknown = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Неподдержанный BLOCK",
      description: "Не применять",
      active: false,
      on_start: false,
      sync: false,
      data: unknownData,
      reason: "Проверить схему",
    },
  });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, "invalid_block_data");
  assert.equal(
    hub.requests.some(
      ({ characteristic, scenario }) =>
        characteristic?.update || scenario?.create || scenario?.update,
    ),
    false,
  );
});
