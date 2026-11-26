import { isDeepStrictEqual } from "node:util";
import { AutomationStore } from "./automation-store.mjs";
import { canonicalBlock, withHiddenHttpUrls } from "./block-model.mjs";
import {
  applicationTime,
  changeAppliedAt,
  isAppliedHistoryChange,
  nativeAffectedRefs,
} from "./change-history.mjs";
import { restoreIntentTime } from "./change-restore.mjs";
import { mapWithConcurrency } from "./device-commands.mjs";
import { changeOperation } from "./light-group-members.mjs";
import {
  accessoryRef,
  characteristicRef,
  extractTypedValue,
  isHubReadFailure,
  isRedactedNode,
  isSensitiveNativeNode,
  matchEnumValue,
  parseEntityRef,
  redactSensitiveText,
  roomRef,
  SprutHubError,
  sanitizeAgentOutput,
  sanitizeNativeData,
  scenarioRef,
  serviceRef,
} from "./spruthub-client.mjs";

// Observed control parameters for configuration points, not a restore
// allowlist and not every writable characteristic.
export const CONTROL_SETTING_TYPES = new Set([
  "TargetTemperature",
  "TargetHeatingCoolingState",
  "C_FanSpeed",
]);

export const HOME_SNAPSHOT_EXCLUDED_CATEGORIES = [
  "device_window_options",
  "logic_options",
  "virtual_links",
  "ephemeral_states",
  "redacted_secrets",
];

export const ATTRIBUTION_NOTE =
  "Attribution matches against this local sprut-agent change journal only; changes made by another client, automation, or the SprutHub app appear as manual_or_external.";

const SCENARIO_READ_CONCURRENCY = 8;
const BRIDGE_READ_CONCURRENCY = 4;
const MAX_MATCHING_AGENT_CHANGES = 5;

const SCENARIO_WINDOW_OPTION_TO_FIELD = {
  Name: "name",
  Desc: "description",
  OnStart: "on_start",
  Sync: "sync",
};

export async function captureHomeSnapshot({
  client,
  serial,
  sensitiveValues = [],
}) {
  const catalogDeadline = Date.now() + client.timeoutMs;
  const [roomsRead, accessoriesRead, scenariosRead, extensionsRead] =
    await Promise.all([
      client.nativeRooms(serial, catalogDeadline),
      client.nativeAccessories(serial, catalogDeadline),
      client.nativeScenarios(serial, catalogDeadline),
      client.nativeExtensions(serial, catalogDeadline),
    ]);

  const notCaptured = [];

  const rooms = [...roomsRead.rooms]
    .sort((left, right) => left.id - right.id)
    .map((room) => ({
      ref: roomRef(serial, room.id),
      id: room.id,
      name: sanitizeSnapshotText(room.name, sensitiveValues),
      visible: typeof room.visible === "boolean" ? room.visible : null,
    }));

  const climateSetpoints = [];
  const accessories = [...accessoriesRead.accessories]
    .sort((left, right) => left.id - right.id)
    .map((accessory) => {
      const accRef = accessoryRef(serial, accessory.id);
      const services = [...(accessory.services ?? [])]
        .filter(({ type }) => type !== "AccessoryInformation")
        .sort((left, right) => left.sId - right.sId)
        .map((service) => {
          for (const characteristic of service.characteristics ?? []) {
            const control = characteristic?.control;
            const controlType = control?.type ?? control?.key;
            if (!CONTROL_SETTING_TYPES.has(controlType)) continue;
            const charRef = characteristicRef(
              serial,
              accessory.id,
              service.sId,
              characteristic.cId,
            );
            if (isSensitiveNativeNode(control)) {
              notCaptured.push({
                entity_ref: charRef,
                kind: "characteristic",
                reason: "redacted",
              });
              continue;
            }
            const typed = extractTypedValue(control.value);
            const rawValue = typed.found ? typed.value : null;
            const sanitizedValue =
              typeof rawValue === "string"
                ? sanitizeSnapshotText(rawValue, sensitiveValues)
                : rawValue;
            if (isHidden(sanitizedValue)) {
              notCaptured.push({
                entity_ref: charRef,
                kind: "characteristic",
                reason: "redacted",
              });
              continue;
            }
            const currentEnum = control.validValues
              ? matchEnumValue(control.validValues, typed)
              : null;
            climateSetpoints.push({
              ref: charRef,
              accessory_ref: accRef,
              type: controlType,
              name: sanitizeSnapshotText(control.name, sensitiveValues),
              value: sanitizedValue,
              enum: currentEnum
                ? {
                    key: sanitizeSnapshotText(currentEnum.key, sensitiveValues),
                    name: sanitizeSnapshotText(
                      currentEnum.name,
                      sensitiveValues,
                    ),
                  }
                : null,
              unit:
                typeof control.unit === "string"
                  ? sanitizeSnapshotText(control.unit, sensitiveValues)
                  : null,
            });
          }
          return {
            sId: service.sId,
            ref: serviceRef(serial, accessory.id, service.sId),
            type: sanitizeSnapshotText(service.type, sensitiveValues),
            name: sanitizeSnapshotText(service.name, sensitiveValues),
            visible:
              typeof service.visible === "boolean" ? service.visible : null,
          };
        });

      return {
        ref: accRef,
        id: accessory.id,
        name: sanitizeSnapshotText(accessory.name, sensitiveValues),
        room_ref: roomRef(serial, accessory.roomId),
        virtual: (accessory.virtual ?? accessory.model === "Virtual") === true,
        services,
      };
    });
  climateSetpoints.sort((left, right) => left.ref.localeCompare(right.ref));

  const predefinedScenarios = [];
  const userScenarioItems = [];
  for (const item of scenariosRead.scenarios) {
    if (item.native.predefined === true) {
      predefinedScenarios.push({
        ref: item.summary.ref,
        index: item.native.index,
        type: item.native.type,
        predefined: true,
        name: sanitizeSnapshotText(item.native.name, sensitiveValues),
        active: item.native.active === true,
      });
    } else {
      userScenarioItems.push(item);
    }
  }

  const userScenarioResults = await mapWithConcurrency(
    userScenarioItems,
    SCENARIO_READ_CONCURRENCY,
    async ({ native, summary }) => {
      let detail;
      try {
        detail = await client.getScenario(native.index);
      } catch (error) {
        if (!isHubReadFailure(error)) throw error;
        notCaptured.push({
          entity_ref: summary.ref,
          kind: "scenario",
          reason: "read_error",
          error_code: error.code,
        });
        return null;
      }
      if (!detail) {
        notCaptured.push({
          entity_ref: summary.ref,
          kind: "scenario",
          reason: "entity_not_found",
        });
        return null;
      }
      const scenarioType = detail.type ?? native.type;
      return {
        ref: summary.ref,
        index: detail.index,
        type: scenarioType,
        predefined: false,
        name: sanitizeSnapshotText(detail.name ?? native.name, sensitiveValues),
        description:
          typeof detail.desc === "string"
            ? sanitizeSnapshotText(detail.desc, sensitiveValues)
            : null,
        active: detail.active === true,
        on_start: detail.onStart === true,
        sync: detail.sync === true,
        configuration: captureScenarioConfiguration(
          scenarioType,
          detail.data,
          sensitiveValues,
        ),
      };
    },
  );

  const scenarios = [
    ...predefinedScenarios,
    ...userScenarioResults.filter(Boolean),
  ].sort((left, right) => left.index.localeCompare(right.index));

  const bridgeExtensions = extensionsRead.extensions
    .filter(
      (extension) =>
        extension.bundle_type === "BRIDGE" ||
        extension.key.startsWith("Bridge:"),
    )
    .sort((left, right) => left.key.localeCompare(right.key));

  const bridgeResults = await mapWithConcurrency(
    bridgeExtensions,
    BRIDGE_READ_CONCURRENCY,
    async (extension) => {
      let children;
      try {
        ({ children } = await client.nativeExtensionChildren(
          serial,
          extension.key,
          Date.now() + client.timeoutMs,
        ));
      } catch (error) {
        if (!isHubReadFailure(error)) throw error;
        notCaptured.push({
          entity_ref: extension.ref,
          kind: "bridge",
          reason: "bridge_unread",
          error_code: error.code,
        });
        return null;
      }
      const exportedRefs = [
        ...new Set(
          children
            .filter((child) => child.spaceKey === "main")
            .map((child) => parseBridgeChildAccessoryId(child.id))
            .filter((id) => id !== null)
            .map((id) => accessoryRef(serial, id)),
        ),
      ].sort();
      return {
        ref: extension.ref,
        key: extension.key,
        name: sanitizeSnapshotText(extension.name, sensitiveValues),
        state: extension.state ?? null,
        enabled: extension.enabled === true,
        exported_accessory_refs: exportedRefs,
      };
    },
  );

  const bridges = bridgeResults.filter(Boolean);

  return {
    home_snapshot: {
      rooms,
      accessories,
      scenarios,
      bridges,
      climate_setpoints: climateSetpoints,
    },
    not_captured: notCaptured,
  };
}

