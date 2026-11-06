import {
  hiddenLogicCode,
  hiddenLogicInfo,
  isHubReadFailure,
  SprutHubError,
} from "./spruthub-client.mjs";

// The operations of prepare_native_change and get_native_change_contract.
export const NATIVE_CHANGE_OPERATIONS = [
  "characteristic_value",
  "characteristic_option",
  "window_option",
  "characteristic_notify",
  "logic_assignment",
  "logic_active",
  "logic_option",
  "logic_source_create",
  "logic_source_update",
  "block_create",
  "block_data_update",
  "block_action_pause",
  "scenario_active",
  "scenario_run",
  "scenario_delete",
  "accessory_placement",
  "room_create",
  "room_name",
  "service_name",
  "service_visible",
  "virtual_light_group",
  "virtual_device",
  "virtual_device_delete",
];

export function parseRoomRef(ref, configuredSerial) {
  const scoped = /^spruthub:\/\/hub\/([^/]+)\/room\/(\d+)$/.exec(ref);
  if (!scoped) {
    throw new SprutHubError(
      "invalid_room_ref",
      "Use a home-qualified room reference returned by home_overview.",
      "home_overview",
    );
  }
  const serial = decodeReferenceSegment(scoped[1]);
  requireConfiguredHome(serial, configuredSerial);
  return Number(scoped[2]);
}

export function parseAccessoryRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)$/.exec(ref ?? "");
  if (!match) {
    throw new SprutHubError(
      "invalid_accessory_ref",
      "Use a home-qualified accessory reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { id: Number(match[2]) };
}

export function parseServiceRef(ref, configuredSerial) {
  const match =
    /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)\/service\/(\d+)$/.exec(
      ref ?? "",
    );
  if (!match) {
    throw new SprutHubError(
      "invalid_service_ref",
      "Use a home-qualified service reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { aId: Number(match[2]), sId: Number(match[3]) };
}

export function parseCharacteristicRef(ref, configuredSerial) {
  const scoped =
    /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/.exec(
      ref,
    );
  if (!scoped) {
    throw new SprutHubError(
      "invalid_characteristic_ref",
      "Use a characteristic reference returned by find_devices or get_entity.",
      "find_devices",
    );
  }
  const serial = decodeReferenceSegment(scoped[1]);
  requireConfiguredHome(serial, configuredSerial);
  return {
    aId: Number(scoped[2]),
    sId: Number(scoped[3]),
    cId: Number(scoped[4]),
  };
}

export function decodeReferenceSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SprutHubError(
      "invalid_characteristic_ref",
      "Use a home-qualified characteristic reference returned by get_entity.",
      "get_entity",
    );
  }
}

export function requireConfiguredHome(serial, configuredSerial) {
  if (configuredSerial !== undefined && serial !== configuredSerial) {
    throw unsupportedHomeWrite();
  }
}

export function unsupportedHomeWrite() {
  return new SprutHubError(
    "unsupported_home_write",
    "Automation writes are limited to the configured SprutHub home.",
    "select_configured_home",
  );
}

export function configuredHomeRef(serial) {
  return `spruthub://hub/${encodeURIComponent(serial)}`;
}

export function parseConfiguredHomeRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_home_ref",
      "Use a home reference returned by home_overview.",
      "home_overview",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return serial;
}

export function parseScenarioRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)\/scenario\/([^/]+)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_scenario_ref",
      "Use a home-qualified scenario reference from home_overview with list=scenarios.",
      "home_overview",
      { next: { tool: "home_overview", arguments: { list: "scenarios" } } },
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { index: decodeReferenceSegment(match[2]) };
}

export function parseWindowRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)\/window\/([^/]*)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_window_ref",
      "Use a home-qualified window reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { windowKey: decodeReferenceSegment(match[2]) };
}

export function assertWindowOptionWritable(windowKey) {
  if (windowKey !== "") return;
  throw new SprutHubError(
    "unsupported_window_option",
    "Home settings windows are read-only in this slice; clock, timezone, network, and security options cannot be changed through native write tools.",
    "get_entity",
  );
}

