import { isDeepStrictEqual } from "node:util";
import {
  canonicalBlock,
  httpUrlHidden,
  withHiddenHttpUrls,
} from "./block-model.mjs";
import {
  applicationTime,
  compareApplication,
  summaryRestoreSupported,
} from "./change-history.mjs";
import { changeName } from "./change-restore.mjs";
import { isHidden, isPlainObject } from "./home-configuration-point.mjs";
import { hubCodeProblems } from "./hub-code.mjs";
import { changeOperation } from "./light-group-members.mjs";
import { readLogicInfo } from "./logic-info.mjs";
import {
  isAllowedTelegramTextOption,
  isTelegramWindowKey,
} from "./native-option-contract.mjs";
import { roomNameWithinLimit } from "./native-values.mjs";
import {
  isSensitiveNativeNode,
  parseEntityRef,
  redactSensitiveText,
  roomRef,
  sanitizeAgentOutput,
} from "./spruthub-client.mjs";
import { validateTelegramTextOptionValue } from "./window-buttons.mjs";

export const UNDO_BATCH_LIMIT = 50;

const SCENARIO_FIELD_TO_WINDOW_OPTION = {
  name: "Name",
  description: "Desc",
  on_start: "OnStart",
  sync: "Sync",
};

const LOGIC_FIELD_TO_INFO_KEY = {
  name: "name",
  description: "description",
  on_start: "onStart",
};

const LOGIC_FIELD_TO_NATIVE_SNAPSHOT_KEY = {
  name: "name",
  description: "desc",
  on_start: "onStart",
};

const SCENARIO_WINDOW_RESERVED_KEYS = new Set([
  "Active",
  "Name",
  "Desc",
  "OnStart",
  "Sync",
]);

const SCALAR_OPTION_INPUT_TYPES = new Set(["NUMBER", "CHECKBOX", "LIST"]);
const WINDOW_OPTION_INPUT_TYPES = new Set([
  "NUMBER",
  "CHECKBOX",
  "LIST",
  "TEXT",
]);

export function buildRestorePlan({
  pointRef,
  point,
  comparison,
  currentSnapshot = null,
  currentByRef = null,
  attributionDetails = null,
  serial,
  sensitiveValues = [],
}) {
  const coverage =
    comparison.coverage === "home" ? "home" : "selected_entities";
  const shortPointId =
    typeof point?.id === "string" && point.id.length > 0
      ? point.id.slice(0, 8)
      : "saved";

  const ctx = {
    pointRef,
    shortPointId,
    coverage,
    serial,
    sensitiveValues,
    attributionUnavailable: comparison.attribution_unavailable === true,
    attributionDetails: attributionDetails ?? new Map(),
    taintedChangeIds: collectTaintedChangeIds(comparison, attributionDetails),
    undoEntriesById: new Map(),
    reapply: [],
    notRestorable: [],
    notRestorableKeys: new Set(),
    removedByUndoAccessories: new Set(),
    movedOutByUndoAccessories: new Set(),
  };

  if (coverage === "home") {
    planHomeRestore(ctx, point.home_snapshot, currentSnapshot, comparison);
  } else {
    planSelectedRestore(ctx, point, currentByRef ?? new Map(), comparison);
  }

  const undoBatches = buildUndoBatches(ctx.undoEntriesById, sensitiveValues);
  const undoChangesCount = ctx.undoEntriesById.size;
  const manualOverrideCount = ctx.reapply.filter(
    (item) => item.manual_override_warning === true,
  ).length;
  const hasManualOverrides = manualOverrideCount > 0;
  const requiresOwnerConfirmation =
    hasManualOverrides ||
    ctx.notRestorable.length > 0 ||
    ctx.attributionUnavailable;
  const tellOwner = requiresOwnerConfirmation
    ? buildTellOwner({
        attributionUnavailable: ctx.attributionUnavailable,
        manualOverrideCount,
        notRestorableCount: ctx.notRestorable.length,
      })
    : undefined;
  const includeBackupNote =
    ctx.notRestorable.length > 0 ||
    point?.house_complete === false ||
    comparison.house_complete === false;
  const backupNote = includeBackupNote
    ? "Configuration points omit excluded categories, redacted secrets, device/logic options, and deleted physical devices. For full hub recovery, restore a .zip hub backup (configuration_point with hub_backup=list/create) manually in the SprutHub app."
    : undefined;

  return {
    read_only: true,
    point_ref: pointRef,
    coverage,
    has_manual_overrides: hasManualOverrides,
    requires_owner_confirmation: requiresOwnerConfirmation,
    ...(tellOwner ? { tell_owner: tellOwner } : {}),
    summary: {
      undo_agent_changes_count: undoChangesCount,
      undo_batches_count: undoBatches.length,
      reapply_from_point_count: ctx.reapply.length,
      manual_override_count: manualOverrideCount,
      not_restorable_count: ctx.notRestorable.length,
    },
    undo_agent_changes: undoBatches,
    reapply_from_point: ctx.reapply,
    not_restorable: ctx.notRestorable,
    ...(backupNote ? { backup_note: backupNote } : {}),
  };
}

// --- Pass 1: Global cross-item taint discovery ---

function collectTaintedChangeIds(comparison, attributionDetails) {
  const tainted = new Set();
  if (comparison.attribution_unavailable === true || !attributionDetails) {
    return tainted;
  }
  for (const detail of attributionDetails.values()) {
    const entries = detail?.entries ?? [];
    if (detail?.attribution !== "agent") {
      for (const entry of entries) {
        if (entry?.change?.id) tainted.add(entry.change.id);
      }
      continue;
    }
    for (const entry of entries) {
      if (!isStandaloneEligibleApply(entry)) {
        if (entry?.change?.id) tainted.add(entry.change.id);
      }
    }
  }
  return tainted;
}

function isStandaloneEligibleApply(entry) {
  if (entry?.eventKind !== "apply") return false;
  const { change } = entry;
  if (!change || typeof change.id !== "string") return false;
  if (change.status === "restored") return false;
  if (["uncertain", "applying", "restoring"].includes(change.status)) {
    return false;
  }
  return summaryRestoreSupported(change) === true;
}

function isEligibleApplyEntry(ctx, entry) {
  if (ctx.attributionUnavailable) return false;
  if (!isStandaloneEligibleApply(entry)) return false;
  return !ctx.taintedChangeIds.has(entry.change.id);
}

function itemDetail(ctx, item) {
  return (
    ctx.attributionDetails.get(item) ?? {
      attribution: item.attribution ?? "manual_or_external",
      entries: [],
    }
  );
}

function registerUndoEntries(ctx, entries) {
  for (const entry of entries) {
    if (!ctx.undoEntriesById.has(entry.change.id)) {
      ctx.undoEntriesById.set(entry.change.id, entry);
    }
  }
}

function addReapply(
  ctx,
  {
    entity_ref,
    kind,
    field,
    attribution,
    from_current,
    to_point,
    arguments: args,
  },
) {
  ctx.reapply.push({
    entity_ref,
    kind,
    field,
    attribution,
    manual_override_warning: attribution !== "agent",
    from_current: sanitizeDisplayValue(from_current, ctx.sensitiveValues),
    to_point: sanitizeDisplayValue(to_point, ctx.sensitiveValues),
    tool: "prepare_native_change",
    arguments: args,
  });
}

function addNotRestorable(
  ctx,
  { entity_ref, kind, field, reason, message, dedupSuffix = "" },
) {
  const baseKey = `${entity_ref}\0${kind}\0${field ?? ""}`;
  const fullKey = dedupSuffix ? `${baseKey}\0${dedupSuffix}` : baseKey;
  if (ctx.notRestorableKeys.has(fullKey)) return;
  ctx.notRestorableKeys.add(fullKey);
  if (dedupSuffix) ctx.notRestorableKeys.add(baseKey);
  ctx.notRestorable.push({
    entity_ref,
    kind,
    ...(field !== undefined ? { field } : {}),
    reason,
    message,
  });
}

