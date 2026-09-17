import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { WebSocket } from "ws";
import {
  parseSprutHubMessage,
  SprutHubError,
} from "../../src/spruthub-client.mjs";
import { SprutHubConnection } from "../../src/spruthub-connection.mjs";

export const MARKER_PREFIX = "sprut-probe:";
export const DEFAULT_TIMER_MS = 3_000;
export const MAX_TIMER_MS = 10_000;
export const LIVE_DEADLINE_MS = 5 * 60 * 1_000;
export const DEFAULT_LOG_COUNT = 80;
const ACCESSORY_NAME_MAX = 30;

export function parseArgs(argv) {
  const args = {
    mode: "help",
    confirmOwnerPermission: false,
    roomId: null,
    connectionEnv: null,
    checkpointDir: defaultCheckpointDir(),
    timerMs: DEFAULT_TIMER_MS,
    deadlineMs: LIVE_DEADLINE_MS,
    logCount: DEFAULT_LOG_COUNT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--list-rooms") args.mode = "list-rooms";
    else if (token === "--execute-live") args.mode = "execute-live";
    else if (token === "--i-confirm-owner-permission") {
      args.confirmOwnerPermission = true;
    } else if (token === "--room-id") {
      args.roomId = parsePositiveInt(argv[++i], "--room-id");
    } else if (token === "--connection-env") {
      args.connectionEnv = requiredValue(argv[++i], "--connection-env");
    } else if (token === "--checkpoint-dir") {
      args.checkpointDir = requiredValue(argv[++i], "--checkpoint-dir");
    } else if (token === "--timer-ms") {
      args.timerMs = parsePositiveInt(argv[++i], "--timer-ms");
    } else if (token === "--deadline-ms") {
      args.deadlineMs = parsePositiveInt(argv[++i], "--deadline-ms");
    } else if (token === "--log-count") {
      args.logCount = parsePositiveInt(argv[++i], "--log-count");
    } else if (token === "--help" || token === "-h") args.mode = "help";
    else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (args.timerMs > MAX_TIMER_MS) {
    throw new Error(`--timer-ms must be <= ${MAX_TIMER_MS}`);
  }
  if (args.deadlineMs > LIVE_DEADLINE_MS) {
    throw new Error(`--deadline-ms must be <= ${LIVE_DEADLINE_MS}`);
  }
  if (args.mode === "execute-live") {
    if (!args.confirmOwnerPermission) {
      throw new Error(
        "Live writes require --i-confirm-owner-permission after a separate owner grant.",
      );
    }
    if (args.roomId === null) {
      throw new Error("Live writes require --room-id from --list-rooms.");
    }
  }
  return args;
}

export function createMarker(entropy = randomBytes(4)) {
  return `${MARKER_PREFIX}${entropy.toString("hex")}`;
}

export function accessoryNameFor(marker) {
  const suffix = marker.slice(MARKER_PREFIX.length).slice(0, 12);
  const name = `p-${suffix}`;
  return name.slice(0, ACCESSORY_NAME_MAX);
}

export function buildLogicSource({
  marker,
  accessoryId,
  timerMs = DEFAULT_TIMER_MS,
}) {
  if (!Number.isInteger(accessoryId) || accessoryId <= 0) {
    throw new Error("LOGIC source requires the created accessory id.");
  }
  if (typeof marker !== "string" || !marker.startsWith(MARKER_PREFIX)) {
    throw new Error("LOGIC source requires a sprut-probe marker.");
  }
  const targetAid = String(accessoryId);
  const timer = String(timerMs);
  return [
    "info = {",
    `  name: ${JSON.stringify(accessoryNameFor(marker))},`,
    '  description: "lifecycle probe, not household automation",',
    '  version: "1.0",',
    '  author: "sprut-agent",',
    "  onStart: true,",
    "  sourceServices: [HS.Lightbulb],",
    "  sourceCharacteristics: [HC.On],",
    "  options: [],",
    "  variables: { offTask: undefined }",
    "};",
    "",
    `var MARKER = ${JSON.stringify(marker)};`,
    `var TARGET_AID = ${targetAid};`,
    `var TARGET_UUID = "${targetAid}";`,
    `var TIMER_MS = ${timer};`,
    "var session = {",
    "  ownUuid: undefined,",
    "  subscribeStarted: false,",
    "  subscribeTask: undefined,",
    "  offTask: undefined,",
    "  ownOn: false",
    "};",
    "",
    "function emit(event, extra) {",
    '  var line = MARKER + " event=" + event;',
    '  if (extra) line += " " + extra;',
    "  try {",
    '    if (typeof log === "function") { log(line); return; }',
    "  } catch (e0) {}",
    "  try {",
    '    if (typeof log !== "undefined" && log) {',
    '      if (typeof log.info === "function") { log.info("{}", line); return; }',
    '      if (typeof log.debug === "function") { log.debug("{}", line); return; }',
    '      if (typeof log.warn === "function") { log.warn("{}", line); return; }',
    "    }",
    "  } catch (e1) {}",
    "}",
    "",
    "function describeArg(value) {",
    '  if (value === null) return "null";',
    '  if (typeof value === "undefined") return "undefined";',
    "  var kind = typeof value;",
    '  if (kind !== "object") return kind;',
    '  var bits = ["object"];',
    '  if (typeof value.getType === "function") bits.push("getType");',
    '  if (typeof value.getUUID === "function") bits.push("getUUID");',
    '  if (typeof value.getValue === "function") bits.push("getValue");',
    '  if (typeof value.getService === "function") bits.push("getService");',
    '  if (typeof value.getAccessory === "function") bits.push("getAccessory");',
    '  if (typeof value.clear === "function") bits.push("clear");',
    '  return bits.join(",");',
    "}",
    "",
    "function looksLikeCharacteristic(value) {",
    "  return !!(",
    "    value &&",
    '    typeof value === "object" &&',
    '    typeof value.getType === "function" &&',
    '    typeof value.getUUID === "function" &&',
    '    typeof value.getService === "function" &&',
    '    typeof value.getAccessory === "function"',
    "  );",
    "}",
    "",
    "function pickCharacteristic(args) {",
    "  var i;",
    "  for (i = 0; i < args.length; i++) {",
    "    if (looksLikeCharacteristic(args[i])) return args[i];",
    "  }",
    "  return null;",
    "}",
    "",
    "function rememberAssignedSource(source) {",
    "  if (!looksLikeCharacteristic(source)) return false;",
    "  var accessory = source.getAccessory();",
    '  if (!accessory || typeof accessory.getUUID !== "function") return false;',
    "  var uuid = accessory.getUUID();",
    '  if (uuid == null || uuid === "") return false;',
    "  if (session.ownUuid && uuid !== session.ownUuid) return false;",
    "  session.ownUuid = uuid;",
    '  if (String(uuid) === TARGET_UUID) emit("uuid_matches_aid", "");',
    '  else emit("uuid_differs_from_aid", "captured=1");',
    "  return true;",
    "}",
    "",
    "function isOwnAccessory(characteristic) {",
    "  if (!looksLikeCharacteristic(characteristic)) return false;",
    "  var accessory = characteristic.getAccessory();",
    '  if (!accessory || typeof accessory.getUUID !== "function") return false;',
    "  var uuid = accessory.getUUID();",
    "  if (session.ownUuid) return uuid === session.ownUuid;",
    "  return String(uuid) === TARGET_UUID;",
    "}",
    "",
    "function clearOff(variables) {",
    "  var task = (variables && variables.offTask) || session.offTask;",
    '  if (task && typeof task.clear === "function") {',
    '    try { task.clear(); emit("timer_cleared", ""); }',
    '    catch (e) { emit("timer_clear_failed", ""); }',
    "  }",
    "  if (variables) variables.offTask = undefined;",
    "  session.offTask = undefined;",
    "}",
    "",
    "function armOff(source, variables) {",
    "  clearOff(variables);",
    "  var task = setTimeout(function () {",
    '    emit("timer_fired", "");',
    "    try {",
    "      if (!isOwnAccessory(source)) {",
    '        emit("timer_skipped_foreign", "");',
    "        return;",
    "      }",
    "      source.setValue(false);",
    '      emit("timer_set_off", "");',
    '    } catch (e) { emit("timer_set_failed", ""); }',
    "  }, TIMER_MS);",
    "  if (variables) variables.offTask = task;",
    "  session.offTask = task;",
    '  emit("timer_armed", "");',
    "}",
    "",
    "function onHubEvent() {",
    "  var n = arguments.length;",
    "  var shapes = [];",
    "  var i;",
    "  for (i = 0; i < n && i < 8; i++) shapes.push(describeArg(arguments[i]));",
    '  emit("subscribe_cb", "arity=" + n + " shapes=" + shapes.join("|"));',
    "  var characteristic = pickCharacteristic(arguments);",
    "  if (!characteristic) {",
    '    emit("subscribe_unparsed", "arity=" + n);',
    "    return;",
    "  }",
    "  if (!isOwnAccessory(characteristic)) {",
    '    emit("subscribe_foreign_ignored", "");',
    "    return;",
    "  }",
    '  var typeName = "";',
    "  try { typeName = String(characteristic.getType()); }",
    "  catch (e) {}",
    '  emit("subscribe_own", "type=" + String(typeName).replace(/[^A-Za-z0-9._-]/g, ""));',
    "}",
    "",
    "function ensureSubscribe() {",
    "  if (session.subscribeStarted) return;",
    "  session.subscribeStarted = true;",
    "  try {",
    '    if (typeof Hub === "undefined" || typeof Hub.subscribe !== "function") {',
    '      emit("subscribe_unavailable", "");',
    "      return;",
    "    }",
    "    session.subscribeTask = Hub.subscribe(onHubEvent);",
    '    emit("subscribe_registered", describeArg(session.subscribeTask));',
    '  } catch (e) { emit("subscribe_register_failed", ""); }',
    "}",
    "",
    "function trigger(source, value, variables, options, context) {",
    '  emit("trigger", "valueType=" + typeof value + " ctx=" + describeArg(context));',
    "  if (!rememberAssignedSource(source)) {",
    '    emit("trigger_untrusted_source", "");',
    "    return;",
    "  }",
    "  ensureSubscribe();",
    "  if (value === true) {",
    "    session.ownOn = true;",
    "    armOff(source, variables);",
    "  } else if (value === false) {",
    "    session.ownOn = false;",
    "    clearOff(variables);",
    '    emit("disarmed", "");',
    "  } else {",
    '    emit("trigger_value_unparsed", "type=" + typeof value);',
    "  }",
    "}",
    "",
    `/* [${marker}] */`,
    "",
  ].join("\n");
}

export function buildReplacementSource({ marker, accessoryId }) {
  if (!Number.isInteger(accessoryId) || accessoryId <= 0) {
    throw new Error("Replacement source requires the created accessory id.");
  }
  return [
    "info = {",
    `  name: ${JSON.stringify(accessoryNameFor(marker))},`,
    '  description: "replacement lifecycle probe",',
    '  version: "1.0",',
    '  author: "sprut-agent",',
    "  onStart: false,",
    "  sourceServices: [HS.Lightbulb],",
    "  sourceCharacteristics: [HC.On],",
    "  options: [],",
    "  variables: {}",
    "};",
    `var MARKER = ${JSON.stringify(marker)};`,
    `var TARGET_AID = ${accessoryId};`,
    `var TARGET_UUID = "${accessoryId}";`,
    "function emit(event) {",
    '  var line = MARKER + " event=" + event;',
    "  try {",
    '    if (typeof log === "function") log(line);',
    '    else if (typeof log !== "undefined" && log && typeof log.info === "function") log.info("{}", line);',
    "  } catch (e) {}",
    "}",
    "function trigger(source) {",
    "  try {",
    '    if (!source || typeof source.getAccessory !== "function") {',
    '      emit("replacement_untrusted_source");',
    "      return;",
    "    }",
    "    var accessory = source.getAccessory();",
    '    if (!accessory || typeof accessory.getUUID !== "function") {',
    '      emit("replacement_untrusted_source");',
    "      return;",
    "    }",
    "    var uuid = accessory.getUUID();",
    '    if (uuid == null || uuid === "") {',
    '      emit("replacement_untrusted_source");',
    "      return;",
    "    }",
    "  } catch (e) {",
    '    emit("replacement_untrusted_source");',
    "    return;",
    "  }",
    '  emit("replacement_trigger");',
    "}",
    `/* [${marker}] */`,
    "",
  ].join("\n");
}

export function sourceFiltersByAccessoryId(source, accessoryId) {
  if (typeof source !== "string") return false;
  if (!Number.isInteger(accessoryId) || accessoryId <= 0) return false;
  const id = String(accessoryId);
  if (!source.includes(`TARGET_AID = ${id}`)) return false;
  if (source.includes("TARGET_AID = 0")) return false;
  return (
    source.includes("getAccessory()") &&
    source.includes("getUUID()") &&
    !/getAccessory\(\)\s*;\s*$/m.test(source.split("\n")[0])
  );
}

export function selectOwnMarkedLogMessages(logs, marker) {
  if (!Array.isArray(logs)) return [];
  const own = [];
  for (const entry of logs) {
    if (!entry || typeof entry.message !== "string") continue;
    const index = entry.message.indexOf(marker);
    if (index === -1) continue;
    const marked = entry.message.slice(index).split(/\r?\n/, 1)[0].trim();
    if (!marked.startsWith(marker)) continue;
    own.push({
      time: typeof entry.time === "number" ? entry.time : null,
      level: typeof entry.level === "string" ? entry.level : null,
      path: typeof entry.path === "string" ? entry.path : null,
      message: marked,
    });
  }
  return own;
}

export function eventsFromMarkedLogs(logs) {
  return logs.map((entry) => {
    const match = /\bevent=([A-Za-z0-9_-]+)/.exec(entry.message);
    return match ? match[1] : null;
  });
}

export function accessoryDeleteDecision({
  accessoryId,
  accessory,
  links,
  logics,
  expectedLogicType,
}) {
  if (!Number.isInteger(accessoryId) || accessoryId <= 0) {
    return { action: "stop", reason: "unknown_accessory_id" };
  }
  if (!accessory) {
    return { action: "stop", reason: "accessory_readback_missing" };
  }
  if (accessory.id !== accessoryId) {
    return { action: "stop", reason: "accessory_id_mismatch" };
  }
  if (accessory.virtual !== true) {
    return { action: "stop", reason: "accessory_not_virtual" };
  }
  if (hasForeignLinks(links)) {
    return { action: "stop", reason: "foreign_links" };
  }
  const foreign = (logics ?? []).filter(
    (logic) => logic?.type && logic.type !== expectedLogicType,
  );
  if (foreign.length > 0) {
    return { action: "stop", reason: "foreign_assignments" };
  }
  if (
    expectedLogicType &&
    (logics ?? []).some((logic) => logic?.type === expectedLogicType)
  ) {
    return { action: "stop", reason: "own_assignment_still_present" };
  }
  return { action: "delete", reason: "owned_unlinked" };
}

export function scenarioDeleteDecision({
  scenarioIndex,
  scenario,
  marker,
  assignmentPresent,
}) {
  if (typeof scenarioIndex !== "string" || scenarioIndex.length === 0) {
    return { action: "stop", reason: "unknown_scenario_index" };
  }
  if (!scenario) {
    return { action: "already_absent", reason: "scenario_missing" };
  }
  if (scenario.index !== scenarioIndex) {
    return { action: "stop", reason: "scenario_index_mismatch" };
  }
  if (typeof scenario.data !== "string" || !scenario.data.includes(marker)) {
    return { action: "stop", reason: "source_changed_or_unmarked" };
  }
  if (assignmentPresent) {
    return { action: "stop", reason: "assignment_still_present" };
  }
  return { action: "delete", reason: "owned_unassigned" };
}

export function assignmentDeleteDecision({
  accessoryId,
  serviceId,
  logicType,
  logics,
}) {
  if (!Number.isInteger(accessoryId) || accessoryId <= 0) {
    return { action: "stop", reason: "unknown_accessory_id" };
  }
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return { action: "stop", reason: "unknown_service_id" };
  }
  if (typeof logicType !== "string" || logicType.length === 0) {
    return { action: "stop", reason: "unknown_logic_type" };
  }
  const matches = (logics ?? []).filter((logic) => logic?.type === logicType);
  if (matches.length === 0) {
    return { action: "already_absent", reason: "assignment_missing" };
  }
  if (matches.length > 1) {
    return { action: "stop", reason: "ambiguous_assignment" };
  }
  return { action: "delete", reason: "owned_assignment" };
}

