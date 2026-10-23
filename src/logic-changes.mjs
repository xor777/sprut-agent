import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { configuredHomeRef, isRecord, stableJson } from "./change-refs.mjs";
import { readLogicInfo } from "./logic-info.mjs";
import {
  freshVerification,
  logicActiveValue,
  SCENARIO_METADATA_OPTIONS,
} from "./native-values.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export const SCENARIO_OPTION_FIELDS = ["name", "desc", "onStart", "sync"];

export const LOGIC_CODE_FIELDS = ["name", "desc", "onStart", "data"];

// Scenarios whose data is source code that logic_source_update writes. A
// GLOBAL's code sets nothing but itself: its name, description and flags
// change only in its options window (2026-10-13-wave4-contracts 1.8).
export const CODE_SCENARIO_TYPES = ["LOGIC", "GLOBAL"];

export function notCodeScenario() {
  return new SprutHubError(
    "unsupported_scenario_type",
    "logic_source_update writes the code of a LOGIC or a GLOBAL; a BLOCK changes with block_data_update. Nothing was prepared.",
    "get_native_change_contract",
  );
}

export function isGlobalCodeChange(change) {
  return (
    change.kind === "logic_source_update" &&
    change.baseline_snapshot?.type === "GLOBAL"
  );
}

// The fields of a scenario a change sets, which are the ones it checks to
// know it still holds. A BLOCK's data and a LOGIC's code are written apart
// from the name, description, start on boot and sequential run, which the
// options window changes (research/protocol/2026-10-13-wave4-contracts.md
// 1.3, 1.10). A LOGIC's code sets its name, description and onStart from
// info on every code write (1.5), so its code owns those three too; its
// sync is not in the code. A create sets all of them. active belongs to
// scenario_active.
export function scenarioFieldsOwned(change) {
  if (change.kind === "window_option") {
    return [SCENARIO_METADATA_OPTIONS[change.option_key].field];
  }
  if (change.kind === "logic_source_update") {
    return isGlobalCodeChange(change) ? ["data"] : LOGIC_CODE_FIELDS;
  }
  if (change.kind === "block_data_update") {
    // A record from before the options window wrote name and desc too.
    return [...new Set([...blockUpdateFields(change), "data"])];
  }
  if (change.kind === "block_action_pause") return ["data"];
  return [...SCENARIO_OPTION_FIELDS, "data"];
}

// The scenario's name, description, start on boot and sequential run are
// compared only where the change sets them.
export function withoutUnownedOptions(change, configuration) {
  const owned = scenarioFieldsOwned(change);
  return Object.fromEntries(
    Object.entries(configuration).filter(
      ([field]) =>
        !SCENARIO_OPTION_FIELDS.includes(field) || owned.includes(field),
    ),
  );
}

// The hub's scenario SDK, read before LOGIC code is written.
export function sdkNext(serial) {
  return {
    tool: "get_entity",
    arguments: { entity_ref: configuredHomeRef(serial), include: ["sdk"] },
  };
}

export function requiredLogicSource(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SprutHubError(
      "invalid_native_change",
      "LOGIC source must be a non-empty string.",
      "get_entity",
    );
  }
  return value;
}

export function logicSourceWithOwnershipMarker(source, marker) {
  return `${source}\n\n/* [${marker}] */`;
}

export function logicSourceCarriesOwnershipMarker(change, scenario) {
  return (
    isRecord(scenario) &&
    scenario.type === "LOGIC" &&
    typeof scenario.data === "string" &&
    scenario.data.includes(`/* [${change.marker}] */`)
  );
}

export function sourceFingerprint(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function logicScenarioSnapshot(scenario) {
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.desc !== "string" ||
    typeof scenario.active !== "boolean" ||
    typeof scenario.onStart !== "boolean" ||
    typeof scenario.sync !== "boolean" ||
    !CODE_SCENARIO_TYPES.includes(scenario.type) ||
    typeof scenario.data !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incomplete LOGIC source configuration.",
    );
  }
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc,
    active: scenario.active,
    onStart: scenario.onStart,
    sync: scenario.sync,
    type: scenario.type,
    data: scenario.data,
  };
}