function hasNotRestorableFor(ctx, entityRef, kind, field) {
  return ctx.notRestorableKeys.has(`${entityRef}\0${kind}\0${field ?? ""}`);
}

function rollbackReason(ctx, label) {
  return `Restore ${label} from configuration point ${ctx.shortPointId}`;
}

// --- Whole-home planning ---

function planHomeRestore(ctx, savedSnapshot, currentSnapshot, comparison) {
  const savedRooms = new Map(savedSnapshot.rooms.map((r) => [r.ref, r]));
  const currentRooms = new Map(currentSnapshot.rooms.map((r) => [r.ref, r]));
  const savedAccessories = new Map(
    savedSnapshot.accessories.map((a) => [a.ref, a]),
  );
  const currentAccessories = new Map(
    currentSnapshot.accessories.map((a) => [a.ref, a]),
  );
  const savedScenarios = new Map(
    savedSnapshot.scenarios.map((s) => [s.ref, s]),
  );
  const currentScenarios = new Map(
    currentSnapshot.scenarios.map((s) => [s.ref, s]),
  );
  const savedClimate = new Map(
    savedSnapshot.climate_setpoints.map((c) => [c.ref, c]),
  );
  const currentClimate = new Map(
    currentSnapshot.climate_setpoints.map((c) => [c.ref, c]),
  );

  // 1. Accessories first (so rooms.added and climate/bridges know which accessories are undone).
  for (const item of comparison.accessories.added) {
    planHomeAddedAccessory(ctx, item);
  }
  for (const item of comparison.accessories.removed) {
    planHomeRemovedAccessory(ctx, item);
  }
  for (const item of comparison.accessories.changed) {
    const saved = savedAccessories.get(item.ref);
    const current = currentAccessories.get(item.ref);
    planHomeChangedAccessory(ctx, item, saved, current, currentRooms);
  }

  // 2. Rooms (after accessories so room_create checks emptiness accurately).
  for (const item of comparison.rooms.changed) {
    const saved = savedRooms.get(item.ref);
    const current = currentRooms.get(item.ref);
    planHomeChangedRoom(ctx, item, saved, current);
  }
  for (const item of comparison.rooms.removed) {
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "room",
      reason: "room_removed",
      message:
        "This room was deleted after the configuration point was saved and cannot be restored with its original room ID automatically.",
    });
  }
  for (const item of comparison.rooms.added) {
    planHomeAddedRoom(ctx, item, currentSnapshot.accessories);
  }

  // 3. Scenarios.
  for (const item of comparison.scenarios.added) {
    planHomeAddedScenario(ctx, item, currentScenarios.get(item.ref));
  }
  for (const item of comparison.scenarios.removed) {
    planHomeRemovedScenario(ctx, item);
  }
  for (const item of comparison.scenarios.changed) {
    const saved = savedScenarios.get(item.ref);
    const current = currentScenarios.get(item.ref);
    planScenarioChanges(ctx, {
      entityRef: item.ref,
      diffItem: item,
      saved,
      current,
    });
  }

  // 4. Bridges.
  for (const item of comparison.bridges.added) {
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "bridge",
      reason: "unsupported_field",
      message:
        "Added bridge extensions cannot be removed automatically through native write tools.",
    });
  }
  for (const item of comparison.bridges.removed) {
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "bridge",
      reason: "unsupported_field",
      message:
        "Removed bridge extensions cannot be restored automatically through native write tools.",
    });
  }
  for (const item of comparison.bridges.changed) {
    planHomeChangedBridge(ctx, item);
  }

  // 5. Climate setpoints.
  for (const item of comparison.climate_setpoints.added) {
    planHomeAddedClimate(ctx, item);
  }
  for (const item of comparison.climate_setpoints.removed) {
    planHomeRemovedClimate(ctx, item);
  }
  for (const item of comparison.climate_setpoints.changed) {
    const saved = savedClimate.get(item.ref);
    const current = currentClimate.get(item.ref);
    planClimateSetpointChange(ctx, {
      entityRef: item.ref,
      diffItem: item,
      saved,
      current,
      accessoryExists: currentAccessories.has(item.accessory_ref),
    });
  }

  // 6. Account for ALL comparison.not_compared entries.
  for (const entry of comparison.not_compared ?? []) {
    accountNotComparedEntry(ctx, entry);
  }
}

function planHomeAddedRoom(ctx, item, currentAccessories) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0) {
    const createEntries = entries.filter(
      ({ change }) => change.kind === "room_create",
    );
    if (
      createEntries.length === 1 &&
      entries.every((e) => isEligibleApplyEntry(ctx, e))
    ) {
      const { change } = createEntries[0];
      const nameMatches = change.applied_snapshot?.name === item.name;
      const visibleMatches =
        change.applied_snapshot?.visible == null ||
        change.applied_snapshot.visible === item.visible;
      const blockingAccessories = currentAccessories.filter(
        (acc) =>
          acc.room_ref === item.ref &&
          !ctx.removedByUndoAccessories.has(acc.ref) &&
          !ctx.movedOutByUndoAccessories.has(acc.ref),
      );
      if (nameMatches && visibleMatches && blockingAccessories.length === 0) {
        registerUndoEntries(ctx, createEntries);
        return;
      }
      if (blockingAccessories.length > 0) {
        addNotRestorable(ctx, {
          entity_ref: item.ref,
          kind: "room",
          reason: "room_not_empty",
          message:
            "This agent-created room currently holds devices that are not being moved or removed by undo; move or remove them first before deleting the room.",
        });
        return;
      }
    }
  }
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "room",
    reason: "room_added_externally",
    message:
      "This room was added outside an unchanged agent room_create and cannot be deleted automatically.",
  });
}

function planHomeChangedRoom(ctx, item, saved, current) {
  const { attribution, entries } = itemDetail(ctx, item);
  const changedFields = new Set(
    (item.changes ?? []).map((diff) => diff.path[0]),
  );

  if (changedFields.has("name")) {
    const nameEntries = entries.filter(
      ({ change }) => change.kind === "room_name",
    );
    if (
      attribution === "agent" &&
      verifyScalarChain(ctx, nameEntries, saved?.name, current?.name)
    ) {
      registerUndoEntries(ctx, nameEntries);
    } else if (isCleanNonEmptyString(saved?.name)) {
      const validName = validateRoomNameForPlan(saved.name);
      if (validName.ok) {
        addReapply(ctx, {
          entity_ref: item.ref,
          kind: "room",
          field: "name",
          attribution,
          from_current: current?.name ?? null,
          to_point: saved.name,
          arguments: {
            operation: "room_name",
            target_ref: item.ref,
            value: validName.name,
            reason: rollbackReason(ctx, "room name"),
          },
        });
      } else {
        addNotRestorable(ctx, {
          entity_ref: item.ref,
          kind: "room",
          field: "name",
          reason: validName.reason,
          message: validName.message,
        });
      }
    } else {
      addNotRestorable(ctx, {
        entity_ref: item.ref,
        kind: "room",
        field: "name",
        reason: isHidden(saved?.name) ? "redacted_value" : "unsupported_field",
        message:
          "The saved room name is missing or redacted and cannot be reapplied automatically.",
      });
    }
  }

  for (const field of changedFields) {
    if (field === "name") continue;
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "room",
      field: String(field),
      reason: "unsupported_field",
      message: `Room field "${field}" cannot be changed through native write tools.`,
    });
  }
}

function planHomeAddedAccessory(ctx, item) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0) {
    const createEntries = entries.filter(
      ({ change }) =>
        change.kind === "virtual_device" ||
        change.kind === "virtual_light_group",
    );
    if (
      createEntries.length === 1 &&
      entries.every((e) => isEligibleApplyEntry(ctx, e))
    ) {
      const { change } = createEntries[0];
      const snapshot =
        change.kind === "virtual_device"
          ? change.created_snapshot
          : change.created_accessory_snapshot;
      const matchesCreated =
        snapshot &&
        snapshot.name === item.name &&
        typeof snapshot.room_id === "number" &&
        roomRef(ctx.serial, snapshot.room_id) === item.room_ref;
      if (matchesCreated) {
        registerUndoEntries(ctx, createEntries);
        ctx.removedByUndoAccessories.add(item.ref);
        return;
      }
    }
  }
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "accessory",
    reason: "device_added_externally",
    message:
      "This device was added outside an unchanged agent virtual device creation and cannot be removed automatically.",
  });
}

