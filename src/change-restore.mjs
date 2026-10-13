import { valuesEqual } from "./change-contracts.mjs";
import { changeRef, nativeChangeNext } from "./change-refs.mjs";
import { resendDeviceCommandNext } from "./device-commands.mjs";
import { isNativeChange, isNativeValueChange } from "./native-values.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export function restoreIntentTime(change) {
  return change.write_intent?.direction === "restore"
    ? change.write_intent.at
    : undefined;
}

export function restoreItemBase(change, automation) {
  const name = changeName(change);
  const value = isNativeValueChange(change) ? summaryValue(change) : undefined;
  return {
    change_ref: automation
      ? changeRef(change.id)
      : `spruthub-change://native/${change.id}`,
    operation: automation ? "legacy_boolean_automation" : change.kind,
    ...(name ? { name } : {}),
    ...(typeof change.target_ref === "string"
      ? { target_ref: change.target_ref }
      : {}),
    ...(change.kind === "characteristic_value" && change.contract?.type
      ? { type: change.contract.type }
      : {}),
    // From what the agent set back to what it was.
    ...(value ? { value: { from: value.to, to: value.from } } : {}),
  };
}

export function restoreItem(change, automation, result, before) {
  const base = restoreItemBase(change, automation);
  if (automation) return automationRestoreItem(change, base, result, before);
  const observed =
    result.observed_value !== undefined &&
    result.observed_value !== null &&
    Object.hasOwn(result.observed_value, "value")
      ? { observed_value: result.observed_value.value }
      : {};
  if (result.restore_outcome) {
    const { status, ...outcome } = result.restore_outcome;
    return {
      ...base,
      status,
      sent: false,
      ...outcome,
      ...observed,
      ...(result.next ? { next: result.next } : {}),
    };
  }
  const intentAt = restoreIntentTime(change);
  const sent = intentAt !== undefined && intentAt !== before.restoreIntentAt;
  // Settled or still unknown underneath, a change the agent changed again
  // later is undone after that one.
  if (result.conflict_reason === "later_owned_change") {
    return {
      ...base,
      status: "skipped",
      reason: "later_change",
      sent,
      later_change_ref: result.restore_first_change_ref,
      ...observed,
    };
  }
  switch (result.status) {
    case "restored":
      if (before.status === "restored") {
        return {
          ...base,
          status: "restored",
          sent: false,
          note: "already_restored",
        };
      }
      if (intentAt !== undefined) {
        return { ...base, status: "restored", sent, ...observed };
      }
      if (
        isNativeValueChange(change) &&
        valuesEqual(change.baseline_value, change.requested_value)
      ) {
        return {
          ...base,
          status: "restored",
          sent: false,
          note: "nothing_to_restore",
          ...observed,
        };
      }
      // Back as it was without this restore: someone else undid it.
      return {
        ...base,
        status: "skipped",
        reason: "changed_since",
        sent: false,
        already_previous: true,
        ...observed,
      };
    case "conflict":
      if (
        ["manual_change", "value_changed_after_apply"].includes(
          result.conflict_reason,
        )
      ) {
        return {
          ...base,
          status: "skipped",
          reason: "changed_since",
          sent: false,
          already_previous: false,
          ...observed,
        };
      }
      return {
        ...base,
        status: "skipped",
        reason: result.conflict_reason ?? "conflict",
        sent: false,
        ...(result.room_contents
          ? { room_contents: result.room_contents }
          : {}),
        ...(result.referencing_scenario_targets
          ? {
              referencing_scenario_targets: result.referencing_scenario_targets,
            }
          : {}),
        ...(result.logic_assignments
          ? { logic_assignments: result.logic_assignments }
          : {}),
        ...observed,
      };
    case "not_owned":
      return {
        ...base,
        status: "skipped",
        reason: [
          "change_was_not_applied",
          "room_creation_not_confirmed",
        ].includes(result.conflict_reason)
          ? "not_applied"
          : "not_owned",
        sent: false,
        ...observed,
      };
    case "uncertain":
    case "applying":
    case "restoring": {
      const restoring = change.write_intent?.direction === "restore";
      return {
        ...base,
        status: "uncertain",
        reason: restoring ? "restore_unconfirmed" : "apply_unconfirmed",
        sent,
        ...observed,
        next:
          (restoring && restoreResendNext(change, result)) ||
          result.next ||
          nativeChangeNext(base.change_ref),
      };
    }
    case "applied":
      // An interrupted apply confirmed only now; the restore itself is
      // the next call.
      return {
        ...base,
        status: "skipped",
        reason: "apply_confirmed_now",
        sent: false,
        ...observed,
        next: {
          tool: "restore_native_change",
          arguments: { change_ref: base.change_ref },
        },
      };
    default:
      return {
        ...base,
        status: "skipped",
        reason: result.status,
        sent: false,
        ...observed,
      };
  }
}

