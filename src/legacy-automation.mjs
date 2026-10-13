import { isDeepStrictEqual } from "node:util";
import { canonicalBlock } from "./block-model.mjs";
import { changeRef } from "./change-refs.mjs";
import { withoutRuntimeActive } from "./logic-changes.mjs";

export function expectedScenario(change) {
  return {
    name: change.name,
    desc: `${change.reason}\n\n[${change.marker}]`,
    active: true,
    onStart: false,
    sync: false,
    type: "BLOCK",
    data: JSON.stringify(change.native_data),
  };
}

export function matchesExpected(scenario, change) {
  const expected = withoutRuntimeActive(expectedScenario(change));
  const metadataMatches = Object.entries(expected).every(
    ([key, value]) => key === "data" || scenario[key] === value,
  );
  if (!metadataMatches || typeof scenario.data !== "string") return false;
  try {
    return isDeepStrictEqual(
      canonicalBlock(JSON.parse(scenario.data)),
      canonicalBlock(change.native_data),
    );
  } catch {
    return false;
  }
}

export function matchesRequiredRuntime(scenario) {
  return (
    scenario.active === true &&
    scenario.onStart === false &&
    scenario.sync === false
  );
}

// The rule a BLOCK in canonicalBlock form expresses, or null when it is not
// one trigger condition setting one target (with an optional auto-off).
export function ruleMeaning(data) {
  const target = data?.targets?.length === 1 ? data.targets[0] : null;
  const condition =
    target?.if?.conditions?.length === 1 ? target.if.conditions[0] : null;
  const actions = target?.then;
  const action =
    Array.isArray(actions) && (actions.length === 1 || actions.length === 2)
      ? actions[0]
      : null;
  const setting =
    action?.characteristics?.length === 1 ? action.characteristics[0] : null;
  const delay = actions?.length === 2 ? actions[1] : null;
  const delayedAction = delay?.targets?.length === 1 ? delay.targets[0] : null;
  const delayedSetting =
    delayedAction?.characteristics?.length === 1
      ? delayedAction.characteristics[0]
      : null;
  if (
    target?.type !== "if" ||
    target.if?.type !== "condition" ||
    target.if.mode !== "AND" ||
    condition?.type !== "characteristic" ||
    action?.type !== "service" ||
    setting?.type !== "set" ||
    !Array.isArray(target.else) ||
    target.else.length !== 0 ||
    target.then_delay !== 0 ||
    target.else_delay !== 0 ||
    target.mode !== "EVERY"
  ) {
    return null;
  }
  if (
    delay !== null &&
    (delay?.type !== "delay" ||
      delay.index !== 1 ||
      !["RESET", "CONTINUE"].includes(delay.mode) ||
      !Number.isSafeInteger(delay.time) ||
      delay.time <= 0 ||
      delayedAction?.type !== "service" ||
      delayedSetting?.type !== "set")
  ) {
    return null;
  }
  return {
    condition: ruleCondition(condition),
    action: {
      aId: action.aId,
      sId: action.sId,
      hs: action.hs,
      cId: setting.cId,
      hc: setting.hc,
      value: setting.value,
    },
    ...(delay
      ? {
          auto_off: {
            index: delay.index,
            mode: delay.mode,
            time: delay.time,
            action: {
              aId: delayedAction.aId,
              sId: delayedAction.sId,
              hs: delayedAction.hs,
              cId: delayedSetting.cId,
              hc: delayedSetting.hc,
              value: delayedSetting.value,
            },
          },
        }
      : {}),
  };
}

export function ruleCondition(condition) {
  return {
    aId: condition.aId,
    sId: condition.sId,
    cId: condition.cId,
    value: condition.value,
    cond: condition.cond,
    trigger: condition.trigger,
    hs: condition.hs,
    hc: condition.hc,
    time: condition.time,
    timeCond: condition.timeCond,
  };
}

// Existing BLOCK scenarios that fire on the requested trigger and write the
// requested target, each with its relation to the requested rule.
export function relatedRules(scenarios, change, homeReference) {
  return scenarios.flatMap((scenario) => {
    const comparison = existingRuleRelation(scenario, change);
    if (!comparison) return [];
    return [
      {
        scenario,
        relation: comparison.relation,
        rule: {
          ref: `${homeReference}/scenario/${encodeURIComponent(scenario.index)}`,
          name: scenario.name,
          relation: comparison.relation,
          differences: comparison.differences,
        },
      },
    ];
  });
}

