import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// The simulator backs agent evaluations. These tests keep it compatible with
// the current client: if the server starts calling a method the simulator
// lacks, or parses a shape it does not return, a public tool fails here.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";

async function setup(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-simulated-hub-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "simulated-hub-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function assertEveryRequestSupported(hub) {
  assert.deepEqual(
    hub.requests
      .filter(({ error }) => error?.code === -32601)
      .map(({ method }) => method),
    [],
  );
}

test("public read tools see the simulated apartment as a native home", async (t) => {
  const { hub, client } = await setup(t);

  const homes = await call(client, "list_homes", {});
  assert.equal(homes.selection.default_home_ref, homeRef);

  const inspected = await call(client, "inspect_home", { home_ref: homeRef });
  assert.deepEqual(
    inspected.entities.rooms.map(({ name }) => name),
    [
      "Прихожая",
      "Коридор",
      "Гостиная",
      "Кухня",
      "Спальня",
      "Детская спальня",
      "Кабинет",
      "Ванная",
    ],
  );
  assert.deepEqual(
    inspected.entities.scenarios.map(({ name, type, active }) => [
      name,
      type,
      active,
    ]),
    [
      ["Свет в коридоре по движению", "BLOCK", true],
      ["Ночной режим", "BLOCK", true],
      ["Свет в прихожей при открытии двери", "BLOCK", false],
      ["Выключить свет в кабинете", "BLOCK", true],
      ["Защита от протечки", "LOGIC", true],
      ["Всё выключить", "BLOCK", true],
    ],
  );
  assert.ok(
    inspected.entities.extensions.some(
      ({ key }) => key === "Controller:zigbee",
    ),
  );

  const catalogAccessories = new Set();
  let page = await call(client, "read_services", {
    home_ref: homeRef,
    representation: "catalog",
  });
  for (;;) {
    for (const service of page.services) {
      catalogAccessories.add(service.accessory.ref);
    }
    if (!page.next) break;
    page = await call(client, page.next.tool, page.next.arguments);
  }
  assert.equal(catalogAccessories.size, hub.state.accessories.length);

  const bedroom = await call(client, "read_services", {
    home_ref: homeRef,
    room_ref: `${homeRef}/room/5`,
    service_types: ["TemperatureSensor"],
  });
  assert.deepEqual(
    bedroom.services.flatMap(({ accessory, readings }) =>
      readings.map(({ type, value, unit }) => [
        accessory.name,
        type,
        value,
        unit,
      ]),
    ),
    [["Датчик климата в спальне", "CurrentTemperature", 21.4, "°C"]],
  );

  const room = await call(client, "get_entity", {
    entity_ref: `${homeRef}/room/6`,
  });
  assert.equal(room.entity.name, "Детская спальня");
  assert.ok(
    room.entity.accessories.some(
      ({ name }) => name === "Датчик климата в детской",
    ),
  );

  const lamp = await call(client, "get_entity", {
    entity_ref: `${homeRef}/accessory/16`,
  });
  assert.equal(lamp.entity.name, "Торшер");
  assert.equal(lamp.entity.room_ref, `${homeRef}/room/3`);

  const night = await call(client, "get_entity", {
    entity_ref: `${homeRef}/scenario/5`,
    include: ["configuration"],
  });
  assert.equal(night.entity.configuration.format, "json");
  const [rule] = night.entity.configuration.value.targets;
  assert.equal(rule.if.conditions[0].type, "interval");
  assert.deepEqual(
    rule.then.map(({ aId }) => aId),
    [15, 14],
  );

  const code = await call(client, "get_entity", {
    entity_ref: `${homeRef}/scenario/9`,
    include: ["configuration"],
  });
  assert.equal(code.entity.configuration.format, "code");
  assert.match(code.entity.configuration.value, /HS\.LeakSensor/);

  const logic = await call(client, "get_entity", {
    entity_ref: `${homeRef}/accessory/23/service/13`,
  });
  assert.deepEqual(
    logic.entity.assigned_logics.map(({ type, active }) => [type, active]),
    [["UserLogic_9", true]],
  );

  assertEveryRequestSupported(hub);
  assert.deepEqual(hub.writes(), []);
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});

