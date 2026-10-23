import { isDeepStrictEqual } from "node:util";
import { canonicalBlock, withHiddenHttpUrls } from "./block-model.mjs";
import { inspectPauseOwnership } from "./block-pause.mjs";
import { storedScenarioRunPlan } from "./block-validation.mjs";
import { valuesEqual } from "./change-contracts.mjs";
import { isRecord, writeRejection } from "./change-refs.mjs";
import {
  blockUpdateFields,
  createdLogicMapping,
  logicScenarioSnapshot,
  logicSourceObservation,
  logicSourceRequestedSnapshot,
  scenarioFieldsOwned,
  sourceFingerprint,
  withoutRuntimeActive,
  withoutUnownedOptions,
} from "./logic-changes.mjs";
import {
  freshVerification,
  nativeScenarioDescription,
  scenarioOptionValue,
} from "./native-values.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export function classifyScenarioRunDelivery(error) {
  if (error instanceof SprutHubError && error.requestSent === false) {
    error.action = "restore_connection_then_prepare_native_change";
    return { status: "not_sent", failure: scenarioRunFailure(error) };
  }
  if (writeRejection(error)) {
    return { status: "rejected", rejection: scenarioRunFailure(error) };
  }
  return { status: "unknown" };
}

export function scenarioRunFailure(error) {
  return {
    code: error.code,
    ...(error.protocolErrorCode !== undefined
      ? { protocol_code: error.protocolErrorCode }
      : {}),
    ...(error.action ? { action: error.action } : {}),
  };
}

export function scenarioRunObservationResult(change, observations) {
  if (!storedScenarioRunPlan(change).effect.predicted) {
    // Values that differ from a conditional or code action are not a failure.
    return "command_acknowledged_effect_not_predicted";
  }
  if (observations.every(({ matches }) => matches === true)) {
    return "command_acknowledged_and_target_values_observed";
  }
  const hasDifference = observations.some(({ matches }) => matches === false);
  const hasIncompleteReadback = observations.some(
    ({ matches }) => matches === null,
  );
  if (hasDifference && hasIncompleteReadback) {
    return "command_acknowledged_with_target_value_difference_and_incomplete_readback";
  }
  return hasDifference
    ? "command_acknowledged_with_target_value_difference"
    : "command_acknowledged_with_incomplete_target_readback";
}

export function scenarioSnapshot(scenario) {
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.desc !== "string" ||
    typeof scenario.active !== "boolean" ||
    typeof scenario.onStart !== "boolean" ||
    typeof scenario.sync !== "boolean" ||
    typeof scenario.type !== "string" ||
    typeof scenario.data !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incomplete scenario configuration.",
    );
  }
  let data;
  try {
    data = JSON.parse(scenario.data);
  } catch {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned invalid BLOCK data.",
    );
  }
  return nativeScenarioConfiguration(scenario, data);
}

// BLOCK data is parsed so hub projections do not look like edits. Other types
// keep only a fingerprint of their source: a run needs equality alone, and
// LOGIC code often holds tokens that must not reach the local journal.
export function runnableScenarioSnapshot(scenario) {
  if (isRecord(scenario) && scenario.type === "BLOCK") {
    return scenarioSnapshot(scenario);
  }
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.active !== "boolean" ||
    typeof scenario.type !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incomplete scenario configuration.",
    );
  }
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc ?? null,
    active: scenario.active,
    onStart: scenario.onStart ?? null,
    sync: scenario.sync ?? null,
    type: scenario.type,
    data_sha256: scenarioSourceFingerprint(scenario.data),
  };
}

export function scenarioSourceFingerprint(data) {
  if (data === undefined || data === null) return null;
  return sourceFingerprint(
    typeof data === "string" ? data : JSON.stringify(data),
  );
}

// scenario_run compares the whole snapshot: a scenario turned off after
// preparation must not be run. Runs prepared by earlier versions saved the
// source of other types itself, so it is fingerprinted before comparing.
export function runSnapshotsEqual(current, saved) {
  return isDeepStrictEqual(
    comparableRunSnapshot(current),
    comparableRunSnapshot(saved),
  );
}