export function homeSnapshotCounts(snapshot) {
  return {
    rooms: snapshot.rooms.length,
    accessories: snapshot.accessories.length,
    scenarios: snapshot.scenarios.length,
    bridges: snapshot.bridges.length,
    climate_setpoints: snapshot.climate_setpoints.length,
  };
}

export function homePointContainsEntity(point, entityRef) {
  const snapshot = point.home_snapshot;
  if (!isPlainObject(snapshot)) return false;
  if (snapshot.rooms.some(({ ref }) => ref === entityRef)) return true;
  if (
    snapshot.accessories.some(
      (accessory) =>
        accessory.ref === entityRef ||
        (accessory.services ?? []).some(({ ref }) => ref === entityRef),
    )
  ) {
    return true;
  }
  if (snapshot.scenarios.some(({ ref }) => ref === entityRef)) return true;
  if (
    snapshot.bridges.some(
      (bridge) =>
        bridge.ref === entityRef ||
        (bridge.exported_accessory_refs ?? []).includes(entityRef),
    )
  ) {
    return true;
  }
  if (snapshot.climate_setpoints.some(({ ref }) => ref === entityRef)) {
    return true;
  }
  return false;
}

export function withHiddenHomeSnapshotUrls(point) {
  if (point.coverage !== "home" || !isPlainObject(point.home_snapshot)) {
    return point;
  }
  return {
    ...point,
    home_snapshot: {
      ...point.home_snapshot,
      scenarios: point.home_snapshot.scenarios.map((scenario) => {
        const config = scenario.configuration;
        if (!isPlainObject(config)) return scenario;
        if (config.format === "json") {
          return {
            ...scenario,
            configuration: {
              ...config,
              value: withHiddenHttpUrls(config.value),
            },
          };
        }
        if (config.format === "code" && typeof config.value === "string") {
          return {
            ...scenario,
            configuration: {
              ...config,
              value: redactSensitiveText(config.value, "javascript_source"),
            },
          };
        }
        if (config.format === "raw" && typeof config.value === "string") {
          return {
            ...scenario,
            configuration: {
              ...config,
              value: redactSensitiveText(config.value),
            },
          };
        }
        return scenario;
      }),
    },
  };
}

export async function compareHomeSnapshots({
  point,
  currentCapture,
  comparedAt,
  stateDirectory,
  hubUrl,
  serial,
  sensitiveValues = [],
}) {
  const saved = point.home_snapshot;
  const current = currentCapture.home_snapshot;
  const notCompared = [];

  const unreadScenarios = collectUnreadByKind(
    point.not_captured,
    currentCapture.not_captured,
    "scenario",
    notCompared,
  );
  const unreadBridges = collectUnreadByKind(
    point.not_captured,
    currentCapture.not_captured,
    "bridge",
    notCompared,
  );
  const unreadClimate = collectUnreadByKind(
    point.not_captured,
    currentCapture.not_captured,
    "characteristic",
    notCompared,
  );

  const attribution = await loadAttributionContext({
    stateDirectory,
    hubUrl,
    serial,
    homeRef: point.home_ref,
    captureStartedAt: point.capture_started_at,
    comparedAt,
    sensitiveValues,
  });

  const summary = createAttributionSummary();
  const roomsDiff = diffRooms(saved.rooms, current.rooms, notCompared);
  const accessoriesDiff = diffAccessories(
    saved.accessories,
    current.accessories,
    notCompared,
  );
  const scenariosDiff = diffScenarios(
    saved.scenarios,
    current.scenarios,
    unreadScenarios,
    notCompared,
  );
  const bridgesDiff = diffBridges(
    saved.bridges,
    current.bridges,
    unreadBridges,
    notCompared,
  );
  const climateDiff = diffClimateSetpoints(
    saved.climate_setpoints,
    current.climate_setpoints,
    unreadClimate,
    notCompared,
  );

  const rooms = attributeCategoryDiff(
    roomsDiff,
    (action, item) => attributeRoomItem(attribution, action, item),
    summary,
  );
  const accessories = attributeCategoryDiff(
    accessoriesDiff,
    (action, item) => attributeAccessoryItem(attribution, action, item),
    summary,
  );
  const scenarios = attributeCategoryDiff(
    scenariosDiff,
    (action, item) => {
      if (action !== "changed") {
        return attributeScenarioItem(attribution, action, item);
      }
      const { _currentConfig, ...clean } = item;
      return {
        item: clean,
        verdict: attributeScenarioItem(
          attribution,
          action,
          clean,
          _currentConfig,
        ),
      };
    },
    summary,
  );
  const bridges = attributeCategoryDiff(
    bridgesDiff,
    (action, item) => attributeBridgeItem(attribution, action, item),
    summary,
  );
  const climateSetpoints = attributeCategoryDiff(
    climateDiff,
    (action, item) => attributeClimateItem(attribution, action, item),
    summary,
  );

  const totalChanges = [
    rooms,
    accessories,
    scenarios,
    bridges,
    climateSetpoints,
  ].reduce(
    (sum, category) =>
      sum +
      category.added.length +
      category.removed.length +
      category.changed.length,
    0,
  );

  return {
    compared_at: comparedAt,
    coverage: "home",
    house_complete: false,
    has_changes: totalChanges > 0,
    unchanged_counts: {
      rooms: roomsDiff.unchanged,
      accessories: accessoriesDiff.unchanged,
      scenarios: scenariosDiff.unchanged,
      bridges: bridgesDiff.unchanged,
      climate_setpoints: climateDiff.unchanged,
    },
    rooms,
    accessories,
    scenarios,
    bridges,
    climate_setpoints: climateSetpoints,
    not_compared: notCompared,
    excluded_categories:
      point.excluded_categories ?? HOME_SNAPSHOT_EXCLUDED_CATEGORIES,
    attribution_summary: finalizeAttributionSummary(
      summary,
      attribution.unavailable,
    ),
    attribution_note: ATTRIBUTION_NOTE,
    ...(attribution.unavailable ? { attribution_unavailable: true } : {}),
  };
}

