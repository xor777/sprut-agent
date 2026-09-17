import assert from "node:assert/strict";
import test from "node:test";
import {
  accessoryDeleteDecision,
  accessoryNameFor,
  assertWriteTarget,
  assignmentDeleteDecision,
  buildLogicSource,
  buildReplacementSource,
  createMarker,
  emptyLogIsNotSuccess,
  parseArgs,
  runProbe,
  scenarioDeleteDecision,
  selectOwnMarkedLogMessages,
  sourceFiltersByAccessoryId,
} from "./manual-light-lifecycle-probe.mjs";

const marker = "sprut-probe:aabbccdd";

test("default argv is help and does not enable live writes", () => {
  const args = parseArgs([]);
  assert.equal(args.mode, "help");
  assert.equal(args.confirmOwnerPermission, false);
});

test("live mode without owner confirmation is refused", () => {
  assert.throws(
    () => parseArgs(["--execute-live", "--room-id", "2"]),
    /--i-confirm-owner-permission/,
  );
});

test("live mode without room id is refused", () => {
  assert.throws(
    () => parseArgs(["--execute-live", "--i-confirm-owner-permission"]),
    /--room-id/,
  );
});

test("generated source filters the created accessory id, not a name match", () => {
  const source = buildLogicSource({ marker, accessoryId: 90, timerMs: 3000 });
  assert.equal(sourceFiltersByAccessoryId(source, 90), true);
  assert.equal(sourceFiltersByAccessoryId(source, 31), false);
  assert.match(source, /TARGET_AID = 90/);
  assert.match(source, /getAccessory\(\)/);
  assert.match(source, /getUUID\(\)/);
  assert.equal(source.includes(accessoryNameFor(marker)), true);
  assert.equal(source.includes("Hub.subscribe"), true);
  assert.doesNotMatch(source, /TARGET_AID = 31/);
});

test("replacement source keeps the accessory filter and marker", () => {
  const source = buildReplacementSource({ marker, accessoryId: 90 });
  assert.equal(sourceFiltersByAccessoryId(source, 90), true);
  assert.match(source, /replacement_trigger/);
  assert.equal(source.includes("setTimeout"), false);
  assert.equal(source.includes("Hub.subscribe"), false);
  assert.equal(source.includes(marker), true);
});

test("log filter keeps only own marked lines and ignores the rest", () => {
  const own = selectOwnMarkedLogMessages(
    [
      {
        time: 1,
        level: "LOG_LEVEL_INFO",
        path: "Scenario.Logic",
        message: `${marker} event=timer_fired`,
      },
      {
        time: 2,
        level: "LOG_LEVEL_INFO",
        path: "Account",
        message: "token=super-secret login=owner@example",
      },
      {
        time: 3,
        path: "Scenario.Logic",
        message: `prefix ${marker} event=subscribe_cb arity=1`,
      },
    ],
    marker,
  );
  assert.deepEqual(
    own.map((entry) => entry.message),
    [`${marker} event=timer_fired`, `${marker} event=subscribe_cb arity=1`],
  );
  assert.equal(emptyLogIsNotSuccess([]).status, "inconclusive");
  assert.equal(emptyLogIsNotSuccess(own).status, "observed");
});

test("unknown accessory identity does not authorize delete", () => {
  assert.deepEqual(
    accessoryDeleteDecision({ accessoryId: null, accessory: { id: 90 } }),
    { action: "stop", reason: "unknown_accessory_id" },
  );
});

test("a name-only candidate with foreign links is not deleted", () => {
  assert.equal(
    accessoryDeleteDecision({
      accessoryId: 90,
      accessory: { id: 90, virtual: true, name: accessoryNameFor(marker) },
      links: [
        {
          type: "IN",
          index: "1",
          characteristics: [{ aId: 31, sId: 13, cId: 15 }],
        },
      ],
      logics: [],
    }).reason,
    "foreign_links",
  );
});

test("a later assignment on the created service blocks accessory delete", () => {
  assert.equal(
    accessoryDeleteDecision({
      accessoryId: 90,
      accessory: { id: 90, virtual: true },
      links: [],
      logics: [{ type: "LightbulbControl" }],
      expectedLogicType: "ProbeType",
    }).reason,
    "foreign_assignments",
  );
});

test("changed source blocks scenario delete", () => {
  assert.equal(
    scenarioDeleteDecision({
      scenarioIndex: "42",
      scenario: { index: "42", data: "unrelated source" },
      marker,
      assignmentPresent: false,
    }).reason,
    "source_changed_or_unmarked",
  );
});

test("assignment delete requires the created type on the created service", () => {
  assert.equal(
    assignmentDeleteDecision({
      accessoryId: 90,
      serviceId: 13,
      logicType: null,
      logics: [{ type: "ProbeType" }],
    }).reason,
    "unknown_logic_type",
  );
  assert.equal(
    assignmentDeleteDecision({
      accessoryId: 90,
      serviceId: 13,
      logicType: "ProbeType",
      logics: [{ type: "ProbeType" }],
    }).action,
    "delete",
  );
});

test("write guard refuses a pre-existing accessory id", () => {
  const owned = new Set([90]);
  assert.throws(
    () => assertWriteTarget(owned, 31, "characteristic.update"),
    /unowned accessory 31/,
  );
});