export function assertWriteTarget(ownedIds, aId, what) {
  if (!ownedIds.has(aId)) {
    throw new Error(`Refusing ${what} for unowned accessory ${aId}.`);
  }
}

export function emptyLogIsNotSuccess(ownLogs) {
  return ownLogs.length === 0
    ? { status: "inconclusive", reason: "no_own_marked_logs" }
    : { status: "observed", reason: "own_marked_logs" };
}

export async function runProbe(options) {
  const {
    hub,
    roomId,
    marker = createMarker(),
    timerMs = DEFAULT_TIMER_MS,
    deadlineMs = LIVE_DEADLINE_MS,
    logCount = DEFAULT_LOG_COUNT,
    sleep = delay,
    now = Date.now,
    writeCheckpoint,
  } = options;
  const startedAt = now();
  const ownedIds = new Set();
  const state = {
    marker,
    roomId,
    accessoryId: null,
    serviceId: null,
    on: null,
    brightness: null,
    scenarioIndex: null,
    logicType: null,
    createSent: false,
    scenarioSent: false,
    assignmentSent: false,
    observations: [],
    steps: [],
  };

  const timedOut = () => now() - startedAt >= deadlineMs;
  const checkpoint = async (reason, extra = {}) => {
    if (!writeCheckpoint) return;
    await writeCheckpoint({
      at: new Date(now()).toISOString(),
      phase: extra.phase ?? "stop",
      marker,
      roomId,
      accessoryId: state.accessoryId,
      serviceId: state.serviceId,
      scenarioIndex: state.scenarioIndex,
      logicType: state.logicType,
      createSent: state.createSent,
      scenarioSent: state.scenarioSent,
      assignmentSent: state.assignmentSent,
      stopReason: reason,
      observations: summarizeObservations(state.observations),
      ...extra,
    });
  };

  try {
    if (timedOut()) {
      await checkpoint("deadline");
      return stopped(state, "deadline");
    }

    let created;
    try {
      state.createSent = true;
      created = await hub.createAccessory({
        name: accessoryNameFor(marker),
        roomId,
        services: [
          {
            type: "Lightbulb",
            name: accessoryNameFor(marker),
            optional: ["Brightness"],
          },
        ],
      });
    } catch (error) {
      if (error?.requestSent) {
        await checkpoint("create_response_lost", { phase: "create_accessory" });
        return stopped(state, "create_response_lost");
      }
      state.createSent = false;
      throw error;
    }
    if (!Number.isInteger(created?.id) || created.id <= 0) {
      await checkpoint("create_without_id", { phase: "create_accessory" });
      return stopped(state, "create_without_id");
    }
    ownedIds.add(created.id);
    state.accessoryId = created.id;

    const accessory = await hub.getAccessory(created.id);
    const selected = selectCreatedVirtualLight(accessory, created.id, roomId);
    if (selected.error) {
      await checkpoint(selected.error, { phase: "verify_accessory" });
      return await failClosed(state, selected.error, hub, ownedIds, checkpoint);
    }
    state.serviceId = selected.serviceId;
    state.on = selected.on;
    state.brightness = selected.brightness;

    const baselineTypes = typeNames(
      await hub.listLogicTypes({ aId: created.id, sId: selected.serviceId }),
    );
    const source = buildLogicSource({
      marker,
      accessoryId: created.id,
      timerMs,
    });
    if (!sourceFiltersByAccessoryId(source, created.id)) {
      await checkpoint("source_missing_accessory_filter");
      return await failClosed(
        state,
        "source_missing_accessory_filter",
        hub,
        ownedIds,
        checkpoint,
      );
    }

    let scenario;
    try {
      state.scenarioSent = true;
      scenario = await hub.createScenario({
        name: accessoryNameFor(marker),
        desc: `lifecycle probe\n\n[${marker}]`,
        active: true,
        onStart: true,
        sync: false,
        type: "LOGIC",
        data: source,
        expand: "data",
      });
    } catch (error) {
      if (error?.requestSent) {
        await checkpoint("scenario_create_response_lost", {
          phase: "create_scenario",
        });
        return await failClosed(
          state,
          "scenario_create_response_lost",
          hub,
          ownedIds,
          checkpoint,
        );
      }
      throw error;
    }
    if (typeof scenario?.index !== "string" || scenario.index.length === 0) {
      await checkpoint("scenario_create_without_index");
      return await failClosed(
        state,
        "scenario_create_without_index",
        hub,
        ownedIds,
        checkpoint,
      );
    }
    state.scenarioIndex = scenario.index;
    const stored = await hub.getScenario(scenario.index);
    if (typeof stored?.data !== "string" || !stored.data.includes(marker)) {
      await checkpoint("scenario_marker_missing");
      return await failClosed(
        state,
        "scenario_marker_missing",
        hub,
        ownedIds,
        checkpoint,
      );
    }

    const mapped = await waitForUniqueLogicType({
      hub,
      aId: created.id,
      sId: selected.serviceId,
      baselineTypes,
      sleep,
      timedOut,
    });
    if (mapped.status !== "mapped") {
      await checkpoint(mapped.status, { candidateTypes: mapped.types });
      return await failClosed(state, mapped.status, hub, ownedIds, checkpoint);
    }
    state.logicType = mapped.type;

    try {
      state.assignmentSent = true;
      await hub.createLogic({
        aId: created.id,
        sId: selected.serviceId,
        type: mapped.type,
      });
      await hub.updateLogicActive({
        aId: created.id,
        sId: selected.serviceId,
        type: mapped.type,
        active: true,
      });
    } catch (error) {
      if (error?.requestSent) {
        await checkpoint("assignment_response_lost");
        return await failClosed(
          state,
          "assignment_response_lost",
          hub,
          ownedIds,
          checkpoint,
        );
      }
      throw error;
    }

    const writeChar = (address, value, what) => {
      assertWriteTarget(ownedIds, address.aId, what);
      return hub.updateCharacteristic({ ...address, value });
    };
    const collect = async (label) => {
      const listed = await hub.listLogs(logCount);
      const own = selectOwnMarkedLogMessages(listed.logs ?? [], marker);
      const observation = {
        label,
        logStatus: listed.status,
        ownCount: own.length,
        events: eventsFromMarkedLogs(own),
        on: await readBool(hub, selected.on),
        brightness: await readNumber(hub, selected.brightness),
      };
      state.observations.push(observation);
      state.steps.push(label);
      return observation;
    };

    await writeChar(selected.on, { boolValue: true }, "on.update");
    await sleep(timerMs + 1_200);
    const positive = await collect("positive_timer");

    await writeChar(selected.brightness, { intValue: 7 }, "brightness.update");
    await sleep(400);
    await writeChar(selected.brightness, { intValue: 11 }, "brightness.update");
    await sleep(800);
    const subscribed = await collect("subscribe_brightness");

    await writeChar(selected.on, { boolValue: true }, "on.update");
    await sleep(200);
    await writeChar(selected.on, { boolValue: false }, "on.update");
    await sleep(timerMs + 1_200);
    const cleared = await collect("clear_timer");

    await writeChar(selected.on, { boolValue: true }, "on.update");
    await sleep(200);
    await hub.updateLogicActive({
      aId: created.id,
      sId: selected.serviceId,
      type: mapped.type,
      active: false,
    });
    await sleep(timerMs + 1_200);
    const deactivated = await collect("deactivate");

    await hub.updateLogicActive({
      aId: created.id,
      sId: selected.serviceId,
      type: mapped.type,
      active: true,
    });
    await writeChar(selected.on, { boolValue: true }, "on.update");
    await sleep(200);
    await hub.updateScenarioData(
      scenario.index,
      buildReplacementSource({ marker, accessoryId: created.id }),
    );
    await sleep(timerMs + 1_200);
    await writeChar(selected.brightness, { intValue: 21 }, "brightness.update");
    await sleep(800);
    const replaced = await collect("source_replacement");

    await hub.updateLogicActive({
      aId: created.id,
      sId: selected.serviceId,
      type: mapped.type,
      active: false,
    });
    const logicsBeforeDelete = await hub.listLogics({
      aId: created.id,
      sId: selected.serviceId,
    });
    const assignmentDecision = assignmentDeleteDecision({
      accessoryId: created.id,
      serviceId: selected.serviceId,
      logicType: mapped.type,
      logics: logicsBeforeDelete,
    });
    if (assignmentDecision.action === "delete") {
      await hub.deleteLogic({
        aId: created.id,
        sId: selected.serviceId,
        type: mapped.type,
      });
    } else if (assignmentDecision.action === "stop") {
      await checkpoint(assignmentDecision.reason, {
        phase: "delete_assignment",
      });
      return await failClosed(
        state,
        assignmentDecision.reason,
        hub,
        ownedIds,
        checkpoint,
      );
    }
    await sleep(timerMs + 800);
    const deletedAssignment = await collect("delete_assignment");

    const teardown = await teardownOwned(state, hub, ownedIds, checkpoint);
    const ownLogs = state.observations.flatMap((item) => item.events);
    const logVerdict = emptyLogIsNotSuccess(
      ownLogs.filter((event) => typeof event === "string"),
    );

    return {
      status: "completed",
      reason: logVerdict.reason,
      logVerdict: logVerdict.status,
      marker,
      accessoryId: created.id,
      scenarioIndex: scenario.index,
      logicType: mapped.type,
      observations: {
        positive_timer: summarizeStep(positive),
        subscribe_brightness: summarizeStep(subscribed),
        clear_timer: summarizeStep(cleared),
        deactivate: summarizeStep(deactivated),
        source_replacement: summarizeStep(replaced),
        delete_assignment: summarizeStep(deletedAssignment),
      },
      teardown,
      timedOut: timedOut(),
    };
  } catch (error) {
    await checkpoint(error?.code ?? error?.message ?? "probe_error", {
      phase: "error",
    });
    const teardown = await teardownOwned(
      state,
      hub,
      ownedIds,
      checkpoint,
    ).catch((teardownError) => ({
      status: "stop",
      reason: teardownError.message,
    }));
    return {
      status: "stopped",
      reason: error?.message ?? "probe_error",
      teardown,
      marker: state.marker,
      accessoryId: state.accessoryId,
      scenarioIndex: state.scenarioIndex,
    };
  }
}

