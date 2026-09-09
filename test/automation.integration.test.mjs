import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
const observedContext = JSON.parse(
  await readFile(
    new URL(
      "../research/protocol/2026-09-09-automation-context.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const rooms = [
  { id: 1, name: "Гостиная" },
  { id: 2, name: "1 - Офис" },
];
const accessories = [
  {
    id: 32,
    roomId: 1,
    name: "Датчик движения",
    online: true,
    services: [
      {
        sId: 13,
        name: "Движение",
        type: "MotionSensor",
        characteristics: [
          {
            cId: 15,
            control: {
              name: "Обнаружено движение",
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
    roomId: 2,
    name: "Цветная лампа",
    online: true,
    services: [
      {
        sId: 13,
        name: "Свет",
        type: "Lightbulb",
        characteristics: [
          {
            cId: 15,
            control: {
              name: "Включена",
              type: "On",
              read: true,
              write: true,
              value: { boolValue: false },
            },
          },
        ],
      },
    ],
  },
];

async function startHub() {
  const requests = [];
  const state = {
    rooms: structuredClone(rooms),
    accessories: structuredClone(accessories),
    scenarios: [
      {
        index: "existing-block",
        name: "Существующий сценарий",
        type: "BLOCK",
        predefined: false,
        active: true,
      },
      {
        index: "built-in-logic",
        name: "Встроенная логика",
        type: "LOGIC",
        predefined: true,
        active: true,
      },
    ],
    nextScenario: 1,
  };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request.params);
      if (request.params.scenario?.create && state.closeWithoutCreate) {
        state.closeWithoutCreate = false;
        socket.close();
        return;
      }
      if (request.params.scenario?.create && state.rejectNextCreate) {
        state.rejectNextCreate = false;
        if (state.beforeCreateRejectionResponse) {
          const beforeCreateRejectionResponse =
            state.beforeCreateRejectionResponse;
          state.beforeCreateRejectionResponse = undefined;
          await beforeCreateRejectionResponse();
        }
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: 409, message: "Scenario rejected" },
          }),
        );
        return;
      }
      if (request.params.scenario?.list && state.closeNextScenarioList) {
        state.closeNextScenarioList = false;
        socket.close();
        return;
      }
      const result = respond(state, request.params);
      if (request.params.scenario?.list && state.afterScenarioList) {
        const afterScenarioList = state.afterScenarioList;
        state.afterScenarioList = undefined;
        await afterScenarioList();
      }
      if (request.params.scenario?.create && state.afterCreate) {
        const afterCreate = state.afterCreate;
        state.afterCreate = undefined;
        await afterCreate();
      }
      if (request.params.scenario?.delete && state.afterDelete) {
        const afterDelete = state.afterDelete;
        state.afterDelete = undefined;
        await afterDelete();
      }
      if (request.params.scenario?.create && state.closeAfterCreate) {
        state.closeAfterCreate = false;
        socket.close();
        return;
      }
      if (request.params.scenario?.create && state.incompatibleCreateResponse) {
        state.incompatibleCreateResponse = false;
        state.closeNextScenarioList = state.closeReadbackAfterWrite === true;
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { scenario: { create: {} } },
          }),
        );
        return;
      }
      if (request.params.scenario?.delete && state.incompatibleDeleteResponse) {
        state.incompatibleDeleteResponse = false;
        state.closeNextScenarioList = state.closeReadbackAfterWrite === true;
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { scenario: {} },
          }),
        );
        return;
      }
      if (
        (request.params.scenario?.create || request.params.scenario?.delete) &&
        state.closeReadbackAfterSuccessfulWrite
      ) {
        state.closeReadbackAfterSuccessfulWrite = false;
        state.closeNextScenarioList = true;
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

function respond(state, params) {
  if (params.room?.get) {
    return {
      room: {
        get: state.rooms.find(({ id }) => id === params.room.get.id) ?? null,
      },
    };
  }
  if (params.accessory?.list) {
    return {
      accessory: {
        list: {
          accessories: state.accessories.filter(
            ({ roomId }) => roomId === params.accessory.list.roomId,
          ),
        },
      },
    };
  }
  if (params.scenario?.list) {
    return params.scenario.list.aId === undefined
      ? { scenario: { list: { scenarios: state.scenarios } } }
      : { scenario: { list: {} } };
  }
  if (params.scenario?.get) {
    const scenario = state.scenarios.find(
      ({ index }) => index === params.scenario.get.index,
    );
    if (!scenario) return { scenario: { get: null } };
    const observed = observedContext.scenarioGet.result.scenario.get;
    return {
      scenario: {
        get: {
          ...scenario,
          onStart: scenario.onStart ?? false,
          sync: scenario.sync ?? false,
          data: scenario.data ?? observed.data,
        },
      },
    };
  }
  if (params.scenario?.create) {
    const scenario = {
      ...structuredClone(params.scenario.create),
      index: `created-${state.nextScenario++}`,
      predefined: false,
    };
    state.scenarios.push(scenario);
    return { scenario: { create: scenario } };
  }
  if (params.scenario?.delete) {
    const index = state.scenarios.findIndex(
      ({ index }) => index === params.scenario.delete.index,
    );
    if (index >= 0 && !state.keepScenarioOnDelete)
      state.scenarios.splice(index, 1);
    return { scenario: { delete: {} } };
  }
  if (params.logic?.list) {
    const logics =
      params.logic.list.aId === 34
        ? [
            {
              type: "LightbulbControl",
              name: "Связь включения и уровня",
              active: true,
            },
          ]
        : [];
    return { logic: { list: { logics } } };
  }
  if (params.logic?.types) {
    const logicTypes =
      params.logic.types.aId === 34
        ? [
            { type: "AdaptiveLighting", name: "Адаптивное освещение" },
            { type: "LightbulbControl", name: "Связь включения и уровня" },
          ]
        : [
            {
              type: "MotionDetectedFromCurrentMotionLevel",
              name: "Наличие движения исходя из уровня движения",
            },
          ];
    return { logic: { types: { logicTypes } } };
  }
  if (params.link?.list) {
    return { link: { list: { links: [{ type: "SYSTEM" }] } } };
  }
  if (params.characteristic?.getOptions) {
    return {
      characteristic: {
        getOptions: {
          options:
            params.characteristic.getOptions.aId === 32
              ? [
                  {
                    key: "SwitchOffTime",
                    name: "Выключить через (сек.)",
                    type: "GenericDouble",
                    value: { doubleValue: 180 },
                    read: true,
                    write: true,
                  },
                ]
              : [],
        },
      },
    };
  }
  if (params.extension?.list) {
    return {
      extension: {
        list: {
          extensions: [
            {
              type: "zigbee",
              bundleType: "CONTROLLER",
              name: "ZigBee",
              enabled: true,
              state: "LOADED",
            },
            {
              type: "telegram",
              bundleType: "NOTIFICATION",
              name: "Telegram",
              enabled: true,
              state: "FAILED",
            },
          ],
        },
      },
    };
  }
  throw new Error(`Unexpected operation: ${JSON.stringify(params)}`);
}

async function startClient(t, hub, stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "automation-test-token",
      SPRUTHUB_SERIAL: "automation-test-hub",
      SPRUTHUB_CID: "automation-test-client",
      SPRUTHUB_TIMEOUT_MS: "1000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "automation-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);
  return client;
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-automation-"),
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

async function readStateJournal(stateDirectory) {
  const [file] = (await readdir(stateDirectory)).filter((name) =>
    name.startsWith("automation-changes-"),
  );
  return readFile(path.join(stateDirectory, file), "utf8");
}

const previewArguments = {
  name: "Движение в гостиной включает офисную лампу",
  reason: "Включать свет при движении",
  source_room_ref: "spruthub://room/1",
  source_characteristic_ref:
    "spruthub://accessory/32/service/13/characteristic/15",
  source_value: true,
  target_room_ref: "spruthub://room/2",
  target_characteristic_ref:
    "spruthub://accessory/34/service/13/characteristic/15",
  target_value: true,
};

async function preview(client) {
  return client.callTool({
    name: "preview_boolean_automation",
    arguments: previewArguments,
  });
}

test("automation preview explains current mechanisms without writing to the hub", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  const result = await preview(client);

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "prepared");
  assert.match(
    result.structuredContent.change_ref,
    /^spruthub-change:\/\/automation\/[a-f0-9]{24}$/,
  );
  assert.deepEqual(result.structuredContent.condition, {
    room: { ref: "spruthub://room/1", name: "Гостиная" },
    device: {
      ref: "spruthub://accessory/32",
      name: "Датчик движения",
    },
    service: {
      ref: "spruthub://accessory/32/service/13",
      name: "Движение",
      type: "MotionSensor",
    },
    characteristic: {
      ref: "spruthub://accessory/32/service/13/characteristic/15",
      name: "Обнаружено движение",
      type: "MotionDetected",
      read: true,
      write: false,
    },
    operator: "=",
    value: true,
    trigger: true,
  });
  assert.equal(result.structuredContent.action.value, true);
  assert.equal(result.structuredContent.action.characteristic.type, "On");
  assert.deepEqual(result.structuredContent.native_shape, {
    mechanism: "BLOCK",
    active: true,
    on_start: false,
    sync: false,
    else_actions: [],
  });
  assert.deepEqual(
    result.structuredContent.context.scenarios.map(
      ({ name, type, predefined, active }) => ({
        name,
        type,
        predefined,
        active,
      }),
    ),
    [
      {
        name: "Существующий сценарий",
        type: "BLOCK",
        predefined: false,
        active: true,
      },
      {
        name: "Встроенная логика",
        type: "LOGIC",
        predefined: true,
        active: true,
      },
    ],
  );
  assert.deepEqual(result.structuredContent.context.target.assigned_logics, [
    {
      type: "LightbulbControl",
      name: "Связь включения и уровня",
      active: true,
    },
  ]);
  assert.deepEqual(result.structuredContent.context.source.options, [
    {
      key: "SwitchOffTime",
      name: "Выключить через (сек.)",
      type: "GenericDouble",
      value: 180,
      read: true,
      write: true,
    },
  ]);
  assert.deepEqual(
    result.structuredContent.context.extensions.map(
      ({ bundle_type, state }) => ({ bundle_type, state }),
    ),
    [
      { bundle_type: "CONTROLLER", state: "LOADED" },
      { bundle_type: "NOTIFICATION", state: "FAILED" },
    ],
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.create || scenario?.delete),
    false,
  );
});