test("lost accessory create does not delete by name or scan the catalog", async () => {
  const deleted = [];
  const checkpoints = [];
  const hub = {
    async createAccessory() {
      const error = new Error("closed");
      error.requestSent = true;
      throw error;
    },
    async deleteAccessory(id) {
      deleted.push(id);
    },
    async listAccessories() {
      throw new Error("must not scan accessories by name");
    },
    async listLogs() {
      return { status: "ok", logs: [] };
    },
  };
  const result = await runProbe({
    hub,
    roomId: 2,
    marker,
    timerMs: 50,
    deadlineMs: 5_000,
    sleep: async () => {},
    now: () => 0,
    writeCheckpoint: async (payload) => {
      checkpoints.push(payload);
    },
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "create_response_lost");
  assert.deepEqual(deleted, []);
  assert.equal(checkpoints[0]?.stopReason, "create_response_lost");
  assert.equal(checkpoints[0]?.accessoryId, null);
});

test("teardown after a later failure deletes only the owned accessory id", async () => {
  const deletedAccessories = [];
  const deletedScenarios = [];
  const writes = [];
  const accessory = virtualLight(90, 2);
  const accessories = new Map([[90, accessory]]);
  const hub = {
    async createAccessory() {
      return accessory;
    },
    async getAccessory(id) {
      const found = accessories.get(id);
      if (!found) throw new Error("missing");
      return found;
    },
    async getAccessoryOrNull(id) {
      return accessories.get(id) ?? null;
    },
    async listLinks() {
      return [];
    },
    async listLogicTypes() {
      return [];
    },
    async listLogics() {
      return [];
    },
    async createScenario() {
      throw new Error("scenario create refused");
    },
    async deleteAccessory(id) {
      deletedAccessories.push(id);
      accessories.delete(id);
    },
    async deleteScenario(index) {
      deletedScenarios.push(index);
    },
    async listAccessories() {
      throw new Error("must not scan");
    },
    async updateCharacteristic(request) {
      writes.push(request.aId);
    },
    async listLogs() {
      return { status: "ok", logs: [] };
    },
  };
  const result = await runProbe({
    hub,
    roomId: 2,
    marker,
    timerMs: 50,
    deadlineMs: 5_000,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(result.status, "stopped");
  assert.deepEqual(deletedAccessories, [90]);
  assert.deepEqual(deletedScenarios, []);
  assert.deepEqual(writes, []);
});

test("foreign links during teardown stop delete instead of widening it", async () => {
  const deletedAccessories = [];
  const characteristicWrites = [];
  const hub = statefulProbeHub({
    links: [
      {
        type: "OUT",
        index: "9",
        characteristics: [{ aId: 31, sId: 13, cId: 15 }],
      },
    ],
    onDeleteAccessory(id) {
      deletedAccessories.push(id);
    },
    onUpdateCharacteristic(request) {
      characteristicWrites.push(request.aId);
    },
  });
  const result = await runProbe({
    hub,
    roomId: 2,
    marker,
    timerMs: 1,
    deadlineMs: 5_000,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.teardown.status, "stop");
  assert.equal(result.teardown.accessory.reason, "foreign_links");
  assert.deepEqual(deletedAccessories, []);
  assert.equal(
    characteristicWrites.every((aId) => aId === 90),
    true,
  );
  assert.equal(characteristicWrites.includes(31), false);
});

test("createMarker stays in the sprut-probe family", () => {
  assert.match(createMarker(Buffer.from("abcd")), /^sprut-probe:/);
});

function virtualLight(id, roomId) {
  return {
    id,
    roomId,
    name: accessoryNameFor(marker),
    online: true,
    virtual: true,
    services: [
      {
        sId: 13,
        name: "Light",
        type: "Lightbulb",
        characteristics: [
          {
            cId: 15,
            control: { name: "On", type: "On", value: { boolValue: false } },
          },
          {
            cId: 16,
            control: {
              name: "Brightness",
              type: "Brightness",
              value: { intValue: 0 },
            },
          },
        ],
      },
    ],
  };
}

function statefulProbeHub({
  links = [],
  onDeleteAccessory,
  onUpdateCharacteristic,
} = {}) {
  const accessory = virtualLight(90, 2);
  let types = [];
  let logics = [];
  let data = `code\n/* [${marker}] */`;
  let scenarioPresent = false;
  return {
    async createAccessory() {
      return accessory;
    },
    async getAccessory() {
      return accessory;
    },
    async getAccessoryOrNull() {
      return accessory;
    },
    async listLinks() {
      return links;
    },
    async listLogicTypes() {
      return types;
    },
    async listLogics() {
      return logics;
    },
    async createScenario() {
      types = [{ type: "ProbeType" }];
      scenarioPresent = true;
      return { index: "77" };
    },
    async getScenario() {
      if (!scenarioPresent) return null;
      return { index: "77", type: "LOGIC", data };
    },
    async createLogic() {
      logics = [{ type: "ProbeType" }];
    },
    async updateLogicActive() {},
    async updateCharacteristic(request) {
      onUpdateCharacteristic?.(request);
    },
    async updateScenarioData(_index, next) {
      data = next;
    },
    async deleteLogic() {
      logics = [];
    },
    async deleteScenario() {
      scenarioPresent = false;
    },
    async deleteAccessory(id) {
      onDeleteAccessory?.(id);
    },
    async listLogs() {
      return {
        status: "ok",
        logs: [{ message: `${marker} event=timer_fired` }],
      };
    },
    async getCharacteristic({ cId }) {
      if (cId === 15) {
        return { control: { value: { boolValue: false } } };
      }
      return { control: { value: { intValue: 11 } } };
    },
    async listAccessories() {
      throw new Error("must not scan");
    },
  };
}
