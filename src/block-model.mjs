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

export const BLOCK_ALLOWED_KEYS = {
  root: new Set(["blockId", "targets"]),
  if: new Set([
    "type",
    "blockId",
    "state",
    "mode",
    "if",
    "then",
    "else",
    "then_delay",
    "else_delay",
  ]),
  condition: new Set(["type", "blockId", "mode", "conditions"]),
  code: new Set(["type", "blockId", "code"]),
  characteristic: new Set([
    "type",
    "blockId",
    "aId",
    "sId",
    "cId",
    "hs",
    "hc",
    "trigger",
    "cond",
    "value",
    "timeCond",
    "time",
  ]),
  interval: new Set(["type", "blockId", "start", "end", "trigger"]),
  cron: new Set(["type", "blockId", "mode", "cron", "offset"]),
  service: new Set(["type", "blockId", "aId", "sId", "hs", "characteristics"]),
  set: new Set(["type", "blockId", "cId", "hc", "value"]),
  delay: new Set(["type", "blockId", "index", "mode", "time", "targets"]),
};

const BLOCK_CREATE_NODE_KINDS = [
  "root",
  "if",
  "condition",
  "characteristic",
  "interval",
  "cron",
  "service",
  "set",
  "delay",
];

const NATIVE_SCALAR_AS_STRING = {
  form: "native_scalar_as_string",
  bool: { true: "true", false: "false" },
  integer: "optional_minus_digits",
  float: "finite_decimal_string",
  string: "literal",
};

const BLOCK_NODE_CONSTRAINTS = {
  root: {
    editor_optional: ["blockId"],
  },
  if: {
    constants: { mode: "EVERY", then_delay: 0, else_delay: 0 },
    editor_optional: ["blockId"],
    hub_assigned: { state: "omit_on_create" },
  },
  condition: {
    fields: { mode: ["AND", "OR"] },
    editor_optional: ["blockId"],
  },
  characteristic: {
    native_ids: ["aId", "sId", "cId"],
    fields: {
      hs: "service_type_from_get_entity",
      hc: "characteristic_type_from_get_entity",
      trigger: "boolean",
      cond: "string",
      value: "string",
    },
    constants: { timeCond: "", time: 0 },
    value_encoding: NATIVE_SCALAR_AS_STRING,
    editor_optional: ["blockId"],
  },
  interval: {
    fields: { trigger: "boolean" },
    editor_optional: ["blockId"],
  },
  cron: {
    constants: { mode: "NONE", offset: 0 },
    fields: { cron: "string" },
    editor_optional: ["blockId"],
  },
  service: {
    native_ids: ["aId", "sId"],
    fields: { hs: "service_type_from_get_entity" },
    editor_optional: ["blockId"],
  },
  set: {
    native_ids: ["cId"],
    fields: { hc: "characteristic_type_from_get_entity", value: "string" },
    value_encoding: NATIVE_SCALAR_AS_STRING,
    editor_optional: ["blockId"],
  },
  delay: {
    constants: { mode: "RESET" },
    fields: {
      index: { type: "integer", minimum: 1, unique: true },
      // Native delay.time is milliseconds; auto_off_after_seconds stays a separate public unit.
      time: { type: "integer", minimum: 1, unit: "milliseconds" },
    },
    editor_optional: ["blockId"],
  },
};

export function publishedBlockNodes() {
  const children = publishedBlockChildren();
  const nodes = {};
  for (const kind of BLOCK_CREATE_NODE_KINDS) {
    const constraints = BLOCK_NODE_CONSTRAINTS[kind] ?? {};
    const nodeChildren = children[kind];
    nodes[kind] = {
      ...(kind === "root" ? {} : { type: kind }),
      ...constraints,
      ...(nodeChildren ? { children: nodeChildren } : {}),
    };
  }
  return nodes;
}

function publishedBlockChildren() {
  const children = {};
  for (const [kind, fields] of Object.entries(BLOCK_CHILD_FIELDS)) {
    children[kind] = {};
    for (const [key, rule] of Object.entries(fields)) {
      const types = publishedChildTypes(rule);
      const minItems =
        (kind === "root" && key === "targets") ||
        (kind === "condition" && key === "conditions") ||
        (kind === "service" && key === "characteristics")
          ? 1
          : undefined;
      children[kind][key] = {
        shape: rule.shape,
        types,
        ...(minItems === undefined ? {} : { min_items: minItems }),
      };
    }
  }
  return children;
}

export function wrapDirectCharacteristicIfPredicates(data) {
  visitKnownBlockNodes(data, (node, kind) => {
    if (kind !== "if") return;
    const predicate = node.if;
    if (!isRecord(predicate) || predicate.type !== "characteristic") return;
    // Official schema/if.if is a condition group; AND of one leaf is the same meaning.
    node.if = {
      type: "condition",
      mode: "AND",
      conditions: [predicate],
    };
  });
}

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

// code is read only as sprut-agent's own pause condition; writers never get it.
function publishedChildTypes(rule) {
  return [...rule.kinds].filter((type) => type !== "code");
}

function visitBlockChild(child, path, rule, visit, invalidChild) {
  if (!isRecord(child) || !rule.kinds.has(child.type)) {
    invalidChild?.(path, unsupportedChildMessage(child, rule), child);
    return;
  }
  visit(child, child.type, path);
}

// The node type lets the agent tell the owner which block to edit by hand.
function unsupportedChildMessage(child, rule) {
  const allowed = publishedChildTypes(rule).join(", ");
  if (!isRecord(child) || typeof child.type !== "string") {
    return `child type must be one of ${allowed}`;
  }
  return BLOCK_CREATE_NODE_KINDS.includes(child.type)
    ? `node type ${child.type} is not allowed here; allowed here: ${allowed}`
    : `node type ${child.type} is not supported by this contract; allowed here: ${allowed}`;
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