// A device command's undo write with no confirmation while the device still
// shows the agent's value: undo does not resend a command by itself (the
// first write may still be on its way), so the item offers the explicit
// resend of the previous value, as a held send_device_commands item does.
export function restoreResendNext(change, result) {
  if (
    change.kind !== "characteristic_value" ||
    !result.observed_value ||
    !valuesEqual(result.observed_value, change.requested_value)
  ) {
    return undefined;
  }
  return resendDeviceCommandNext(
    change.home_ref,
    { target_ref: change.target_ref, value: change.baseline_value.value },
    `Undo: ${change.reason}`,
  );
}

export function automationRestoreItem(change, base, result, before) {
  switch (result.status) {
    case "rolled_back":
      if (before.status === "rolled_back") {
        return {
          ...base,
          status: "restored",
          sent: false,
          note: "already_restored",
        };
      }
      return result.removed === true
        ? { ...base, status: "restored", sent: true }
        : {
            ...base,
            status: "skipped",
            reason: "changed_since",
            sent: false,
            already_previous: true,
          };
    case "conflict":
      return {
        ...base,
        status: "skipped",
        reason: "changed_since",
        sent: false,
      };
    case "uncertain":
    case "rollback_uncertain": {
      // Only a delete of this call ends in rollback_uncertain; uncertain
      // alone is a creation still unknown, and nothing was sent for it.
      const deleteSent = change.status === "rollback_uncertain";
      return {
        ...base,
        status: "uncertain",
        reason: deleteSent ? "restore_unconfirmed" : "apply_unconfirmed",
        sent: deleteSent,
        next: nativeChangeNext(base.change_ref),
      };
    }
    default:
      return {
        ...base,
        status: "skipped",
        reason: result.status,
        sent: false,
      };
  }
}

export function restoreFailureItem(change, automation, error) {
  const base = restoreItemBase(change, automation);
  if (error instanceof SprutHubError && error.code === "restore_unsupported") {
    return {
      ...base,
      status: "skipped",
      reason: "not_restorable",
      sent: false,
      message: error.message,
    };
  }
  const details = error instanceof SprutHubError ? (error.details ?? {}) : {};
  return {
    ...base,
    status: "failed",
    sent: details.rejection !== undefined || details.hub_effect === "partial",
    error: {
      code: error instanceof SprutHubError ? error.code : "internal_error",
      message:
        error instanceof SprutHubError
          ? error.message
          : "The restore failed inside sprut-agent.",
      ...(error instanceof SprutHubError && error.action
        ? { action: error.action }
        : {}),
    },
    ...(details.hub_effect ? { hub_effect: details.hub_effect } : {}),
    ...(details.rejection ? { rejection: details.rejection } : {}),
    next: details.next ?? nativeChangeNext(base.change_ref),
  };
}

export function restoreChangesResult(homeRef, results) {
  const summary = {
    total: results.length,
    restored: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const { status } of results) summary[status] += 1;
  return {
    status: summary.restored === summary.total ? "ok" : "incomplete",
    home_ref: homeRef,
    summary,
    results,
    limitations: [
      "Results are in the order the changes were undone: newest first. Each item was checked against the home right before its own write.",
      "skipped changed_since: the value or configuration changed after the agent's change (by hand, in the app or by a scenario) and was left as it is; already_previous=true means it is already as before. later_change: undo later_change_ref first, or together. device_unavailable: the device is offline; try again when it is back. lamp_level_not_restored: undo puts back only a lamp's on/off, never its brightness, hue, saturation or color temperature, as on the hub's lamps a brightness write switches an off lamp on; a lamp is any service with On and such a level.",
      "A device command is put back as a value; what happened meanwhile (light, movement, a scenario it triggered) is not undone. Scenario runs, sent notifications and HTTP requests cannot be undone.",
    ],
  };
}

// The name the owner knows the target by, as saved with the change: the
// device and channel of a command, the room, the scenario.
export function changeName(change) {
  if (typeof change.target_name === "string" && change.target_name !== "") {
    return change.target_name;
  }
  if (!isNativeChange(change)) {
    return typeof change.name === "string" ? change.name : undefined;
  }
  switch (change.kind) {
    case "accessory_placement":
      return change.baseline_snapshot?.name;
    case "room_create":
      return change.applied_snapshot?.name ?? change.requested_name;
    case "room_name":
    case "service_name":
      return change.baseline_value?.value;
    case "virtual_light_group":
      return change.created_accessory_snapshot?.name ?? change.requested_name;
    case "block_create":
    case "logic_source_create":
      return change.requested_snapshot?.name;
    case "block_data_update":
    case "block_action_pause":
    case "scenario_run":
    case "logic_source_update":
      return change.baseline_snapshot?.name;
    default:
      return undefined;
  }
}

// Settings whose values are short and safe to show in a history line;
// options (which may hold codes) and long texts are read with
// get_native_change.
export const SUMMARY_VALUE_KINDS = new Set([
  "characteristic_value",
  "characteristic_notify",
  "logic_active",
  "scenario_active",
  "service_visible",
  "room_name",
  "service_name",
]);

export function summaryValue(change) {
  if (
    !SUMMARY_VALUE_KINDS.has(change.kind) ||
    !change.baseline_value ||
    !change.requested_value
  ) {
    return undefined;
  }
  return {
    from: change.baseline_value.value,
    to: change.requested_value.value,
  };
}