export async function listRoomsSafe(hub) {
  const listed = await hub.listRooms();
  return (listed.rooms ?? []).map((room) => ({
    id: roomIdFromRef(room.ref),
    name: typeof room.name === "string" ? room.name : null,
  }));
}

export function helpText() {
  return `Manual-light native lifecycle probe (SPRUT-105 / decision 6639)

This is not household automation and not a live grant. Default mode makes
no hub connection and no writes.

Household result still missing: a manually turned-on office lamp should stay
on while you sit still. This kit only prepares a bounded native lifecycle
probe of one LOGIC assignment plus Hub.subscribe.

Commands:
  node research/protocol/manual-light-lifecycle-probe.mjs
  node research/protocol/manual-light-lifecycle-probe.mjs --list-rooms --connection-env PATH
  node research/protocol/manual-light-lifecycle-probe.mjs --execute-live --i-confirm-owner-permission --room-id ID --connection-env PATH

Live scope after a separate owner grant:
  one temporary virtual Lightbulb with On/Brightness, no links;
  one uniquely marked LOGIC; one assignment on that created service.
  Writes only those created objects. 5-minute deadline. Short timer.
  Reads only own marked log lines via log.list. No log.subscribe.
  Lost create does not delete by name.

Do not load the VM default connection.env. Pass --connection-env or a complete
SPRUTHUB_TOKEN+SPRUTHUB_URL+SPRUTHUB_CID (or LOGIN+PASSWORD) in the process.
`;
}

