export const BLOCK_CHILD_FIELDS = {
  root: {
    targets: { shape: "array", kinds: new Set(["if", "service", "delay"]) },
  },
  if: {
    if: {
      shape: "single",
      kinds: new Set(["condition", "characteristic"]),
    },
    // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK grammar requires this field name.
    then: { shape: "array", kinds: new Set(["if", "service", "delay"]) },
    else: { shape: "array", kinds: new Set(["if", "service", "delay"]) },
  },
  condition: {
    conditions: {
      shape: "array",
      kinds: new Set(["condition", "characteristic", "interval", "code"]),
    },
  },
  interval: {
    start: { shape: "single", kinds: new Set(["cron"]) },
    end: { shape: "single", kinds: new Set(["cron"]) },
  },
  service: {
    characteristics: { shape: "array", kinds: new Set(["set"]) },
  },
  delay: {
    targets: { shape: "array", kinds: new Set(["if", "service", "delay"]) },
  },
};

export function visitKnownBlockNodes(data, visitor, invalidChild) {
  const visit = (node, kind, path) => {
    if (!isRecord(node)) return;
    visitor(node, kind, path);
    for (const [key, rule] of Object.entries(BLOCK_CHILD_FIELDS[kind] ?? {})) {
      const value = node[key];
      const childPath = `${path}.${key}`;
      if (rule.shape === "array") {
        if (!Array.isArray(value)) {
          invalidChild?.(childPath, "child field must be an array", value);
          continue;
        }
        value.forEach((child, index) => {
          visitBlockChild(
            child,
            `${childPath}[${index}]`,
            rule,
            visit,
            invalidChild,
          );
        });
        continue;
      }
      if (Array.isArray(value) || !isRecord(value)) {
        invalidChild?.(childPath, "child field must be one object", value);
        continue;
      }
      visitBlockChild(value, childPath, rule, visit, invalidChild);
    }
  };
  visit(data, "root", "root");
}

export function blockAffectedRefs(data, homeRef) {
  const refs = [];
  visitKnownBlockNodes(data, (node, kind) => {
    if (kind === "characteristic") {
      refs.push(...bindingRefs(homeRef, node.aId, node.sId, node.cId));
    }
    if (kind === "service") {
      refs.push(...bindingRefs(homeRef, node.aId, node.sId));
      for (const action of node.characteristics ?? []) {
        refs.push(...bindingRefs(homeRef, node.aId, node.sId, action?.cId));
      }
    }
  });
  return [...new Set(refs)];
}

export function inspectBlockRelations(
  data,
  { homeRef, scenarioRef, scenarioActive },
) {
  const roles = [];
  const unresolved = [];
  if (!isRecord(data)) {
    return {
      roles,
      unresolved: [
        {
          area: "block_node",
          outcome: "invalid",
          ...blockRelationLocation(scenarioRef, "root"),
        },
      ],
    };
  }
  visitKnownBlockNodes(
    data,
    (node, kind, path) => {
      if (kind === "code") {
        unresolved.push({
          area: "block_code_condition",
          outcome: "not_analyzed",
          ...blockRelationLocation(scenarioRef, path),
        });
        return;
      }
      if (kind === "characteristic") {
        const entityRef = characteristicRef(
          homeRef,
          node.aId,
          node.sId,
          node.cId,
        );
        if (!entityRef) {
          unresolved.push(invalidReference(scenarioRef, path));
          return;
        }
        roles.push({
          scenario_ref: scenarioRef,
          scenario_active: scenarioActive,
          runtime_status: "not_observed",
          role: node.trigger === true ? "trigger" : "condition",
          entity_ref: entityRef,
          ...blockRelationLocation(scenarioRef, path),
        });
      }
      if (kind !== "service") return;
      for (const [index, action] of (node.characteristics ?? []).entries()) {
        if (action?.type !== "set") continue;
        const entityRef = characteristicRef(
          homeRef,
          node.aId,
          node.sId,
          action.cId,
        );
        const actionPath = `${path}.characteristics[${index}]`;
        if (!entityRef) {
          unresolved.push(invalidReference(scenarioRef, actionPath));
          continue;
        }
        roles.push({
          scenario_ref: scenarioRef,
          scenario_active: scenarioActive,
          runtime_status: "not_observed",
          role: "action_target",
          entity_ref: entityRef,
          ...blockRelationLocation(scenarioRef, actionPath),
          ...(typeof action.value === "string"
            ? { value_source: "literal" }
            : {}),
        });
        if (typeof action.value !== "string") {
          unresolved.push({
            area: "action_value_source",
            outcome: "unknown",
            ...blockRelationLocation(scenarioRef, actionPath),
          });
        }
      }
    },
    (path, _reason, node) => {
      unresolved.push({
        area: "block_node",
        outcome: "unsupported",
        ...blockRelationLocation(scenarioRef, path),
        ...(typeof node?.type === "string" ? { native_type: node.type } : {}),
      });
    },
  );
  return { roles, unresolved };
}

function visitBlockChild(child, path, rule, visit, invalidChild) {
  if (!isRecord(child) || !rule.kinds.has(child.type)) {
    invalidChild?.(
      path,
      `child type must be one of ${[...rule.kinds].join(", ")}`,
      child,
    );
    return;
  }
  visit(child, child.type, path);
}

function invalidReference(scenarioRef, path) {
  return {
    area: "block_reference",
    outcome: "invalid",
    ...blockRelationLocation(scenarioRef, path),
  };
}

function blockRelationLocation(scenarioRef, path) {
  const configurationPointer = blockConfigurationPointer(path);
  return {
    scenario_ref: scenarioRef,
    configuration_pointer: configurationPointer,
    next: {
      tool: "get_entity",
      arguments: {
        entity_ref: scenarioRef,
        include: ["configuration"],
        pointer: configurationPointer,
      },
    },
  };
}

function blockConfigurationPointer(path) {
  const tokens = [];
  for (const match of path.matchAll(/\.([^.[\]]+)|\[(\d+)\]/g)) {
    tokens.push(match[1] ?? match[2]);
  }
  return tokens.length === 0
    ? "/configuration/value"
    : `/configuration/value/${tokens.join("/")}`;
}

function characteristicRef(homeRef, aId, sId, cId) {
  return stableNativeId(aId) && stableNativeId(sId) && stableNativeId(cId)
    ? `${homeRef}/accessory/${aId}/service/${sId}/characteristic/${cId}`
    : null;
}

function bindingRefs(homeRef, aId, sId, cId) {
  if (!stableNativeId(aId)) return [];
  const accessory = `${homeRef}/accessory/${aId}`;
  if (!stableNativeId(sId)) return [accessory];
  const service = `${accessory}/service/${sId}`;
  return stableNativeId(cId)
    ? [accessory, service, `${service}/characteristic/${cId}`]
    : [accessory, service];
}

function stableNativeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