// The options of a scenario's options window that window_option writes
// on the scenario ref (SCENARIO_METADATA_OPTIONS); Active is
// scenario_active's.
export const SCENARIO_METADATA_KEYS = new Set([
  "Name",
  "Desc",
  "OnStart",
  "Sync",
]);

export function parseWindowOptionOwner(ref, configuredSerial) {
  try {
    return { kind: "scenario", ...parseScenarioRef(ref, configuredSerial) };
  } catch (error) {
    if (
      !(error instanceof SprutHubError) ||
      error.code !== "invalid_scenario_ref"
    ) {
      throw error;
    }
  }
  return { kind: "window", ...parseWindowRef(ref, configuredSerial) };
}

export function scenarioOwnerRequired(scenarioRef, optionKey = "Name") {
  return new SprutHubError(
    "scenario_owner_required",
    "A scenario's Name, Desc, OnStart and Sync are written through window_option with the owning scenario ref, which confirms them with scenario.get; nothing was sent.",
    "get_entity",
    scenarioRef
      ? {
          next: {
            tool: "get_native_change_contract",
            arguments: {
              operation: "window_option",
              target_ref: scenarioRef,
              option_key: optionKey,
            },
          },
        }
      : {},
  );
}

// SprutHub sets a LOGIC's name, description and start on boot from info in
// its code on every code write, also unchanged, and a write of its options
// window does not change info (research/protocol/2026-10-13-wave4-
// contracts.md 1.4, 1.5): the window would hold them only until the next
// code write, so they are changed in the code. In code the agent cannot
// read (hiddenLogicCode), the owner changes them in the SprutHub app.
export function logicInfoInCode(scenarioRef, optionKey, scenario) {
  if (hiddenLogicCode(scenario?.data)) {
    return new SprutHubError(
      "logic_info_in_code",
      `${hiddenLogicInfo(optionKey)} Nothing was sent.`,
    );
  }
  const field = { Name: "name", Desc: "description", OnStart: "onStart" }[
    optionKey
  ];
  return new SprutHubError(
    "logic_info_in_code",
    `A LOGIC's ${optionKey} is info.${field} in its code: SprutHub sets the scenario's name, description and start on boot from info on every code write, so a change in its options window would last only until the next one. Nothing was sent. Read the code (get_entity with include configuration), change info.${field} there as a plain value and leave the rest of the code as it is, then prepare logic_source_update with that code; its prepare lists in code_sets what the write sets. Sync is not in the code and changes with window_option.`,
    "get_entity",
    {
      next: {
        tool: "get_entity",
        arguments: { entity_ref: scenarioRef, include: ["configuration"] },
      },
    },
  );
}

export function scenarioActiveOwnerRequired(scenarioRef) {
  return new SprutHubError(
    "scenario_owner_required",
    "Active in a scenario's options window is that scenario's on/off flag. It is switched with scenario_active on the scenario ref, which confirms it with scenario.get as well as the window; nothing was sent.",
    "get_native_change_contract",
    scenarioRef
      ? {
          next: {
            tool: "get_native_change_contract",
            arguments: {
              operation: "scenario_active",
              target_ref: scenarioRef,
            },
          },
        }
      : {},
  );
}

export function unsupportedBlockMetadata(input) {
  return new SprutHubError(
    "unsupported_block_metadata",
    "block_data_update writes only data. Change Name or Desc with window_option using the scenario ref.",
    "get_native_change_contract",
    {
      next: {
        tool: "get_native_change_contract",
        arguments: {
          operation: "window_option",
          target_ref: input.target_ref,
          option_key: typeof input.name === "string" ? "Name" : "Desc",
        },
      },
    },
  );
}

// block_create and logic_source_create take an initial active flag, so agents
// switching an existing scenario or logic reach for it instead of value.
export function activeInsteadOfValue(input) {
  return new SprutHubError(
    "invalid_native_value",
    `${input.operation} takes the new on/off state in value; active only sets the initial flag of block_create and logic_source_create. Prepare again with value=${input.active}.`,
    "prepare_native_change",
    {
      next: {
        tool: "prepare_native_change",
        arguments: {
          operation: input.operation,
          target_ref: input.target_ref,
          value: input.active,
          reason: input.reason,
        },
      },
    },
  );
}