// equivalent: the same rule (runtime flags are listed as differences).
// superset: it already sets the target to the requested value on this
// trigger, with the requested auto-off if any, and does more (for example
// turns the target off later); a new rule would duplicate it.
// inactive_superset: such a rule that is turned off; it does not block.
// conflict: the same trigger and target with other behavior.
export function existingRuleRelation(scenario, change) {
  if (scenario.type !== "BLOCK" || typeof scenario.data !== "string") {
    return null;
  }
  // Both rules are read in canonicalBlock form, so a rule made in the web
  // client without mode, branch delays or else and with its OR group is the
  // rule it means.
  const requested = ruleMeaning(canonicalBlock(change.native_data));
  let data;
  try {
    data = canonicalBlock(JSON.parse(scenario.data));
  } catch {
    return null;
  }
  const existing = triggeredTargetRule(data, requested);
  if (!requested || !existing) return null;
  const runtime = runtimeDifferences(scenario);
  const candidate = ruleMeaning(data);
  if (
    candidate !== null &&
    JSON.stringify(candidate) === JSON.stringify(requested)
  ) {
    return { relation: "equivalent", differences: runtime };
  }
  const requestedAutoOff = requested.auto_off
    ? [
        autoOffDescription({
          ...requested.auto_off,
          value: requested.auto_off.action.value,
        }),
      ]
    : [];
  const existingAutoOff = existing.delayed.map(autoOffDescription);
  const immediateMatches =
    existing.immediate.length > 0 &&
    existing.immediate.every((value) => value === requested.action.value);
  const autoOffCovered = requestedAutoOff.every((wanted) =>
    existingAutoOff.some((present) => isDeepStrictEqual(present, wanted)),
  );
  const differences = [];
  if (!immediateMatches) {
    differences.push({
      field: "target_value",
      existing: existing.immediate.map(blockValue),
      requested: blockValue(requested.action.value),
    });
  }
  if (!isDeepStrictEqual(existingAutoOff, requestedAutoOff)) {
    differences.push({
      field: "auto_off",
      existing: existingAutoOff,
      requested: requestedAutoOff,
    });
  }
  differences.push(...existing.shape);
  for (const [field, count] of [
    ["other_actions", existing.otherActions],
    ["else_actions", existing.elseActions],
  ]) {
    if (count > 0) differences.push({ field, existing: count, requested: 0 });
  }
  differences.push(...runtime);
  const superset =
    immediateMatches && autoOffCovered && existing.shape.length === 0;
  if (!superset) return { relation: "conflict", differences };
  // A turned-off rule fires nothing, so a new rule would not duplicate it;
  // on start or sync it still fires on the trigger.
  return {
    relation: scenario.active === false ? "inactive_superset" : "superset",
    differences,
  };
}

// The first top-level `if` of a BLOCK in canonicalBlock form whose
// conditions include the requested trigger and whose actions write the
// requested target characteristic.
export function triggeredTargetRule(data, requested) {
  if (!requested || !Array.isArray(data?.targets)) return null;
  const trigger = JSON.stringify(requested.condition);
  const target = requested.action;
  const rule = data.targets.find(
    (candidate) =>
      candidate?.type === "if" &&
      candidate.if?.type === "condition" &&
      Array.isArray(candidate.if.conditions) &&
      candidate.if.conditions.some(
        (condition) =>
          condition?.type === "characteristic" &&
          JSON.stringify(ruleCondition(condition)) === trigger,
      ),
  );
  if (!rule || !Array.isArray(rule.then)) return null;
  const immediate = [];
  const delayed = [];
  let otherActions = data.targets.length - 1;
  const targetSettings = (node, onSetting) => {
    if (
      node?.type !== "service" ||
      node.aId !== target.aId ||
      node.sId !== target.sId ||
      !Array.isArray(node.characteristics)
    ) {
      otherActions += 1;
      return;
    }
    for (const setting of node.characteristics) {
      if (setting?.type === "set" && setting.cId === target.cId) {
        onSetting(setting.value);
      } else {
        otherActions += 1;
      }
    }
  };
  for (const action of rule.then) {
    if (action?.type === "delay" && Array.isArray(action.targets)) {
      for (const node of action.targets) {
        targetSettings(node, (value) =>
          delayed.push({
            index: action.index,
            mode: action.mode,
            time: action.time,
            value,
          }),
        );
      }
    } else {
      targetSettings(action, (value) => immediate.push(value));
    }
  }
  if (immediate.length === 0 && delayed.length === 0) return null;
  const shape = [];
  if (rule.if.conditions.length !== 1) {
    shape.push({
      field: "conditions",
      existing: rule.if.conditions.length,
      requested: 1,
    });
  }
  if (rule.mode !== "EVERY") {
    shape.push({
      field: "mode",
      existing: rule.mode ?? null,
      requested: "EVERY",
    });
  }
  if ((rule.then_delay ?? 0) !== 0) {
    shape.push({
      field: "then_delay",
      existing: rule.then_delay,
      requested: 0,
    });
  }
  return {
    immediate,
    delayed,
    otherActions,
    elseActions: Array.isArray(rule.else) ? rule.else.length : 0,
    shape,
  };
}

export function autoOffDescription({ index, mode, time, value }) {
  return {
    after_seconds: Number.isFinite(time) ? time / 1_000 : null,
    timer_mode: mode ?? null,
    target_value: blockValue(value),
    timer_index: index ?? null,
  };
}

export function blockValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value ?? null;
}