function planHomeRemovedAccessory(ctx, item) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0) {
    const deleteEntries = entries.filter(
      ({ change }) => change.kind === "virtual_device_delete",
    );
    if (
      deleteEntries.length === 1 &&
      entries.every((e) => isEligibleApplyEntry(ctx, e))
    ) {
      registerUndoEntries(ctx, deleteEntries);
      return;
    }
  }
  const isVirtual = item.virtual === true;
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "accessory",
    reason: isVirtual ? "virtual_device_removed" : "physical_device_removed",
    message: isVirtual
      ? "This virtual device was removed outside an undoable agent delete and cannot be restored with its original ID automatically."
      : "This physical device was removed from the hub and must be physically re-paired in SprutHub.",
  });
}

function planHomeChangedAccessory(ctx, item, saved, current, currentRooms) {
  const { attribution, entries } = itemDetail(ctx, item);
  const changedFields = new Set(
    (item.changes ?? []).map((diff) => diff.path[0]),
  );

  const placementChanged =
    changedFields.has("name") || changedFields.has("room_ref");
  if (placementChanged) {
    planAccessoryPlacement(ctx, {
      entityRef: item.ref,
      attribution,
      entries,
      changedFields,
      saved,
      current,
      currentRooms,
    });
  }

  for (const field of changedFields) {
    if (field === "name" || field === "room_ref") continue;
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "accessory",
      field: String(field),
      reason: "unsupported_field",
      message: `Accessory field "${field}" cannot be changed through native write tools.`,
    });
  }

  for (const addedSvc of item.added_services ?? []) {
    addNotRestorable(ctx, {
      entity_ref: addedSvc.ref ?? item.ref,
      kind: "service",
      field: "added_services",
      reason: "unsupported_field",
      message:
        "Services added to an existing accessory cannot be removed automatically.",
    });
  }
  for (const removedSvc of item.removed_services ?? []) {
    addNotRestorable(ctx, {
      entity_ref: removedSvc.ref ?? item.ref,
      kind: "service",
      field: "removed_services",
      reason: "unsupported_field",
      message:
        "Services removed from an existing accessory cannot be recreated automatically.",
    });
  }

  const savedServices = new Map((saved?.services ?? []).map((s) => [s.ref, s]));
  const currentServices = new Map(
    (current?.services ?? []).map((s) => [s.ref, s]),
  );
  for (const svcDiff of item.changed_services ?? []) {
    planServiceChanges(ctx, {
      svcDiff,
      attribution,
      entries,
      savedSvc: savedServices.get(svcDiff.ref),
      currentSvc: currentServices.get(svcDiff.ref),
    });
  }
}

function planAccessoryPlacement(
  ctx,
  {
    entityRef,
    attribution,
    entries,
    changedFields,
    saved,
    current,
    currentRooms,
  },
) {
  const placementEntries = entries.filter(
    ({ change }) =>
      change.kind === "accessory_placement" && change.target_ref === entityRef,
  );
  if (
    attribution === "agent" &&
    verifyPlacementChain(ctx, placementEntries, saved, current, currentRooms)
  ) {
    registerUndoEntries(ctx, placementEntries);
    if (changedFields.has("room_ref")) {
      ctx.movedOutByUndoAccessories.add(entityRef);
    }
    return;
  }

  const nameChanged = changedFields.has("name");
  const roomChanged = changedFields.has("room_ref");

  let canRestoreRoom = false;
  if (roomChanged) {
    if (
      typeof saved?.room_ref === "string" &&
      (!currentRooms || currentRooms.has(saved.room_ref))
    ) {
      canRestoreRoom = true;
    } else {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "accessory",
        field: "room_ref",
        reason: "target_room_missing",
        message:
          "The room this device belonged to in the saved point no longer exists on the hub, so the device cannot be moved back there automatically.",
      });
    }
  }

  let canRestoreName = false;
  if (nameChanged) {
    if (isCleanNonEmptyString(saved?.name)) {
      canRestoreName = true;
    } else {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "accessory",
        field: "name",
        reason: isHidden(saved?.name) ? "redacted_value" : "unsupported_field",
        message:
          "The saved device name is missing or redacted and cannot be reapplied automatically.",
      });
    }
  }

  if (!canRestoreName && !canRestoreRoom) return;

  // prepare_native_change accessory_placement requires BOTH name and room_ref.
  const targetName = canRestoreName ? saved.name : current?.name;
  const targetRoomRef = canRestoreRoom ? saved.room_ref : current?.room_ref;

  if (!isCleanNonEmptyString(targetName)) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "accessory",
      field: canRestoreRoom ? "room_ref" : "name",
      reason: isHidden(targetName) ? "redacted_value" : "unsupported_field",
      message:
        "Accessory placement requires a valid non-redacted accessory name, which is unavailable.",
    });
    return;
  }
  if (
    typeof targetRoomRef !== "string" ||
    (currentRooms && !currentRooms.has(targetRoomRef))
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "accessory",
      field: canRestoreName ? "name" : "room_ref",
      reason: "target_room_missing",
      message:
        "Accessory placement requires an existing destination room on the hub.",
    });
    return;
  }

  const field =
    canRestoreName && canRestoreRoom
      ? "placement"
      : canRestoreName
        ? "name"
        : "room_ref";
  const fromCurrent =
    canRestoreName && canRestoreRoom
      ? { name: current?.name ?? null, room_ref: current?.room_ref ?? null }
      : canRestoreName
        ? (current?.name ?? null)
        : (current?.room_ref ?? null);
  const toPoint =
    canRestoreName && canRestoreRoom
      ? { name: saved.name, room_ref: saved.room_ref }
      : canRestoreName
        ? saved.name
        : saved.room_ref;

  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "accessory",
    field,
    attribution,
    from_current: fromCurrent,
    to_point: toPoint,
    arguments: {
      operation: "accessory_placement",
      target_ref: entityRef,
      name: targetName,
      room_ref: targetRoomRef,
      reason: rollbackReason(ctx, "accessory placement"),
    },
  });
}

function planServiceChanges(
  ctx,
  { svcDiff, attribution, entries, savedSvc, currentSvc },
) {
  const svcFields = new Set(
    (svcDiff.changes ?? []).map((diff) => diff.path[0]),
  );

  if (svcFields.has("name")) {
    const nameEntries = entries.filter(
      ({ change }) =>
        change.kind === "service_name" && change.target_ref === svcDiff.ref,
    );
    if (
      attribution === "agent" &&
      verifyScalarChain(ctx, nameEntries, savedSvc?.name, currentSvc?.name)
    ) {
      registerUndoEntries(ctx, nameEntries);
    } else if (isCleanNonEmptyString(savedSvc?.name)) {
      addReapply(ctx, {
        entity_ref: svcDiff.ref,
        kind: "service",
        field: "name",
        attribution,
        from_current: currentSvc?.name ?? null,
        to_point: savedSvc.name,
        arguments: {
          operation: "service_name",
          target_ref: svcDiff.ref,
          value: savedSvc.name,
          reason: rollbackReason(ctx, "service name"),
        },
      });
    } else {
      addNotRestorable(ctx, {
        entity_ref: svcDiff.ref,
        kind: "service",
        field: "name",
        reason: isHidden(savedSvc?.name)
          ? "redacted_value"
          : "unsupported_field",
        message:
          "The saved service name is missing or redacted and cannot be reapplied automatically.",
      });
    }
  }

  if (svcFields.has("visible")) {
    const visibleEntries = entries.filter(
      ({ change }) =>
        change.kind === "service_visible" && change.target_ref === svcDiff.ref,
    );
    if (
      attribution === "agent" &&
      verifyScalarChain(
        ctx,
        visibleEntries,
        savedSvc?.visible,
        currentSvc?.visible,
      )
    ) {
      registerUndoEntries(ctx, visibleEntries);
    } else if (typeof savedSvc?.visible === "boolean") {
      addReapply(ctx, {
        entity_ref: svcDiff.ref,
        kind: "service",
        field: "visible",
        attribution,
        from_current: currentSvc?.visible ?? null,
        to_point: savedSvc.visible,
        arguments: {
          operation: "service_visible",
          target_ref: svcDiff.ref,
          value: savedSvc.visible,
          reason: rollbackReason(ctx, "service visibility"),
        },
      });
    } else {
      addNotRestorable(ctx, {
        entity_ref: svcDiff.ref,
        kind: "service",
        field: "visible",
        reason: "unsupported_field",
        message:
          "The saved service visibility flag is unknown and cannot be reapplied automatically.",
      });
    }
  }

  for (const field of svcFields) {
    if (field === "name" || field === "visible") continue;
    addNotRestorable(ctx, {
      entity_ref: svcDiff.ref,
      kind: "service",
      field: String(field),
      reason: "unsupported_field",
      message: `Service field "${field}" cannot be changed through native write tools.`,
    });
  }
}