export function unsupportedBlockFlags(input) {
  const optionKey =
    input.on_start !== undefined
      ? "OnStart"
      : input.sync !== undefined
        ? "Sync"
        : undefined;
  return new SprutHubError(
    "unsupported_block_flags",
    "block_data_update writes only data; omit active, on_start and sync. Change OnStart (run when the hub starts) or Sync (run actions one after another) with window_option on the scenario ref, and turn the scenario on or off with scenario_active.",
    "get_native_change_contract",
    {
      next: {
        tool: "get_native_change_contract",
        arguments: optionKey
          ? {
              operation: "window_option",
              target_ref: input.target_ref,
              option_key: optionKey,
            }
          : { operation: "scenario_active", target_ref: input.target_ref },
      },
    },
  );
}

export function parseLogicRef(ref, configuredSerial) {
  const match =
    /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)\/service\/(\d+)\/logic\/([^/]+)$/.exec(
      ref,
    );
  if (!match) {
    throw new SprutHubError(
      "invalid_logic_ref",
      "Use a home-qualified logic reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  const type = decodeReferenceSegment(match[4]);
  if (type.length === 0) {
    throw new SprutHubError(
      "invalid_logic_ref",
      "Use a home-qualified logic reference returned by get_entity.",
      "get_entity",
    );
  }
  return {
    aId: Number(match[2]),
    sId: Number(match[3]),
    type,
  };
}

export function requireEntityHome(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)(?:\/|$)/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_entity_ref",
      "Use a home-qualified entity reference returned by SprutHub discovery.",
      "home_overview",
    );
  }
  requireConfiguredHome(decodeReferenceSegment(match[1]), configuredSerial);
}

export function scenarioNotFound() {
  return new SprutHubError(
    "scenario_not_found",
    "The selected SprutHub scenario was not found.",
    "home_overview",
  );
}

export function inactiveScenarioRun(targetRef) {
  return new SprutHubError(
    "scenario_inactive",
    "This scenario is turned off, so the run is not sent: SprutHub acknowledges a manual run of a turned-off BLOCK but runs none of its actions. scenario_active turns it on and also re-arms its triggers; do that only if the owner wants it on, then prepare scenario_run again.",
    "get_native_change_contract",
    {
      next: {
        tool: "get_native_change_contract",
        arguments: { operation: "scenario_active", target_ref: targetRef },
      },
    },
  );
}

// A manual run was observed for an action-only BLOCK; user LOGIC is run on
// the owner's decision. A GLOBAL run may execute its code again and register
// its cron jobs and subscriptions a second time, and built-in scenarios were
// never run, so other types wait for a live check.
export function isVerifiedRunType(snapshot) {
  return (
    ["BLOCK", "LOGIC"].includes(snapshot.type) && snapshot.predefined !== true
  );
}

export function unverifiedScenarioRunType(snapshot) {
  const kind =
    snapshot.predefined === true ? "built-in" : String(snapshot.type);
  return new SprutHubError(
    "scenario_run_unverified_type",
    `A manual run of a ${kind} scenario has not been verified on a SprutHub hub yet, so it is not sent: a GLOBAL run may execute its code again and register its timers and subscriptions a second time. Only BLOCK and user LOGIC scenarios are run. scenario_active can turn this scenario on or off; to run it now, ask the owner to run it in the SprutHub app.`,
  );
}

export function unsupportedScenarioType() {
  return new SprutHubError(
    "unsupported_scenario_type",
    "Only native BLOCK scenario data can be changed in this slice.",
  );
}

export function logicNotFound() {
  return new SprutHubError(
    "logic_not_found",
    "The selected native logic assignment was not found.",
    "get_entity",
  );
}