export function runtimeDifferences(scenario) {
  return [
    ["active", scenario.active, true],
    ["on_start", scenario.onStart, false],
    ["sync", scenario.sync, false],
  ]
    .filter(([, existing, required]) => existing !== required)
    .map(([field, existing, requested]) => ({
      field,
      existing: existing ?? null,
      requested,
    }));
}

export function rolledBackResult(change, removed) {
  return {
    ...publicChange(change),
    status: "rolled_back",
    removed,
    physical_state_reverted: false,
  };
}

export function withLocalState(
  result,
  saved,
  action = "restore_state_storage_then_get_native_change",
) {
  if (saved) return result;
  return {
    ...result,
    local_state: {
      saved: false,
      action,
    },
  };
}

export function observeReconciliation(change, reconciliation) {
  if (reconciliation.owned) {
    return {
      kind: reconciliation.matches ? "owned_match" : "owned_conflict",
      scenario: reconciliation.scenario,
    };
  }
  if (change.owned === true) {
    return reconciliation.scenario
      ? { kind: "ownership_conflict", scenario: reconciliation.scenario }
      : { kind: "absent" };
  }
  if (reconciliation.equivalent) {
    return { kind: "equivalent", scenario: reconciliation.equivalent };
  }
  if (reconciliation.runtimeConflict) {
    return {
      kind: "runtime_conflict",
      scenario: reconciliation.runtimeConflict,
    };
  }
  if (reconciliation.superset) {
    return {
      kind: "superset_conflict",
      scenario: reconciliation.superset.scenario,
      existingRule: reconciliation.superset.rule,
    };
  }
  return reconciliation.scenario
    ? { kind: "ownership_conflict", scenario: reconciliation.scenario }
    : { kind: "absent" };
}

export function observationState(observation) {
  const state = {
    scenario_index: observation.scenario.index,
    conflict_reason: undefined,
  };
  switch (observation.kind) {
    case "owned_match":
      return { ...state, status: "applied", owned: true };
    case "owned_conflict":
      return { ...state, status: "conflict", owned: true };
    case "equivalent":
      return { ...state, status: "already_present", owned: false };
    case "runtime_conflict":
      return {
        ...state,
        status: "conflict",
        owned: false,
        conflict_reason: "equivalent_rule_runtime_mismatch",
      };
    case "ownership_conflict":
      return { ...state, status: "conflict", owned: false };
    case "superset_conflict":
      return {
        ...state,
        status: "conflict",
        owned: false,
        conflict_reason: "existing_rule_superset",
      };
    default:
      throw new Error(`Cannot persist ${observation.kind} observation.`);
  }
}

export function observationResult(change, observation) {
  switch (observation.kind) {
    case "owned_match":
      return {
        ...publicChange(change),
        status: "applied",
        scenario_index: observation.scenario.index,
        owned: true,
        configuration_matches: true,
      };
    case "owned_conflict":
      return conflictResult(change, observation.scenario.index);
    case "equivalent":
      return {
        ...publicChange(change),
        status: "already_present",
        scenario_index: observation.scenario.index,
        owned: false,
        configuration_matches: true,
      };
    case "runtime_conflict":
      return runtimeConflictResult(change, observation.scenario);
    case "ownership_conflict":
      return ownershipConflictResult(change, observation.scenario.index);
    case "superset_conflict":
      return {
        ...publicChange(change),
        status: "conflict",
        conflict_reason: "existing_rule_superset",
        scenario_index: observation.scenario.index,
        owned: false,
        configuration_matches: false,
        existing_rule: observation.existingRule,
        action: "reuse_or_adjust_existing_rule",
      };
    default:
      throw new Error(`Cannot describe ${observation.kind} observation.`);
  }
}

export function publicChange(change) {
  return {
    status: change.status,
    change_ref: changeRef(change.id),
    name: change.name,
    reason: change.reason,
    condition: change.condition,
    action: change.action,
    ...(change.scenario_index ? { scenario_index: change.scenario_index } : {}),
  };
}

export function conflictResult(change, scenarioIndex) {
  return {
    ...publicChange(change),
    status: "conflict",
    scenario_index: scenarioIndex,
    owned: true,
    configuration_matches: false,
    action: "review_manual_changes",
  };
}

export function ownershipConflictResult(change, scenarioIndex) {
  return {
    ...publicChange(change),
    status: "conflict",
    scenario_index: scenarioIndex,
    owned: false,
    configuration_matches: false,
    action: "review_manual_changes",
  };
}

export function runtimeConflictResult(change, scenario) {
  return {
    ...publicChange(change),
    status: "conflict",
    reason: "equivalent_rule_runtime_mismatch",
    scenario_index: scenario.index,
    owned: false,
    configuration_matches: false,
    current_runtime: {
      active: scenario.active,
      on_start: scenario.onStart,
      sync: scenario.sync,
    },
    required_runtime: { active: true, on_start: false, sync: false },
    action: "review_existing_scenario",
  };
}

export function uncertainResult(change) {
  return {
    ...publicChange(change),
    status: "uncertain",
    action: "inspect_hub_before_retry",
  };
}