test("a prepared characteristic value changes only that simulated characteristic", async (t) => {
  const { hub, client } = await setup(t);

  const prepared = await call(client, "prepare_native_change", {
    operation: "characteristic_value",
    target_ref: `${homeRef}/accessory/16/service/13/characteristic/15`,
    value: 30,
    reason: "Приглушить торшер",
  });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(hub.writes(), []);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.observed_value, { value: 30, kind: "intValue" });
  assert.deepEqual(diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()), [
    { key: "characteristic/16.13.15/Brightness", before: 55, after: 30 },
  ]);
  assert.deepEqual(
    hub.writes().map(({ method, params }) => [method, params]),
    [
      [
        "characteristic.update",
        {
          characteristic: {
            update: {
              aId: 16,
              sId: 13,
              cId: 15,
              control: { value: { intValue: 30 } },
            },
          },
        },
      ],
    ],
  );
  assertEveryRequestSupported(hub);
});

test("a BLOCK created through prepare and apply is stored natively and restored away", async (t) => {
  const { hub, client } = await setup(t);
  const data = {
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              aId: 38,
              sId: 13,
              cId: 14,
              hs: "MotionSensor",
              hc: "MotionDetected",
              cond: "=",
              value: "true",
              trigger: true,
              time: 0,
              timeCond: "",
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [
          {
            type: "service",
            aId: 35,
            sId: 13,
            hs: "Lightbulb",
            characteristics: [
              { type: "set", cId: 14, hc: "On", value: "true" },
            ],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  };

  const prepared = await call(client, "prepare_native_change", {
    operation: "block_create",
    target_ref: homeRef,
    name: "Свет в ванной по движению",
    description: "Включает свет в ванной при движении",
    active: true,
    on_start: false,
    sync: false,
    data,
    reason: "Включать свет в ванной при движении",
  });
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(hub.writes(), []);

  const applied = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  const created = hub.state.scenarios.at(-1);
  assert.equal(applied.scenario_ref, `${homeRef}/scenario/${created.index}`);
  assert.equal(created.name, "Свет в ванной по движению");
  assert.equal(created.active, true);
  const snapshot = hub.snapshot();
  assert.deepEqual(
    JSON.parse(snapshot[`scenario/${created.index}/data`]),
    data,
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), snapshot).filter(
      ({ key }) => !key.startsWith(`scenario/${created.index}/`),
    ),
    [],
  );
  assert.deepEqual(
    hub
      .writes()
      .map(({ method }) => method)
      .filter((method) => method === "scenario.create"),
    ["scenario.create"],
  );

  const readBack = await call(client, "get_entity", {
    entity_ref: applied.scenario_ref,
    include: ["configuration"],
  });
  assert.equal(readBack.entity.name, "Свет в ванной по движению");
  assert.equal(readBack.entity.configuration.value.targets[0].then[0].aId, 35);

  const restored = await call(client, "restore_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(restored.status, "restored");
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
  assertEveryRequestSupported(hub);
});

test("the simulator refuses unknown methods and foreign tokens without touching the home", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const socket = new WebSocket(hub.url, "json-rpc");
  t.after(() => socket.close());
  await once(socket, "open");
  const send = async (message) => {
    socket.send(JSON.stringify(message));
    const [data] = await once(socket, "message");
    return JSON.parse(data.toString());
  };

  const unknown = await send({
    id: 1,
    token: hub.token,
    serial: hub.serial,
    params: { scenario: { export: { index: "5" } } },
  });
  assert.deepEqual(unknown.error, {
    code: -32601,
    message: "unsupported by simulator: scenario.export",
  });

  const foreign = await send({
    id: 2,
    token: "another-token",
    serial: hub.serial,
    params: { characteristic: { update: { aId: 16, sId: 13, cId: 14 } } },
  });
  assert.equal(foreign.error.code, 401);
  assert.deepEqual(
    hub.requests.map(({ method, write }) => [method, write]),
    [
      ["scenario.export", false],
      ["characteristic.update", true],
    ],
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});