export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.mode === "help") {
    deps.stdout?.write(helpText());
    return { status: "help" };
  }
  const env = await loadExplicitEnv(
    args.connectionEnv,
    deps.env ?? process.env,
  );
  const connection = new (deps.SprutHubConnection ?? SprutHubConnection)({
    env,
  });
  const client = await connection.getClient();
  try {
    const hub = deps.hub ?? clientHub(client, deps);
    if (args.mode === "list-rooms") {
      const rooms = await listRoomsSafe(hub);
      deps.stdout?.write(`${JSON.stringify({ rooms }, null, 2)}\n`);
      return { status: "list-rooms", rooms };
    }
    const result = await runProbe({
      hub,
      roomId: args.roomId,
      timerMs: args.timerMs,
      deadlineMs: args.deadlineMs,
      logCount: args.logCount,
      sleep: deps.sleep,
      now: deps.now,
      writeCheckpoint: (payload) =>
        persistCheckpoint(args.checkpointDir, payload),
    });
    deps.stdout?.write(`${JSON.stringify(publicResult(result), null, 2)}\n`);
    return result;
  } finally {
    await client.close?.();
  }
}

function clientHub(client, deps) {
  return {
    listRooms: () => client.listRooms(),
    createAccessory: (request) => client.createAccessory(request),
    getAccessory: (id) => client.getAccessory(id),
    getAccessoryOrNull: (id) => client.getAccessoryOrNull(id),
    deleteAccessory: (id) => client.deleteAccessory(id),
    listLinks: (address) => client.listLinks(address),
    listLogicTypes: (address) => client.listLogicTypes(address),
    listLogics: (address) => client.listLogics(address),
    createLogic: (address) => client.createLogic(address),
    updateLogicActive: (address) => client.updateLogicActive(address),
    deleteLogic: (address) => client.deleteLogic(address),
    createScenario: (request) => client.createScenario(request),
    getScenario: (index) => client.getScenario(index),
    updateScenarioData: (index, data) => client.updateScenarioData(index, data),
    deleteScenario: (index) => client.deleteScenario(index),
    getCharacteristic: (address) => client.getCharacteristic(address),
    updateCharacteristic: (address) => client.updateCharacteristic(address),
    listLogs: (count) =>
      deps.listLogs
        ? deps.listLogs(count)
        : listLogsWithClient(client, count, deps.WebSocketImpl),
  };
}

