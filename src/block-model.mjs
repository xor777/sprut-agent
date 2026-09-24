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
      kinds: new Set([
        "condition",
        "characteristic",
        "interval",
        "cron",
        "code",
      ]),
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
    fields: {
      mode: ["NONE", "SUNRISE", "SUNSET"],
      cron: "string",
      offset: "integer",
    },
    forms_by_position: {
      "interval.start": "supported.daily_interval",
      "interval.end": "supported.daily_interval",
      "condition.conditions": "supported.time_trigger",
    },
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

// A cron in condition.conditions fires its BLOCK at its moment. Only the
// daily form 0 MM HH ? * * * is observed on a hub
// (research/protocol/2026-09-13-native-daily-interval.md). The other forms
// read the official editor schema's seven-field cron as Quartz: seconds
// first, "?" for the unused day field, year last. Day names avoid Quartz's
// 1=SUN numbering. The SUNRISE/SUNSET cron and minutes as the offset unit
// are assumptions that still need a live check.
const CRON_DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SUN_OFFSET = {
  type: "integer",
  unit: "minutes",
  minimum: -720,
  maximum: 720,
  negative: "before",
};

export const TIME_TRIGGER = {
  node: "cron",
  position: "condition.conditions",
  native_trigger: true,
  clock: "selected_hub_local_wall_clock",
  forms: {
    days_at_time: { mode: "NONE", cron: "0 MM HH ? * DAYS *", offset: 0 },
    one_date: { mode: "NONE", cron: "0 MM HH D M ? YYYY", offset: 0 },
    sun: {
      mode: ["SUNRISE", "SUNSET"],
      cron: "0 0 0 ? * DAYS *",
      offset: SUN_OFFSET,
    },
  },
  fields: {
    MM: "minute_0_to_59",
    HH: "hour_0_to_23",
    D: "day_of_month_1_to_31",
    M: "month_1_to_12",
    YYYY: "year_2000_to_2099",
    DAYS: `* for every day, or comma-separated names from ${CRON_DAY_NAMES.join(",")}`,
  },
  evidence: "official_editor_schema_only",
};

const CRON_MINUTE = "([0-5]?\\d)";
const CRON_HOUR = "([01]?\\d|2[0-3])";
const DAYS_AT_TIME_CRON = new RegExp(
  `^0 ${CRON_MINUTE} ${CRON_HOUR} \\? \\* (\\S+) \\*$`,
);
const ONE_DATE_CRON = new RegExp(
  `^0 ${CRON_MINUTE} ${CRON_HOUR} (0?[1-9]|[12]\\d|3[01]) (0?[1-9]|1[0-2]) \\? (20\\d\\d)$`,
);
const SUN_CRON = /^0 0 0 \? \* (\S+) \*$/;

// Returns why a standalone cron is outside TIME_TRIGGER, or null.
export function timeTriggerProblem(node) {
  const { forms } = TIME_TRIGGER;
  const days = `DAYS is ${TIME_TRIGGER.fields.DAYS}`;
  if (typeof node.cron !== "string") return "time trigger needs a cron string";
  if (node.mode === "NONE") {
    if (node.offset !== 0) return "time trigger at a clock time needs offset 0";
    const weekly = DAYS_AT_TIME_CRON.exec(node.cron);
    if (weekly && cronDaysValid(weekly[3])) return null;
    const date = ONE_DATE_CRON.exec(node.cron);
    if (date && calendarDateValid(date[3], date[4], date[5])) return null;
    return `time trigger cron must be ${forms.days_at_time.cron} or ${forms.one_date.cron} in the selected hub's local wall clock; ${days}`;
  }
  if (node.mode === "SUNRISE" || node.mode === "SUNSET") {
    const sun = SUN_CRON.exec(node.cron);
    if (!sun || !cronDaysValid(sun[1])) {
      return `time trigger ${node.mode} needs cron ${forms.sun.cron}; ${days}`;
    }
    if (
      !Number.isSafeInteger(node.offset) ||
      node.offset < SUN_OFFSET.minimum ||
      node.offset > SUN_OFFSET.maximum
    ) {
      return `time trigger ${node.mode} offset must be whole ${SUN_OFFSET.unit} from ${SUN_OFFSET.minimum} to ${SUN_OFFSET.maximum}`;
    }
    return null;
  }
  return "time trigger mode must be NONE, SUNRISE or SUNSET";
}

function cronDaysValid(text) {
  if (text === "*") return true;
  const days = text.split(",");
  return (
    days.every((day) => CRON_DAY_NAMES.includes(day)) &&
    new Set(days).size === days.length
  );
}

function calendarDateValid(day, month, year) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

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