test("apply creates one exact native rule and repeated apply does not duplicate it", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);

  const first = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const second = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.status, "applied");
  assert.equal(first.structuredContent.created, true);
  assert.equal(second.structuredContent.status, "applied");
  assert.equal(second.structuredContent.created, false);
  const creates = hub.requests.filter(({ scenario }) => scenario?.create);
  assert.equal(creates.length, 1);
  const payload = creates[0].scenario.create;
  assert.deepEqual(
    {
      name: payload.name,
      active: payload.active,
      onStart: payload.onStart,
      sync: payload.sync,
      type: payload.type,
    },
    {
      name: previewArguments.name,
      active: true,
      onStart: false,
      sync: false,
      type: "BLOCK",
    },
  );
  assert.match(payload.desc, /sprut-agent:automation:[a-f0-9]{24}/);
  const data = JSON.parse(payload.data);
  assert.deepEqual(data.targets[0].if.conditions, [
    {
      type: "characteristic",
      blockId: 3,
      aId: 32,
      sId: 13,
      cId: 15,
      value: "true",
      cond: "=",
      trigger: true,
      hs: "MotionSensor",
      hc: "MotionDetected",
      time: 0,
      timeCond: "",
    },
  ]);
  assert.deepEqual(data.targets[0].then, [
    {
      type: "service",
      blockId: 4,
      aId: 34,
      sId: 13,
      hs: "Lightbulb",
      characteristics: [
        { type: "set", blockId: 5, cId: 15, hc: "On", value: "true" },
      ],
    },
  ]);
  assert.deepEqual(data.targets[0].else, []);
  assert.equal(
    hub.state.scenarios.some(({ index }) => index === "existing-block"),
    true,
  );
});