export async function listLogsWithClient(
  client,
  count,
  WebSocketImpl = WebSocket,
) {
  try {
    const response = await sendJsonRpc(
      client,
      { log: { list: { count } } },
      WebSocketImpl,
    );
    const logs = response?.result?.log?.list?.log;
    if (!Array.isArray(logs)) return { status: "incompatible", logs: [] };
    return { status: "ok", logs };
  } catch {
    return { status: "unavailable", logs: [] };
  }
}

export async function sendJsonRpc(client, params, WebSocketImpl = WebSocket) {
  const timeoutMs = client.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const socket = new WebSocketImpl(client.url, "json-rpc");
  try {
    await waitSocketOpen(socket, deadline);
    const id = 1;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(new Error("json-rpc timeout"));
          socket.terminate();
        },
        Math.max(0, deadline - Date.now()),
      );
      socket.on("message", (data) => {
        let message;
        try {
          message = parseSprutHubMessage(data);
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) {
          reject(
            new SprutHubError(
              "request_rejected",
              "SprutHub rejected the request.",
              undefined,
              { protocolErrorCode: message.error.code },
            ),
          );
          return;
        }
        resolve(message);
      });
      socket.send(
        JSON.stringify({
          id,
          token: client.token,
          ...(client.serial == null ? {} : { serial: client.serial }),
          cid: client.cid,
          params,
        }),
      );
    });
  } finally {
    if (socket.readyState === WebSocketImpl.OPEN) socket.close();
    else socket.terminate?.();
  }
}