export async function attributeSelectedComparison({
  point,
  entities,
  currentByRef,
  comparedAt,
  stateDirectory,
  hubUrl,
  serial,
  sensitiveValues = [],
}) {
  const attribution = await loadAttributionContext({
    stateDirectory,
    hubUrl,
    serial,
    homeRef: point.home_ref,
    captureStartedAt: point.capture_started_at,
    comparedAt,
    sensitiveValues,
  });
  const summary = createAttributionSummary();

  const attributed = entities.map((entity) => {
    if (entity.status !== "changed" && entity.status !== "missing") {
      return entity;
    }
    const action = entity.status === "missing" ? "missing" : "changed";
    const current = currentByRef?.get(entity.entity_ref) ?? null;
    const verdict = attributeSelectedEntity(
      attribution,
      entity,
      action,
      current,
    );
    return decorateAttribution(entity, verdict, summary);
  });

  return {
    entities: attributed,
    attribution_summary: finalizeAttributionSummary(
      summary,
      attribution.unavailable,
    ),
    attribution_note: ATTRIBUTION_NOTE,
    ...(attribution.unavailable ? { attribution_unavailable: true } : {}),
  };
}

// --- Shared diff helpers used by both selected_entities and home points ---

export function diffCharacteristicSettings(previous, current) {
  if (isHidden(previous.value) || isHidden(current.value)) {
    return {
      changes: [],
      not_compared: [{ path: ["value"], reason: "redacted" }],
    };
  }
  if (!climateSemanticsComparable(previous, current)) {
    return {
      changes: [],
      not_compared: [{ path: ["value"], reason: "incomparable_semantics" }],
    };
  }
  if (
    !isKnownClimateValue(previous.value) ||
    !isKnownClimateValue(current.value)
  ) {
    return {
      changes: [],
      not_compared: [{ path: ["value"], reason: "unknown_value" }],
    };
  }
  if (
    Object.is(previous.value, current.value) &&
    (previous.enum?.key ?? null) === (current.enum?.key ?? null)
  ) {
    return { changes: [], not_compared: [] };
  }
  return {
    changes: [
      {
        path: ["value"],
        from: comparableClimateValue(previous),
        to: comparableClimateValue(current),
      },
    ],
    not_compared: [],
  };
}

export function diffSettings(previous, current) {
  const changes = [];
  const notCompared = [];
  diffValues([], previous, current, changes, notCompared);
  return { changes, not_compared: notCompared };
}

export function isHidden(value) {
  return isRedactedNode(value) || value === "[REDACTED]";
}

export function redactedMarker() {
  return { redacted: true, reason: "sensitive_native_data" };
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- Internal capture & diff helpers ---

function sanitizeSnapshotText(value, sensitiveValues) {
  if (typeof value !== "string") return value;
  const sanitized = sanitizeNativeData(value);
  return sanitizeAgentOutput(sanitized, sensitiveValues);
}

function captureScenarioConfiguration(scenarioType, data, sensitiveValues) {
  if (typeof data !== "string") {
    return { format: "not_returned", value: null };
  }
  if (scenarioType === "BLOCK") {
    try {
      const parsed = JSON.parse(data);
      const hidden = withHiddenHttpUrls(parsed);
      const canonical = isPlainObject(hidden) ? canonicalBlock(hidden) : hidden;
      return {
        format: "json",
        value: sanitizeAgentOutput(
          sanitizeNativeData(canonical),
          sensitiveValues,
        ),
      };
    } catch {
      return {
        format: "raw",
        value: sanitizeSnapshotText(data, sensitiveValues),
      };
    }
  }
  const hasSecret = sensitiveValues.some(
    (secret) => secret.length > 0 && data.includes(secret),
  );
  return {
    format: "code",
    value: hasSecret
      ? "[REDACTED]"
      : redactSensitiveText(data, "javascript_source"),
  };
}

function parseBridgeChildAccessoryId(rawId) {
  if (typeof rawId !== "string" || !/^(?:0|[1-9]\d*)$/.test(rawId)) {
    return null;
  }
  const parsed = Number(rawId);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function collectUnreadByKind(
  savedNotCaptured,
  currentNotCaptured,
  kind,
  notCompared,
) {
  const savedMap = new Map(
    (savedNotCaptured ?? [])
      .filter(
        (item) => item.kind === kind && typeof item.entity_ref === "string",
      )
      .map((item) => [item.entity_ref, item]),
  );
  const currentMap = new Map(
    (currentNotCaptured ?? [])
      .filter(
        (item) => item.kind === kind && typeof item.entity_ref === "string",
      )
      .map((item) => [item.entity_ref, item]),
  );
  const refs = new Set([...savedMap.keys(), ...currentMap.keys()]);
  for (const ref of [...refs].sort()) {
    const savedEntry = savedMap.get(ref);
    const currentEntry = currentMap.get(ref);
    const entry = currentEntry ?? savedEntry;
    notCompared.push({
      entity_ref: ref,
      kind,
      reason: entry.reason,
      side:
        savedEntry && currentEntry ? "both" : savedEntry ? "saved" : "current",
      ...(entry.error_code ? { error_code: entry.error_code } : {}),
    });
  }
  return refs;
}

function appendNotCompared(notCompared, entityRef, kind, entries) {
  for (const item of entries) {
    notCompared.push({
      entity_ref: entityRef,
      kind,
      path: item.path,
      reason: item.reason,
    });
  }
}

function diffRooms(savedRooms, currentRooms, notCompared) {
  const savedByRef = new Map(savedRooms.map((room) => [room.ref, room]));
  const currentByRef = new Map(currentRooms.map((room) => [room.ref, room]));
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const room of currentRooms) {
    if (!savedByRef.has(room.ref)) {
      added.push(room);
      continue;
    }
    const previous = savedByRef.get(room.ref);
    const { changes, not_compared: nc } = diffSettings(
      { name: previous.name, visible: previous.visible },
      { name: room.name, visible: room.visible },
    );
    appendNotCompared(notCompared, room.ref, "room", nc);
    if (changes.length > 0) {
      changed.push({
        ref: room.ref,
        id: room.id,
        name: room.name,
        changes,
        ...(nc.length > 0 ? { not_compared: nc } : {}),
      });
    } else if (nc.length === 0) {
      unchanged += 1;
    }
  }
  for (const room of savedRooms) {
    if (!currentByRef.has(room.ref)) removed.push(room);
  }
  return { added, removed, changed, unchanged };
}

function diffAccessories(savedAccessories, currentAccessories, notCompared) {
  const savedByRef = new Map(savedAccessories.map((acc) => [acc.ref, acc]));
  const currentByRef = new Map(currentAccessories.map((acc) => [acc.ref, acc]));
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const accessory of currentAccessories) {
    if (!savedByRef.has(accessory.ref)) {
      added.push(accessory);
      continue;
    }
    const previous = savedByRef.get(accessory.ref);
    const { changes, not_compared: nc } = diffSettings(
      {
        name: previous.name,
        room_ref: previous.room_ref,
        virtual: previous.virtual,
      },
      {
        name: accessory.name,
        room_ref: accessory.room_ref,
        virtual: accessory.virtual,
      },
    );
    const svcDiff = diffAccessoryServices(
      previous.services ?? [],
      accessory.services ?? [],
    );
    appendNotCompared(notCompared, accessory.ref, "accessory", nc);
    notCompared.push(...svcDiff.notCompared);
    const hasDiff =
      changes.length > 0 ||
      svcDiff.added.length > 0 ||
      svcDiff.removed.length > 0 ||
      svcDiff.changed.length > 0;
    if (hasDiff) {
      changed.push({
        ref: accessory.ref,
        id: accessory.id,
        name: accessory.name,
        ...(changes.length > 0 ? { changes } : {}),
        ...(svcDiff.added.length > 0 ? { added_services: svcDiff.added } : {}),
        ...(svcDiff.removed.length > 0
          ? { removed_services: svcDiff.removed }
          : {}),
        ...(svcDiff.changed.length > 0
          ? { changed_services: svcDiff.changed }
          : {}),
        ...(nc.length > 0 ? { not_compared: nc } : {}),
      });
    } else if (nc.length === 0 && svcDiff.notCompared.length === 0) {
      unchanged += 1;
    }
  }
  for (const accessory of savedAccessories) {
    if (!currentByRef.has(accessory.ref)) removed.push(accessory);
  }
  return { added, removed, changed, unchanged };
}