export function logicSourceCreateRequest(change) {
  return {
    name: change.requested_snapshot.name,
    desc: `${change.requested_snapshot.desc}\n\n[${change.marker}]`,
    active: change.requested_snapshot.active,
    onStart: change.requested_snapshot.onStart,
    sync: change.requested_snapshot.sync,
    type: "LOGIC",
    data: change.requested_snapshot.data,
    expand: "data",
  };
}

export function logicSourceRequestedSnapshot(change) {
  if (change.kind === "logic_source_update") {
    return change.requested_snapshot;
  }
  const request = logicSourceCreateRequest(change);
  return {
    name: request.name,
    desc: request.desc,
    active: request.active,
    onStart: request.onStart,
    sync: request.sync,
    type: request.type,
    data: request.data,
  };
}

export function logicEditableSnapshot(snapshot) {
  return {
    name: snapshot.name,
    desc: snapshot.desc,
    active: snapshot.active,
    onStart: snapshot.onStart,
    sync: snapshot.sync,
    type: snapshot.type,
    data: snapshot.data,
  };
}

export function logicSnapshotMatches(change, scenario, expected) {
  const comparable = (snapshot) =>
    withoutUnownedOptions(
      change,
      withoutRuntimeActive(logicEditableSnapshot(snapshot)),
    );
  return (
    scenario !== null &&
    isDeepStrictEqual(
      comparable(logicScenarioSnapshot(scenario)),
      comparable(expected),
    )
  );
}

export function logicSourceWriteMatches(scenario, expected) {
  if (scenario === null) return false;
  const snapshot = logicScenarioSnapshot(scenario);
  return snapshot.data === expected.data;
}

export function logicEditableFlagsMatch(scenario, expected) {
  return (
    scenario !== null &&
    isDeepStrictEqual(
      publicLogicEditableFlags(logicScenarioSnapshot(scenario)),
      publicLogicEditableFlags(expected),
    )
  );
}

export function logicSourceObservation(change, current, snapshot) {
  let matches;
  let expected;
  if (snapshot === "baseline") {
    if (change.kind === "logic_source_create") {
      const type = createdLogicType(change);
      matches =
        current.scenario === null &&
        !(type !== undefined && logicTypeListed(current.logicTypes, type));
    } else {
      expected = change.baseline_snapshot;
      matches = logicSnapshotMatches(change, current.scenario, expected);
    }
  } else if (snapshot === "requested") {
    expected = logicSourceRequestedSnapshot(change);
    matches = logicSourceWriteMatches(current.scenario, expected);
  } else if (snapshot === "applied") {
    expected = change.applied_snapshot;
    matches =
      expected !== undefined &&
      logicSnapshotMatches(change, current.scenario, expected);
  } else if (snapshot === "restored") {
    if (change.kind === "logic_source_create") {
      const type = createdLogicType(change);
      matches =
        current.scenario === null &&
        !(type !== undefined && logicTypeListed(current.logicTypes, type));
    } else {
      expected = change.baseline_snapshot;
      matches = logicSourceWriteMatches(current.scenario, expected);
    }
  } else {
    throw new TypeError(`Unknown LOGIC source snapshot ${snapshot}.`);
  }
  const observedSource =
    current.scenario && typeof current.scenario.data === "string"
      ? current.scenario.data
      : undefined;
  return {
    matches,
    fields: {
      configuration_matches: matches,
      ...(observedSource !== undefined
        ? {
            observed_source_sha256: sourceFingerprint(observedSource),
            source_exact_match:
              expected !== undefined && observedSource === expected.data,
          }
        : {}),
      // The hub's error after a code write: the stored code did not
      // compile or run through (2026-10-23-scenario-code 3.7-3.9).
      ...(snapshot !== "baseline" && isRecord(current.scenario)
        ? { hub_code_error: current.scenario.error === true }
        : {}),
      ...(["requested", "restored"].includes(snapshot) &&
      current.scenario !== null
        ? {
            ...(expected !== undefined
              ? {
                  editable_flags_exact_match: logicEditableFlagsMatch(
                    current.scenario,
                    expected,
                  ),
                }
              : {}),
            observed_editable_flags: publicLogicEditableFlags(
              logicScenarioSnapshot(current.scenario),
            ),
          }
        : {}),
      last_verification: freshVerification(
        matches
          ? `${snapshot}_logic_source`
          : `${snapshot}_logic_source_missing`,
      ),
    },
  };
}

