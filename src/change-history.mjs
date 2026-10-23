import { blockAffectedRefs } from "./block-model.mjs";
import { publicPauseEffect } from "./change-presentation.mjs";
import { groupRef, stableNativeId } from "./change-refs.mjs";
import { changeName, summaryValue } from "./change-restore.mjs";
import {
  changeOperation,
  LIGHT_GROUP_MEMBERS,
} from "./light-group-members.mjs";
import { createdLogicMapping } from "./logic-changes.mjs";
import { isNativeValueChange } from "./native-values.mjs";
import { isLogicSourceChange } from "./scenario-changes.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

// When a change was first applied: its first apply intent, else (a draft)
// when it was recorded.
export function applicationTime(change) {
  return changeAppliedAt(change) ?? change.created_at;
}

export function compareApplication(left, right) {
  return (
    applicationTime(left).localeCompare(applicationTime(right)) ||
    (left.group_id !== undefined && left.group_id === right.group_id
      ? left.group_index - right.group_index
      : 0) ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}

// What an owner recognises in a history line: what changed (name, value),
// why (the agent's reason), when, its status and the call it belongs to.
// Affected refs only select (entity_ref); they are not listed, so a line
// stays short however many devices a scenario touches.
export function changeSummary(change) {
  const name = changeName(change);
  const appliedAt = changeAppliedAt(change);
  const described = {
    ...(name ? { name } : {}),
    ...(typeof change.reason === "string" ? { reason: change.reason } : {}),
  };
  const reference = `spruthub-change://native/${change.id}`;
  const value = summaryValue(change);
  return {
    change_ref: reference,
    operation: changeOperation(change),
    ...described,
    target_ref: change.target_ref,
    ...(change.bridge_export ? { bridge: change.bridge_export.bridge } : {}),
    ...(value ? { value } : {}),
    recorded_status: change.status,
    ...(change.kind === "block_action_pause"
      ? {
          effect_status: publicPauseEffect(change).status,
          ...(change.replaces_pause_change_id
            ? {
                replaces_change_ref: `spruthub-change://native/${change.replaces_pause_change_id}`,
              }
            : {}),
          ...(change.superseded_by_change_ref
            ? { superseded_by_change_ref: change.superseded_by_change_ref }
            : {}),
          ...(change.completed_by_change_ref
            ? { completed_by_change_ref: change.completed_by_change_ref }
            : {}),
          ...(change.restored_by_change_ref
            ? { restored_by_change_ref: change.restored_by_change_ref }
            : {}),
        }
      : {}),
    ...(change.group_id ? { group_ref: groupRef(change.group_id) } : {}),
    ...(appliedAt ? { applied_at: appliedAt } : {}),
    created_at: change.created_at,
    updated_at: change.updated_at,
    next: {
      tool: "get_native_change",
      arguments: { change_ref: reference },
    },
  };
}

export function changeAppliedAt(change) {
  return change.history?.find(({ status }) => status === "applying")?.at;
}

export function compareChangeSummaries(left, right) {
  const updated = right.updated_at.localeCompare(left.updated_at);
  return updated || left.change_ref.localeCompare(right.change_ref);
}

export function historySelection(homeRef, entityRef, limit, cursor) {
  const scope = JSON.stringify({
    home_ref: homeRef,
    entity_ref: entityRef ?? null,
  });
  const selection = { homeRef, entityRef: entityRef ?? null, limit, scope };
  return {
    ...selection,
    after: decodeHistoryCursor(cursor, scope, selection),
  };
}

export function decodeHistoryCursor(cursor, expectedScope, selection) {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed?.v !== 2 ||
      typeof parsed.after_ref !== "string" ||
      parsed.after_ref.length === 0 ||
      typeof parsed.after_updated_at !== "string" ||
      parsed.after_updated_at.length === 0 ||
      parsed.scope !== expectedScope
    ) {
      throw new Error("invalid cursor");
    }
    return {
      change_ref: parsed.after_ref,
      updated_at: parsed.after_updated_at,
    };
  } catch {
    throw invalidHistoryCursor(selection);
  }
}

export function encodeHistoryCursor(after, scope) {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      after_ref: after.change_ref,
      after_updated_at: after.updated_at,
      scope,
    }),
  ).toString("base64url");
}

export function historyNext(selection, cursor) {
  return {
    tool: "get_native_change",
    arguments: {
      home_ref: selection.homeRef,
      ...(selection.entityRef ? { entity_ref: selection.entityRef } : {}),
      limit: selection.limit,
      ...(cursor ? { cursor } : {}),
    },
  };
}

