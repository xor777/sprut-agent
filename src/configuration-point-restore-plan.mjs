import { isDeepStrictEqual } from "node:util";
import {
  blockAffectedRefs,
  blockDataHasTrigger,
  blockScenarioTargets,
  canonicalBlock,
  httpUrlHidden,
  isActionPath,
  visitKnownBlockNodes,
  withHiddenHttpUrls,
} from "./block-model.mjs";
import {
  applicationTime,
  changeAppliedAt,
  compareApplication,
  summaryRestoreSupported,
} from "./change-history.mjs";
import { changeName } from "./change-restore.mjs";
import { isHidden, isPlainObject } from "./home-configuration-point.mjs";
import { hubCodeProblems } from "./hub-code.mjs";
import {
  changeOperation,
  expectedAppliedKeys,
  incomingLinks,
  LIGHT_GROUP_MEMBERS,
  linkKeys,
  sameKeys,
} from "./light-group-members.mjs";
import { readLogicInfo } from "./logic-info.mjs";
import {
  isAllowedTelegramTextOption,
  isTelegramWindowKey,
} from "./native-option-contract.mjs";
import { roomNameWithinLimit } from "./native-values.mjs";
import {
  accessoryMentions,
  homeRef as homeRefOf,
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

const SCENARIO_METADATA_KEYS = new Set(["Name", "Desc", "OnStart", "Sync"]);

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
  currentRooms = null,
  currentAccessoryIds = null,
  currentScenarioIndexes = null,
  scenarioOptionsWindows = null,
  liveVirtualLightGroups = null,
}) {
  const coverage =
    comparison.coverage === "home" ? "home" : "selected_entities";
  const shortPointId =
    typeof point?.id === "string" && point.id.length > 0
      ? point.id.slice(0, 8)
      : "saved";

  const homeCurrentRooms =
    coverage === "home" && currentSnapshot
      ? new Map(currentSnapshot.rooms.map((room) => [room.ref, room]))
      : currentRooms;
  const homeCurrentAccessoryIds =
    coverage === "home" && currentSnapshot
      ? new Set(currentSnapshot.accessories.map(({ id }) => id))
      : currentAccessoryIds;
  const homeCurrentScenarioIndexes =
    coverage === "home" && currentSnapshot
      ? buildHomeScenarioIndexSet(currentSnapshot, comparison)
      : currentScenarioIndexes;

  const ctx = {
    pointRef,
    shortPointId,
    coverage,
    serial,
    sensitiveValues,
    captureStartedMs: Date.parse(point?.capture_started_at ?? ""),
    attributionUnavailable: comparison.attribution_unavailable === true,
    attributionDetails: attributionDetails ?? new Map(),
    taintedChangeIds: collectTaintedChangeIds(comparison, attributionDetails),
    currentRooms: homeCurrentRooms,
    currentAccessoryIds: homeCurrentAccessoryIds,
    currentScenarioIndexes: homeCurrentScenarioIndexes,
    scenarioOptionsWindows,
    liveVirtualLightGroups: liveVirtualLightGroups ?? new Map(),
    undoEntriesById: new Map(),
    reapply: [],
    notRestorable: [],
    notRestorableKeys: new Set(),
    removedByUndoAccessories: new Set(),
    movedOutByUndoAccessories: new Set(),
    undoneRemovedScenarios: new Map(),
    undoneConfigScenarios: new Map(),
    undoneAddedBridgeExports: new Map(),
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
    manual_override_warning = true,
    displayRole = "data",
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
    manual_override_warning: manual_override_warning !== false,
    from_current: sanitizeDisplayValue(
      from_current,
      ctx.sensitiveValues,
      displayRole,
    ),
    to_point: sanitizeDisplayValue(to_point, ctx.sensitiveValues, displayRole),
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

  // 1. Scenarios first (so accessories.added knows which scenario dependencies are undone).
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

  // 2. Bridges next (so accessories.added knows which bridge exports are undone).
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

  // 3. Accessories (after scenarios/bridges, before rooms.added).
  for (const item of comparison.accessories.added) {
    planHomeAddedAccessory(ctx, item, currentSnapshot);
  }
  for (const item of comparison.accessories.removed) {
    planHomeRemovedAccessory(ctx, item, currentRooms);
  }
  for (const item of comparison.accessories.changed) {
    const saved = savedAccessories.get(item.ref);
    const current = currentAccessories.get(item.ref);
    planHomeChangedAccessory(ctx, item, saved, current, currentRooms);
  }

  // 4. Rooms (after accessories so room_create checks emptiness accurately).
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
      accessoryExists: currentAccessories.has(
        item.ref ? item.accessory_ref : "",
      ),
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
    const active = extractEligibleApplyEntries(ctx, entries);
    const createEntries = (active ?? []).filter(
      ({ change }) => change.kind === "room_create",
    );
    if (active && createEntries.length === 1 && active.length === 1) {
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
    const undoChain =
      attribution === "agent"
        ? verifyScalarChain(ctx, nameEntries, saved?.name, current?.name)
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
    } else if (isCleanNonEmptyString(saved?.name)) {
      const validName = validateRoomNameForPlan(saved.name);
      if (validName.ok) {
        const pureRestore = isPureAgentRestoreTransitionScalar(
          ctx,
          attribution,
          nameEntries,
          saved.name,
          current?.name,
        );
        addReapply(ctx, {
          entity_ref: item.ref,
          kind: "room",
          field: "name",
          attribution,
          manual_override_warning: !pureRestore,
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

function planHomeAddedAccessory(ctx, item, currentSnapshot) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0) {
    const createEntries = entries.filter(
      ({ change }) =>
        change.kind === "virtual_device" ||
        change.kind === "virtual_light_group",
    );
    const memberEntries = entries.filter(
      ({ change }) => change.kind === LIGHT_GROUP_MEMBERS,
    );
    const otherActive = entries.filter(
      (entry) =>
        entry.change?.kind !== "virtual_device" &&
        entry.change?.kind !== "virtual_light_group" &&
        entry.change?.kind !== LIGHT_GROUP_MEMBERS &&
        entry.change?.status !== "restored",
    );
    if (
      createEntries.length === 1 &&
      otherActive.length === 0 &&
      isEligibleApplyEntry(ctx, createEntries[0])
    ) {
      const createEntry = createEntries[0];
      const { change } = createEntry;
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
        if (
          hasBlockingVirtualDeviceDependency(
            ctx,
            item,
            createEntry.eventMs,
            currentSnapshot,
          )
        ) {
          addNotRestorable(ctx, {
            entity_ref: item.ref,
            kind: "accessory",
            reason: "virtual_device_in_use",
            message:
              "This agent-created virtual device is referenced by a live scenario or exported to a bridge that is not removed before undo, so deleting it automatically would fail with virtual_device_in_use.",
          });
          return;
        }
        if (change.kind === "virtual_device") {
          if (memberEntries.length === 0) {
            registerUndoEntries(ctx, [createEntry]);
            ctx.removedByUndoAccessories.add(item.ref);
            return;
          }
        } else {
          const groupUndoChain = verifyVirtualLightGroupUndoChain(
            ctx,
            createEntry,
            memberEntries,
            item,
          );
          if (groupUndoChain) {
            registerUndoEntries(ctx, groupUndoChain);
            ctx.removedByUndoAccessories.add(item.ref);
            return;
          }
          addNotRestorable(ctx, {
            entity_ref: item.ref,
            kind: "accessory",
            reason: "virtual_light_group_modified",
            message:
              "This agent-created virtual light group has link or member changes that cannot be undone cleanly back to its initial state.",
          });
          return;
        }
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

function planHomeRemovedAccessory(ctx, item, currentRooms) {
  const { attribution, entries } = itemDetail(ctx, item);
  if (attribution === "agent" && entries.length > 0) {
    const active = extractEligibleApplyEntries(ctx, entries);
    const deleteEntries = (active ?? []).filter(
      ({ change }) => change.kind === "virtual_device_delete",
    );
    if (active && deleteEntries.length === 1 && active.length === 1) {
      const baseRoomId =
        deleteEntries[0].change.baseline_snapshot?.room_id ??
        deleteEntries[0].change.room_id;
      if (!roomIdExists(currentRooms, ctx.serial, baseRoomId)) {
        addNotRestorable(ctx, {
          entity_ref: item.ref,
          kind: "accessory",
          reason: "target_room_missing",
          message:
            "The room this deleted virtual device belonged to no longer exists on the hub, so virtual_device_delete cannot be undone automatically.",
        });
        return;
      }
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
  const undoChain =
    attribution === "agent"
      ? verifyPlacementChain(
          ctx,
          placementEntries,
          saved,
          current,
          currentRooms,
        )
      : null;
  if (undoChain) {
    registerUndoEntries(ctx, undoChain);
    if (changedFields.has("room_ref")) {
      ctx.movedOutByUndoAccessories.add(entityRef);
    }
    return;
  }

  const nameChanged = changedFields.has("name");
  const roomChanged = changedFields.has("room_ref");

  let canRestoreRoom = false;
  if (roomChanged) {
    if (currentRooms?.unavailable) {
      addNotRestorable(ctx, {
        entity_ref: entityRef,
        kind: "accessory",
        field: "room_ref",
        reason: "not_compared",
        message:
          "Live rooms could not be read from the hub to verify the saved destination room, so accessory placement cannot be planned safely.",
      });
    } else if (
      typeof saved?.room_ref === "string" &&
      roomRefExists(currentRooms, saved.room_ref)
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
    currentRooms?.unavailable ||
    !roomRefExists(currentRooms, targetRoomRef)
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "accessory",
      field: canRestoreName ? "name" : "room_ref",
      reason: currentRooms?.unavailable
        ? "not_compared"
        : "target_room_missing",
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

  const pureRestore = isPureAgentRestoreTransitionPlacement(
    ctx,
    attribution,
    placementEntries,
    saved,
    current,
  );
  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "accessory",
    field,
    attribution,
    manual_override_warning: !pureRestore,
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
    const undoChain =
      attribution === "agent"
        ? verifyScalarChain(ctx, nameEntries, savedSvc?.name, currentSvc?.name)
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
    } else if (isCleanNonEmptyString(savedSvc?.name)) {
      const pureRestore = isPureAgentRestoreTransitionScalar(
        ctx,
        attribution,
        nameEntries,
        savedSvc.name,
        currentSvc?.name,
      );
      addReapply(ctx, {
        entity_ref: svcDiff.ref,
        kind: "service",
        field: "name",
        attribution,
        manual_override_warning: !pureRestore,
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
    const undoChain =
      attribution === "agent"
        ? verifyScalarChain(
            ctx,
            visibleEntries,
            savedSvc?.visible,
            currentSvc?.visible,
          )
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
    } else if (typeof savedSvc?.visible === "boolean") {
      const pureRestore = isPureAgentRestoreTransitionScalar(
        ctx,
        attribution,
        visibleEntries,
        savedSvc.visible,
        currentSvc?.visible,
      );
      addReapply(ctx, {
        entity_ref: svcDiff.ref,
        kind: "service",
        field: "visible",
        attribution,
        manual_override_warning: !pureRestore,
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
    const active = extractEligibleApplyEntries(ctx, entries);
    const createEntries = (active ?? []).filter(
      ({ change }) =>
        change.kind === "block_create" || change.kind === "logic_source_create",
    );
    if (
      active &&
      createEntries.length === 1 &&
      active.length === 1 &&
      createdScenarioMatchesCurrent(
        createEntries[0].change,
        currentScenario,
        ctx.sensitiveValues,
      )
    ) {
      registerUndoEntries(ctx, createEntries);
      ctx.undoneRemovedScenarios.set(item.ref, createEntries[0].eventMs);
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
    const active = extractEligibleApplyEntries(ctx, entries);
    const deleteEntries = (active ?? []).filter(
      ({ change }) => change.kind === "scenario_delete",
    );
    if (active && deleteEntries.length === 1 && active.length === 1) {
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
    const undoChain =
      attribution === "agent"
        ? verifyScalarChain(ctx, activeEntries, saved?.active, current?.active)
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
    } else if (typeof saved?.active === "boolean") {
      const pureRestore = isPureAgentRestoreTransitionScalar(
        ctx,
        attribution,
        activeEntries,
        saved.active,
        current?.active,
      );
      addReapply(ctx, {
        entity_ref: entityRef,
        kind: "scenario",
        field: "active",
        attribution,
        manual_override_warning: !pureRestore,
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
    const metaUndoChain =
      attribution === "agent"
        ? verifyScalarChain(ctx, metaEntries, saved?.[field], current?.[field])
        : null;
    if (metaUndoChain) {
      registerUndoEntries(ctx, metaUndoChain);
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

    const pureRestore = isPureAgentRestoreTransitionScalar(
      ctx,
      attribution,
      metaEntries,
      savedVal,
      current?.[field],
    );
    addReapply(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field,
      attribution,
      manual_override_warning: !pureRestore,
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
  const undoChain =
    attribution === "agent"
      ? verifyBlockChain(
          ctx,
          blockEntries,
          saved?.configuration?.value,
          current?.configuration?.value,
        )
      : null;
  if (undoChain) {
    registerUndoEntries(ctx, undoChain);
    ctx.undoneConfigScenarios.set(entityRef, {
      savedScenario: saved,
      minEventMs: Math.min(...undoChain.map((entry) => entry.eventMs)),
    });
    return;
  }

  const savedConfig = saved?.configuration;
  const currentConfig = current?.configuration;
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
  if (
    containsHiddenHttpUrl(savedConfig.value) ||
    containsHiddenHttpUrl(currentConfig?.value)
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "redacted_http_url",
      message:
        "This BLOCK scenario contains an HTTP request URL whose path or query is redacted, so it cannot be restored automatically without risking URL loss.",
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
  if (
    isPlainObject(currentConfig?.value) &&
    blockDataHasTrigger(currentConfig.value) &&
    !blockDataHasTrigger(savedConfig.value)
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "block_would_remove_last_trigger",
      message:
        "The saved BLOCK has no triggers while the current BLOCK is triggered; prepare_native_change refuses to remove the last trigger automatically.",
    });
    return;
  }
  const blockProblem = validateSavedBlockForReapply(ctx, savedConfig.value);
  if (blockProblem) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: blockProblem.reason,
      message: blockProblem.message,
    });
    return;
  }

  const pureRestore = isPureAgentRestoreTransitionBlock(
    ctx,
    attribution,
    blockEntries,
    savedConfig.value,
    currentConfig?.value,
  );
  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "scenario",
    field: "configuration",
    attribution,
    manual_override_warning: !pureRestore,
    from_current: currentConfig?.value ?? null,
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
  const undoChain =
    attribution === "agent"
      ? verifyLogicSourceChain(ctx, codeEntries, saved, current, changedFields)
      : null;
  if (undoChain) {
    registerUndoEntries(ctx, undoChain);
    ctx.undoneConfigScenarios.set(entityRef, {
      savedScenario: saved,
      minEventMs: Math.min(...undoChain.map((entry) => entry.eventMs)),
    });
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
  const sanitizedSaved = sanitizeCodeForCompare(
    savedConfig.value,
    ctx.sensitiveValues,
  );
  const sanitizedCurrent =
    typeof currentConfig?.value === "string"
      ? sanitizeCodeForCompare(currentConfig.value, ctx.sensitiveValues)
      : null;
  if (
    isHidden(savedConfig.value) ||
    savedConfig.value.includes("[REDACTED]") ||
    sanitizedSaved !== savedConfig.value ||
    sanitizedSaved.includes("[REDACTED]") ||
    isHidden(currentConfig?.value) ||
    (typeof currentConfig?.value === "string" &&
      (currentConfig.value.includes("[REDACTED]") ||
        sanitizedCurrent !== currentConfig.value ||
        sanitizedCurrent.includes("[REDACTED]")))
  ) {
    addNotRestorable(ctx, {
      entity_ref: entityRef,
      kind: "scenario",
      field: "configuration",
      reason: "redacted_value",
      message:
        "This scenario's source code contains redacted credential-shaped text or connection secrets and cannot be rewritten automatically.",
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

  const pureRestore = isPureAgentRestoreTransitionLogicSource(
    ctx,
    attribution,
    codeEntries,
    saved,
    current,
    changedFields,
  );
  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "scenario",
    field: "configuration",
    attribution,
    manual_override_warning: !pureRestore,
    displayRole: "javascript_source",
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
    const undoChain =
      attribution === "agent"
        ? verifyBridgeExportChain(ctx, exportEntries, "added")
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
      ctx.undoneAddedBridgeExports.set(
        `${item.ref}\0${accRef}`,
        Math.min(...undoChain.map((entry) => entry.eventMs)),
      );
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
    const undoChain =
      attribution === "agent"
        ? verifyBridgeExportChain(ctx, exportEntries, "removed")
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
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
  const undoChain =
    attribution === "agent"
      ? verifyScalarChain(ctx, valueEntries, saved?.value, current?.value)
      : null;
  if (undoChain) {
    registerUndoEntries(ctx, undoChain);
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
  const pureRestore = isPureAgentRestoreTransitionScalar(
    ctx,
    attribution,
    valueEntries,
    saved.value,
    current?.value,
  );
  addReapply(ctx, {
    entity_ref: entityRef,
    kind: "characteristic",
    field: "value",
    attribution,
    manual_override_warning: !pureRestore,
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
      planSelectedMissingEntity(ctx, entity);
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
  if (
    entity.kind === "scenario" &&
    attribution === "agent" &&
    entries.length > 0
  ) {
    const active = extractEligibleApplyEntries(ctx, entries);
    const deleteEntries = (active ?? []).filter(
      ({ change }) => change.kind === "scenario_delete",
    );
    if (active && deleteEntries.length === 1 && active.length === 1) {
      registerUndoEntries(ctx, deleteEntries);
      return;
    }
  }
  if (
    entity.kind === "accessory" &&
    attribution === "agent" &&
    entries.length > 0
  ) {
    const active = extractEligibleApplyEntries(ctx, entries);
    const deleteEntries = (active ?? []).filter(
      ({ change }) => change.kind === "virtual_device_delete",
    );
    if (active && deleteEntries.length === 1 && active.length === 1) {
      const baseRoomId =
        deleteEntries[0].change.baseline_snapshot?.room_id ??
        deleteEntries[0].change.room_id;
      if (ctx.currentRooms?.unavailable) {
        addNotRestorable(ctx, {
          entity_ref: entity.entity_ref,
          kind: entity.kind,
          reason: "not_compared",
          message:
            "Live rooms could not be read from the hub to verify the deleted virtual device's original room.",
        });
        return;
      }
      if (!roomIdExists(ctx.currentRooms, ctx.serial, baseRoomId)) {
        addNotRestorable(ctx, {
          entity_ref: entity.entity_ref,
          kind: entity.kind,
          reason: "target_room_missing",
          message:
            "The room this deleted virtual device belonged to no longer exists on the hub, so virtual_device_delete cannot be undone automatically.",
        });
        return;
      }
      registerUndoEntries(ctx, deleteEntries);
      return;
    }
  }

  const causedByParentDelete = entries.some(
    ({ change }) =>
      change?.kind === "scenario_delete" ||
      change?.kind === "virtual_device_delete",
  );
  if (
    causedByParentDelete &&
    ["logic", "window", "characteristic"].includes(entity.kind)
  ) {
    addNotRestorable(ctx, {
      entity_ref: entity.entity_ref,
      kind: entity.kind,
      reason: "parent_recreate_changes_id",
      message: `This ${entity.kind} was removed when its parent scenario or virtual device was deleted; undoing the parent delete assigns a new ID/index and does not restore logic assignments, window options, or previous characteristic references.`,
    });
    return;
  }

  addNotRestorable(ctx, {
    entity_ref: entity.entity_ref,
    kind: entity.kind,
    reason: "entity_missing",
    message: `This ${entity.kind} no longer exists on the hub and cannot be restored automatically.`,
  });
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
        currentRooms: ctx.currentRooms,
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
      const undoChain =
        attribution === "agent"
          ? verifyScalarChain(
              ctx,
              activeEntries,
              saved?.settings?.active,
              current?.settings?.active,
            )
          : null;
      if (undoChain) {
        registerUndoEntries(ctx, undoChain);
      } else if (typeof saved?.settings?.active === "boolean") {
        const pureRestore = isPureAgentRestoreTransitionScalar(
          ctx,
          attribution,
          activeEntries,
          saved.settings.active,
          current?.settings?.active,
        );
        addReapply(ctx, {
          entity_ref: entity.entity_ref,
          kind: "logic",
          field: "active",
          attribution,
          manual_override_warning: !pureRestore,
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
    const undoChain =
      attribution === "agent"
        ? verifyScalarChain(
            ctx,
            optEntries,
            savedOpt.configured_value,
            currentOpt.configured_value,
          )
        : null;
    if (undoChain) {
      registerUndoEntries(ctx, undoChain);
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
      const scenarioWindowRejection = checkScenarioOptionsWindowRejection(
        ctx,
        windowKey,
        optionKey,
      );
      if (scenarioWindowRejection) {
        addNotRestorable(ctx, {
          entity_ref: entityRef,
          kind,
          field,
          reason: scenarioWindowRejection.reason,
          message: scenarioWindowRejection.message,
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

    const pureRestore = isPureAgentRestoreTransitionScalar(
      ctx,
      attribution,
      optEntries,
      savedOpt.configured_value,
      currentOpt.configured_value,
    );
    addReapply(ctx, {
      entity_ref: entityRef,
      kind,
      field,
      attribution,
      manual_override_warning: !pureRestore,
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

function extractEligibleApplyEntries(ctx, entries) {
  if (entries.length === 0) return null;
  if (
    entries[0].eventKind === "restore" ||
    entries[0].change?.status === "restored"
  ) {
    return null;
  }
  const active = [];
  for (const entry of entries) {
    if (entry.change?.status === "restored") continue;
    if (!isEligibleApplyEntry(ctx, entry)) return null;
    active.push(entry);
  }
  return active.length > 0 ? active : null;
}

function isCleanPureAgentEvent(entry) {
  if (!entry?.change) return false;
  if (entry.eventKind === "restore") {
    return entry.change.status === "restored";
  }
  if (entry.eventKind === "apply") {
    return (
      entry.change.status === "applied" ||
      entry.change.status === "restored" ||
      (entry.change.status === "conflict" &&
        entry.change.conflict_reason === "later_owned_change")
    );
  }
  return false;
}

function oldestRestoreWasPreSnapshot(ctx, oldestEntry) {
  if (oldestEntry.eventKind !== "restore") return true;
  if (!Number.isFinite(ctx.captureStartedMs)) return false;
  const appliedAt =
    changeAppliedAt(oldestEntry.change) ?? oldestEntry.change?.created_at;
  const appliedMs = Date.parse(appliedAt ?? "");
  return Number.isFinite(appliedMs) && appliedMs <= ctx.captureStartedMs;
}

function verifyPureAgentRestoreTransition(
  ctx,
  attribution,
  entries,
  savedValue,
  currentValue,
  { beforeOf, afterOf, equals },
) {
  if (attribution !== "agent" || ctx.attributionUnavailable) return false;
  if (entries.length === 0) return false;
  if (!entries.some((entry) => entry.eventKind === "restore")) return false;
  if (!entries.every(isCleanPureAgentEvent)) return false;
  if (!oldestRestoreWasPreSnapshot(ctx, entries.at(-1))) return false;
  if (!equals(afterOf(entries[0]), currentValue)) return false;
  for (let index = 0; index < entries.length - 1; index += 1) {
    if (!equals(beforeOf(entries[index]), afterOf(entries[index + 1]))) {
      return false;
    }
  }
  return equals(beforeOf(entries.at(-1)), savedValue);
}

function scalarEventValue(container) {
  return container && Object.hasOwn(container, "value")
    ? { ok: true, value: container.value }
    : { ok: false, value: undefined };
}

function isPureAgentRestoreTransitionScalar(
  ctx,
  attribution,
  entries,
  savedValue,
  currentValue,
) {
  return verifyPureAgentRestoreTransition(
    ctx,
    attribution,
    entries,
    { ok: true, value: savedValue },
    { ok: true, value: currentValue },
    {
      beforeOf: (entry) =>
        scalarEventValue(
          entry.eventKind === "restore"
            ? entry.change.requested_value
            : entry.change.baseline_value,
        ),
      afterOf: (entry) =>
        scalarEventValue(
          entry.eventKind === "restore"
            ? entry.change.baseline_value
            : entry.change.requested_value,
        ),
      equals: (left, right) =>
        left.ok && right.ok && isDeepStrictEqual(left.value, right.value),
    },
  );
}

function placementStateFromSnapshot(serial, snap) {
  if (!snap || typeof snap.room_id !== "number") return null;
  return { name: snap.name, room_ref: roomRef(serial, snap.room_id) };
}

function isPureAgentRestoreTransitionPlacement(
  ctx,
  attribution,
  entries,
  saved,
  current,
) {
  if (!saved || !current) return false;
  return verifyPureAgentRestoreTransition(
    ctx,
    attribution,
    entries,
    { name: saved.name, room_ref: saved.room_ref },
    { name: current.name, room_ref: current.room_ref },
    {
      beforeOf: (entry) =>
        placementStateFromSnapshot(
          ctx.serial,
          entry.eventKind === "restore"
            ? (entry.change.applied_snapshot ?? entry.change.requested_snapshot)
            : entry.change.baseline_snapshot,
        ),
      afterOf: (entry) =>
        placementStateFromSnapshot(
          ctx.serial,
          entry.eventKind === "restore"
            ? entry.change.baseline_snapshot
            : (entry.change.applied_snapshot ??
                entry.change.requested_snapshot),
        ),
      equals: (left, right) =>
        left !== null &&
        right !== null &&
        left.name === right.name &&
        left.room_ref === right.room_ref,
    },
  );
}

function isPureAgentRestoreTransitionBlock(
  ctx,
  attribution,
  entries,
  savedData,
  currentData,
) {
  if (!isPlainObject(savedData) || !isPlainObject(currentData)) return false;
  if (containsHiddenHttpUrl(savedData) || containsHiddenHttpUrl(currentData)) {
    return false;
  }
  return verifyPureAgentRestoreTransition(
    ctx,
    attribution,
    entries,
    savedData,
    currentData,
    {
      beforeOf: (entry) =>
        entry.eventKind === "restore"
          ? (entry.change.applied_snapshot?.data ??
            entry.change.requested_snapshot?.data)
          : entry.change.baseline_snapshot?.data,
      afterOf: (entry) =>
        entry.eventKind === "restore"
          ? entry.change.baseline_snapshot?.data
          : (entry.change.applied_snapshot?.data ??
            entry.change.requested_snapshot?.data),
      equals: blockDataEquals,
    },
  );
}

function isPureAgentRestoreTransitionLogicSource(
  ctx,
  attribution,
  entries,
  saved,
  current,
  changedFields,
) {
  const savedCode = saved?.configuration?.value;
  const currentCode = current?.configuration?.value;
  if (typeof savedCode !== "string" || typeof currentCode !== "string") {
    return false;
  }
  const ok = verifyPureAgentRestoreTransition(
    ctx,
    attribution,
    entries,
    savedCode,
    currentCode,
    {
      beforeOf: (entry) =>
        sanitizeCodeForCompare(
          entry.eventKind === "restore"
            ? (entry.change.applied_snapshot?.data ??
                entry.change.requested_snapshot?.data)
            : entry.change.baseline_snapshot?.data,
          ctx.sensitiveValues,
        ),
      afterOf: (entry) =>
        sanitizeCodeForCompare(
          entry.eventKind === "restore"
            ? entry.change.baseline_snapshot?.data
            : (entry.change.applied_snapshot?.data ??
                entry.change.requested_snapshot?.data),
          ctx.sensitiveValues,
        ),
      equals: (left, right) => typeof left === "string" && left === right,
    },
  );
  if (!ok) return false;
  if (saved?.type === "LOGIC") {
    const oldest = entries.at(-1);
    const newest = entries[0];
    const oldestBeforeSnap =
      oldest.eventKind === "restore"
        ? (oldest.change.applied_snapshot ?? oldest.change.requested_snapshot)
        : oldest.change.baseline_snapshot;
    const newestAfterSnap =
      newest.eventKind === "restore"
        ? newest.change.baseline_snapshot
        : (newest.change.applied_snapshot ?? newest.change.requested_snapshot);
    for (const field of ["name", "description", "on_start"]) {
      if (!changedFields.has(field)) continue;
      const nativeKey = LOGIC_FIELD_TO_NATIVE_SNAPSHOT_KEY[field];
      if (
        !isDeepStrictEqual(oldestBeforeSnap?.[nativeKey], saved?.[field]) ||
        !isDeepStrictEqual(newestAfterSnap?.[nativeKey], current?.[field])
      ) {
        return false;
      }
    }
  }
  return true;
}

function verifyScalarChain(ctx, entries, savedValue, currentValue) {
  const active = extractEligibleApplyEntries(ctx, entries);
  if (!active) return null;
  const newest = active[0].change;
  if (
    !newest.requested_value ||
    !Object.hasOwn(newest.requested_value, "value") ||
    !isDeepStrictEqual(newest.requested_value.value, currentValue)
  ) {
    return null;
  }
  for (let index = 0; index < active.length - 1; index += 1) {
    const newerBase = active[index].change.baseline_value;
    const olderReq = active[index + 1].change.requested_value;
    if (
      !newerBase ||
      !olderReq ||
      !Object.hasOwn(newerBase, "value") ||
      !Object.hasOwn(olderReq, "value") ||
      !isDeepStrictEqual(newerBase.value, olderReq.value)
    ) {
      return null;
    }
  }
  const oldest = active.at(-1).change;
  if (
    !oldest.baseline_value ||
    !Object.hasOwn(oldest.baseline_value, "value") ||
    !isDeepStrictEqual(oldest.baseline_value.value, savedValue)
  ) {
    return null;
  }
  return active;
}

function verifyPlacementChain(ctx, entries, saved, current, currentRooms) {
  if (!saved || !current || currentRooms?.unavailable) return null;
  const active = extractEligibleApplyEntries(ctx, entries);
  if (!active) return null;

  const newestSnap =
    active[0].change.applied_snapshot ?? active[0].change.requested_snapshot;
  if (
    !newestSnap ||
    newestSnap.name !== current.name ||
    typeof newestSnap.room_id !== "number" ||
    roomRef(ctx.serial, newestSnap.room_id) !== current.room_ref
  ) {
    return null;
  }

  for (let index = 0; index < active.length; index += 1) {
    const base = active[index].change.baseline_snapshot;
    if (!base || typeof base.room_id !== "number") return null;
    if (!roomIdExists(currentRooms, ctx.serial, base.room_id)) {
      return null;
    }
    if (index < active.length - 1) {
      const olderSnap =
        active[index + 1].change.applied_snapshot ??
        active[index + 1].change.requested_snapshot;
      if (
        !olderSnap ||
        base.name !== olderSnap.name ||
        base.room_id !== olderSnap.room_id
      ) {
        return null;
      }
    }
  }

  const oldestBase = active.at(-1).change.baseline_snapshot;
  if (
    oldestBase.name !== saved.name ||
    roomRef(ctx.serial, oldestBase.room_id) !== saved.room_ref
  ) {
    return null;
  }
  return active;
}

function verifyBlockChain(ctx, entries, savedData, currentData) {
  if (!isPlainObject(savedData) || !isPlainObject(currentData)) {
    return null;
  }
  if (containsHiddenHttpUrl(savedData) || containsHiddenHttpUrl(currentData)) {
    return null;
  }
  if (!blockReferencesExist(ctx, savedData)) {
    return null;
  }
  const active = extractEligibleApplyEntries(ctx, entries);
  if (!active) return null;
  const newestRaw =
    active[0].change.applied_snapshot?.data ??
    active[0].change.requested_snapshot?.data;
  if (!blockDataEquals(newestRaw, currentData)) return null;

  for (let index = 0; index < active.length - 1; index += 1) {
    const newerBase = active[index].change.baseline_snapshot?.data;
    const olderResult =
      active[index + 1].change.applied_snapshot?.data ??
      active[index + 1].change.requested_snapshot?.data;
    if (!blockDataEquals(newerBase, olderResult)) return null;
  }
  const oldestBase = active.at(-1).change.baseline_snapshot?.data;
  return blockDataEquals(oldestBase, savedData) ? active : null;
}

function verifyLogicSourceChain(ctx, entries, saved, current, changedFields) {
  const active = extractEligibleApplyEntries(ctx, entries);
  if (!active) return null;
  const savedCode = saved?.configuration?.value;
  const currentCode = current?.configuration?.value;
  if (
    typeof savedCode !== "string" ||
    typeof currentCode !== "string" ||
    isHidden(savedCode) ||
    isHidden(currentCode)
  ) {
    return null;
  }
  const newest = active[0].change;
  const newestSnap = newest.applied_snapshot ?? newest.requested_snapshot;
  if (
    sanitizeCodeForCompare(newestSnap?.data, ctx.sensitiveValues) !==
    currentCode
  ) {
    return null;
  }
  for (let index = 0; index < active.length - 1; index += 1) {
    const newerBase = active[index].change.baseline_snapshot?.data;
    const olderSnap =
      active[index + 1].change.applied_snapshot ??
      active[index + 1].change.requested_snapshot;
    if (typeof newerBase !== "string" || newerBase !== olderSnap?.data) {
      return null;
    }
  }
  const oldestBase = active.at(-1).change.baseline_snapshot;
  if (
    sanitizeCodeForCompare(oldestBase?.data, ctx.sensitiveValues) !== savedCode
  ) {
    return null;
  }
  if (saved?.type === "LOGIC") {
    for (const field of ["name", "description", "on_start"]) {
      if (!changedFields.has(field)) continue;
      const nativeKey = LOGIC_FIELD_TO_NATIVE_SNAPSHOT_KEY[field];
      if (
        !isDeepStrictEqual(oldestBase?.[nativeKey], saved?.[field]) ||
        !isDeepStrictEqual(newestSnap?.[nativeKey], current?.[field])
      ) {
        return null;
      }
    }
  }
  return active;
}

function verifyBridgeExportChain(ctx, entries, direction) {
  if (entries.length === 0) return null;

  const byKey = new Map();
  for (const entry of entries) {
    const key = entry.change.option_key;
    if (typeof key !== "string" || key.length === 0) return null;
    const list = byKey.get(key) ?? [];
    list.push(entry);
    byKey.set(key, list);
  }

  let matchedDirection = false;
  const expectedFinal = direction === "added";
  const expectedSaved = !expectedFinal;
  const verifiedEntries = [];

  for (const rawChain of byKey.values()) {
    if (
      rawChain.every(
        (entry) =>
          entry.change?.status === "restored" &&
          !oldestRestoreWasPreSnapshot(ctx, entry),
      )
    ) {
      // Closed in-window apply->restore cycle on another service checkbox of
      // the same accessory: net effect is already back at baseline.
      continue;
    }
    const active = extractEligibleApplyEntries(ctx, rawChain);
    if (!active) return null;
    const newestVal = active[0].change.requested_value?.value;
    const oldestBase = active.at(-1).change.baseline_value?.value;
    if (typeof newestVal !== "boolean" || typeof oldestBase !== "boolean") {
      return null;
    }
    const verified = verifyScalarChain(ctx, active, oldestBase, newestVal);
    if (!verified) return null;
    if (direction === "added" && oldestBase !== false) return null;
    if (direction === "removed" && newestVal !== false) return null;
    if (newestVal === expectedFinal && oldestBase === expectedSaved) {
      matchedDirection = true;
    }
    verifiedEntries.push(...verified);
  }
  return matchedDirection && verifiedEntries.length > 0
    ? verifiedEntries
    : null;
}

function verifyVirtualLightGroupUndoChain(
  ctx,
  createEntry,
  memberEntries,
  item,
) {
  const createChange = createEntry.change;
  const live = ctx.liveVirtualLightGroups?.get(item.ref);
  if (!live || live.readError || live.absent) return null;
  if (
    !createChange.applied_snapshot ||
    !Array.isArray(createChange.characteristic_types)
  ) {
    return null;
  }
  if (
    !isDeepStrictEqual(
      live.accessory,
      createChange.applied_snapshot.accessory,
    ) ||
    !isDeepStrictEqual(
      live.link_settings,
      createChange.applied_snapshot.link_settings,
    )
  ) {
    return null;
  }
  const liveIncoming = {};
  const createdIncoming = {};
  for (const type of createChange.characteristic_types) {
    const rawLinks = live.links?.[type];
    if (!Array.isArray(rawLinks)) return null;
    if (
      rawLinks.some(
        (link) => link.type !== "IN" || link.characteristics.length !== 1,
      )
    ) {
      return null;
    }
    liveIncoming[type] = incomingLinks(rawLinks);
    createdIncoming[type] = incomingLinks(
      createChange.applied_snapshot.links?.[type] ?? [],
    );
  }
  const liveKeys = linkKeys(liveIncoming);
  const createdKeys = linkKeys(createdIncoming);

  if (
    memberEntries.length === 0 ||
    memberEntries.every((entry) => entry.change?.status === "restored")
  ) {
    return sameKeys(liveKeys, createdKeys) ? [createEntry] : null;
  }

  const activeMembers = extractEligibleApplyEntries(ctx, memberEntries);
  if (!activeMembers) return null;
  if (activeMembers.some((entry) => entry.eventMs < createEntry.eventMs)) {
    return null;
  }
  for (const { change } of activeMembers) {
    if (!change.baseline_links || !Array.isArray(change.steps)) return null;
    for (const step of change.steps) {
      if (
        step.action === "remove" &&
        ctx.currentAccessoryIds instanceof Set &&
        !ctx.currentAccessoryIds.has(step.target?.aId)
      ) {
        return null;
      }
    }
  }
  if (!sameKeys(expectedAppliedKeys(activeMembers[0].change), liveKeys)) {
    return null;
  }
  for (let index = 0; index < activeMembers.length - 1; index += 1) {
    const newerBase = linkKeys(activeMembers[index].change.baseline_links);
    const olderApplied = expectedAppliedKeys(activeMembers[index + 1].change);
    if (!sameKeys(newerBase, olderApplied)) return null;
  }
  const oldestBase = linkKeys(activeMembers.at(-1).change.baseline_links);
  if (!sameKeys(oldestBase, createdKeys)) return null;

  return [...activeMembers, createEntry];
}

function hasBlockingVirtualDeviceDependency(
  ctx,
  item,
  createEventMs,
  currentSnapshot,
) {
  const homeRef = homeRefOf(ctx.serial);
  for (const scenario of currentSnapshot.scenarios ?? []) {
    const removedAt = ctx.undoneRemovedScenarios.get(scenario.ref);
    if (removedAt !== undefined && removedAt >= createEventMs) continue;
    const reverted = ctx.undoneConfigScenarios.get(scenario.ref);
    const effective =
      reverted && reverted.minEventMs >= createEventMs
        ? reverted.savedScenario
        : scenario;
    if (scenarioReferencesAccessory(effective, item, homeRef)) {
      return true;
    }
  }
  for (const bridge of currentSnapshot.bridges ?? []) {
    if (!(bridge.exported_accessory_refs ?? []).includes(item.ref)) continue;
    const undoneAt = ctx.undoneAddedBridgeExports.get(
      `${bridge.ref}\0${item.ref}`,
    );
    if (undoneAt === undefined || undoneAt < createEventMs) {
      return true;
    }
  }
  return false;
}

function scenarioReferencesAccessory(scenario, item, homeRef) {
  const config = scenario?.configuration;
  if (!isPlainObject(config)) return false;
  if (config.format === "json" && isPlainObject(config.value)) {
    if (blockAffectedRefs(config.value, homeRef).includes(item.ref)) {
      return true;
    }
    let mentioned = false;
    visitKnownBlockNodes(config.value, (node, kind) => {
      if (mentioned || kind !== "code" || typeof node.code !== "string") return;
      if (
        accessoryMentions(node.code, { id: item.id, name: item.name }) !== null
      ) {
        mentioned = true;
      }
    });
    return mentioned;
  }
  if (
    (config.format === "code" || config.format === "javascript") &&
    typeof config.value === "string"
  ) {
    return (
      accessoryMentions(config.value, { id: item.id, name: item.name }) !== null
    );
  }
  return false;
}

function collectBlockReferencedIds(blockData) {
  const accessoryIds = new Set();
  const scenarioIndexes = new Set();
  visitKnownBlockNodes(blockData, (node, kind) => {
    if (kind === "characteristic" && Number.isSafeInteger(node.aId)) {
      accessoryIds.add(node.aId);
    }
    if (kind === "service") {
      if (Number.isSafeInteger(node.aId)) accessoryIds.add(node.aId);
      for (const action of node.characteristics ?? []) {
        if (action?.type === "from" && Number.isSafeInteger(action.from_aId)) {
          accessoryIds.add(action.from_aId);
        }
      }
    }
  });
  for (const target of blockScenarioTargets(blockData)) {
    if (typeof target.index === "string") scenarioIndexes.add(target.index);
  }
  return { accessoryIds, scenarioIndexes };
}

function blockReferencesExist(ctx, blockData) {
  const { accessoryIds, scenarioIndexes } =
    collectBlockReferencedIds(blockData);
  if (accessoryIds.size > 0) {
    if (ctx.currentAccessoryIds?.unavailable) return false;
    if (ctx.currentAccessoryIds instanceof Set) {
      for (const aId of accessoryIds) {
        if (!ctx.currentAccessoryIds.has(aId)) return false;
      }
    }
  }
  if (scenarioIndexes.size > 0) {
    if (ctx.currentScenarioIndexes?.unavailable) return false;
    if (ctx.currentScenarioIndexes instanceof Set) {
      for (const index of scenarioIndexes) {
        if (!ctx.currentScenarioIndexes.has(index)) return false;
      }
    }
  }
  return true;
}

function validateSavedBlockForReapply(ctx, blockData) {
  let nodeProblem = null;
  visitKnownBlockNodes(blockData, (node, kind, path) => {
    if (nodeProblem || kind !== "code") return;
    if (!isActionPath(path)) {
      nodeProblem = {
        reason: "unsupported_block_node",
        message:
          "The saved BLOCK contains a code condition node that cannot be written through block_data_update.",
      };
      return;
    }
    if (typeof node.code !== "string" || node.code.trim().length === 0) {
      nodeProblem = {
        reason: "unsupported_javascript",
        message:
          "The saved BLOCK contains an empty code action that cannot be written through block_data_update.",
      };
      return;
    }
    const sanitized = sanitizeCodeForCompare(node.code, ctx.sensitiveValues);
    if (
      node.code.includes("[REDACTED]") ||
      sanitized !== node.code ||
      sanitized.includes("[REDACTED]")
    ) {
      nodeProblem = {
        reason: "redacted_value",
        message:
          "The saved BLOCK contains a code action with redacted or sensitive content and cannot be written automatically.",
      };
      return;
    }
    if (
      hubCodeProblems(node.code, { functionBody: true }).problems.length > 0
    ) {
      nodeProblem = {
        reason: "unsupported_javascript",
        message:
          "The saved BLOCK contains a code action that fails SprutHub's Nashorn JavaScript check and cannot be written automatically.",
      };
    }
  });
  if (nodeProblem) return nodeProblem;

  const { accessoryIds, scenarioIndexes } =
    collectBlockReferencedIds(blockData);
  if (accessoryIds.size > 0) {
    if (ctx.currentAccessoryIds?.unavailable) {
      return {
        reason: "not_compared",
        message:
          "Live accessories could not be read from the hub to verify devices referenced by this BLOCK scenario.",
      };
    }
    if (ctx.currentAccessoryIds instanceof Set) {
      for (const aId of accessoryIds) {
        if (!ctx.currentAccessoryIds.has(aId)) {
          return {
            reason: "referenced_entity_missing",
            message: `This saved BLOCK references accessory ${aId}, which no longer exists on the hub, so block_data_update would be refused.`,
          };
        }
      }
    }
  }
  if (scenarioIndexes.size > 0) {
    if (ctx.currentScenarioIndexes?.unavailable) {
      return {
        reason: "not_compared",
        message:
          "Live scenarios could not be read from the hub to verify scenarios referenced by this BLOCK scenario.",
      };
    }
    if (ctx.currentScenarioIndexes instanceof Set) {
      for (const index of scenarioIndexes) {
        if (!ctx.currentScenarioIndexes.has(index)) {
          return {
            reason: "referenced_entity_missing",
            message: `This saved BLOCK references scenario ${index}, which no longer exists on the hub, so block_data_update would be refused.`,
          };
        }
      }
    }
  }
  return null;
}

function checkScenarioOptionsWindowRejection(ctx, windowKey, optionKey) {
  if (ctx.scenarioOptionsWindows?.unavailable) {
    if (SCENARIO_WINDOW_RESERVED_KEYS.has(optionKey)) {
      return {
        reason: "not_compared",
        message:
          "Live scenarios could not be read from the hub to verify whether this window belongs to a scenario.",
      };
    }
    return null;
  }
  if (ctx.scenarioOptionsWindows instanceof Map) {
    const matches = ctx.scenarioOptionsWindows.get(windowKey) ?? [];
    if (matches.length === 1 && matches[0].predefined === true) {
      return {
        reason: "predefined_scenario",
        message:
          "This options window belongs to a built-in (predefined) SprutHub scenario and cannot be modified through native write tools.",
      };
    }
    if (optionKey === "Active" && matches.length > 0) {
      return {
        reason: "scenario_owner_required",
        message:
          "Scenario Active state must be restored via scenario_active on the owning scenario ref rather than its raw options window ref.",
      };
    }
    if (SCENARIO_METADATA_KEYS.has(optionKey) && matches.length === 1) {
      if (matches[0].type === "LOGIC" && optionKey !== "Sync") {
        return {
          reason: "logic_info_in_code",
          message: `LOGIC scenario option "${optionKey}" is controlled by info in the scenario's code and cannot be written via window_option.`,
        };
      }
      return {
        reason: "scenario_owner_required",
        message: `Scenario option "${optionKey}" must be restored through the owning scenario ref rather than its raw options window ref.`,
      };
    }
    return null;
  }
  if (
    windowKey.startsWith("Scenario/") &&
    !isTelegramWindowKey(windowKey) &&
    SCENARIO_WINDOW_RESERVED_KEYS.has(optionKey)
  ) {
    return {
      reason: "scenario_owner_required",
      message: `Scenario option "${optionKey}" must be restored through the owning scenario ref rather than its raw window ref.`,
    };
  }
  return null;
}

function buildHomeScenarioIndexSet(currentSnapshot, comparison) {
  const indexes = new Set(
    (currentSnapshot.scenarios ?? [])
      .map(({ index }) => index)
      .filter((index) => typeof index === "string"),
  );
  for (const entry of comparison.not_compared ?? []) {
    if (entry.kind !== "scenario" || entry.reason !== "read_error") continue;
    try {
      const parsed = parseEntityRef(entry.entity_ref);
      if (parsed.kind === "scenario" && typeof parsed.index === "string") {
        indexes.add(parsed.index);
      }
    } catch {
      // Ignore malformed refs.
    }
  }
  return indexes;
}

function roomRefExists(currentRooms, targetRoomRef) {
  if (currentRooms === null || currentRooms === undefined) return true;
  if (currentRooms.unavailable) return false;
  return currentRooms.has(targetRoomRef);
}

function roomIdExists(currentRooms, serial, roomId) {
  if (typeof roomId !== "number") return false;
  return roomRefExists(currentRooms, roomRef(serial, roomId));
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

function sanitizeDisplayValue(value, sensitiveValues, role = "data") {
  if (typeof value === "string" && role !== "data") {
    return sanitizeAgentOutput(value, sensitiveValues, {
      stringRoles: { "": role },
    });
  }
  return sanitizeAgentOutput(value, sensitiveValues);
}