export function comparableRunSnapshot(snapshot) {
  if (snapshot.type === "BLOCK") {
    return comparableNativeScenarioConfiguration(snapshot);
  }
  const { data, data_sha256: fingerprint, ...configuration } = snapshot;
  return {
    ...configuration,
    data_sha256: Object.hasOwn(snapshot, "data")
      ? scenarioSourceFingerprint(data)
      : fingerprint,
  };
}

export function nativeScenarioConfiguration(scenario, data) {
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc,
    active: scenario.active,
    onStart: scenario.onStart,
    sync: scenario.sync,
    type: scenario.type,
    data,
  };
}

export function isLogicSourceChange(change) {
  return ["logic_source_create", "logic_source_update"].includes(change.kind);
}

export function isBlockChange(change) {
  return ["block_create", "block_data_update", "block_action_pause"].includes(
    change.kind,
  );
}

export const SCENARIO_CREATE_KINDS = new Set([
  "block_create",
  "logic_source_create",
]);

// The scenario a change belongs to in the agent's chain of changes of it.
export function scenarioChainIndex(change) {
  let index;
  if (change.kind === "window_option") {
    index = change.owner_kind === "scenario" ? change.owner_index : undefined;
  } else if (SCENARIO_CREATE_KINDS.has(change.kind)) {
    index = change.scenario_index;
  } else if (
    ["block_data_update", "block_action_pause", "logic_source_update"].includes(
      change.kind,
    )
  ) {
    index = change.target?.index;
  }
  return index === undefined || index === null ? undefined : String(index);
}

// The fields this change set that the scenario no longer holds as the
// change left them (expected, its applied snapshot by default): a pause is
// read as a whole. undefined when the scenario is gone or of another type.
export function scenarioFieldsDiffering(
  change,
  scenario,
  expected = change.applied_snapshot,
) {
  if (!isRecord(scenario)) return undefined;
  if (change.kind === "block_action_pause") return scenarioFieldsOwned(change);
  if (expected === undefined) return undefined;
  let now;
  let then;
  try {
    [now, then] = isBlockChange(change)
      ? [scenarioSnapshot(scenario), expected].map(
          comparableNativeScenarioConfiguration,
        )
      : [logicScenarioSnapshot(scenario), expected];
  } catch (error) {
    if (error instanceof SprutHubError) return undefined;
    throw error;
  }
  if (now.type !== then.type) return undefined;
  return scenarioFieldsOwned(change).filter(
    (field) => !isDeepStrictEqual(now[field], then[field]),
  );
}

// The scenario still holds what this change of it set.
export function scenarioEditHolds(change, scenario) {
  try {
    if (change.kind === "window_option") {
      return (
        scenario.type === (change.owner_type ?? "BLOCK") &&
        valuesEqual(
          scenarioOptionValue(scenario, change.option_key),
          change.requested_value,
        )
      );
    }
    return scenarioChangeObservation(
      change,
      { scenario, logicTypes: [] },
      "applied",
    ).matches;
  } catch (error) {
    if (error instanceof SprutHubError) return false;
    throw error;
  }
}

export function scenarioChangeObservation(change, current, snapshot) {
  const expectedSnapshot = snapshot === "restored" ? "baseline" : snapshot;
  return isLogicSourceChange(change)
    ? logicSourceObservation(change, current, snapshot)
    : blockSnapshotObservation(change, current.scenario, expectedSnapshot);
}

export function scenarioChangeSnapshot(change, scenario) {
  return isLogicSourceChange(change)
    ? logicScenarioSnapshot(scenario)
    : scenarioSnapshot(scenario);
}