function diffAccessoryServices(previousServices, currentServices) {
  const prevById = new Map(previousServices.map((svc) => [svc.sId, svc]));
  const currById = new Map(currentServices.map((svc) => [svc.sId, svc]));
  const added = [];
  const removed = [];
  const changed = [];
  const notCompared = [];

  for (const service of currentServices) {
    if (!prevById.has(service.sId)) {
      added.push(service);
      continue;
    }
    const previous = prevById.get(service.sId);
    const { changes, not_compared: nc } = diffSettings(
      { type: previous.type, name: previous.name, visible: previous.visible },
      { type: service.type, name: service.name, visible: service.visible },
    );
    appendNotCompared(notCompared, service.ref, "service", nc);
    if (changes.length > 0) {
      changed.push({
        sId: service.sId,
        ref: service.ref,
        name: service.name,
        changes,
        ...(nc.length > 0 ? { not_compared: nc } : {}),
      });
    }
  }
  for (const service of previousServices) {
    if (!currById.has(service.sId)) removed.push(service);
  }
  return { added, removed, changed, notCompared };
}

function diffScenarios(
  savedScenarios,
  currentScenarios,
  unreadScenarios,
  notCompared,
) {
  const savedByRef = new Map(
    savedScenarios
      .filter(({ ref }) => !unreadScenarios.has(ref))
      .map((scenario) => [scenario.ref, scenario]),
  );
  const currentByRef = new Map(
    currentScenarios
      .filter(({ ref }) => !unreadScenarios.has(ref))
      .map((scenario) => [scenario.ref, scenario]),
  );
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const scenario of currentByRef.values()) {
    if (!savedByRef.has(scenario.ref)) {
      added.push(compactScenarioSummary(scenario));
      continue;
    }
    const previous = savedByRef.get(scenario.ref);
    const { changes, not_compared: nc } = diffSettings(
      comparableHomeScenario(previous),
      comparableHomeScenario(scenario),
    );
    appendNotCompared(notCompared, scenario.ref, "scenario", nc);
    if (changes.length > 0) {
      changed.push({
        ref: scenario.ref,
        index: scenario.index,
        type: scenario.type,
        name: scenario.name,
        changes,
        ...(nc.length > 0 ? { not_compared: nc } : {}),
        _currentConfig: scenario.configuration ?? null,
      });
    } else if (nc.length === 0) {
      unchanged += 1;
    }
  }
  for (const scenario of savedByRef.values()) {
    if (!currentByRef.has(scenario.ref)) {
      removed.push(compactScenarioSummary(scenario));
    }
  }
  return { added, removed, changed, unchanged };
}

function compactScenarioSummary(scenario) {
  return {
    ref: scenario.ref,
    index: scenario.index,
    type: scenario.type,
    predefined: scenario.predefined === true,
    name: scenario.name,
    active: scenario.active === true,
  };
}

function comparableHomeScenario(scenario) {
  if (scenario.predefined === true) {
    return {
      type: scenario.type,
      predefined: true,
      name: scenario.name,
      active: scenario.active === true,
    };
  }
  let configuration = scenario.configuration ?? {
    format: "not_returned",
    value: null,
  };
  if (configuration.format === "json" && isPlainObject(configuration.value)) {
    configuration = {
      ...configuration,
      value: canonicalBlock(withHiddenHttpUrls(configuration.value)),
    };
  }
  return {
    type: scenario.type,
    predefined: false,
    name: scenario.name,
    description: scenario.description ?? null,
    active: scenario.active === true,
    on_start: scenario.on_start === true,
    sync: scenario.sync === true,
    configuration,
  };
}

function diffBridges(savedBridges, currentBridges, unreadBridges, notCompared) {
  const savedByRef = new Map(
    savedBridges
      .filter(({ ref }) => !unreadBridges.has(ref))
      .map((bridge) => [bridge.ref, bridge]),
  );
  const currentByRef = new Map(
    currentBridges
      .filter(({ ref }) => !unreadBridges.has(ref))
      .map((bridge) => [bridge.ref, bridge]),
  );
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const bridge of currentByRef.values()) {
    if (!savedByRef.has(bridge.ref)) {
      added.push(bridge);
      continue;
    }
    const previous = savedByRef.get(bridge.ref);
    const { changes, not_compared: nc } = diffSettings(
      {
        name: previous.name,
        state: previous.state,
        enabled: previous.enabled,
      },
      {
        name: bridge.name,
        state: bridge.state,
        enabled: bridge.enabled,
      },
    );
    const prevExports = new Set(previous.exported_accessory_refs ?? []);
    const currExports = new Set(bridge.exported_accessory_refs ?? []);
    const addedExports = [...currExports]
      .filter((ref) => !prevExports.has(ref))
      .sort();
    const removedExports = [...prevExports]
      .filter((ref) => !currExports.has(ref))
      .sort();
    appendNotCompared(notCompared, bridge.ref, "bridge", nc);
    if (
      changes.length > 0 ||
      addedExports.length > 0 ||
      removedExports.length > 0
    ) {
      changed.push({
        ref: bridge.ref,
        key: bridge.key,
        name: bridge.name,
        ...(changes.length > 0 ? { changes } : {}),
        ...(addedExports.length > 0 ? { added_exports: addedExports } : {}),
        ...(removedExports.length > 0
          ? { removed_exports: removedExports }
          : {}),
        ...(nc.length > 0 ? { not_compared: nc } : {}),
      });
    } else if (nc.length === 0) {
      unchanged += 1;
    }
  }
  for (const bridge of savedByRef.values()) {
    if (!currentByRef.has(bridge.ref)) removed.push(bridge);
  }
  return { added, removed, changed, unchanged };
}

function diffClimateSetpoints(
  savedSetpoints,
  currentSetpoints,
  unreadClimate,
  notCompared,
) {
  const savedByRef = new Map(
    savedSetpoints
      .filter(({ ref }) => !unreadClimate.has(ref))
      .map((item) => [item.ref, item]),
  );
  const currentByRef = new Map(
    currentSetpoints
      .filter(({ ref }) => !unreadClimate.has(ref))
      .map((item) => [item.ref, item]),
  );
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const item of currentByRef.values()) {
    if (!savedByRef.has(item.ref)) {
      added.push(item);
      continue;
    }
    const previous = savedByRef.get(item.ref);
    const { changes, not_compared: nc } = diffCharacteristicSettings(
      previous,
      item,
    );
    appendNotCompared(notCompared, item.ref, "characteristic", nc);
    if (changes.length > 0) {
      changed.push({
        ref: item.ref,
        accessory_ref: item.accessory_ref,
        type: item.type,
        name: item.name,
        changes,
        ...(nc.length > 0 ? { not_compared: nc } : {}),
      });
    } else if (nc.length === 0) {
      unchanged += 1;
    }
  }
  for (const item of savedByRef.values()) {
    if (!currentByRef.has(item.ref)) removed.push(item);
  }
  return { added, removed, changed, unchanged };
}

