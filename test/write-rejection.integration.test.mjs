import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  SIMULATED_HUB_TOKEN,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// A JSON-RPC error reply to a write is the hub's answer to that request: it
// received the write and refused it. Such a write must end as a definite
// rejection carrying the hub's code and message, not as an uncertain outcome
// that tells the agent the write may have happened and should be reconciled.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";

async function setup(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-write-rejection-"),
  );
  t.after(async () => {
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

async function startClient(t, hub, stateDirectory) {
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
  const client = new Client({ name: "write-rejection-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function requestsTo(hub, method) {
  return hub.requests.filter((request) => request.method === method);
}

function unsupported(method) {
  return {
    code: "unsupported",
    protocol_code: -32601,
    hub_message: `unsupported by simulator: ${method}`,
  };
}

function assertRefused(result, changeRef, rejection) {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.error.code, rejection.code);
  assert.equal(result.structuredContent.error.retryable, false);
  assert.equal(result.structuredContent.change_ref, changeRef);
  assert.equal(result.structuredContent.hub_effect, "not_applied");
  assert.deepEqual(result.structuredContent.rejection, rejection);
}

function assertRecordedRejection(change, { status, direction, rejection }) {
  assert.equal(change.status, status, JSON.stringify(change));
  assert.equal(change.native_write_sent, true);
  assert.equal(change.write_intent.acknowledged, false);
  assert.equal(change.write_intent.direction, direction);
  assert.equal(change.write_intent.phase, "reconciled");
  assert.deepEqual(change.write_intent.rejection, rejection);
}

const blockData = {
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
          characteristics: [{ type: "set", cId: 14, hc: "On", value: "true" }],
        },
      ],
      else: [],
      then_delay: 0,
      else_delay: 0,
    },
  ],
};

// One prepared change per native write lifecycle, with the write its apply
// sends first and the write its restore sends first.
const lifecycles = [
  {
    name: "characteristic value",
    applyMethod: "characteristic.update",
    input: {
      operation: "characteristic_value",
      target_ref: `${homeRef}/accessory/16/service/13/characteristic/15`,
      value: 30,
    },
  },
  {
    name: "scenario active flag",
    applyMethod: "window.update",
    restoreMethod: "window.update",
    input: {
      operation: "scenario_active",
      target_ref: `${homeRef}/scenario/3`,
      value: false,
    },
  },
  {
    name: "accessory placement",
    applyMethod: "accessory.update",
    restoreMethod: "accessory.update",
    input: {
      operation: "accessory_placement",
      target_ref: `${homeRef}/accessory/16`,
      name: "Торшер у кровати",
      room_ref: `${homeRef}/room/5`,
    },
  },
  {
    name: "room creation",
    applyMethod: "room.create",
    restoreMethod: "room.delete",
    input: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Кладовая",
    },
  },
  {
    name: "logic assignment",
    applyMethod: "logic.create",
    restoreMethod: "logic.delete",
    input: {
      operation: "logic_assignment",
      target_ref: `${homeRef}/accessory/16/service/13/logic/SmoothBrightnessChange`,
    },
  },
  {
    name: "BLOCK scenario",
    applyMethod: "scenario.create",
    restoreMethod: "scenario.delete",
    input: {
      operation: "block_create",
      target_ref: homeRef,
      name: "Свет в ванной по движению",
      description: "Включает свет в ванной при движении",
      active: true,
      on_start: false,
      sync: false,
      data: blockData,
    },
  },
  {
    name: "virtual light group",
    applyMethod: "accessory.create",
    restoreMethod: "link.remove",
    input: {
      operation: "virtual_light_group",
      target_ref: homeRef,
      room_ref: `${homeRef}/room/3`,
      name: "Свет гостиной",
      member_service_refs: [
        `${homeRef}/accessory/15/service/13`,
        `${homeRef}/accessory/16/service/13`,
      ],
      characteristic_types: ["On", "Brightness"],
    },
  },
];