// What a write of this change leaves on the hub, field by field as an
// applied snapshot holds it: what an apply not yet seen would show.
export function scenarioRequestedSnapshot(change) {
  if (isLogicSourceChange(change)) return logicSourceRequestedSnapshot(change);
  // A create the hub acknowledged has its index even when the read after
  // it failed; its Desc carries the ownership marker.
  if (change.kind === "block_create") {
    return {
      ...blockCreateRequest(change),
      data: change.requested_snapshot.data,
    };
  }
  return change.requested_snapshot;
}

export function blockCreateRequest(change) {
  return {
    name: change.requested_snapshot.name,
    desc: nativeScenarioDescription(
      change.requested_snapshot.desc,
      change.marker,
    ),
    active: change.requested_snapshot.active,
    onStart: change.requested_snapshot.onStart,
    sync: change.requested_snapshot.sync,
    type: "BLOCK",
    data: JSON.stringify(change.requested_snapshot.data),
  };
}

export function blockUpdateWritesData(change) {
  if (change.kind === "block_data_update") {
    return blockUpdateFields(change).includes("data");
  }
  return isBlockChange(change);
}

export function scenarioUpdateFields(change, snapshot) {
  const fields = {};
  for (const field of blockUpdateFields(change)) {
    if (field === "data") fields.data = JSON.stringify(snapshot.data);
    else fields[field] = snapshot[field];
  }
  return fields;
}

export function blockDataUpdateDiff(change) {
  const diff = {};
  const written = blockUpdateFields(change);
  if (written.includes("name")) {
    diff.name = {
      changed: change.baseline_snapshot.name !== change.requested_snapshot.name,
      from: change.baseline_snapshot.name,
      to: change.requested_snapshot.name,
    };
  }
  if (written.includes("desc")) {
    diff.description = {
      changed: change.baseline_snapshot.desc !== change.requested_snapshot.desc,
      from: change.baseline_snapshot.desc,
      to: change.requested_snapshot.desc,
    };
  }
  if (written.includes("data")) {
    diff.data = {
      changed: !isDeepStrictEqual(
        canonicalBlock(change.baseline_snapshot.data),
        canonicalBlock(change.requested_snapshot.data),
      ),
      from: withHiddenHttpUrls(change.baseline_snapshot.data),
      to: withHiddenHttpUrls(change.requested_snapshot.data),
    };
  }
  return diff;
}

export function blockCreateSnapshot(change) {
  const request = blockCreateRequest(change);
  return {
    ...request,
    data: withHiddenHttpUrls(change.requested_snapshot.data),
  };
}

// Flags of the first readback after create. active may differ from the
// request without costing ownership: it belongs to scenario_active.
export function blockCreateObservedFlags(change) {
  const observed = change.applied_snapshot;
  if (!observed) return {};
  const requested = change.requested_snapshot;
  return {
    observed_at_create: {
      active: observed.active,
      onStart: observed.onStart,
      sync: observed.sync,
    },
    flags_exact_match:
      observed.active === requested.active &&
      observed.onStart === requested.onStart &&
      observed.sync === requested.sync,
  };
}

export function blockMatchesRequested(change, scenario) {
  if (!scenario) return false;
  const current = scenarioSnapshot(scenario);
  if (["block_data_update", "block_action_pause"].includes(change.kind)) {
    if (!change.requested_snapshot) return false;
    return blockConfigurationsEqual(change, current, change.requested_snapshot);
  }
  const expected = blockCreateRequest(change);
  return (
    current.name === expected.name &&
    current.desc === expected.desc &&
    current.onStart === expected.onStart &&
    current.sync === expected.sync &&
    current.type === expected.type &&
    isDeepStrictEqual(
      canonicalBlock(current.data),
      canonicalBlock(change.requested_snapshot.data),
    )
  );
}

export function blockStillAtBaseline(change, scenario) {
  if (change.kind === "block_create") return scenario === null;
  const baseline = change.restore_snapshot ?? change.baseline_snapshot;
  return (
    scenario !== null &&
    blockConfigurationsEqual(change, scenarioSnapshot(scenario), baseline)
  );
}