function planHomeAddedScenario(ctx, item, currentScenario) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0 && currentScenario) {
    const createEntries = entries.filter(
      ({ change }) =>
        change.kind === "block_create" || change.kind === "logic_source_create",
    );
    if (
      createEntries.length === 1 &&
      entries.every((e) => isEligibleApplyEntry(ctx, e)) &&
      createdScenarioMatchesCurrent(
        createEntries[0].change,
        currentScenario,
        ctx.sensitiveValues,
      )
    ) {
      registerUndoEntries(ctx, createEntries);
      return;
    }
  }
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "scenario",
    reason: "scenario_added_externally",
    message:
      "This scenario was added outside an unchanged agent creation and cannot be removed via undo automatically.",
  });
}

function planHomeRemovedScenario(ctx, item) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0) {
    const deleteEntries = entries.filter(
      ({ change }) => change.kind === "scenario_delete",
    );
    if (
      deleteEntries.length === 1 &&
      entries.every((e) => isEligibleApplyEntry(ctx, e))
    ) {
      registerUndoEntries(ctx, deleteEntries);
      return;
    }
  }
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "scenario",
    reason: "scenario_removed_externally",
    message:
      "This scenario was removed outside an undoable agent delete and cannot be restored with its original scenario index automatically.",
  });
}

function planScenarioChanges(ctx, { entityRef, diffItem, saved, current }) {
  const { attribution, entries } = itemDetail(ctx, diffItem);
  if (saved?.predefined === true || current?.predefined === true) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      reason: "predefined_scenario",
      message:
        "Built-in (predefined) SprutHub scenarios are read-only and cannot be changed through native write tools.",
    });
    return;
  }

  const changedFields = new Set(
    (diffItem.changes ?? []).map((diff) => diff.path[0]),
  );
  const scenarioType = saved?.type ?? current?.type ?? diffItem.type;

  // 1. Handle configuration first so LOGIC knows whether code restore covers info fields.
  let logicSourceRestored = false;
  if (changedFields.has("configuration")) {
    if (scenarioType === "BLOCK") {
      planBlockConfigurationChange(ctx, {
        entityRef,
        attribution,
        entries,
        saved,
        current,
      });
    } else if (scenarioType === "LOGIC" || scenarioType === "GLOBAL") {
      logicSourceRestored = planCodeConfigurationChange(ctx, {
        entityRef,
        attribution,
        entries,
        saved,
        current,
        changedFields,
      });
    } else {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "scenario",
        field: "configuration",
        reason: "unsupported_field",
        message: `Configuration for scenario type "${String(scenarioType)}" cannot be restored automatically.`,
      });
    }
  }

  // 2. Handle active flag.
  if (changedFields.has("active")) {
    const activeEntries = entries.filter(
      ({ change }) =>
        change.kind === "scenario_active" && change.target_ref === entityRef,
    );
    if (
      attribution === "agent" &&
      verifyScalarChain(ctx, activeEntries, saved?.active, current?.active)
    ) {
      registerUndoEntries(ctx, activeEntries);
    } else if (typeof saved?.active === "boolean") {
      addReapply(ctx, {
        entity_ref: entityRef,
        kind: "scenario",
        field: "active",
        attribution,
        from_current: current?.active ?? null,
        to_point: saved.active,
        arguments: {
          operation: "scenario_active",
          target_ref: entityRef,
          value: saved.active,
          reason: rollbackReason(ctx, "scenario active state"),
        },
      });
    } else {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "scenario",
        field: "active",
        reason: "unsupported_field",
        message: "The saved scenario active state is unknown.",
      });
    }
  }

  // 3. Handle metadata fields (name, description, on_start, sync).
  const savedLogicInfo =
    scenarioType === "LOGIC" &&
    logicSourceRestored &&
    typeof saved?.configuration?.value === "string"
      ? readLogicInfo(saved.configuration.value)
      : null;

  for (const field of ["name", "description", "on_start", "sync"]) {
    if (!changedFields.has(field)) continue;
    const optionKey = SCENARIO_FIELD_TO_WINDOW_OPTION[field];

    if (scenarioType === "LOGIC" && field !== "sync") {
      const infoKey = LOGIC_FIELD_TO_INFO_KEY[field];
      const coveredByRestoredCode =
        savedLogicInfo &&
        Object.hasOwn(savedLogicInfo.values, infoKey) &&
        isDeepStrictEqual(savedLogicInfo.values[infoKey], saved?.[field]);
      if (!coveredByRestoredCode) {
        addNotRestorable(ctx, {
          entity_ref: entityRef,
          kind: "scenario",
          field,
          reason: "logic_info_in_code",
          message: `A LOGIC scenario's ${field} is controlled by info.${infoKey} in its code and cannot be written via window_option.`,
        });
      }
      continue;
    }

    if (!["BLOCK", "GLOBAL", "LOGIC"].includes(scenarioType)) {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "scenario",
        field,
        reason: "unsupported_field",
        message: `Scenario field "${field}" cannot be changed for type "${String(scenarioType)}".`,
      });
      continue;
    }

    const metaEntries = entries.filter(
      ({ change }) =>
        change.kind === "window_option" &&
        change.owner_kind === "scenario" &&
        change.target_ref === entityRef &&
        change.option_key === optionKey,
    );
    if (
      attribution === "agent" &&
      verifyScalarChain(ctx, metaEntries, saved?.[field], current?.[field])
    ) {
      registerUndoEntries(ctx, metaEntries);
      continue;
    }

    const savedVal = saved?.[field];
    const valid =
      field === "name"
        ? isCleanNonEmptyString(savedVal)
        : field === "description"
          ? isCleanString(savedVal)
          : typeof savedVal === "boolean";
    if (!valid) {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "scenario",
        field,
        reason: isHidden(savedVal) ? "redacted_value" : "unsupported_field",
        message: `Saved scenario ${field} is missing, redacted, or invalid and cannot be reapplied automatically.`,
      });
      continue;
    }

    addReapply(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field,
      attribution,
      from_current: current?.[field] ?? null,
      to_point: savedVal,
      arguments: {
        operation: "window_option",
        target_ref: entityRef,
        option_key: optionKey,
        value: savedVal,
        reason: rollbackReason(ctx, `scenario ${field}`),
      },
    });
  }

  for (const field of changedFields) {
    if (
      [
        "configuration",
        "active",
        "name",
        "description",
        "on_start",
        "sync",
      ].includes(field)
    ) {
      continue;
    }
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: String(field),
      reason: "unsupported_field",
      message: `Scenario field "${field}" cannot be changed through native write tools.`,
    });
  }
}