test("a room rename the hub does not support is rejected, not uncertain", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const firstClient = await startClient(t, hub, stateDirectory);
  const prepared = await call(firstClient, "prepare_native_change", {
    operation: "room_name",
    target_ref: `${homeRef}/room/2`,
    value: "Холл",
    reason: "Переименовать коридор",
  });
  // The simulator implements room.update; refuse it the way a hub without
  // the method answers, once for each apply below.
  hub.refuseNext("room.update");
  hub.refuseNext("room.update");
  const rejection = unsupported("room.update");

  const applied = await firstClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });

  assertRefused(applied, prepared.change_ref, rejection);
  assertRecordedRejection(
    await call(firstClient, "get_native_change", {
      change_ref: prepared.change_ref,
    }),
    { status: "not_applied", direction: "apply", rejection },
  );
  await firstClient.close();

  const restartedClient = await startClient(t, hub, stateDirectory);
  assertRecordedRejection(
    await call(restartedClient, "get_native_change", {
      change_ref: prepared.change_ref,
    }),
    { status: "not_applied", direction: "apply", rejection },
  );
  const repeated = await restartedClient.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });
  assertRefused(repeated, prepared.change_ref, rejection);
  assert.equal(hub.state.rooms.find(({ id }) => id === 2).name, "Коридор");
});

test("a refused apply of every native write lifecycle is a recorded rejection", async (t) => {
  for (const lifecycle of lifecycles) {
    await t.test(lifecycle.name, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const prepared = await call(client, "prepare_native_change", {
        ...lifecycle.input,
        reason: "Проверить явный отказ хаба",
      });
      hub.refuseNext(lifecycle.applyMethod);
      const rejection = unsupported(lifecycle.applyMethod);

      const applied = await client.callTool({
        name: "apply_native_change",
        arguments: { change_ref: prepared.change_ref },
      });

      assertRefused(applied, prepared.change_ref, rejection);
      assertRecordedRejection(
        await call(client, "get_native_change", {
          change_ref: prepared.change_ref,
        }),
        { status: "not_applied", direction: "apply", rejection },
      );
      assert.equal(requestsTo(hub, lifecycle.applyMethod).length, 1);
      assert.deepEqual(
        diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
        [],
      );
    });
  }
});

test("a refused restore of every native write lifecycle keeps the change applied", async (t) => {
  for (const lifecycle of lifecycles.filter(({ restoreMethod }) =>
    Boolean(restoreMethod),
  )) {
    await t.test(lifecycle.name, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const prepared = await call(client, "prepare_native_change", {
        ...lifecycle.input,
        reason: "Проверить явный отказ хаба при возврате",
      });
      const applied = await call(client, "apply_native_change", {
        change_ref: prepared.change_ref,
      });
      assert.equal(applied.status, "applied");
      const afterApply = hub.snapshot();
      const sentBeforeRestore = requestsTo(hub, lifecycle.restoreMethod).length;
      hub.refuseNext(lifecycle.restoreMethod);
      const rejection = unsupported(lifecycle.restoreMethod);

      const restored = await client.callTool({
        name: "restore_native_change",
        arguments: { change_ref: prepared.change_ref },
      });

      assertRefused(restored, prepared.change_ref, rejection);
      assertRecordedRejection(
        await call(client, "get_native_change", {
          change_ref: prepared.change_ref,
        }),
        { status: "applied", direction: "restore", rejection },
      );
      assert.equal(
        requestsTo(hub, lifecycle.restoreMethod).length,
        sentBeforeRestore + 1,
      );
      assert.deepEqual(diffHomeSnapshots(afterApply, hub.snapshot()), []);
    });
  }
});

function linksInUse(state) {
  return Object.fromEntries(
    [...state.links].filter(([, links]) => links.length > 0).sort(),
  );
}

// A virtual light group is written step by step: create the accessory, add
// each link, enable link processing; restore removes the links, disables
// processing and deletes the accessory. A refusal of a later step leaves the
// steps the hub already acknowledged in the home, so the change is partial:
// neither "nothing changed" on apply nor "still applied" on restore.
const partialGroupRefusals = [
  { name: "a link on apply", direction: "apply", method: "link.addVirtual" },
  {
    name: "link processing on apply",
    direction: "apply",
    method: "characteristic.update",
  },
  {
    name: "disabling link processing on restore",
    direction: "restore",
    method: "characteristic.update",
  },
  {
    name: "the accessory delete on restore",
    direction: "restore",
    method: "accessory.delete",
  },
];