export function unsupportedNativeOperation() {
  return new SprutHubError(
    "unsupported_native_operation",
    "This native operation is not supported in the current slice.",
    "use_a_supported_operation",
    { supported_operations: NATIVE_CHANGE_OPERATIONS },
  );
}

// What every answer of sprut-agent shows in place of credential-shaped text
// (redactSensitiveText in spruthub-client.mjs). A BLOCK read through
// get_entity may carry it; it is never the owner's text or URL.
export const REDACTED_MARK = "[REDACTED]";

// Text with the mark that an agent writes is a copy of an answer, as a
// scenario Desc with a camera link read as [REDACTED]: written, it would
// replace the owner's name, description, value or source on the hub for
// good. BLOCK data has its own rules (validateBlockNode,
// restoreHiddenBlockStrings).
export function refuseRedactionMark(text, field) {
  if (typeof text !== "string" || !text.includes(REDACTED_MARK)) return;
  throw new SprutHubError(
    "invalid_native_value",
    `The ${field} contains ${REDACTED_MARK}, which sprut-agent shows in place of credential-shaped text; it is not the owner's text, and writing it would replace the stored text with the mark. Ask the owner for the full new ${field} and send it without ${REDACTED_MARK}.`,
  );
}

// The names, descriptions and LOGIC source a prepared change writes; its
// scalar value is checked again by validateCharacteristicValue.
export function refuseRedactedChangeTexts(change) {
  const requested = change.requested_snapshot;
  const texts = {
    accessory_placement: { name: requested?.name },
    room_create: { name: change.requested_name },
    virtual_light_group: { name: change.create_request?.name },
    virtual_device: { name: change.create_request?.name },
    block_create: { name: requested?.name, description: requested?.desc },
    logic_source_create: {
      name: requested?.name,
      description: requested?.desc,
      source: requested?.data,
    },
    logic_source_update: { source: requested?.data },
  }[change.kind];
  for (const [field, text] of Object.entries(texts ?? {})) {
    refuseRedactionMark(text, field);
  }
}

export function stableNativeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativeTargetKey({ aId, sId, cId }) {
  return `${aId}:${sId}:${cId}`;
}

export function nativeChangeNext(changeRef) {
  return { tool: "get_native_change", arguments: { change_ref: changeRef } };
}

export function groupRef(id) {
  return `spruthub-change://group/${id}`;
}

export function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseNativeChangeRef(ref) {
  const match = /^spruthub-change:\/\/native\/([a-f0-9]{24})$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_change_ref",
      "Use a change_ref from prepare_native_change, send_device_commands or the history (get_native_change without change_ref).",
      "get_native_change",
    );
  }
  return match[1];
}

export function parseRestoreRef(ref) {
  const match = /^spruthub-change:\/\/(native|group)\/([a-f0-9]{24})$/.exec(
    typeof ref === "string" ? ref : "",
  );
  if (!match) {
    throw new SprutHubError(
      "invalid_change_ref",
      "Use a change_ref or group_ref from send_device_commands, prepare_native_change or the history of get_native_change.",
      "get_native_change",
    );
  }
  return { type: match[1], id: match[2] };
}

export function serviceKey({ aId, sId }) {
  return `${aId}.${sId}`;
}

// An error reply to the write request means the hub received it and refused
// it, whatever the code. Only a transport-level unknown after sending (timeout,
// closed connection, unreadable or unrecognized reply) may have changed the
// home.
// A read the hub did not answer or refused (undoOrUnknown). A write the hub
// refused carries its rejection (finishRefusedWrite) and is not one.
export function isUnreadError(error) {
  return isHubReadFailure(error) && error.details?.rejection === undefined;
}

export function isUncertainWriteError(error) {
  return (
    error instanceof SprutHubError &&
    error.requestSent === true &&
    error.hubError === undefined
  );
}

export function writeRejection(error) {
  if (!(error instanceof SprutHubError) || error.hubError === undefined) {
    return undefined;
  }
  return {
    code: error.code,
    protocol_code: error.hubError.code,
    ...(error.hubError.message !== undefined
      ? { hub_message: error.hubError.message }
      : {}),
  };
}