export function invalidHistoryCursor(selection) {
  return new SprutHubError(
    "invalid_cursor",
    "Use the cursor returned by the history of get_native_change for the same home and entity filter.",
    "restart_history",
    { next: historyNext(selection, null) },
  );
}

export function nativeAffectedRefs(change, homeRef) {
  const refs = [change.target_ref];
  if (isNativeValueChange(change)) {
    if (typeof change.window_ref === "string") refs.push(change.window_ref);
    refs.push(...canonicalAncestors(refs[0]));
    // A bridge export is the service's and its accessory's.
    if (change.bridge_export) {
      const { service_ref: ref } = change.bridge_export;
      refs.push(ref, ref.replace(/\/service\/\d+$/, ""));
    }
  }
  if (change.kind === "accessory_placement") {
    refs.push(
      `${homeRef}/room/${change.baseline_snapshot.room_id}`,
      `${homeRef}/room/${change.requested_snapshot.room_id}`,
    );
  } else if (change.kind === "room_create") {
    if (change.created_room_id !== undefined) {
      refs.push(`${homeRef}/room/${change.created_room_id}`);
    }
    for (const candidate of change.candidate_rooms ?? []) {
      refs.push(`${homeRef}/room/${candidate.id}`);
    }
  } else if (change.kind === "virtual_light_group") {
    refs.push(change.room_ref, ...change.member_service_refs);
    if (change.created_accessory_id !== undefined) {
      refs.push(`${homeRef}/accessory/${change.created_accessory_id}`);
      for (const type of change.characteristic_types) {
        const target = change.virtual_target.characteristics[type];
        refs.push(...bindingRefs(homeRef, target.aId, target.sId, target.cId));
      }
    }
    for (const ref of change.member_service_refs) {
      refs.push(...canonicalAncestors(ref));
    }
  } else if (change.kind === LIGHT_GROUP_MEMBERS) {
    // The group and the lamps that join or leave it.
    refs.push(...canonicalAncestors(change.target_ref));
    for (const member of change.members) {
      if (member.change === "stays") continue;
      refs.push(member.service_ref, ...canonicalAncestors(member.service_ref));
    }
  }
  if (change.kind === "logic_assignment") {
    refs.push(...canonicalAncestors(refs[0]));
  } else if (
    [
      "block_create",
      "block_data_update",
      "block_action_pause",
      "scenario_run",
    ].includes(change.kind)
  ) {
    if (change.scenario_index) {
      refs.push(
        `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
      );
    }
    const configurations =
      change.kind === "block_create"
        ? [change.requested_snapshot?.data]
        : change.kind === "scenario_run"
          ? [change.baseline_snapshot?.data]
          : [
              change.baseline_snapshot?.data,
              change.requested_snapshot?.data,
              change.restore_snapshot?.data,
            ];
    for (const data of configurations) {
      refs.push(...blockAffectedRefs(data, homeRef));
    }
  } else if (isLogicSourceChange(change)) {
    if (change.scenario_index) {
      refs.push(
        `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
      );
    }
    const { type } =
      change.kind === "logic_source_create" ? createdLogicMapping(change) : {};
    if (type !== undefined) {
      refs.push(`${change.target_ref}/logic/${encodeURIComponent(type)}`);
    }
  }
  return uniqueRefs(refs);
}

export function bindingRefs(homeRef, aId, sId, cId) {
  if (!stableNativeId(aId)) return [];
  const accessory = `${homeRef}/accessory/${aId}`;
  if (!stableNativeId(sId)) return [accessory];
  const service = `${accessory}/service/${sId}`;
  return stableNativeId(cId)
    ? [accessory, service, `${service}/characteristic/${cId}`]
    : [accessory, service];
}

export function canonicalAncestors(ref) {
  const logic =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+\/service\/\d+)\/logic\/[^/]+$/.exec(
      ref,
    );
  if (logic) {
    const service = logic[1];
    return [service.replace(/\/service\/\d+$/, ""), service];
  }
  const characteristic =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+\/service\/\d+)\/characteristic\/\d+$/.exec(
      ref,
    );
  if (characteristic) {
    const service = characteristic[1];
    return [service.replace(/\/service\/\d+$/, ""), service];
  }
  const service =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+)\/service\/\d+$/.exec(ref);
  return service ? [service[1]] : [];
}

export function uniqueRefs(refs) {
  return [...new Set(refs.filter((ref) => typeof ref === "string"))];
}