// SprutHub 3.0.0 (owner hub, 2026-09-24, research/protocol/
// 2026-09-24-live-conformance-3.md): a user LOGIC's native type is the string
// of its scenario index. While the LOGIC is on, its anchor's logic.types
// lists {type: index, name: scenario name, desc}, and the name follows a
// rename; a turned-off LOGIC is not listed there. So the type comes from the
// index, for records of earlier versions too, and each read with the LOGIC
// present checks it: an entry of that type named unlike the scenario means
// the identity does not hold here, and nothing is mapped (fail closed).
export function createdLogicType(change) {
  return change.scenario_index === undefined
    ? undefined
    : String(change.scenario_index);
}

// entries is null when the anchor service is gone.
export function logicTypeListed(entries, type) {
  return entries?.some((entry) => entry.type === type) === true;
}

// The latest read's view of the type on the anchor: listed with the
// scenario's name, not listed while the LOGIC is off or on, or listed with
// another name. A scenario at the index without this change's ownership
// marker is another one, or this one with the marker removed from its
// source; nothing shows which, so its type is not this change's. With no
// scenario at the index the type names nothing.
export function recordLogicTypeCheck(change, current) {
  const type = createdLogicType(change);
  if (type === undefined) return;
  if (current.scenario === null) {
    change.logic_type_check = "absent";
    return;
  }
  if (!logicSourceCarriesOwnershipMarker(change, current.scenario)) {
    change.logic_type_check = "not_owned";
    return;
  }
  // The anchor is gone: nothing lists the type there. A name mismatch seen
  // before stays, since it was the only check of the identity.
  if (current.logicTypes === null) {
    if (change.logic_type_check !== "name_mismatch") {
      change.logic_type_check = "anchor_missing";
    }
    return;
  }
  const entry = current.logicTypes.find((item) => item.type === type);
  change.logic_type_check = entry
    ? entry.name === current.scenario.name
      ? "listed"
      : "name_mismatch"
    : current.scenario.active === true
      ? "not_listed"
      : "turned_off";
}

export function createdLogicMapping(change) {
  const type = createdLogicType(change);
  // Once the created LOGIC was seen gone, a scenario at its index later,
  // even an exact copy with the marker, is another LOGIC.
  if (
    type === undefined ||
    change.logic_type_check === "absent" ||
    change.owned_target_absent_observed === true
  ) {
    return { status: "missing", reason: "logic_scenario_not_found" };
  }
  if (change.logic_type_check === "name_mismatch") {
    return { status: "missing", reason: "logic_type_name_mismatch" };
  }
  if (change.logic_type_check === "not_owned") {
    return { status: "missing", reason: "logic_scenario_not_owned" };
  }
  const assignmentReady = change.logic_type_check === "listed";
  return {
    status: "mapped",
    type,
    assignmentReady,
    reason: assignmentReady
      ? undefined
      : change.logic_type_check === "anchor_missing"
        ? "logic_target_service_not_found"
        : change.logic_type_check === "turned_off"
          ? "logic_turned_off"
          : "logic_type_not_available_on_target",
  };
}

export function createdLogicRefusalDetails(change) {
  return {
    change_ref: `spruthub-change://native/${change.id}`,
    scenario_ref: `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`,
  };
}

// Why the assignments of this created LOGIC cannot be checked, or undefined.
export function createdLogicUnmappedRefusal(change) {
  const mapping = createdLogicMapping(change);
  if (mapping.status === "mapped") return undefined;
  const details = createdLogicRefusalDetails(change);
  const evidence =
    mapping.reason === "logic_type_name_mismatch"
      ? `SprutHub lists type ${createdLogicType(change)} on ${change.target_ref} under a name other than this LOGIC's`
      : `the scenario at ${details.scenario_ref} does not carry this change's ownership marker (it is another LOGIC at a reused index, or this one with the marker removed from its source)`;
  return new SprutHubError(
    mapping.reason,
    `${evidence}, so the type of the created LOGIC cannot be proven and its assignments cannot be checked. Restore will not delete it. The owner can delete it in the SprutHub app after checking that no device uses it.`,
    "get_native_change",
    details,
  );
}

