import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  };
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request.params);
      socket.send(
        JSON.stringify({
          id: request.id,
          result: respond(state, request.params),
        }),
      );
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
          onStart: false,
          sync: false,
          data: observed.data,
        },
      },
    };
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
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  await client.connect(transport);
  return client;
}

test("automation preview explains current mechanisms without writing to the hub", async (t) => {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-automation-"),
  );
  const client = await startClient(t, hub, stateDirectory);

  const result = await client.callTool({
    name: "preview_boolean_automation",
    arguments: {
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
    },
  });

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