async function failClosed(state, reason, hub, ownedIds, checkpoint) {
  const teardown = await teardownOwned(state, hub, ownedIds, checkpoint);
  return { status: "stopped", reason, teardown, marker: state.marker };
}

function stopped(state, reason) {
  return {
    status: "stopped",
    reason,
    marker: state.marker,
    accessoryId: state.accessoryId,
    scenarioIndex: state.scenarioIndex,
    createSent: state.createSent,
  };
}

async function teardownOwned(state, hub, ownedIds, checkpoint) {
  const result = {
    assignment: null,
    scenario: null,
    accessory: null,
  };
  if (state.accessoryId && state.serviceId && state.logicType) {
    const logics = await hub.listLogics({
      aId: state.accessoryId,
      sId: state.serviceId,
    });
    const decision = assignmentDeleteDecision({
      accessoryId: state.accessoryId,
      serviceId: state.serviceId,
      logicType: state.logicType,
      logics,
    });
    result.assignment = decision;
    if (decision.action === "delete") {
      await hub.deleteLogic({
        aId: state.accessoryId,
        sId: state.serviceId,
        type: state.logicType,
      });
    } else if (decision.action === "stop") {
      await checkpoint(decision.reason, { phase: "teardown_assignment" });
      return { status: "stop", ...result };
    }
  }

  if (state.scenarioIndex) {
    const scenario = await hub.getScenario(state.scenarioIndex);
    const logics = state.accessoryId
      ? await hub.listLogics({
          aId: state.accessoryId,
          sId: state.serviceId,
        })
      : [];
    const decision = scenarioDeleteDecision({
      scenarioIndex: state.scenarioIndex,
      scenario,
      marker: state.marker,
      assignmentPresent: (logics ?? []).some(
        (logic) => logic?.type === state.logicType,
      ),
    });
    result.scenario = decision;
    if (decision.action === "delete") {
      await hub.deleteScenario(state.scenarioIndex);
      const remaining = await hub.getScenario(state.scenarioIndex);
      if (remaining !== null) {
        await checkpoint("scenario_still_present", {
          phase: "teardown_scenario",
        });
        return { status: "stop", ...result, scenarioReadback: "present" };
      }
    } else if (decision.action === "stop") {
      await checkpoint(decision.reason, { phase: "teardown_scenario" });
      return { status: "stop", ...result };
    }
  }

  if (!ownedIds.has(state.accessoryId)) {
    if (state.createSent && !state.accessoryId) {
      return { status: "stop", reason: "create_response_lost", ...result };
    }
    return { status: "ok", ...result };
  }
  assertWriteTarget(ownedIds, state.accessoryId, "accessory.delete");
  const accessory = await hub.getAccessoryOrNull(state.accessoryId);
  const links = accessory
    ? await collectLinks(hub, state.on, state.brightness)
    : [];
  const logics = accessory
    ? await hub.listLogics({
        aId: state.accessoryId,
        sId: state.serviceId,
      })
    : [];
  const decision = accessoryDeleteDecision({
    accessoryId: state.accessoryId,
    accessory,
    links,
    logics,
    expectedLogicType: state.logicType,
  });
  result.accessory = decision;
  if (decision.action !== "delete") {
    await checkpoint(decision.reason, { phase: "teardown_accessory" });
    return { status: "stop", ...result };
  }
  await hub.deleteAccessory(state.accessoryId);
  const remaining = await hub.getAccessoryOrNull(state.accessoryId);
  if (remaining !== null) {
    await checkpoint("accessory_still_present", {
      phase: "teardown_accessory",
    });
    return { status: "stop", ...result, accessoryReadback: "present" };
  }
  return { status: "ok", ...result, accessoryReadback: "absent" };
}