test("a refused later step of a virtual light group reports the partial group it leaves", async (t) => {
  const groupInput = lifecycles.find(
    ({ name }) => name === "virtual light group",
  ).input;
  for (const refusal of partialGroupRefusals) {
    await t.test(refusal.name, async (t) => {
      const { hub, stateDirectory } = await setup(t);
      const client = await startClient(t, hub, stateDirectory);
      const prepared = await call(client, "prepare_native_change", {
        ...groupInput,
        reason: "Проверить отказ хаба посреди изменения",
      });
      const changeRef = prepared.change_ref;
      if (refusal.direction === "restore") {
        const applied = await call(client, "apply_native_change", {
          change_ref: changeRef,
        });
        assert.equal(applied.status, "applied");
      }
      const accessoryIds = new Set(hub.state.accessories.map(({ id }) => id));
      hub.refuseNext(refusal.method);
      const rejection = unsupported(refusal.method);

      const refused = await client.callTool({
        name: `${refusal.direction}_native_change`,
        arguments: { change_ref: changeRef },
      });

      assert.equal(refused.isError, true, JSON.stringify(refused));
      const error = refused.structuredContent;
      assert.equal(error.error.code, rejection.code);
      assert.equal(error.change_ref, changeRef);
      assert.equal(error.hub_effect, "partial");
      assert.deepEqual(error.rejection, rejection);
      // The group accessory this change created is still in the home.
      const group = hub.state.accessories.find(
        (accessory) =>
          accessory.virtual === true &&
          (refusal.direction === "restore" || !accessoryIds.has(accessory.id)),
      );
      assert.ok(group, "the created group accessory is still present");
      assert.equal(
        error.change?.virtual_accessory_ref,
        `${homeRef}/accessory/${group.id}`,
      );
      assert.deepEqual(
        error.next,
        refusal.direction === "apply"
          ? {
              tool: "restore_native_change",
              arguments: { change_ref: changeRef },
            }
          : { tool: "get_native_change", arguments: { change_ref: changeRef } },
      );

      // The error and a later read describe the same recorded state.
      const detail = await call(client, "get_native_change", {
        change_ref: changeRef,
      });
      assert.equal(detail.status, "uncertain");
      assert.equal(detail.verification.result, "owned_partial_group_observed");
      assert.equal(error.change.status, detail.status);
      assert.equal(
        error.change.verification.result,
        detail.verification.result,
      );
      assert.equal(detail.write_intent.direction, refusal.direction);
      assert.deepEqual(detail.write_intent.rejection, rejection);
      assert.equal(detail.restore_supported, true);

      // Restoring the partial change puts the home back as it was prepared.
      const restored = await call(client, "restore_native_change", {
        change_ref: changeRef,
      });
      assert.equal(restored.status, "restored", JSON.stringify(restored));
      assert.deepEqual(
        diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
        [],
      );
      assert.deepEqual(linksInUse(hub.state), linksInUse(hub.initialState));
    });
  }
});

test("a refused scenario run is a recorded rejection that is never resent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await call(client, "prepare_native_change", {
    operation: "scenario_run",
    target_ref: `${homeRef}/scenario/11`,
    reason: "Выключить всё",
  });
  hub.refuseNext("scenario.run");
  const rejection = unsupported("scenario.run");

  const refused = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });

  assertRefused(refused, prepared.change_ref, rejection);
  const detail = await call(client, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assertRecordedRejection(detail, {
    status: "not_applied",
    direction: "apply",
    rejection,
  });
  assert.equal(detail.command_delivery.status, "rejected");
  const repeated = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(repeated.status, "not_applied");
  assert.equal(requestsTo(hub, "scenario.run").length, 1);
  assert.deepEqual(hub.state.runs, []);
});

