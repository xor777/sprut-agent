import {
  characteristicContract,
  typedNativeValue,
} from "./change-contracts.mjs";
import {
  nativeChangeNext,
  nativeTargetKey,
  parseCharacteristicRef,
  serviceKey,
  writeRejection,
} from "./change-refs.mjs";
import { isDeviceCommandRejection } from "./native-values.mjs";
import {
  characteristicRef,
  SprutHubError,
  sanitizeNativeData,
  virtuallyWritable,
} from "./spruthub-client.mjs";

export function parseDeviceCommandTargets(commands, configuredSerial) {
  const invalid = [];
  const firstIndexByTarget = new Map();
  const targets = commands.map((command, index) => {
    let target;
    try {
      target = parseCharacteristicRef(command.target_ref, configuredSerial);
    } catch (error) {
      if (!isDeviceCommandRejection(error)) throw error;
      invalid.push(invalidDeviceCommand(index, command, error));
      return null;
    }
    const key = nativeTargetKey(target);
    if (firstIndexByTarget.has(key)) {
      invalid.push({
        index,
        target_ref: command.target_ref,
        code: "duplicate_target",
        message: `Command ${firstIndexByTarget.get(key)} already targets this characteristic; send one value per characteristic.`,
      });
    } else {
      firstIndexByTarget.set(key, index);
    }
    return target;
  });
  if (invalid.length > 0) throw invalidDeviceCommands(invalid);
  return targets;
}

export function invalidDeviceCommand(index, command, error, contract) {
  return {
    index,
    target_ref: command.target_ref,
    code: error.code,
    message: error.message,
    ...(error.action ? { action: error.action } : {}),
    ...(error.code === "invalid_native_value" && contract ? { contract } : {}),
  };
}

export function invalidDeviceCommands(invalid) {
  return new SprutHubError(
    "invalid_device_commands",
    "No command was sent. Fix every command listed in invalid_commands and call send_device_commands again.",
    "send_device_commands",
    { invalid_commands: invalid },
  );
}

export function latestSentValueCommand(changes, homeRef, target) {
  const key = nativeTargetKey(target);
  let latest;
  for (const change of changes) {
    if (
      change.kind !== "characteristic_value" ||
      change.home_ref !== homeRef ||
      change.native_write_sent !== true ||
      !change.target ||
      nativeTargetKey(change.target) !== key
    ) {
      continue;
    }
    if (
      latest === undefined ||
      (change.write_intent?.at ?? "") > (latest.write_intent?.at ?? "")
    ) {
      latest = change;
    }
  }
  return latest;
}

export function deviceCommandName(accessory, { sId }) {
  if (typeof accessory?.name !== "string") return null;
  const service = accessory.services?.find((entry) => entry.sId === sId);
  return sanitizeNativeData(
    typeof service?.name === "string"
      ? `${accessory.name} / ${service.name}`
      : accessory.name,
  );
}

// Devices whose commands are under way at once in one send_device_commands
// call. The owner's hub took 48 writes in flight on one socket without an
// error or a wrong result (2026-10-13-parallel-writes); 32 stays below that
// and still covers the largest room of the owner's home (20 light services)
// in one round.
export const DEVICE_COMMAND_CONCURRENCY = 32;

export const LAMP_LEVEL_ZERO_NOTE = {
  code: "lamp_level_zero_is_off",
  message:
    "Sent as the lamp's off (sent_as), one write with any off of the same lamp in this call: previous_value and observed_value are its on/off, and its brightness stays as it was.",
};

export const LAMP_KEPT_OFF_NOTE = {
  code: "lamp_level_not_sent",
  message:
    "Not sent: the lamp was off and this call keeps it off, and the on/level link the hub assigns to dimmable lamps switches an off lamp on at a brightness write (a color write is held back the same way). The lamp stays off; set this once it is on, or send it with the lamp's On=true.",
};

export const LAMP_SWITCHED_ON_NOTE = {
  code: "lamp_switched_on",
  message:
    "The lamp was off before this call and is on now: on the hub's lamps a brightness write switches an off lamp on.",
};

// Calls operation for each item with at most limit under way, resolving to
// the results in the items' order.
export async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// The commands of one call by device, each device's in the order they are
// sent. A lamp's off goes after the level and color commands of the same
// lamp: a level write switches a lamp with «Связь включения и уровня» on,
// so [On=false, Brightness=70] sent in that order ends on at 70
// (2026-10-13-lamp-logic-undo, U2 and U4). A lamp already off gets no level
// at all beside its off (lampKeptOff). Other commands keep the call's
// order.
export function deviceCommandRuns(items) {
  const lampLevels = new Set(
    items
      .filter(({ onTarget }) => onTarget)
      .map(({ onTarget }) => serviceKey(onTarget)),
  );
  const lampOff = ({ draft }) =>
    draft.contract.type === "On" &&
    draft.requested.value === false &&
    lampLevels.has(serviceKey(draft.fields.target));
  const runs = new Map();
  for (const item of items) {
    const run = runs.get(item.draft.fields.target.aId) ?? [];
    run.push(item);
    runs.set(item.draft.fields.target.aId, run);
  }
  return [...runs].map(([aId, run]) => ({
    aId,
    items: [...run.filter((item) => !lampOff(item)), ...run.filter(lampOff)],
  }));
}