// A restored create whose delete was not checked against the LOGIC's own
// type (its index): assignments of that type may remain on devices. This
// version checks the index before it sends a delete. Earlier versions
// checked the one new type seen right after the create while the LOGIC read
// turned on, or a type mapped by a later read, which no record keeps.
export function logicDeleteAssignmentCheckUnproven(change) {
  if (change.kind !== "logic_source_create" || change.status !== "restored") {
    return false;
  }
  const legacy = change.new_logic_types_after_create;
  const checked =
    change.logic_delete_checked_type ??
    (Array.isArray(legacy) &&
    legacy.length === 1 &&
    change.logic_active_after_create === true
      ? legacy[0]
      : undefined);
  return checked === undefined || checked !== createdLogicType(change);
}

// Inputs of logic_source_create that logic_source_update does not take,
// with where each is changed instead: the code's info, the options window
// or scenario_active.
export const LOGIC_SOURCE_METADATA_INPUTS = {
  name: "info.name",
  description: "info.description",
  on_start: "info.onStart",
  sync: "Sync",
  active: null,
};

export function logicSourceMetadataInput(targetRef, field) {
  const place = LOGIC_SOURCE_METADATA_INPUTS[field];
  const [message, next] = place?.startsWith("info.")
    ? [
        `logic_source_update writes only the code, and SprutHub ignores a scenario's ${field} sent with it; nothing was prepared. SprutHub sets the scenario's name, description and start on boot from info in the code on every code write: write ${place} in source as a plain value.`,
        { operation: "logic_source_update", target_ref: targetRef },
      ]
    : place
      ? [
          `logic_source_update writes only the code, and SprutHub ignores a scenario's ${field} sent with it; nothing was prepared. Sync is not in the code: prepare window_option Sync on the scenario ref.`,
          {
            operation: "window_option",
            target_ref: targetRef,
            option_key: place,
          },
        ]
      : [
          "logic_source_update writes only the code; nothing was prepared. Turn the scenario on or off with scenario_active.",
          { operation: "scenario_active", target_ref: targetRef },
        ];
  return new SprutHubError(
    "unsupported_logic_metadata",
    message,
    "get_native_change_contract",
    { next: { tool: "get_native_change_contract", arguments: next } },
  );
}

// SprutHub sets a LOGIC's name, description and start on boot from info in
// its code on every code write, even unchanged (research/protocol/
// 2026-10-13-wave4-contracts.md 1.5), so writing code, and writing the old
// code back on restore, may change them. They are read from info without
// running the code (readLogicInfo); a field info does not hold as a plain
// value is unknown.
export const LOGIC_INFO_METADATA = [
  { info: "name", field: "name", shown: "name", label: "name" },
  {
    info: "description",
    field: "desc",
    shown: "description",
    label: "description",
  },
  {
    info: "onStart",
    field: "onStart",
    shown: "on_start",
    label: "start on boot",
  },
];

// Read-only facts for a code update, nothing is refused by them:
// code_sets, the values writing source sets that differ from the scenario
// now; restore_code_sets, the values writing back the code from before
// (restore) sets instead of those the scenario had before the change, as a
// name given in the app that the old code's info does not hold; warnings
// for a value set back from an unchanged info and for unknown values.
export function logicCodeInfoEffects(baseline, source) {
  const written = readLogicInfo(source);
  const restored = readLogicInfo(baseline.data);
  const snapshot = {};
  const codeSets = [];
  const restoreCodeSets = [];
  const warnings = [];
  const unknown = { written: [], restored: [] };
  for (const { info, field, shown, label } of LOGIC_INFO_METADATA) {
    const before = baseline[field];
    if (Object.hasOwn(written.values, info)) {
      const to = written.values[info];
      snapshot[field] = to;
      if (to !== before) {
        codeSets.push({ field: shown, from: before, to });
        if (restored.values[info] === to) {
          warnings.push(
            `This code write sets the ${label} back to ${JSON.stringify(to)} from info.${info}, which the code keeps: the ${JSON.stringify(before)} it had when this change was prepared was set outside the code. To keep that, write it into info.${info}.`,
          );
        }
      }
    } else {
      snapshot[field] = null;
      codeSets.push({ field: shown, from: before, unknown: true });
      unknown.written.push({ info, label });
    }
    if (Object.hasOwn(restored.values, info)) {
      const to = restored.values[info];
      if (to !== before) {
        restoreCodeSets.push({ field: shown, before_change: before, to });
        warnings.push(
          `Restore writes back the code from before this change, whose info.${info} sets the ${label} to ${JSON.stringify(to)}, not the ${JSON.stringify(before)} it had before this change, which was set outside the code.`,
        );
      }
    } else {
      restoreCodeSets.push({
        field: shown,
        before_change: before,
        unknown: true,
      });
      unknown.restored.push({ info, label });
    }
  }
  for (const [fields, info, after] of [
    [unknown.written, written, "after this write"],
    [
      unknown.restored,
      restored,
      "after restore, which writes back the code from before this change,",
    ],
  ]) {
    if (fields.length === 0) continue;
    // Why: info itself unreadable, or each field's own reason.
    const why =
      info.problem ??
      fields.map(({ info: key }) => info.problems[key]).join(", and ");
    warnings.push(
      `SprutHub sets the scenario's ${fields.map(({ label }) => label).join(", ")} from info in the code on every code write, and ${why}, so ${after} ${fields.length === 1 ? "it is" : "they are"} not known.`,
    );
  }
  return { snapshot, codeSets, restoreCodeSets, warnings };
}