function climateSemanticsComparable(previous, current) {
  if (previous.type !== current.type) return false;
  if (!Object.is(previous.unit, current.unit)) return false;
  const previousKey = previous.enum?.key ?? null;
  const currentKey = current.enum?.key ?? null;
  if (previousKey === currentKey) return true;
  // Same type with different keys is an ordinary mode/speed change only when
  // the numeric codes also differ; the same code with a new key changed meaning.
  return (
    Boolean(previousKey) &&
    Boolean(currentKey) &&
    !Object.is(previous.value, current.value)
  );
}

function isKnownClimateValue(value) {
  return ["boolean", "number", "string"].includes(typeof value);
}

function comparableClimateValue(settings) {
  return {
    value: settings.value,
    ...(settings.enum
      ? { enum: { key: settings.enum.key, name: settings.enum.name } }
      : {}),
    unit: settings.unit,
  };
}

function diffValues(path, previous, current, changes, notCompared) {
  if (isHidden(previous) || isHidden(current)) {
    // Hidden values are not evidence of equality: two redacted secrets may differ.
    notCompared.push({ path, reason: "redacted" });
    return;
  }
  if (previous === undefined || current === undefined) {
    if (!isDeepStrictEqual(previous, current)) {
      changes.push({ path, from: previous, to: current });
    }
    return;
  }
  if (isPlainObject(previous) && isPlainObject(current)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const key of keys) {
      diffValues(
        [...path, key],
        Object.hasOwn(previous, key) ? previous[key] : undefined,
        Object.hasOwn(current, key) ? current[key] : undefined,
        changes,
        notCompared,
      );
    }
    return;
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    const length = Math.max(previous.length, current.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(
        [...path, index],
        previous[index],
        current[index],
        changes,
        notCompared,
      );
    }
    return;
  }
  if (!isDeepStrictEqual(previous, current)) {
    changes.push({ path, from: previous, to: current });
  }
}

// --- Journal attribution ---

async function loadAttributionContext({
  stateDirectory,
  hubUrl,
  serial,
  homeRef,
  captureStartedAt,
  comparedAt,
  sensitiveValues,
}) {
  let rawChanges;
  try {
    const store = new AutomationStore({
      directory: stateDirectory,
      hubUrl,
      hubSerial: serial,
    });
    rawChanges = await store.list();
  } catch (error) {
    if (!(error instanceof SprutHubError)) throw error;
    return {
      unavailable: true,
      homeRef,
      serial,
      sensitiveValues,
      entries: [],
    };
  }

  const startMs = Date.parse(captureStartedAt);
  const endMs = Date.parse(comparedAt);
  const entries = [];
  for (const change of rawChanges) {
    if (change.home_ref !== homeRef) continue;
    if (!isAppliedHistoryChange(change)) continue;
    const event = latestInWindowEvent(change, startMs, endMs);
    if (!event) continue;
    const refs = new Set(nativeAffectedRefs(change, homeRef));
    if (typeof change.bridge_export?.bridge_ref === "string") {
      refs.add(change.bridge_export.bridge_ref);
    }
    if (typeof change.recreated_index === "string") {
      refs.add(scenarioRef(serial, change.recreated_index));
    }
    if (typeof change.options_window_ref === "string") {
      refs.add(change.options_window_ref);
    }
    if (typeof change.device_window_ref === "string") {
      refs.add(change.device_window_ref);
    }
    if (
      change.kind === "scenario_delete" &&
      change.baseline_snapshot?.type === "LOGIC"
    ) {
      const deletedIndex = deletedScenarioIndex(change);
      if (deletedIndex !== null) {
        for (const assignment of change.dependencies?.logic_assignments ?? []) {
          if (typeof assignment?.service_ref === "string") {
            refs.add(
              `${assignment.service_ref}/logic/${encodeURIComponent(deletedIndex)}`,
            );
          }
        }
      }
    }
    entries.push({ change, refs, ...event });
  }
  entries.sort(compareEntriesNewestFirst);
  return {
    unavailable: false,
    homeRef,
    serial,
    sensitiveValues,
    entries,
  };
}

// Only real agent write events inside [startMs, endMs] qualify: apply intent
// (history applying timestamp) or explicit restore intent (write_intent with
// direction === "restore" and no rejection). Read-only reconciliations and
// no-write restores only bump updated_at and must not drag pre-snapshot
// changes into the window.
function latestInWindowEvent(change, startMs, endMs) {
  const restoreAt = restoreIntentTime(change);
  const restoreRejected =
    change.write_intent?.direction === "restore" &&
    change.write_intent?.rejection !== undefined;
  const restoreMs =
    typeof restoreAt === "string" &&
    !restoreRejected &&
    ["restored", "restoring", "uncertain", "conflict"].includes(change.status)
      ? Date.parse(restoreAt)
      : Number.NaN;

  const applyAt =
    changeAppliedAt(change) ??
    (change.native_write_sent === true ? change.created_at : undefined);
  const applyRejected =
    change.write_intent?.direction === "apply" &&
    change.write_intent?.rejection !== undefined;
  const appliedMs =
    typeof applyAt === "string" && !applyRejected
      ? Date.parse(applyAt)
      : Number.NaN;

  const restoreInWindow = inWindow(restoreMs, startMs, endMs);
  const applyInWindow = inWindow(appliedMs, startMs, endMs);

  if (restoreInWindow && (!applyInWindow || restoreMs >= appliedMs)) {
    return { eventKind: "restore", eventMs: restoreMs, eventAt: restoreAt };
  }
  if (applyInWindow) {
    return { eventKind: "apply", eventMs: appliedMs, eventAt: applyAt };
  }
  return null;
}

function inWindow(ms, startMs, endMs) {
  return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
}

function createAttributionSummary() {
  return {
    agent: 0,
    manual_or_external: 0,
    agent_and_later_change: 0,
    unavailable: 0,
  };
}

function finalizeAttributionSummary(summary, unavailable) {
  return {
    agent: summary.agent,
    manual_or_external: summary.manual_or_external,
    agent_and_later_change: summary.agent_and_later_change,
    ...(unavailable && summary.unavailable > 0
      ? { unavailable: summary.unavailable }
      : {}),
  };
}

function attributeCategoryDiff(diff, evaluate, summary) {
  const mapAction = (action, items) =>
    items.map((raw) => {
      const evaluated = evaluate(action, raw);
      if (
        evaluated &&
        Object.hasOwn(evaluated, "verdict") &&
        Object.hasOwn(evaluated, "item")
      ) {
        return decorateAttribution(evaluated.item, evaluated.verdict, summary);
      }
      return decorateAttribution(raw, evaluated, summary);
    });
  return {
    added: mapAction("added", diff.added),
    removed: mapAction("removed", diff.removed),
    changed: mapAction("changed", diff.changed),
  };
}

function decorateAttribution(item, verdict, summary) {
  if (verdict.attribution === "agent") summary.agent += 1;
  else if (verdict.attribution === "manual_or_external") {
    summary.manual_or_external += 1;
  } else if (verdict.attribution === "agent_and_later_change") {
    summary.agent_and_later_change += 1;
  } else if (verdict.attribution === "unavailable") {
    summary.unavailable += 1;
  }
  return {
    ...item,
    ...verdict,
  };
}