function selectCreatedVirtualLight(accessory, accessoryId, roomId) {
  if (!accessory || accessory.id !== accessoryId) {
    return { error: "accessory_id_mismatch" };
  }
  if (accessory.virtual !== true) return { error: "accessory_not_virtual" };
  if (accessory.roomId !== roomId) return { error: "accessory_room_mismatch" };
  const services = (accessory.services ?? []).filter(
    (service) => service.type === "Lightbulb",
  );
  if (services.length !== 1) return { error: "lightbulb_service_missing" };
  const service = services[0];
  const on = findCharacteristic(service, "On");
  const brightness = findCharacteristic(service, "Brightness");
  if (!on || !brightness) return { error: "on_or_brightness_missing" };
  return {
    serviceId: service.sId,
    on: { aId: accessory.id, sId: service.sId, cId: on.cId },
    brightness: { aId: accessory.id, sId: service.sId, cId: brightness.cId },
  };
}

function findCharacteristic(service, type) {
  const matches = (service.characteristics ?? []).filter(
    (characteristic) =>
      (characteristic.control?.type ?? characteristic.control?.key) === type,
  );
  return matches.length === 1 ? matches[0] : null;
}

function hasForeignLinks(links) {
  return (links ?? []).some(
    (link) => link?.type === "IN" || link?.type === "OUT",
  );
}