export function logicAssignmentSnapshot(logic, options) {
  if (!isRecord(logic) || typeof logic.type !== "string") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic configuration.",
    );
  }
  if (!Array.isArray(options)) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic options.",
    );
  }
  const normalizedOptions = options
    .map((option) => logicOptionConfiguration(option))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (
    normalizedOptions.some(
      (option, index) => option.key === normalizedOptions[index - 1]?.key,
    )
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned the same logic option key more than once.",
    );
  }
  return {
    logic: {
      type: logic.type,
      active: logicActiveValue(logic).value,
    },
    options: normalizedOptions,
  };
}

export function logicOptionConfiguration(option) {
  if (
    !isRecord(option) ||
    typeof option.key !== "string" ||
    typeof option.type !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic option configuration.",
    );
  }
  const hasValue = Object.hasOwn(option, "value");
  return {
    key: option.key,
    type: option.type,
    value_present: hasValue,
    ...(hasValue
      ? { value_fingerprint: nativeConfigurationFingerprint(option.value) }
      : {}),
  };
}

export function logicAssignmentConfigurationObservation(created, current) {
  const differences = logicAssignmentConfigurationDifferences(created, current);
  const matches = differences === undefined;
  return {
    matches,
    fields: {
      configuration_matches: matches,
      configuration_differences: differences,
      last_verification: freshVerification(
        matches ? "created_configuration" : "created_configuration_changed",
      ),
    },
  };
}

export function logicAssignmentConfigurationDifferences(created, current) {
  const differences = {};
  if (created.logic.active !== current.logic.active) {
    differences.active = {
      created: created.logic.active,
      current: current.logic.active,
    };
  }
  const createdOptions = new Map(
    created.options.map((option) => [option.key, option]),
  );
  const currentOptions = new Map(
    current.options.map((option) => [option.key, option]),
  );
  const optionKeys = [
    ...new Set([...createdOptions.keys(), ...currentOptions.keys()]),
  ]
    .filter(
      (key) =>
        !isDeepStrictEqual(createdOptions.get(key), currentOptions.get(key)),
    )
    .sort((left, right) => left.localeCompare(right));
  if (optionKeys.length > 0) differences.option_keys = optionKeys;
  return Object.keys(differences).length > 0 ? differences : undefined;
}

export function nativeConfigurationFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function blockUpdateFields(change) {
  return change.update_fields ?? ["data"];
}

// active is a runtime flag owned by scenario_active and the SprutHub UI.
// Turning a scenario off or on is not an edit of the configuration that a
// BLOCK or LOGIC change owns, so their ownership checks leave it
// out on both sides; journals saved with active in their snapshots still match.
// The name, description, onStart and sync are left out the same way where
// the change does not set them (withoutUnownedOptions).
export function withoutRuntimeActive({ active: _active, ...configuration }) {
  return configuration;
}

export function publicLogicEditableFlags(snapshot) {
  return {
    name: snapshot.name,
    description: snapshot.desc,
    active: snapshot.active,
    on_start: snapshot.onStart,
    sync: snapshot.sync,
    type: snapshot.type,
  };
}