export function blockMatchesApplied(change, scenario) {
  if (change.kind === "block_action_pause" && scenario !== null) {
    const current = scenarioSnapshot(scenario);
    return (
      inspectPauseOwnership(current.data, [change]).get(change.id)?.state ===
      "owned"
    );
  }
  return (
    scenario !== null &&
    change.applied_snapshot !== undefined &&
    blockConfigurationsEqual(
      change,
      scenarioSnapshot(scenario),
      change.applied_snapshot,
    )
  );
}

export function blockMatchesBaseline(change, scenario) {
  if (change.kind === "block_create") return scenario === null;
  return blockStillAtBaseline(change, scenario);
}

function blockHoldsCode(value) {
  if (Array.isArray(value)) return value.some(blockHoldsCode);
  if (!isRecord(value)) return false;
  return value.type === "code" || Object.values(value).some(blockHoldsCode);
}

export function blockSnapshotObservation(change, scenario, snapshot) {
  let matches;
  if (snapshot === "baseline") {
    matches = blockMatchesBaseline(change, scenario);
  } else if (snapshot === "applied") {
    matches = blockMatchesApplied(change, scenario);
  } else if (snapshot === "requested") {
    matches = blockMatchesRequested(change, scenario);
  } else {
    throw new TypeError(`Unknown BLOCK snapshot ${snapshot}.`);
  }
  const result = `${snapshot}_configuration`;
  return {
    matches,
    fields: {
      // The hub's error after a write of code: a code node did not compile
      // (2026-10-23-scenario-code 2.9-2.12).
      ...(snapshot !== "baseline" &&
      isRecord(scenario) &&
      blockHoldsCode(change.requested_snapshot?.data)
        ? { hub_code_error: scenario.error === true }
        : {}),
      configuration_matches: matches,
      last_verification: freshVerification(
        matches ? result : `${result}_missing`,
      ),
    },
  };
}

export function pauseHasNoProvenHubEffect(change) {
  // Deadline and native_write_sent are stored before the hub RPC. Either is
  // evidence apply started; a missing wrapper is then not "never applied".
  return (
    change.native_write_sent !== true &&
    change.applied_snapshot === undefined &&
    !Number.isSafeInteger(change.pause_expires_at_ms)
  );
}

export function scenarioLacksProvenApply(change) {
  // Lost write ownership: a later requested match is coincidence, not restore rights.
  return change.status === "conflict" && change.applied_snapshot === undefined;
}

export function scenarioRestoreSupported(change) {
  if (scenarioLacksProvenApply(change)) return false;
  if (change.owned_target_absent_observed === true) return false;
  if (
    ["block_create", "logic_source_create"].includes(change.kind) &&
    change.status === "restored"
  ) {
    return false;
  }
  if (
    change.kind === "logic_source_create" &&
    createdLogicMapping(change).status !== "mapped"
  ) {
    return false;
  }
  return true;
}

export function scenarioUnprovenApplyFields(change, current) {
  const requested = scenarioChangeObservation(change, current, "requested");
  return {
    ...requested.fields,
    configuration_matches: false,
  };
}

export function unprovenApplyNext(change) {
  return {
    tool: "get_native_change_contract",
    arguments: {
      operation: change.kind,
      target_ref: change.target_ref,
    },
  };
}

export function scenarioConflictAsksForNewPrepare(change) {
  // Conflict is a lifecycle status. Only these reasons mean "prepare a new
  // change"; assignment-blocked restore still needs the current dependency.
  return (
    change.status === "conflict" &&
    (scenarioLacksProvenApply(change) ||
      change.conflict_reason === "manual_change" ||
      change.conflict_reason === "baseline_changed")
  );
}

// Shown only while the restore is blocked by them; a later get or restore
// that finds none replaces the conflict.
export function publicScenarioTargetReferences(change) {
  return change.status === "conflict" &&
    change.conflict_reason === "scenario_targets_present"
    ? {
        referencing_scenario_targets: structuredClone(
          change.referencing_scenario_targets,
        ),
      }
    : {};
}