test("apply reconciles a dropped create response without sending create twice", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  hub.state.closeAfterCreate = true;

  const result = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "applied");
  assert.equal(result.structuredContent.recovered_after_disconnect, true);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("change ownership and status survive an MCP process restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const result = await secondClient.callTool({
    name: "get_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "applied");
  assert.equal(result.structuredContent.owned, true);
  assert.equal(result.structuredContent.configuration_matches, true);
});

test("rollback deletes only an unchanged owned scenario and preserves manual edits", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const first = await preview(client);
  const firstApply = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });

  const rolledBack = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  assert.equal(rolledBack.isError, undefined);
  assert.equal(rolledBack.structuredContent.status, "rolled_back");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === firstApply.structuredContent.scenario_index,
    ),
    false,
  );

  const second = await preview(client);
  const secondApply = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  const manuallyEdited = hub.state.scenarios.find(
    ({ index }) => index === secondApply.structuredContent.scenario_index,
  );
  manuallyEdited.name = "Ручная правка после создания";

  const refused = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  assert.equal(refused.isError, undefined);
  assert.equal(refused.structuredContent.status, "conflict");
  assert.equal(refused.structuredContent.action, "review_manual_changes");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === secondApply.structuredContent.scenario_index,
    ),
    true,
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("an equivalent rule under another name is reused without transferring ownership", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const first = await preview(client);
  const firstApply = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: first.structuredContent.change_ref },
  });
  const second = await client.callTool({
    name: "preview_boolean_automation",
    arguments: { ...previewArguments, name: "Другое название той же связи" },
  });

  const secondApply = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });
  const secondRollback = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: second.structuredContent.change_ref },
  });

  assert.equal(secondApply.structuredContent.status, "already_present");
  assert.equal(secondApply.structuredContent.created, false);
  assert.equal(secondApply.structuredContent.owned, false);
  assert.equal(
    secondApply.structuredContent.scenario_index,
    firstApply.structuredContent.scenario_index,
  );
  assert.equal(secondRollback.structuredContent.status, "not_owned");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === firstApply.structuredContent.scenario_index,
    ),
    true,
  );
});