function planBlockConfigurationChange(
  ctx,
  { entityRef, attribution, entries, saved, current },
) {
  const blockEntries = entries.filter(
    ({ change }) =>
      change.target_ref === entityRef &&
      (change.kind === "block_data_update" ||
        change.kind === "block_action_pause"),
  );
  if (
    attribution === "agent" &&
    verifyBlockChain(
      ctx,
      blockEntries,
      saved?.configuration?.value,
      current?.configuration?.value,
    )
  ) {
    registerUndoEntries(ctx, blockEntries);
    return;
  }

  const savedConfig = saved?.configuration;
  if (savedConfig?.format !== "json" || !isPlainObject(savedConfig.value)) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "unsupported_field",
      message:
        "The saved BLOCK configuration is not valid JSON data and cannot be reapplied automatically.",
    });
    return;
  }
  if (containsHiddenHttpUrl(savedConfig.value)) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "redacted_http_url",
      message:
        "This BLOCK scenario contains an HTTP request URL whose path or query is redacted in the saved point, so it cannot be reapplied automatically without losing the URL.",
    });
    return;
  }
  if (containsRedactedOrHidden(savedConfig.value)) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "redacted_value",
      message:
        "This BLOCK scenario contains redacted sensitive data in the saved point and cannot be reapplied automatically.",
    });
    return;
  }

  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "scenario",
    field: "configuration",
    attribution,
    from_current: current?.configuration?.value ?? null,
    to_point: savedConfig.value,
    arguments: {
      operation: "block_data_update",
      target_ref: entityRef,
      data: structuredClone(savedConfig.value),
      reason: rollbackReason(ctx, "BLOCK scenario data"),
    },
  });
}

function planCodeConfigurationChange(
  ctx,
  { entityRef, attribution, entries, saved, current, changedFields },
) {
  const codeEntries = entries.filter(
    ({ change }) =>
      change.target_ref === entityRef && change.kind === "logic_source_update",
  );
  if (
    attribution === "agent" &&
    verifyLogicSourceChain(ctx, codeEntries, saved, current, changedFields)
  ) {
    registerUndoEntries(ctx, codeEntries);
    return true;
  }

  const savedConfig = saved?.configuration;
  const currentConfig = current?.configuration;
  const validFormat =
    savedConfig?.format === "code" || savedConfig?.format === "javascript";
  if (
    !validFormat ||
    typeof savedConfig?.value !== "string" ||
    savedConfig.value.trim().length === 0
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "redacted_value",
      message:
        "The saved scenario source code is unavailable and cannot be reapplied automatically.",
    });
    return false;
  }
  if (
    isHidden(savedConfig.value) ||
    savedConfig.value.includes("[REDACTED]") ||
    isHidden(currentConfig?.value) ||
    (typeof currentConfig?.value === "string" &&
      currentConfig.value.includes("[REDACTED]"))
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "redacted_value",
      message:
        "This scenario's source code contains redacted credential-shaped text and cannot be rewritten automatically.",
    });
    return false;
  }
  if (hubCodeProblems(savedConfig.value).problems.length > 0) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "unsupported_javascript",
      message:
        "The saved scenario source code contains JavaScript syntax that SprutHub's Nashorn check refuses to write automatically.",
    });
    return false;
  }

  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "scenario",
    field: "configuration",
    attribution,
    from_current: currentConfig?.value ?? null,
    to_point: savedConfig.value,
    arguments: {
      operation: "logic_source_update",
      target_ref: entityRef,
      source: savedConfig.value,
      reason: rollbackReason(ctx, "scenario source code"),
    },
  });
  return true;
}

function planHomeChangedBridge(ctx, item) {
  const { attribution, entries } = itemDetail(ctx, item);

  for (const diff of item.changes ?? []) {
    const field = String(diff.path[0]);
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "bridge",
      field,
      reason: "unsupported_field",
      message: `Bridge field "${field}" cannot be changed through native write tools.`,
    });
  }

  for (const accRef of item.added_exports ?? []) {
    const exportEntries = entries.filter(
      ({ change }) =>
        change.kind === "window_option" &&
        change.bridge_export?.bridge_ref === item.ref &&
        bridgeExportAccessoryRef(change) === accRef,
    );
    if (
      attribution === "agent" &&
      verifyBridgeExportChain(ctx, exportEntries, "added")
    ) {
      registerUndoEntries(ctx, exportEntries);
      continue;
    }
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "bridge",
      field: "added_exports",
      reason: "bridge_export_requires_service_selection",
      message: `Bridge export for ${accRef} cannot be undone automatically because whole-home points track exported accessories rather than per-service checkboxes. Inspect the accessory with get_entity (include: ["bridges"]) and toggle its service via window_option if confirmed.`,
      dedupSuffix: accRef,
    });
  }

  for (const accRef of item.removed_exports ?? []) {
    const exportEntries = entries.filter(
      ({ change }) =>
        change.kind === "window_option" &&
        change.bridge_export?.bridge_ref === item.ref &&
        bridgeExportAccessoryRef(change) === accRef,
    );
    if (
      attribution === "agent" &&
      verifyBridgeExportChain(ctx, exportEntries, "removed")
    ) {
      registerUndoEntries(ctx, exportEntries);
      continue;
    }
    addNotRestorable(ctx, {
      entity_ref: item.ref,
      kind: "bridge",
      field: "removed_exports",
      reason: "bridge_export_requires_service_selection",
      message: `Removed bridge export for ${accRef} cannot be restored automatically because whole-home points track exported accessories rather than per-service checkboxes. Inspect the accessory with get_entity (include: ["bridges"]) and toggle its service via window_option if confirmed.`,
      dedupSuffix: accRef,
    });
  }
}

function planHomeAddedClimate(ctx, item) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (
    attribution === "agent" &&
    entries.some(({ change }) => ctx.undoEntriesById.has(change.id))
  ) {
    return;
  }
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "characteristic",
    reason: "characteristic_added",
    message:
      "This climate setpoint belongs to a device added after the saved point and cannot be removed independently.",
  });
}

function planHomeRemovedClimate(ctx, item) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (
    attribution === "agent" &&
    entries.some(({ change }) => ctx.undoEntriesById.has(change.id))
  ) {
    return;
  }
  addNotRestorable(ctx, {
    entity_ref: item.ref,
    kind: "characteristic",
    reason: "characteristic_removed",
    message:
      "This climate setpoint's device or characteristic no longer exists on the hub and cannot be restored automatically.",
  });
}

function planClimateSetpointChange(
  ctx,
  { entityRef, diffItem, saved, current, accessoryExists },
) {
  const { attribution, entries } = itemDetail(ctx, diffItem);
  const valueEntries = entries.filter(
    ({ change }) =>
      change.kind === "characteristic_value" && change.target_ref === entityRef,
  );
  if (
    attribution === "agent" &&
    verifyScalarChain(ctx, valueEntries, saved?.value, current?.value)
  ) {
    registerUndoEntries(ctx, valueEntries);
    return;
  }
  if (!accessoryExists) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "characteristic",
      field: "value",
      reason: "target_accessory_missing",
      message:
        "The parent accessory for this climate setpoint no longer exists on the hub.",
    });
    return;
  }
  if (!isCleanScalar(saved?.value)) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "characteristic",
      field: "value",
      reason: isHidden(saved?.value) ? "redacted_value" : "unsupported_field",
      message:
        "The saved climate setpoint value is unknown or redacted and cannot be reapplied automatically.",
    });
    return;
  }
  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "characteristic",
    field: "value",
    attribution,
    from_current: current?.value ?? null,
    to_point: saved.value,
    arguments: {
      operation: "characteristic_value",
      target_ref: entityRef,
      value: saved.value,
      reason: rollbackReason(ctx, "climate setpoint"),
    },
  });
}

// --- Selected-entities planning ---