export function isLampLevelZero(draft) {
  return draft.contract.type === "Brightness" && draft.requested.value === 0;
}

// The accessory of a device read, or the read's error.
export function commandDevice(read) {
  if (read.error) throw read.error;
  return read.accessory;
}

export function commandCharacteristic(accessory, { sId, cId }) {
  const characteristic = accessory.services
    ?.find((service) => service.sId === sId)
    ?.characteristics?.find((entry) => entry.cId === cId);
  if (!characteristic?.control || typeof characteristic.control !== "object") {
    throw new SprutHubError(
      "characteristic_not_found",
      "The characteristic was not found on its device.",
      "find_devices",
    );
  }
  return characteristic;
}

export function inspectedCommandValue(accessory, target) {
  const { control } = commandCharacteristic(accessory, target);
  const virtual = virtuallyWritable(accessory, target, control);
  return {
    // virtual_write: a reading or press the hub writes only because the
    // device is virtual; its restore reads it with the same allowance.
    fields: { target, ...(virtual ? { virtual_write: true } : {}) },
    contract: characteristicContract(
      virtual ? { ...control, write: true } : control,
    ),
    value: typedNativeValue(control.value),
  };
}

// A lamp's On in a device read, undefined when that read failed or holds no
// usable On.
export function lampOnState(read, onTarget) {
  if (!read?.accessory) return undefined;
  try {
    const { control } = commandCharacteristic(read.accessory, onTarget);
    return {
      value: typedNativeValue(control.value),
      contract: characteristicContract(control),
    };
  } catch {
    return undefined;
  }
}

export function characteristicRefOf(serial, { aId, sId, cId }) {
  return characteristicRef(serial, aId, sId, cId);
}

export function resendDeviceCommandNext(homeRef, command, reason) {
  return {
    tool: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [
        {
          target_ref: command.target_ref,
          value: command.value,
          resend_unconfirmed: true,
        },
      ],
      reason,
    },
  };
}

export const DEVICE_COMMAND_STATUSES = {
  applied: "applied",
  uncertain: "uncertain",
  conflict: "conflict",
  not_applied: "rejected",
};

export function deviceCommandOutcome(result) {
  const status = DEVICE_COMMAND_STATUSES[result.status] ?? "uncertain";
  return {
    status,
    sent: result.native_write_sent === true,
    ...(result.observed_value
      ? { observed_value: result.observed_value.value }
      : {}),
    change_ref: result.change_ref,
    restore_supported: result.restore_supported === true,
    ...(result.restore_limitation
      ? { restore_limitation: result.restore_limitation }
      : {}),
    ...(result.conflict_reason
      ? { conflict_reason: result.conflict_reason }
      : {}),
    ...(result.local_state ? { local_state: result.local_state } : {}),
    ...(status === "applied"
      ? {}
      : { next: nativeChangeNext(result.change_ref) }),
  };
}

export function deviceCommandFailure(change, error) {
  const code = error instanceof SprutHubError ? error.code : "internal_error";
  let status = "uncertain";
  if (
    change === undefined ||
    change.status === "prepared" ||
    code === "state_storage_unavailable"
  ) {
    status = "not_sent";
  } else if (change.status === "not_applied") {
    status = error.requestSent === true ? "rejected" : "not_sent";
  }
  const changeRef = change ? `spruthub-change://native/${change.id}` : null;
  const rejection = status === "rejected" ? writeRejection(error) : undefined;
  return {
    status,
    sent: status === "rejected" || status === "uncertain",
    change_ref: changeRef,
    restore_supported: false,
    error: {
      code,
      message:
        error instanceof SprutHubError
          ? error.message
          : "The command failed inside sprut-agent.",
      ...(error instanceof SprutHubError && error.action
        ? { action: error.action }
        : {}),
    },
    ...(rejection ? { rejection } : {}),
    ...(status === "uncertain" ? { next: nativeChangeNext(changeRef) } : {}),
  };
}

export function deviceCommandsResult(homeRef, results, groupReference) {
  const summary = {
    total: results.length,
    applied: 0,
    already_desired: 0,
    uncertain: 0,
    conflict: 0,
    rejected: 0,
    not_sent: 0,
  };
  for (const { status } of results) summary[status] += 1;
  return {
    status:
      summary.applied + summary.already_desired === summary.total
        ? "ok"
        : "incomplete",
    home_ref: homeRef,
    ...(groupReference ? { group_ref: groupReference } : {}),
    summary,
    results,
    limitations: [
      "observed_value is a read of the device after its commands; it cannot prove the command caused it.",
      "restore_native_change with group_ref puts back the previous values of this call's commands, each only while its device still shows the value sent; past physical effects are not undone.",
    ],
  };
}