function buildVerdict(context, matchedEntries, allCovered) {
  if (context.unavailable) {
    return { attribution: "unavailable" };
  }
  if (matchedEntries.length === 0) {
    return { attribution: "manual_or_external" };
  }
  const sorted = [...matchedEntries].sort(compareEntriesNewestFirst);
  const uniqueEntries = [];
  const seenIds = new Set();
  for (const entry of sorted) {
    if (seenIds.has(entry.change.id)) continue;
    seenIds.add(entry.change.id);
    uniqueEntries.push(entry);
  }
  const latest = uniqueEntries[0].change;
  const latestHasForeignConflict =
    latest.status === "conflict" &&
    latest.conflict_reason !== "later_owned_change";
  const hasLaterSignal = !allCovered || latestHasForeignConflict;
  return {
    attribution: hasLaterSignal ? "agent_and_later_change" : "agent",
    matching_agent_changes: uniqueEntries
      .slice(0, MAX_MATCHING_AGENT_CHANGES)
      .map((entry) =>
        summarizeMatchingAgentChange(entry, context.sensitiveValues),
      ),
    ...(uniqueEntries.length > MAX_MATCHING_AGENT_CHANGES
      ? { matching_agent_changes_total: uniqueEntries.length }
      : {}),
  };
}

function summarizeMatchingAgentChange(entry, sensitiveValues) {
  const { change, eventKind, eventAt } = entry;
  return {
    change_ref: `spruthub-change://native/${change.id}`,
    operation: changeOperation(change),
    ...(typeof change.reason === "string"
      ? { reason: sanitizeAgentOutput(change.reason, sensitiveValues) }
      : {}),
    applied_at: applicationTime(change),
    ...(eventKind === "restore" ? { restored_at: eventAt } : {}),
    recorded_status: change.status,
  };
}

function compareEntriesNewestFirst(left, right) {
  return (
    right.eventMs - left.eventMs ||
    right.change.updated_at.localeCompare(left.change.updated_at) ||
    right.change.id.localeCompare(left.change.id)
  );
}

function isAccessoryAddedEvent(entry) {
  const { change, eventKind } = entry;
  if (eventKind === "apply") {
    return (
      change.kind === "virtual_device" ||
      change.kind === "virtual_light_group" ||
      (change.kind === "window_button" && change.button_kind === "xiaomi_join")
    );
  }
  return eventKind === "restore" && change.kind === "virtual_device_delete";
}

function isAccessoryRemovedEvent(entry) {
  const { change, eventKind } = entry;
  if (eventKind === "apply") {
    return (
      change.kind === "virtual_device_delete" ||
      (change.kind === "window_button" &&
        change.button_kind === "device_remove")
    );
  }
  return (
    eventKind === "restore" &&
    (change.kind === "virtual_device" || change.kind === "virtual_light_group")
  );
}

function isScenarioAddedEvent(entry) {
  const { change, eventKind } = entry;
  if (eventKind === "apply") {
    return (
      change.kind === "block_create" || change.kind === "logic_source_create"
    );
  }
  return eventKind === "restore" && change.kind === "scenario_delete";
}

function isScenarioRemovedEvent(entry) {
  const { change, eventKind } = entry;
  if (eventKind === "apply") {
    return change.kind === "scenario_delete";
  }
  return (
    eventKind === "restore" &&
    (change.kind === "block_create" || change.kind === "logic_source_create")
  );
}