async function collectLinks(hub, on, brightness) {
  const listed = [];
  for (const address of [on, brightness].filter(Boolean)) {
    listed.push(...(await hub.listLinks(address)));
  }
  return listed;
}

function typeNames(types) {
  return (types ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry?.type,
  );
}

async function waitForUniqueLogicType({
  hub,
  aId,
  sId,
  baselineTypes,
  sleep,
  timedOut,
}) {
  const baseline = new Set(baselineTypes.filter(Boolean));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (timedOut()) return { status: "deadline", types: [] };
    const current = typeNames(await hub.listLogicTypes({ aId, sId })).filter(
      Boolean,
    );
    const added = current.filter((type) => !baseline.has(type));
    if (added.length === 1) return { status: "mapped", type: added[0] };
    if (added.length > 1)
      return { status: "ambiguous_logic_type", types: added };
    await sleep(400);
  }
  return { status: "logic_type_missing", types: [] };
}

async function readBool(hub, address) {
  const characteristic = await hub.getCharacteristic(address);
  return characteristic?.control?.value?.boolValue;
}

async function readNumber(hub, address) {
  const characteristic = await hub.getCharacteristic(address);
  const value = characteristic?.control?.value;
  return value?.intValue ?? value?.longValue ?? value?.doubleValue;
}

function summarizeStep(observation) {
  return {
    logStatus: observation.logStatus,
    ownCount: observation.ownCount,
    events: observation.events,
    on: observation.on,
    brightness: observation.brightness,
  };
}

function summarizeObservations(observations) {
  return observations.map((item) => ({
    label: item.label,
    ownCount: item.ownCount,
    events: item.events,
  }));
}

function publicResult(result) {
  return {
    status: result.status,
    reason: result.reason,
    logVerdict: result.logVerdict,
    marker: result.marker,
    accessoryId: result.accessoryId,
    scenarioIndex: result.scenarioIndex,
    logicType: result.logicType,
    observations: result.observations,
    teardown: result.teardown,
    timedOut: result.timedOut === true,
  };
}

function roomIdFromRef(ref) {
  if (typeof ref !== "string") return null;
  const match = /\/room\/(\d+)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function requiredValue(value, flag) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function defaultCheckpointDir() {
  return path.join(
    homedir(),
    ".local/share/sprut-agent/private-research/manual-light-lifecycle-probe",
  );
}

function hasCompleteExplicitConnection(env) {
  if (typeof env.SPRUTHUB_TOKEN === "string" && env.SPRUTHUB_TOKEN) {
    return Boolean(env.SPRUTHUB_URL && env.SPRUTHUB_CID);
  }
  return Boolean(env.SPRUTHUB_LOGIN && env.SPRUTHUB_PASSWORD);
}

async function loadExplicitEnv(connectionEnvPath, processEnv) {
  if (hasCompleteExplicitConnection(processEnv) && !connectionEnvPath) {
    return processEnv;
  }
  if (!connectionEnvPath) {
    throw new Error(
      "Pass --connection-env PATH or set complete SPRUTHUB_* in this process. The default VM profile is not read.",
    );
  }
  const parsed = parseEnv(await readFile(connectionEnvPath, "utf8"));
  return { ...processEnv, ...parsed };
}

async function persistCheckpoint(directory, payload) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(
    directory,
    `${payload.marker.replaceAll(":", "-")}.json`,
  );
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitSocketOpen(socket, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("websocket open timeout"));
    }, remaining);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    });
  });
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  main(process.argv.slice(2), { stdout: process.stdout }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