function planSelectedRestore(ctx, point, currentByRef, comparison) {
  const savedByRef = new Map(
    (point.captured ?? []).map((captured) => [captured.entity_ref, captured]),
  );

  for (const entity of comparison.entities ?? []) {
    const saved = savedByRef.get(entity.entity_ref);
    const current = currentByRef.get(entity.entity_ref);

    if (entity.status === "missing") {
      const coveredByUndo = planSelectedMissingEntity(ctx, entity);
      if (!coveredByUndo) {
        addNotRestorable(ctx, {
          entity_ref: entity.entity_ref,
          kind: entity.kind,
          reason: "entity_missing",
          message: `This ${entity.kind} no longer exists on the hub and cannot be restored automatically.`,
        });
      }
      continue;
    }

    if (entity.status === "changed") {
      planSelectedChangedEntity(ctx, entity, saved, current);
    }

    // Account for all per-entity not_compared entries (unchanged, changed, read_error).
    for (const nc of entity.not_compared ?? []) {
      accountNotComparedEntry(ctx, {
        entity_ref: entity.entity_ref,
        kind: entity.kind,
        path: nc.path,
        reason: nc.reason,
      });
    }
  }
}

function planSelectedMissingEntity(ctx, entity) {
  const { attribution, entries } = itemDetail(ctx, entity);
  if (attribution !== "agent" || entries.length === 0) return false;
  const deleteEntries = entries.filter(
    ({ change }) =>
      change.kind === "scenario_delete" ||
      change.kind === "virtual_device_delete",
  );
  if (
    deleteEntries.length === 1 &&
    entries.every((e) => isEligibleApplyEntry(ctx, e))
  ) {
    registerUndoEntries(ctx, deleteEntries);
    return true;
  }
  return false;
}

function planSelectedChangedEntity(ctx, entity, saved, current) {
  const { attribution, entries } = itemDetail(ctx, entity);
  if (entity.kind === "characteristic") {
    const changedTop = new Set(
      (entity.changes ?? []).map((diff) => diff.path[0]),
    );
    if (changedTop.has("value")) {
      planClimateSetpointChange(ctx, {
        entityRef: entity.entity_ref,
        diffItem: entity,
        saved: saved?.settings,
        current: current?.settings,
        accessoryExists: true,
      });
    }
    planOptionMapChanges(ctx, {
      entityRef: entity.entity_ref,
      kind: "characteristic",
      operation: "characteristic_option",
      allowedInputTypes: SCALAR_OPTION_INPUT_TYPES,
      attribution,
      entries,
      changes: (entity.changes ?? []).filter(
        (diff) => diff.path[0] === "options",
      ),
      savedOptions: saved?.settings?.options,
      currentOptions: current?.settings?.options,
    });
    return;
  }

  if (entity.kind === "accessory") {
    const changedFields = new Set(
      (entity.changes ?? []).map((diff) => diff.path[0]),
    );
    if (changedFields.has("name") || changedFields.has("room_ref")) {
      planAccessoryPlacement(ctx, {
        entityRef: entity.entity_ref,
        attribution,
        entries,
        changedFields,
        saved: saved?.settings,
        current: current?.settings,
        currentRooms: null,
      });
    }
    for (const field of changedFields) {
      if (field === "name" || field === "room_ref") continue;
      addNotRestorable(ctx, {
        entity_ref: entity.entity_ref,
        kind: "accessory",
        field: String(field),
        reason: "unsupported_field",
        message: `Accessory field "${field}" cannot be changed through native write tools.`,
      });
    }
    return;
  }

  if (entity.kind === "scenario") {
    planScenarioChanges(ctx, {
      entityRef: entity.entity_ref,
      diffItem: entity,
      saved: saved?.settings,
      current: current?.settings,
    });
    return;
  }

  if (entity.kind === "logic") {
    const changedTop = new Set(
      (entity.changes ?? []).map((diff) => diff.path[0]),
    );
    if (changedTop.has("active")) {
      const activeEntries = entries.filter(
        ({ change }) =>
          change.kind === "logic_active" &&
          change.target_ref === entity.entity_ref,
      );
      if (
        attribution === "agent" &&
        verifyScalarChain(
          ctx,
          activeEntries,
          saved?.settings?.active,
          current?.settings?.active,
        )
      ) {
        registerUndoEntries(ctx, activeEntries);
      } else if (typeof saved?.settings?.active === "boolean") {
        addReapply(ctx, {
          entity_ref: entity.entity_ref,
          kind: "logic",
          field: "active",
          attribution,
          from_current: current?.settings?.active ?? null,
          to_point: saved.settings.active,
          arguments: {
            operation: "logic_active",
            target_ref: entity.entity_ref,
            value: saved.settings.active,
            reason: rollbackReason(ctx, "logic active state"),
          },
        });
      } else {
        addNotRestorable(ctx, {
          entity_ref: entity.entity_ref,
          kind: "logic",
          field: "active",
          reason: "unsupported_field",
          message: "The saved logic active state is unknown.",
        });
      }
    }
    planOptionMapChanges(ctx, {
      entityRef: entity.entity_ref,
      kind: "logic",
      operation: "logic_option",
      allowedInputTypes: SCALAR_OPTION_INPUT_TYPES,
      attribution,
      entries,
      changes: (entity.changes ?? []).filter(
        (diff) => diff.path[0] === "options",
      ),
      savedOptions: saved?.settings?.options,
      currentOptions: current?.settings?.options,
    });
    for (const field of changedTop) {
      if (field === "active" || field === "options") continue;
      addNotRestorable(ctx, {
        entity_ref: entity.entity_ref,
        kind: "logic",
        field: String(field),
        reason: "unsupported_field",
        message: `Logic field "${field}" cannot be changed through native write tools.`,
      });
    }
    return;
  }

  if (entity.kind === "window") {
    let windowKey = null;
    try {
      const parsed = parseEntityRef(entity.entity_ref);
      windowKey = parsed.kind === "window" ? parsed.windowKey : null;
    } catch {
      windowKey = null;
    }
    planOptionMapChanges(ctx, {
      entityRef: entity.entity_ref,
      kind: "window",
      operation: "window_option",
      allowedInputTypes: WINDOW_OPTION_INPUT_TYPES,
      windowKey,
      attribution,
      entries,
      changes: (entity.changes ?? []).filter(
        (diff) => diff.path[0] === "options",
      ),
      savedOptions: saved?.settings?.options,
      currentOptions: current?.settings?.options,
    });
    for (const diff of entity.changes ?? []) {
      if (diff.path[0] === "options") continue;
      addNotRestorable(ctx, {
        entity_ref: entity.entity_ref,
        kind: "window",
        field: String(diff.path[0]),
        reason: "unsupported_field",
        message: `Window field "${diff.path[0]}" cannot be changed through native write tools.`,
      });
    }
  }
}