test("an unknown create outcome stays uncertain and a repeated apply does not resend it", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  hub.state.closeWithoutCreate = true;

  const first = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const second = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const rollback = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(first.structuredContent.status, "uncertain");
  assert.equal(first.structuredContent.action, "inspect_hub_before_retry");
  assert.equal(second.structuredContent.status, "uncertain");
  assert.equal(rollback.structuredContent.status, "uncertain");
  assert.equal(rollback.structuredContent.action, "inspect_hub_before_retry");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.delete),
    false,
  );
});

test("rollback preserves a scenario whose ownership marker was manually removed", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  const applied = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const manuallyEdited = hub.state.scenarios.find(
    ({ index }) => index === applied.structuredContent.scenario_index,
  );
  manuallyEdited.desc = "Ручное описание без маркера";

  const result = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(result.structuredContent.status, "conflict");
  assert.equal(result.structuredContent.owned, false);
  assert.equal(result.structuredContent.action, "review_manual_changes");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === applied.structuredContent.scenario_index,
    ),
    true,
  );
  assert.equal(
    hub.requests.some(({ scenario }) => scenario?.delete),
    false,
  );
});

test("a matching rule with different runtime properties is an explicit conflict", async (t) => {
  for (const [property, value] of [
    ["active", false],
    ["sync", true],
  ]) {
    await t.test(`${property}=${value}`, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const first = await preview(client);
      const firstApply = await client.callTool({
        name: "apply_automation_change",
        arguments: { change_ref: first.structuredContent.change_ref },
      });
      const existing = hub.state.scenarios.find(
        ({ index }) => index === firstApply.structuredContent.scenario_index,
      );
      existing[property] = value;
      const second = await client.callTool({
        name: "preview_boolean_automation",
        arguments: {
          ...previewArguments,
          name: `Повтор при ${property}=${value}`,
        },
      });

      const result = await client.callTool({
        name: "apply_automation_change",
        arguments: { change_ref: second.structuredContent.change_ref },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.status, "conflict");
      assert.equal(
        result.structuredContent.reason,
        "equivalent_rule_runtime_mismatch",
      );
      assert.equal(
        result.structuredContent.scenario_index,
        firstApply.structuredContent.scenario_index,
      );
      assert.deepEqual(result.structuredContent.required_runtime, {
        active: true,
        on_start: false,
        sync: false,
      });
      assert.equal(
        hub.requests.filter(({ scenario }) => scenario?.create).length,
        1,
      );
    });
  }
});