function attributeRoomItem(context, action, item) {
  if (context.unavailable) return { attribution: "unavailable" };
  if (action === "added") {
    const matched = context.entries.filter(
      ({ change, refs, eventKind }) =>
        eventKind === "apply" &&
        change.kind === "room_create" &&
        refs.has(item.ref),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }
  if (action === "removed") {
    const matched = context.entries.filter(
      ({ change, refs, eventKind }) =>
        eventKind === "restore" &&
        change.kind === "room_create" &&
        refs.has(item.ref),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }
  const matched = context.entries.filter(
    ({ change }) =>
      change.kind === "room_name" && change.target_ref === item.ref,
  );
  const allCovered = (item.changes ?? []).every((changeDiff) => {
    if (changeDiff.path[0] !== "name") return false;
    return scalarMatchesLatest(matched, changeDiff.to);
  });
  return buildVerdict(context, matched, allCovered);
}

function attributeAccessoryItem(context, action, item) {
  if (context.unavailable) return { attribution: "unavailable" };
  const ref = item.ref ?? item.entity_ref;
  if (action === "added") {
    const matched = context.entries.filter(
      (entry) => entry.refs.has(ref) && isAccessoryAddedEvent(entry),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }
  if (action === "removed" || action === "missing") {
    const matched = context.entries.filter(
      (entry) => entry.refs.has(ref) && isAccessoryRemovedEvent(entry),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }

  const placementMatches = context.entries.filter(
    ({ change }) =>
      change.kind === "accessory_placement" && change.target_ref === ref,
  );
  const changedServiceRefs = new Set(
    (item.changed_services ?? []).map((svc) => svc.ref),
  );
  const serviceMatches = context.entries.filter(
    ({ change }) =>
      (change.kind === "service_name" || change.kind === "service_visible") &&
      changedServiceRefs.has(change.target_ref),
  );
  const matched = [...placementMatches, ...serviceMatches];

  let allCovered =
    (item.added_services?.length ?? 0) === 0 &&
    (item.removed_services?.length ?? 0) === 0;

  if (allCovered) {
    allCovered = (item.changes ?? []).every((changeDiff) => {
      const field = changeDiff.path[0];
      if (field === "name") {
        const nameEdits = placementMatches.filter(({ change }) =>
          placementChangedField(change, "name"),
        );
        return placementFieldMatchesLatest(nameEdits, "name", changeDiff.to);
      }
      if (field === "room_ref") {
        const roomEdits = placementMatches.filter(({ change }) =>
          placementChangedField(change, "room_id"),
        );
        return placementRoomMatchesLatest(
          roomEdits,
          context.serial,
          changeDiff.to,
        );
      }
      return false;
    });
  }

  if (allCovered) {
    allCovered = (item.changed_services ?? []).every((svc) =>
      (svc.changes ?? []).every((changeDiff) => {
        const field = changeDiff.path[0];
        if (field === "name") {
          const svcEdits = serviceMatches.filter(
            ({ change }) =>
              change.kind === "service_name" && change.target_ref === svc.ref,
          );
          return scalarMatchesLatest(svcEdits, changeDiff.to);
        }
        if (field === "visible") {
          const svcEdits = serviceMatches.filter(
            ({ change }) =>
              change.kind === "service_visible" &&
              change.target_ref === svc.ref,
          );
          return scalarMatchesLatest(svcEdits, changeDiff.to);
        }
        return false;
      }),
    );
  }

  return buildVerdict(context, matched, allCovered);
}

function attributeScenarioItem(context, action, item, currentConfig = null) {
  if (context.unavailable) return { attribution: "unavailable" };
  const ref = item.ref ?? item.entity_ref;
  if (action === "added") {
    const matched = context.entries.filter(
      (entry) => entry.refs.has(ref) && isScenarioAddedEvent(entry),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }
  if (action === "removed" || action === "missing") {
    const matched = context.entries.filter(
      (entry) => entry.refs.has(ref) && isScenarioRemovedEvent(entry),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }

  const matched = context.entries.filter(({ change }) => {
    if (change.target_ref !== ref) return false;
    if (
      [
        "scenario_active",
        "block_data_update",
        "block_action_pause",
        "logic_source_update",
      ].includes(change.kind)
    ) {
      return true;
    }
    return change.kind === "window_option" && change.owner_kind === "scenario";
  });

  const allCovered = (item.changes ?? []).every((changeDiff) => {
    const field = changeDiff.path[0];
    if (field === "active") {
      const edits = matched.filter(
        ({ change }) => change.kind === "scenario_active",
      );
      return scalarMatchesLatest(edits, changeDiff.to);
    }
    if (["name", "description", "on_start", "sync"].includes(field)) {
      const metadataEdits = matched.filter(({ change }) => {
        if (
          change.kind === "window_option" &&
          SCENARIO_WINDOW_OPTION_TO_FIELD[change.option_key] === field
        ) {
          return true;
        }
        return (
          field !== "sync" &&
          change.kind === "logic_source_update" &&
          (change.baseline_snapshot?.type === "LOGIC" ||
            change.requested_snapshot?.type === "LOGIC")
        );
      });
      if (metadataEdits.length === 0) return false;
      const latestEntry = metadataEdits[0];
      if (latestEntry.change.kind === "window_option") {
        return scalarMatchesLatest([latestEntry], changeDiff.to);
      }
      return logicInfoFieldMatchesChange(latestEntry, field, changeDiff.to);
    }
    if (field === "configuration") {
      const configEdits = matched.filter(({ change }) =>
        [
          "block_data_update",
          "block_action_pause",
          "logic_source_update",
        ].includes(change.kind),
      );
      if (configEdits.length === 0) return false;
      const latestEntry = configEdits[0];
      if (
        latestEntry.change.kind === "block_data_update" ||
        latestEntry.change.kind === "block_action_pause"
      ) {
        return blockConfigurationMatchesChange(latestEntry, currentConfig);
      }
      if (latestEntry.change.kind === "logic_source_update") {
        return codeConfigurationMatchesChange(
          latestEntry,
          currentConfig,
          context.sensitiveValues,
        );
      }
      return false;
    }
    return false;
  });

  return buildVerdict(context, matched, allCovered);
}

function attributeBridgeItem(context, action, item) {
  if (context.unavailable) return { attribution: "unavailable" };
  if (action === "added" || action === "removed") {
    return buildVerdict(context, [], false);
  }
  const addedExports = item.added_exports ?? [];
  const removedExports = item.removed_exports ?? [];
  const touchedAccessories = new Set([...addedExports, ...removedExports]);

  const exportMatches = context.entries.filter(({ change }) => {
    if (
      change.kind !== "window_option" ||
      change.bridge_export?.bridge_ref !== item.ref
    ) {
      return false;
    }
    const accRef = bridgeExportAccessoryRef(change);
    return accRef !== null && touchedAccessories.has(accRef);
  });

  const removalMatches = context.entries.filter(
    (entry) =>
      isAccessoryRemovedEvent(entry) &&
      removedExports.some((accRef) => entry.refs.has(accRef)),
  );

  const matched = [...exportMatches, ...removalMatches];
  let allCovered = (item.changes?.length ?? 0) === 0;
  if (allCovered) {
    for (const accRef of addedExports) {
      const edits = exportMatches.filter(
        ({ change }) => bridgeExportAccessoryRef(change) === accRef,
      );
      if (!scalarMatchesLatest(edits, true)) {
        allCovered = false;
        break;
      }
    }
  }
  if (allCovered) {
    for (const accRef of removedExports) {
      const edits = exportMatches.filter(
        ({ change }) => bridgeExportAccessoryRef(change) === accRef,
      );
      const deleted = removalMatches.some(({ refs }) => refs.has(accRef));
      if (!deleted && !scalarMatchesLatest(edits, false)) {
        allCovered = false;
        break;
      }
    }
  }
  return buildVerdict(context, matched, allCovered);
}

function attributeClimateItem(context, action, item) {
  if (context.unavailable) return { attribution: "unavailable" };
  const ref = item.ref ?? item.entity_ref;
  const accRef =
    item.accessory_ref ??
    ref.replace(/\/service\/\d+\/characteristic\/\d+$/, "");
  if (action === "added") {
    const matched = context.entries.filter(
      (entry) => entry.refs.has(accRef) && isAccessoryAddedEvent(entry),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }
  if (action === "removed" || action === "missing") {
    const matched = context.entries.filter(
      (entry) => entry.refs.has(accRef) && isAccessoryRemovedEvent(entry),
    );
    return buildVerdict(context, matched, matched.length > 0);
  }
  const matched = context.entries.filter(
    ({ change }) =>
      change.kind === "characteristic_value" && change.target_ref === ref,
  );
  const allCovered = (item.changes ?? []).every((changeDiff) => {
    if (changeDiff.path[0] !== "value") return false;
    const expectedTo = isPlainObject(changeDiff.to)
      ? changeDiff.to.value
      : changeDiff.to;
    return scalarMatchesLatest(matched, expectedTo);
  });
  return buildVerdict(context, matched, allCovered);
}

function attributeSelectedEntity(context, entity, action, current) {
  if (entity.kind === "accessory") {
    return attributeAccessoryItem(context, action, entity);
  }
  if (entity.kind === "scenario") {
    return attributeScenarioItem(
      context,
      action,
      entity,
      current?.settings?.configuration ?? null,
    );
  }
  if (entity.kind === "characteristic") {
    return attributeClimateItem(context, action, entity);
  }
  if (entity.kind === "logic") {
    return attributeLogicItem(context, action, entity);
  }
  if (entity.kind === "window") {
    return attributeWindowItem(context, action, entity);
  }
  return buildVerdict(context, [], false);
}

function attributeLogicItem(context, action, item) {
  if (context.unavailable) return { attribution: "unavailable" };
  const ref = item.entity_ref;
  if (action === "missing") {
    const parsed = safeParseEntityRef(ref);
    const parentAccRef =
      parsed?.kind === "logic"
        ? accessoryRef(context.serial, parsed.accessoryId)
        : null;
    const matched = context.entries.filter((entry) => {
      const { change, refs, eventKind } = entry;
      if (
        change.kind === "logic_assignment" &&
        eventKind === "restore" &&
        refs.has(ref)
      ) {
        return true;
      }
      if (isScenarioRemovedEvent(entry)) {
        if (refs.has(ref)) return true;
        const removedIndex = deletedScenarioIndex(change);
        const isLogicScenario =
          change.kind === "logic_source_create" ||
          change.baseline_snapshot?.type === "LOGIC";
        if (
          isLogicScenario &&
          removedIndex !== null &&
          parsed?.kind === "logic" &&
          parsed.logicType === removedIndex
        ) {
          return true;
        }
      }
      if (
        parentAccRef !== null &&
        isAccessoryRemovedEvent(entry) &&
        refs.has(parentAccRef)
      ) {
        return true;
      }
      return false;
    });
    return buildVerdict(context, matched, matched.length > 0);
  }
  const matched = context.entries.filter(
    ({ change }) =>
      (change.kind === "logic_active" || change.kind === "logic_option") &&
      change.target_ref === ref,
  );
  const allCovered = (item.changes ?? []).every((changeDiff) => {
    if (changeDiff.path[0] === "active") {
      const edits = matched.filter(
        ({ change }) => change.kind === "logic_active",
      );
      return scalarMatchesLatest(edits, changeDiff.to);
    }
    if (
      changeDiff.path[0] === "options" &&
      typeof changeDiff.path[1] === "string" &&
      changeDiff.path[2] === "configured_value" &&
      changeDiff.path.length === 3
    ) {
      const key = changeDiff.path[1];
      const edits = matched.filter(
        ({ change }) =>
          change.kind === "logic_option" && change.option_key === key,
      );
      return scalarMatchesLatest(edits, changeDiff.to);
    }
    return false;
  });
  return buildVerdict(context, matched, allCovered);
}

function attributeWindowItem(context, action, item) {
  if (context.unavailable) return { attribution: "unavailable" };
  const ref = item.entity_ref;
  if (action === "missing") {
    const parsed = safeParseEntityRef(ref);
    const windowKey = parsed?.kind === "window" ? parsed.windowKey : null;
    const bridgeAccId =
      windowKey !== null ? parseBridgeChildWindowAccessoryId(windowKey) : null;
    const logicWin = windowKey !== null ? parseLogicWindowKey(windowKey) : null;
    const matched = context.entries.filter((entry) => {
      const { change, refs } = entry;
      if (isScenarioRemovedEvent(entry)) {
        if (change.options_window_ref === ref || refs.has(ref)) return true;
        const removedIndex = deletedScenarioIndex(change);
        const isLogicScenario =
          change.kind === "logic_source_create" ||
          change.baseline_snapshot?.type === "LOGIC";
        if (
          isLogicScenario &&
          removedIndex !== null &&
          logicWin !== null &&
          logicWin.type === removedIndex
        ) {
          return true;
        }
      }
      if (isAccessoryRemovedEvent(entry)) {
        if (
          change.device_window_ref === ref ||
          change.target_ref === ref ||
          refs.has(ref)
        ) {
          return true;
        }
        if (
          bridgeAccId !== null &&
          refs.has(accessoryRef(context.serial, bridgeAccId))
        ) {
          return true;
        }
        if (
          logicWin !== null &&
          refs.has(accessoryRef(context.serial, logicWin.accessoryId))
        ) {
          return true;
        }
      }
      return false;
    });
    return buildVerdict(context, matched, matched.length > 0);
  }
  const matched = context.entries.filter(
    ({ change }) =>
      change.kind === "window_option" &&
      (change.target_ref === ref || change.window_ref === ref),
  );
  const allCovered = (item.changes ?? []).every((changeDiff) => {
    if (
      changeDiff.path[0] === "options" &&
      typeof changeDiff.path[1] === "string" &&
      changeDiff.path[2] === "configured_value" &&
      changeDiff.path.length === 3
    ) {
      const key = changeDiff.path[1];
      const edits = matched.filter(({ change }) => change.option_key === key);
      return scalarMatchesLatest(edits, changeDiff.to);
    }
    return false;
  });
  return buildVerdict(context, matched, allCovered);
}

function scalarMatchesLatest(entries, liveValue) {
  if (entries.length === 0) return false;
  const { change, eventKind } = entries[0];
  const expected =
    eventKind === "restore" ? change.baseline_value : change.requested_value;
  if (!expected || !Object.hasOwn(expected, "value")) {
    return false;
  }
  return isDeepStrictEqual(expected.value, liveValue);
}

function placementChangedField(change, field) {
  if (!change.baseline_snapshot || !change.requested_snapshot) return true;
  return !isDeepStrictEqual(
    change.baseline_snapshot[field],
    change.requested_snapshot[field],
  );
}

function placementFieldMatchesLatest(entries, field, liveValue) {
  if (entries.length === 0) return false;
  const { change, eventKind } = entries[0];
  const candidates =
    eventKind === "restore"
      ? [change.baseline_snapshot?.[field]]
      : [change.applied_snapshot?.[field], change.requested_snapshot?.[field]];
  const valid = candidates.filter((value) => value !== undefined);
  if (valid.length === 0) return false;
  return valid.some((candidate) => isDeepStrictEqual(candidate, liveValue));
}

function placementRoomMatchesLatest(entries, serial, liveRoomRef) {
  if (entries.length === 0) return false;
  const { change, eventKind } = entries[0];
  const candidates =
    eventKind === "restore"
      ? [change.baseline_snapshot?.room_id]
      : [change.applied_snapshot?.room_id, change.requested_snapshot?.room_id];
  const valid = candidates
    .filter((id) => typeof id === "number")
    .map((id) => roomRef(serial, id));
  if (valid.length === 0) return false;
  return valid.includes(liveRoomRef);
}

function bridgeExportAccessoryRef(change) {
  const svcRef = change.bridge_export?.service_ref;
  if (typeof svcRef !== "string") return null;
  return svcRef.replace(/\/service\/\d+$/, "");
}

function parseBlockData(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function blockConfigurationMatchesChange(entry, currentConfig) {
  if (currentConfig?.format !== "json" || !isPlainObject(currentConfig.value)) {
    return false;
  }
  const { change, eventKind } = entry;
  const raw =
    eventKind === "restore"
      ? (change.restore_snapshot?.data ?? change.baseline_snapshot?.data)
      : (change.applied_snapshot?.data ?? change.requested_snapshot?.data);
  const parsed = parseBlockData(raw);
  if (!parsed) return false;
  const expected = canonicalBlock(withHiddenHttpUrls(parsed));
  const current = canonicalBlock(withHiddenHttpUrls(currentConfig.value));
  const { changes } = diffSettings(expected, current);
  return changes.length === 0;
}

function codeConfigurationMatchesChange(
  entry,
  currentConfig,
  sensitiveValues = [],
) {
  if (
    currentConfig?.format !== "code" ||
    typeof currentConfig.value !== "string"
  ) {
    return false;
  }
  if (isHidden(currentConfig.value)) return false;
  const { change, eventKind } = entry;
  const expected =
    eventKind === "restore"
      ? (change.restore_snapshot?.data ?? change.baseline_snapshot?.data)
      : (change.applied_snapshot?.data ?? change.requested_snapshot?.data);
  if (typeof expected !== "string") return false;
  const hasSecret = sensitiveValues.some(
    (secret) => secret.length > 0 && expected.includes(secret),
  );
  const sanitizedExpected = hasSecret
    ? "[REDACTED]"
    : redactSensitiveText(expected, "javascript_source");
  if (isHidden(sanitizedExpected)) return false;
  return sanitizedExpected === currentConfig.value;
}

const LOGIC_INFO_NATIVE_FIELD = {
  name: "name",
  description: "desc",
  on_start: "onStart",
};

function logicInfoFieldMatchesChange(entry, field, liveValue) {
  const nativeField = LOGIC_INFO_NATIVE_FIELD[field];
  if (!nativeField) return false;
  const { change, eventKind } = entry;
  const candidates =
    eventKind === "restore"
      ? [
          change.restore_snapshot?.[nativeField],
          change.baseline_snapshot?.[nativeField],
        ]
      : [
          change.applied_snapshot?.[nativeField],
          change.requested_snapshot?.[nativeField],
        ];
  const valid = candidates.filter((value) => value !== undefined);
  if (valid.length === 0) return false;
  return valid.some((candidate) => isDeepStrictEqual(candidate, liveValue));
}

function safeParseEntityRef(ref) {
  try {
    return parseEntityRef(ref);
  } catch {
    return null;
  }
}

function deletedScenarioIndex(change) {
  const index =
    change.target?.index ??
    change.baseline_snapshot?.index ??
    change.scenario_index;
  return typeof index === "string" && index.length > 0 ? index : null;
}

function parseBridgeChildWindowAccessoryId(windowKey) {
  const match = /^Bridge\/[^/]+\/Child\/(\d+)\/$/.exec(windowKey);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

function parseLogicWindowKey(windowKey) {
  const match = /^Logic\/([^/]+)\/(\d+)\/(\d+)$/.exec(windowKey);
  if (!match) return null;
  const accessoryId = Number(match[2]);
  const serviceId = Number(match[3]);
  if (!Number.isSafeInteger(accessoryId) || !Number.isSafeInteger(serviceId)) {
    return null;
  }
  return { type: match[1], accessoryId, serviceId };
}