test("a device command the hub refuses reports the hub reason in its item", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  hub.refuseNext("characteristic.update", {
    code: -32603,
    message: "Internal error: device is not responding",
  });
  const rejection = {
    code: "request_rejected",
    protocol_code: -32603,
    hub_message: "Internal error: device is not responding",
  };

  const sent = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${homeRef}/accessory/16/service/13/characteristic/15`,
        value: 30,
      },
    ],
    reason: "Приглушить торшер",
  });

  const [item] = sent.results;
  assert.equal(item.status, "rejected", JSON.stringify(item));
  assert.equal(item.sent, true);
  assert.equal(item.error.code, "request_rejected");
  assert.deepEqual(item.rejection, rejection);
  const detail = await call(client, "get_native_change", {
    change_ref: item.change_ref,
  });
  assertRecordedRejection(detail, {
    status: "not_applied",
    direction: "apply",
    rejection,
  });
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );
});

test("a hub refusal keeps its reason while the connection token stays out of output and journal", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await call(client, "prepare_native_change", {
    ...lifecycles.find(({ name }) => name === "BLOCK scenario").input,
    reason: "Сохранить причину отказа хаба",
  });
  hub.refuseNext("scenario.create", {
    code: -32603,
    message: "Internal error: scenario compilation failed",
  });

  const refused = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });

  const rejection = {
    code: "request_rejected",
    protocol_code: -32603,
    hub_message: "Internal error: scenario compilation failed",
  };
  assertRefused(refused, prepared.change_ref, rejection);
  assertRecordedRejection(
    await call(client, "get_native_change", {
      change_ref: prepared.change_ref,
    }),
    { status: "not_applied", direction: "apply", rejection },
  );

  hub.refuseNext("scenario.create", {
    code: -32603,
    message: `Internal error: bad session ${SIMULATED_HUB_TOKEN}`,
  });
  const leaking = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.change_ref },
  });
  assert.equal(leaking.isError, true);
  assert.equal(leaking.structuredContent.rejection.protocol_code, -32603);
  assert.equal(JSON.stringify(leaking).includes(SIMULATED_HUB_TOKEN), false);
  const detail = await client.callTool({
    name: "get_native_change",
    arguments: { change_ref: prepared.change_ref },
  });
  assert.equal(JSON.stringify(detail).includes(SIMULATED_HUB_TOKEN), false);
  for (const file of await readdir(stateDirectory)) {
    if (!file.endsWith(".json")) continue;
    const journal = await readFile(path.join(stateDirectory, file), "utf8");
    assert.equal(journal.includes(SIMULATED_HUB_TOKEN), false);
  }
});

test("a refused boolean automation create and rollback are rejections with the hub reason", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);
  const prepared = await call(client, "preview_boolean_automation", {
    name: "Свет в ванной по движению",
    reason: "Включать свет в ванной при движении",
    source_room_ref: `${homeRef}/room/8`,
    source_characteristic_ref: `${homeRef}/accessory/38/service/13/characteristic/14`,
    source_value: true,
    target_room_ref: `${homeRef}/room/8`,
    target_characteristic_ref: `${homeRef}/accessory/35/service/13/characteristic/14`,
    target_value: true,
  });
  hub.refuseNext("scenario.create");

  const refused = await client.callTool({
    name: "apply_automation_change",
    arguments: { change_ref: prepared.change_ref },
  });

  assertRefused(refused, prepared.change_ref, unsupported("scenario.create"));
  assert.equal(
    (
      await call(client, "get_automation_change", {
        change_ref: prepared.change_ref,
      })
    ).status,
    "prepared",
  );
  assert.deepEqual(
    diffHomeSnapshots(hub.initialSnapshot(), hub.snapshot()),
    [],
  );

  const applied = await call(client, "apply_automation_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(applied.status, "applied");
  hub.refuseNext("scenario.delete");
  const refusedRollback = await client.callTool({
    name: "rollback_automation_change",
    arguments: { change_ref: prepared.change_ref },
  });

  assertRefused(
    refusedRollback,
    prepared.change_ref,
    unsupported("scenario.delete"),
  );
  assert.equal(
    (
      await call(client, "get_automation_change", {
        change_ref: prepared.change_ref,
      })
    ).status,
    "applied",
  );
});