function planOptionMapChanges(
  ctx,
  {
    entityRef,
    kind,
    operation,
    allowedInputTypes,
    windowKey = null,
    attribution,
    entries,
    changes,
    savedOptions,
    currentOptions,
  },
) {
  const seenKeys = new Set();
  for (const diff of changes) {
    const optionKey = typeof diff.path[1] === "string" ? diff.path[1] : null;
    if (!optionKey || seenKeys.has(optionKey)) continue;
    seenKeys.add(optionKey);

    const field = `options.${optionKey}`;
    const savedOpt = isPlainObject(savedOptions)
      ? savedOptions[optionKey]
      : undefined;
    const currentOpt = isPlainObject(currentOptions)
      ? currentOptions[optionKey]
      : undefined;

    if (
      diff.path.length !== 3 ||
      diff.path[2] !== "configured_value" ||
      !isPlainObject(savedOpt) ||
      !isPlainObject(currentOpt)
    ) {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind,
        field,
        reason: "unsupported_field",
        message: `Option "${optionKey}" was added, removed, or changed schema and cannot be reapplied automatically.`,
      });
      continue;
    }

    const optEntries = entries.filter(
      ({ change }) =>
        change.kind === operation &&
        (change.target_ref === entityRef || change.window_ref === entityRef) &&
        change.option_key === optionKey,
    );
    if (
      attribution === "agent" &&
      verifyScalarChain(
        ctx,
        optEntries,
        savedOpt.configured_value,
        currentOpt.configured_value,
      )
    ) {
      registerUndoEntries(ctx, optEntries);
      continue;
    }

    if (
      isHidden(savedOpt) ||
      isHidden(savedOpt.configured_value) ||
      isSensitiveNativeNode({ ...savedOpt, key: optionKey }) ||
      isSensitiveNativeNode({ ...currentOpt, key: optionKey })
    ) {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind,
        field,
        reason: "redacted_value",
        message: `Option "${optionKey}" holds sensitive or redacted data and cannot be written automatically.`,
      });
      continue;
    }

    if (operation === "window_option") {
      if (windowKey === null || windowKey === "") {
        addNotRestorable(ctx, {
          entity_ref: entityRef,
          kind,
          field,
          reason: "unsupported_field",
          message:
            "Home settings window options are read-only and cannot be changed through native write tools.",
        });
        continue;
      }
      if (
        windowKey.startsWith("Scenario/") &&
        !isTelegramWindowKey(windowKey) &&
        SCENARIO_WINDOW_RESERVED_KEYS.has(optionKey)
      ) {
        addNotRestorable(ctx, {
          entity_ref: entityRef,
          kind,
          field,
          reason: "scenario_owner_required",
          message: `Scenario option "${optionKey}" must be restored through the owning scenario ref rather than its raw window ref.`,
        });
        continue;
      }
    }

    if (
      !allowedInputTypes.has(savedOpt.input_type) ||
      savedOpt.input_type !== currentOpt.input_type ||
      savedOpt.type !== currentOpt.type ||
      !isCleanScalar(savedOpt.configured_value)
    ) {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind,
        field,
        reason: "unsupported_option",
        message: `Option "${optionKey}" (${String(savedOpt.input_type)}) does not match a writable scalar option contract.`,
      });
      continue;
    }

    if (
      operation === "window_option" &&
      savedOpt.input_type === "TEXT" &&
      isAllowedTelegramTextOption(windowKey, optionKey)
    ) {
      try {
        validateTelegramTextOptionValue(
          windowKey,
          optionKey,
          savedOpt.configured_value,
        );
      } catch {
        addNotRestorable(ctx, {
          entity_ref: entityRef,
          kind,
          field,
          reason: "invalid_option_value",
          message: `Saved Telegram text option "${optionKey}" fails validation and cannot be reapplied automatically.`,
        });
        continue;
      }
    }

    addReapply(ctx, {
      entity_ref: entityRef,
      kind,
      field,
      attribution,
      from_current: currentOpt.configured_value,
      to_point: savedOpt.configured_value,
      arguments: {
        operation,
        target_ref: entityRef,
        option_key: optionKey,
        value: savedOpt.configured_value,
        reason: rollbackReason(ctx, `${kind} option ${optionKey}`),
      },
    });
  }
}

// --- Chain integrity verifiers ---

function verifyScalarChain(ctx, entries, savedValue, currentValue) {
  if (entries.length === 0) return false;
  if (!entries.every((e) => isEligibleApplyEntry(ctx, e))) return false;
  const newest = entries[0].change;
  if (
    !newest.requested_value ||
    !Object.hasOwn(newest.requested_value, "value") ||
    !isDeepStrictEqual(newest.requested_value.value, currentValue)
  ) {
    return false;
  }
  for (let index = 0; index < entries.length - 1; index += 1) {
    const newerBase = entries[index].change.baseline_value;
    const olderReq = entries[index + 1].change.requested_value;
    if (
      !newerBase ||
      !olderReq ||
      !Object.hasOwn(newerBase, "value") ||
      !Object.hasOwn(olderReq, "value") ||
      !isDeepStrictEqual(newerBase.value, olderReq.value)
    ) {
      return false;
    }
  }
  const oldest = entries.at(-1).change;
  if (
    !oldest.baseline_value ||
    !Object.hasOwn(oldest.baseline_value, "value") ||
    !isDeepStrictEqual(oldest.baseline_value.value, savedValue)
  ) {
    return false;
  }
  return true;
}

function verifyPlacementChain(ctx, entries, saved, current, currentRooms) {
  if (entries.length === 0 || !saved || !current) return false;
  if (!entries.every((e) => isEligibleApplyEntry(ctx, e))) return false;

  const newestSnap =
    entries[0].change.applied_snapshot ?? entries[0].change.requested_snapshot;
  if (
    !newestSnap ||
    newestSnap.name !== current.name ||
    typeof newestSnap.room_id !== "number" ||
    roomRef(ctx.serial, newestSnap.room_id) !== current.room_ref
  ) {
    return false;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const base = entries[index].change.baseline_snapshot;
    if (!base || typeof base.room_id !== "number") return false;
    if (currentRooms && !currentRooms.has(roomRef(ctx.serial, base.room_id))) {
      return false;
    }
    if (index < entries.length - 1) {
      const olderSnap =
        entries[index + 1].change.applied_snapshot ??
        entries[index + 1].change.requested_snapshot;
      if (
        !olderSnap ||
        base.name !== olderSnap.name ||
        base.room_id !== olderSnap.room_id
      ) {
        return false;
      }
    }
  }

  const oldestBase = entries.at(-1).change.baseline_snapshot;
  return (
    oldestBase.name === saved.name &&
    roomRef(ctx.serial, oldestBase.room_id) === saved.room_ref
  );
}

function verifyBlockChain(ctx, entries, savedData, currentData) {
  if (
    entries.length === 0 ||
    !isPlainObject(savedData) ||
    !isPlainObject(currentData)
  ) {
    return false;
  }
  if (!entries.every((e) => isEligibleApplyEntry(ctx, e))) return false;
  const newestRaw =
    entries[0].change.applied_snapshot?.data ??
    entries[0].change.requested_snapshot?.data;
  if (!blockDataEquals(newestRaw, currentData)) return false;

  for (let index = 0; index < entries.length - 1; index += 1) {
    const newerBase = entries[index].change.baseline_snapshot?.data;
    const olderResult =
      entries[index + 1].change.applied_snapshot?.data ??
      entries[index + 1].change.requested_snapshot?.data;
    if (!blockDataEquals(newerBase, olderResult)) return false;
  }
  const oldestBase = entries.at(-1).change.baseline_snapshot?.data;
  return blockDataEquals(oldestBase, savedData);
}

function verifyLogicSourceChain(ctx, entries, saved, current, changedFields) {
  if (entries.length === 0) return false;
  if (!entries.every((e) => isEligibleApplyEntry(ctx, e))) return false;
  const savedCode = saved?.configuration?.value;
  const currentCode = current?.configuration?.value;
  if (
    typeof savedCode !== "string" ||
    typeof currentCode !== "string" ||
    isHidden(savedCode) ||
    isHidden(currentCode)
  ) {
    return false;
  }
  const newest = entries[0].change;
  const newestSnap = newest.applied_snapshot ?? newest.requested_snapshot;
  if (
    sanitizeCodeForCompare(newestSnap?.data, ctx.sensitiveValues) !==
    currentCode
  ) {
    return false;
  }
  for (let index = 0; index < entries.length - 1; index += 1) {
    const newerBase = entries[index].change.baseline_snapshot?.data;
    const olderSnap =
      entries[index + 1].change.applied_snapshot ??
      entries[index + 1].change.requested_snapshot;
    if (typeof newerBase !== "string" || newerBase !== olderSnap?.data) {
      return false;
    }
  }
  const oldestBase = entries.at(-1).change.baseline_snapshot;
  if (
    sanitizeCodeForCompare(oldestBase?.data, ctx.sensitiveValues) !== savedCode
  ) {
    return false;
  }
  if (saved?.type === "LOGIC") {
    for (const field of ["name", "description", "on_start"]) {
      if (!changedFields.has(field)) continue;
      const nativeKey = LOGIC_FIELD_TO_NATIVE_SNAPSHOT_KEY[field];
      if (
        !isDeepStrictEqual(oldestBase?.[nativeKey], saved?.[field]) ||
        !isDeepStrictEqual(newestSnap?.[nativeKey], current?.[field])
      ) {
        return false;
      }
    }
  }
  return true;
}