test("status reflects a foreign equivalent after its runtime conflict is fixed", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const owner = await preview(client);
  const ownerApply = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: owner.structuredContent.change_ref },
  });
  const existing = hub.state.scenarios.find(
    ({ index }) => index === ownerApply.structuredContent.scenario_index,
  );
  existing.active = false;
  const foreign = await client.callTool({
    name: "preview_boolean_automation",
    arguments: { ...previewArguments, name: "Внешнее правило" },
  });
  const conflict = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: foreign.structuredContent.change_ref },
  });
  existing.active = true;
  const journalBeforeStatus = await readStateJournal(stateDirectory);

  const result = await client.callTool({
    name: "get_automation_change",
    arguments: { change_ref: foreign.structuredContent.change_ref },
  });

  assert.equal(conflict.structuredContent.status, "conflict");
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "already_present");
  assert.equal(result.structuredContent.scenario_index, existing.index);
  assert.equal(result.structuredContent.owned, false);
  assert.equal(result.structuredContent.configuration_matches, true);
  assert.equal(await readStateJournal(stateDirectory), journalBeforeStatus);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create || scenario?.delete)
      .length,
    1,
  );
});

test("an incompatible create response remains recoverable without a duplicate", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  hub.state.incompatibleCreateResponse = true;
  hub.state.closeReadbackAfterWrite = true;

  const uncertain = await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(uncertain.isError, undefined);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.action, "inspect_hub_before_retry");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.created, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("an incompatible create response is applied when reconciliation succeeds", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  hub.state.incompatibleCreateResponse = true;

  const result = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "applied");
  assert.equal(result.structuredContent.recovered_after_uncertain_write, true);
  assert.equal(result.structuredContent.recovered_after_disconnect, undefined);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("a confirmed create rejection has no hidden effect and can be retried", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  hub.state.rejectNextCreate = true;

  const rejected = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "request_rejected");
  assert.equal(
    hub.state.scenarios.filter(({ index }) => index.startsWith("created-"))
      .length,
    0,
  );

  const retried = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(retried.isError, undefined);
  assert.equal(retried.structuredContent.status, "applied");
  assert.equal(
    hub.state.scenarios.filter(({ index }) => index.startsWith("created-"))
      .length,
    1,
  );
});

test("a confirmed create rejection survives failure to restore the prepared journal state", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  let restoreStateDirectory;
  hub.state.rejectNextCreate = true;
  hub.state.beforeCreateRejectionResponse = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const rejected = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "request_rejected");
  assert.equal(
    rejected.structuredContent.change_ref,
    prepared.structuredContent.change_ref,
  );
  assert.equal(rejected.structuredContent.hub_effect, "not_applied");
  assert.deepEqual(rejected.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_preview_boolean_automation",
  });
  assert.equal(
    hub.state.scenarios.filter(({ index }) => index.startsWith("created-"))
      .length,
    0,
  );
  await restoreStateDirectory();

  const staleRetry = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(staleRetry.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );

  const replacement = await preview(client);
  const applied = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: replacement.structuredContent.change_ref },
  });
  assert.equal(applied.structuredContent.status, "applied");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    2,
  );
});