export function unprovenApplyLimitation() {
  return "This change has no proven applied snapshot, so apply will not be sent again and restore is not allowed. Prepare a new authorized change from the current hub configuration.";
}

export function ownedTargetAbsentLimitation() {
  return "A saved absence of this created scenario at its recorded index ends restore for this change; a later copy is not deleted.";
}

export function scenarioRepeatApplyLimitation() {
  return "This change was already applied, so apply will not be sent again. Prepare a new authorized change from the current hub configuration.";
}

export function snapshotsEqual(left, right) {
  return isDeepStrictEqual(
    comparableNativeScenarioConfiguration(left),
    comparableNativeScenarioConfiguration(right),
  );
}

export function blockConfigurationsEqual(change, left, right) {
  return snapshotsEqual(
    withoutUnownedOptions(change, withoutRuntimeActive(left)),
    withoutUnownedOptions(change, withoutRuntimeActive(right)),
  );
}

export function comparableNativeScenarioConfiguration(snapshot) {
  // Compare identity plus ScenarioCreateRequest/ScenarioUpdateRequest fields.
  // ScenarioMessage rooms, iconsIf/iconsThen, error, order and bundleId are
  // hub projections or runtime diagnostics, not editable configuration.
  return nativeScenarioConfiguration(snapshot, canonicalBlock(snapshot.data));
}

// What a BLOCK does on its triggers, one key per trigger and characteristic
// it sets on it: the trigger condition, the branch, the characteristic and
// value set, and the delay before it. Only characteristic triggers, daily
// intervals and time triggers of top-level ifs count; a BLOCK that is only
// run by hand or by another scenario has none.
export function blockRuleEffects(data) {
  const effects = new Map();
  const block = canonicalBlock(data);
  for (const target of Array.isArray(block?.targets) ? block.targets : []) {
    if (target?.type !== "if") continue;
    const triggers = ruleTriggers(target.if);
    for (const [branch, actions] of [
      ["then", target.then],
      ["else", target.else],
    ]) {
      for (const action of ruleActions(actions, 0)) {
        for (const trigger of triggers) {
          const effect = { trigger, branch, ...action };
          effects.set(JSON.stringify(effect), effect);
        }
      }
    }
  }
  return effects;
}

function ruleTriggers(node) {
  if (node?.type === "condition" && Array.isArray(node.conditions)) {
    return node.conditions.flatMap(ruleTriggers);
  }
  if (node?.type === "characteristic" && node.trigger === true) {
    const { aId, sId, cId, cond, value } = node;
    return [{ aId, sId, cId, cond, value }];
  }
  if (
    (node?.type === "interval" && node.trigger === true) ||
    node?.type === "cron"
  ) {
    return [node];
  }
  return [];
}

function ruleActions(actions, delay) {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action) => {
    if (action?.type === "delay") {
      return ruleActions(action.targets, delay + (action.time ?? 0));
    }
    if (action?.type !== "service" || !Array.isArray(action.characteristics)) {
      return [];
    }
    return action.characteristics
      .filter((setting) => setting?.type === "set")
      .map((setting) => ({
        aId: action.aId,
        sId: action.sId,
        cId: setting.cId,
        value: setting.value,
        delay,
      }));
  });
}

// How a stored BLOCK relates to a requested one: same (the same data),
// superset (it already sets everything the request sets on the same
// triggers, and maybe more), partial (some of it), or null.
export function existingRuleRelation(stored, requested, requestedEffects) {
  const storedEffects = blockRuleEffects(stored);
  const shared = [...requestedEffects.keys()].filter((key) =>
    storedEffects.has(key),
  );
  if (shared.length === 0) return null;
  if (isDeepStrictEqual(canonicalBlock(stored), canonicalBlock(requested))) {
    return "same";
  }
  return shared.length === requestedEffects.size ? "superset" : "partial";
}