function verifyBridgeExportChain(ctx, entries, direction) {
  if (entries.length === 0) return false;
  if (!entries.every((e) => isEligibleApplyEntry(ctx, e))) return false;

  const byKey = new Map();
  for (const entry of entries) {
    const key = entry.change.option_key;
    if (typeof key !== "string" || key.length === 0) return false;
    const list = byKey.get(key) ?? [];
    list.push(entry);
    byKey.set(key, list);
  }

  let matchedDirection = false;
  const expectedFinal = direction === "added";
  const expectedSaved = !expectedFinal;
  for (const chain of byKey.values()) {
    const newestVal = chain[0].change.requested_value?.value;
    const oldestBase = chain.at(-1).change.baseline_value?.value;
    if (typeof newestVal !== "boolean" || typeof oldestBase !== "boolean") {
      return false;
    }
    if (!verifyScalarChain(ctx, chain, oldestBase, newestVal)) return false;
    if (direction === "added" && oldestBase !== false) return false;
    if (direction === "removed" && newestVal !== false) return false;
    if (newestVal === expectedFinal && oldestBase === expectedSaved) {
      matchedDirection = true;
    }
  }
  return matchedDirection;
}

function createdScenarioMatchesCurrent(
  change,
  currentScenario,
  sensitiveValues,
) {
  const applied = change.applied_snapshot;
  if (!applied) return false;
  if (
    applied.name !== currentScenario.name ||
    (applied.desc ?? null) !== (currentScenario.description ?? null) ||
    applied.onStart !== currentScenario.on_start ||
    applied.sync !== currentScenario.sync
  ) {
    return false;
  }
  if (change.kind === "block_create") {
    return blockDataEquals(applied.data, currentScenario.configuration?.value);
  }
  return (
    sanitizeCodeForCompare(applied.data, sensitiveValues) ===
    currentScenario.configuration?.value
  );
}

// --- not_compared accounting ---

function accountNotComparedEntry(ctx, entry) {
  const entityRef = entry.entity_ref;
  const kind = entry.kind ?? "entity";
  if (typeof entityRef !== "string") return;

  const field = notComparedPathToField(entry.path);
  if (hasNotRestorableFor(ctx, entityRef, kind, field)) return;

  const isRedacted = entry.reason === "redacted";
  const isHttpUrl =
    isRedacted &&
    kind === "scenario" &&
    Array.isArray(entry.path) &&
    entry.path[0] === "configuration" &&
    entry.path.at(-1) === "url";
  const reason = isHttpUrl
    ? "redacted_http_url"
    : isRedacted
      ? "redacted_value"
      : "not_compared";
  const message = isHttpUrl
    ? "This scenario contains an HTTP request URL whose path or query is redacted and was not compared; it cannot be restored automatically."
    : isRedacted
      ? `This ${kind}${field ? ` (${field})` : ""} holds redacted sensitive data that was not compared and cannot be restored automatically.`
      : `This ${kind}${field ? ` (${field})` : ""} could not be compared (${entry.reason ?? "unavailable"}) and cannot be restored automatically.`;

  addNotRestorable(ctx, {
    entity_ref: entityRef,
    kind,
    ...(field !== undefined ? { field } : {}),
    reason,
    message,
  });
}

function notComparedPathToField(path) {
  if (!Array.isArray(path) || path.length === 0) return undefined;
  if (path[0] === "configuration") return "configuration";
  if (path[0] === "options" && typeof path[1] === "string") {
    return `options.${path[1]}`;
  }
  return path.map(String).join(".");
}

// --- Batching, sorting & guidance ---

function buildUndoBatches(undoEntriesById, sensitiveValues) {
  const sorted = [...undoEntriesById.values()].sort(
    (left, right) =>
      right.eventMs - left.eventMs ||
      compareApplication(right.change, left.change) ||
      right.change.id.localeCompare(left.change.id),
  );
  const batches = [];
  for (let start = 0; start < sorted.length; start += UNDO_BATCH_LIMIT) {
    const slice = sorted.slice(start, start + UNDO_BATCH_LIMIT);
    batches.push({
      batch_index: batches.length,
      tool: "restore_native_change",
      arguments: {
        change_refs: slice.map(
          ({ change }) => `spruthub-change://native/${change.id}`,
        ),
      },
      changes: slice.map(({ change }) =>
        summarizeUndoChange(change, sensitiveValues),
      ),
    });
  }
  return batches;
}

function summarizeUndoChange(change, sensitiveValues) {
  const rawName = changeName(change);
  const name =
    typeof rawName === "string" && rawName.length > 0
      ? sanitizeAgentOutput(rawName, sensitiveValues)
      : undefined;
  const reason =
    typeof change.reason === "string" && change.reason.length > 0
      ? sanitizeAgentOutput(change.reason, sensitiveValues)
      : undefined;
  const appliedAt = applicationTime(change);
  return {
    change_ref: `spruthub-change://native/${change.id}`,
    operation: changeOperation(change),
    target_ref: change.target_ref,
    ...(name ? { name } : {}),
    ...(reason ? { reason } : {}),
    ...(typeof appliedAt === "string" && appliedAt.length > 0
      ? { applied_at: appliedAt }
      : {}),
  };
}

function buildTellOwner({
  attributionUnavailable,
  manualOverrideCount,
  notRestorableCount,
}) {
  const parts = [];
  if (attributionUnavailable) {
    parts.push(
      "The local agent change journal could not be read, so agent and manual edits cannot be distinguished.",
    );
  }
  if (manualOverrideCount > 0) {
    parts.push(
      `${manualOverrideCount} setting(s) in reapply_from_point were edited manually/externally (or modified after the agent) and would be overwritten.`,
    );
  }
  if (notRestorableCount > 0) {
    parts.push(
      `${notRestorableCount} item(s) in not_restorable cannot be rolled back automatically.`,
    );
  }
  parts.push(
    "Confirm with the owner before running any restore_native_change or prepare_native_change/apply_native_change write calls.",
  );
  return parts.join(" ");
}

// --- Pure value helpers ---

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

function blockDataEquals(leftRaw, rightRaw) {
  const left = parseBlockData(leftRaw);
  const right = parseBlockData(rightRaw);
  if (!left || !right) return false;
  return isDeepStrictEqual(
    canonicalBlock(withHiddenHttpUrls(left)),
    canonicalBlock(withHiddenHttpUrls(right)),
  );
}

function sanitizeCodeForCompare(raw, sensitiveValues) {
  if (typeof raw !== "string") return null;
  const hasSecret = sensitiveValues.some(
    (secret) => secret.length > 0 && raw.includes(secret),
  );
  return hasSecret
    ? "[REDACTED]"
    : redactSensitiveText(raw, "javascript_source");
}

function containsHiddenHttpUrl(value) {
  if (Array.isArray(value)) return value.some(containsHiddenHttpUrl);
  if (!isPlainObject(value)) return false;
  if (
    value.type === "http" &&
    (isHidden(value.url) ||
      typeof value.url !== "string" ||
      httpUrlHidden(value.url))
  ) {
    return true;
  }
  return Object.values(value).some(containsHiddenHttpUrl);
}

function containsRedactedOrHidden(value) {
  if (isHidden(value)) return true;
  if (typeof value === "string") return value.includes("[REDACTED]");
  if (Array.isArray(value)) return value.some(containsRedactedOrHidden);
  if (isPlainObject(value)) {
    return Object.values(value).some(containsRedactedOrHidden);
  }
  return false;
}

function isCleanString(value) {
  return (
    typeof value === "string" &&
    !isHidden(value) &&
    !value.includes("[REDACTED]")
  );
}

function isCleanNonEmptyString(value) {
  return isCleanString(value) && value.trim().length > 0;
}

function isCleanScalar(value) {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    isCleanString(value)
  );
}

function validateRoomNameForPlan(rawName) {
  const trimmed = rawName.trim();
  try {
    return { ok: true, name: roomNameWithinLimit(trimmed) };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code ?? "invalid_room_name",
      message:
        error?.message ??
        "The saved room name exceeds SprutHub's room name constraints and cannot be reapplied automatically.",
    };
  }
}

function sanitizeDisplayValue(value, sensitiveValues) {
  return sanitizeAgentOutput(value, sensitiveValues);
}