test("an incompatible delete response is reconciled after restart without another delete", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.incompatibleDeleteResponse = true;
  hub.state.closeReadbackAfterWrite = true;

  const uncertain = await firstClient.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(uncertain.isError, undefined);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(uncertain.structuredContent.action, "inspect_hub_before_retry");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const journalBeforeStatus = await readStateJournal(stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(await readStateJournal(stateDirectory), journalBeforeStatus);
  const repeated = await secondClient.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.structuredContent.status, "rolled_back");
  assert.equal(repeated.structuredContent.status, "rolled_back");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("parallel equivalent applies in one MCP process create only one native rule", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const [first, second] = await Promise.all([preview(client), preview(client)]);

  const results = await Promise.all(
    [first, second].map((prepared) =>
      client.callTool({
        name: "apply_automation_change",
        arguments: { change_ref: prepared.structuredContent.change_ref },
      }),
    ),
  );

  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  assert.deepEqual(
    results.map(({ structuredContent }) => structuredContent.status).sort(),
    ["already_present", "applied"],
  );
});

test("a failed readback after a successful create stays recoverable", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  hub.state.closeReadbackAfterSuccessfulWrite = true;

  const uncertain = await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.isError, undefined);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.created, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("a confirmed create reports its hub effect when the final journal save fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  let restoreStateDirectory;
  hub.state.afterCreate = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };
  hub.state.incompatibleCreateResponse = true;

  const result = await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "applied");
  assert.equal(
    result.structuredContent.change_ref,
    prepared.structuredContent.change_ref,
  );
  assert.equal(result.structuredContent.created, true);
  assert.equal(result.structuredContent.hub_configuration_verified, true);
  assert.equal(result.structuredContent.recovered_after_uncertain_write, true);
  assert.deepEqual(result.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_automation_change",
  });
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "applied");
  assert.equal(recovered.structuredContent.created, false);
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.create).length,
    1,
  );
});

test("a failed readback after a successful delete stays recoverable", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.closeReadbackAfterSuccessfulWrite = true;

  const uncertain = await firstClient.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.isError, undefined);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "rolled_back");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("a confirmed delete reports its hub effect when the final journal save fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await preview(firstClient);
  await firstClient.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  let restoreStateDirectory;
  hub.state.afterDelete = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const result = await firstClient.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "rolled_back");
  assert.equal(
    result.structuredContent.change_ref,
    prepared.structuredContent.change_ref,
  );
  assert.equal(result.structuredContent.removed, true);
  assert.deepEqual(result.structuredContent.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_automation_change",
  });
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await secondClient.callTool({
    name: "get_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  const repeated = await secondClient.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(recovered.structuredContent.status, "rolled_back");
  assert.equal(repeated.structuredContent.status, "rolled_back");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("rollback does not delete when its recovery intent cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  let restoreStateDirectory;
  hub.state.afterScenarioList = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const refused = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });

  assert.equal(refused.isError, true);
  assert.equal(
    refused.structuredContent.error.code,
    "state_storage_unavailable",
  );
  assert.equal(
    refused.structuredContent.error.action,
    "restore_state_storage_then_retry",
  );
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    0,
  );
  await restoreStateDirectory();

  const retried = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(retried.structuredContent.status, "rolled_back");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    1,
  );
});

test("a successful delete response cannot claim rollback while the scenario remains", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await preview(client);
  const applied = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  hub.state.keepScenarioOnDelete = true;

  const uncertain = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(uncertain.isError, undefined);
  assert.equal(uncertain.structuredContent.status, "uncertain");
  assert.equal(
    hub.state.scenarios.some(
      ({ index }) => index === applied.structuredContent.scenario_index,
    ),
    true,
  );

  hub.state.keepScenarioOnDelete = false;
  const retried = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(retried.structuredContent.status, "rolled_back");
  assert.equal(
    hub.requests.filter(({ scenario }) => scenario?.delete).length,
    2,
  );
});
