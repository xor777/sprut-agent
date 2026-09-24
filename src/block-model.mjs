const TARGET_KINDS = [
  "if",
  "service",
  "delay",
  "clear_delay",
  "scenario",
  "notify",
  "http",
];

// Service actions that the preview and relations interpret.
export const SERVICE_ACTION_KINDS = ["set", "toggle", "inc", "dec"];

export const BLOCK_CHILD_FIELDS = {
  root: {
    targets: { shape: "array", kinds: new Set(TARGET_KINDS) },
  },
  if: {
    if: {
      shape: "single",
      kinds: new Set(["condition", "characteristic"]),
    },
    // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK grammar requires this field name.
    then: { shape: "array", kinds: new Set(TARGET_KINDS) },
    // The web client creates an if with else null and stores some without
    // else; both mean no else branch.
    else: { shape: "array", kinds: new Set(TARGET_KINDS), optional: true },
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
    characteristics: { shape: "array", kinds: new Set(SERVICE_ACTION_KINDS) },
  },
  delay: {
    targets: { shape: "array", kinds: new Set(TARGET_KINDS) },
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
  toggle: new Set(["type", "blockId", "cId", "hc"]),
  inc: new Set(["type", "blockId", "cId", "hc", "value"]),
  dec: new Set(["type", "blockId", "cId", "hc", "value"]),
  delay: new Set(["type", "blockId", "index", "mode", "time", "targets"]),
  clear_delay: new Set(["type", "blockId", "index"]),
  scenario: new Set(["type", "blockId", "index", "mode"]),
  notify: new Set(["type", "blockId", "text", "mode", "to"]),
  http: new Set(["type", "blockId", "method", "url"]),
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
  "toggle",
  "inc",
  "dec",
  "delay",
  "clear_delay",
  "scenario",
  "notify",
  "http",
];

const NATIVE_SCALAR_AS_STRING = {
  form: "native_scalar_as_string",
  bool: { true: "true", false: "false" },
  integer: "optional_minus_digits",
  float: "finite_decimal_string",
  string: "literal",
};

// The official web client writes timeCond "" (applies at once), ">" ("has
// not changed for") or "<" ("changed back within"), with time in
// milliseconds (research/protocol/2026-09-24-web-client-evidence.md).
// SprutHub 3.0.0 stored ">" with 60000 as sent; how the hub evaluates "<"
// is known only from the client's label.
const HOLD_TIME = { type: "integer", minimum: 1, unit: "milliseconds" };
export const CHARACTERISTIC_HOLD = {
  none: { timeCond: "", time: 0 },
  held_for: { timeCond: ">", time: HOLD_TIME },
  changed_back_within: { timeCond: "<", time: HOLD_TIME },
};

// SprutHub stores an inc/dec step sent as "10" as the number 10 (live
// conformance on 3.0.0 rev 20131, 2026-09-24); set values stay strings. A
// step is a finite number or a plain decimal string; how the hub reads other
// spellings such as "0xA", "1e1" or " 10 " is not observed. Returns the
// step as a number, or null.
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

export function relativeStepNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return typeof value === "string" && PLAIN_DECIMAL.test(value)
    ? Number(value)
    : null;
}

// inc/dec step limits read from the characteristic returned by get_entity.
const RELATIVE_STEP = {
  exclusive_minimum: 0,
  maximum: "characteristic_max_minus_min",
  multiple_of: "characteristic_min_step",
  characteristic_without_valid_values: true,
};

export const CLEAR_ALL_DELAYS = 0;

// A branch repeat period (then_delay/else_delay): 0 runs the branch once; a
// positive period repeats it («Каждые» in the web client's TimeDelay, which
// writes minutes and seconds as milliseconds and starts at 1000). A period
// under a second is refused so that a repeated write cannot flood a device.
// How long the repetition lasts on a hub is not observed.
export const BRANCH_REPEAT = {
  type: "integer",
  unit: "milliseconds",
  no_repeat: 0,
  minimum: 1_000,
};

// Scenario target modes of the web client's RunScenario. FIRE and
// ACTIVATE_AND_FIRE run the target, so they are followed for a chain back to
// the BLOCK being written; the others switch or reset it without a run.
export const SCENARIO_TARGET_MODES = {
  FIRE: "run_the_scenario",
  ACTIVATE: "turn_the_scenario_on",
  DEACTIVATE: "turn_the_scenario_off",
  ACTIVATE_AND_FIRE: "turn_the_scenario_on_and_run_it",
  RESET: "reset_the_scenario_meaning_known_only_from_the_editor_label",
};
const SCENARIO_RUN_MODES = new Set(["FIRE", "ACTIVATE_AND_FIRE"]);

export function scenarioTargetRuns(mode) {
  return SCENARIO_RUN_MODES.has(mode);
}

// Notify modes with the web client's labels. Where the hub shows a MESSAGE
// is not known from the client.
export const NOTIFY_MODES = {
  MESSAGE: "system_notification_editor_label_Системное",
  PUSH: "send_through_notification_services_editor_label_Отправить",
};

// Recipients of a PUSH, as the web client writes them: null for every
// notification service, or one entry per service by the index of its
// NOTIFICATION extension, with clients null for all its recipients or the
// ids of its children. The client writes neither an empty list nor empty
// clients; it sets them to null.
export const NOTIFY_RECIPIENTS = {
  all_services: null,
  listed_services: [
    {
      index:
        "index of a notification service: an extension with bundle_type NOTIFICATION (home_overview list=extensions)",
      clients:
        "null for all its recipients, or ids of its children (get_entity include children)",
    },
  ],
  with_mode_MESSAGE: "null_or_omitted",
};

// The web client's Http node: a method from its list and the URL as typed,
// with no body or headers. Any absolute http or https URL is accepted, as in
// the editor: what the BLOCK calls (a device on the home network, a webhook)
// is the owner's request. A user name or password in the URL is refused:
// every answer would repeat it, and redaction does not recognize it there.
export const HTTP_METHODS = [
  "GET",
  "POST",
  "HEAD",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
];
export const HTTP_URL = {
  form: "absolute_url_as_typed",
  schemes: ["http", "https"],
  user_name_or_password: "refused",
  shown_in_answers:
    "scheme, host and path; the query and fragment are not shown",
};

// The part of a request URL that answers show: scheme, host, port and path.
// Returns null for a URL that does not parse.
export function shownHttpUrl(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return {
    url: `${parsed.origin}${parsed.pathname}`,
    ...(parsed.search || parsed.hash ? { query: "not_shown" } : {}),
  };
}

const BLOCK_NODE_CONSTRAINTS = {
  root: {
    editor_optional: ["blockId"],
  },
  if: {
    // The web client creates an if without mode and shows it as EVERY; ONCE
    // was stored as sent on SprutHub 3.0.0, its run is not observed. It may
    // also leave out then_delay and else_delay.
    fields: {
      mode: ["EVERY", "ONCE"],
      then_delay: BRANCH_REPEAT,
      else_delay: BRANCH_REPEAT,
    },
    when_omitted: { mode: "EVERY", then_delay: 0, else_delay: 0 },
    modes: {
      EVERY: "run_the_chosen_branch_on_every_check",
      ONCE: "run_a_branch_only_when_the_condition_result_changes",
    },
    repeat: {
      then_delay: "repeats_then_every_period_while_it_is_the_chosen_branch",
      else_delay: "repeats_else_every_period_while_it_is_the_chosen_branch",
    },
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
    hold: CHARACTERISTIC_HOLD,
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
  // toggle, inc and dec follow the editor schema; not observed on a hub.
  toggle: {
    native_ids: ["cId"],
    fields: { hc: "characteristic_type_from_get_entity" },
    characteristic_kind: ["boolValue"],
    omitted: ["value"],
    editor_optional: ["blockId"],
  },
  inc: {
    native_ids: ["cId"],
    fields: { hc: "characteristic_type_from_get_entity", value: "number" },
    characteristic_kind: ["intValue", "longValue", "doubleValue"],
    value_meaning: "positive_step_in_characteristic_unit",
    step: RELATIVE_STEP,
    editor_optional: ["blockId"],
  },
  dec: {
    native_ids: ["cId"],
    fields: { hc: "characteristic_type_from_get_entity", value: "number" },
    characteristic_kind: ["intValue", "longValue", "doubleValue"],
    value_meaning: "positive_step_in_characteristic_unit",
    step: RELATIVE_STEP,
    editor_optional: ["blockId"],
  },
  scenario: {
    fields: {
      index: "existing_scenario_index_from_scenario_ref",
      mode: Object.keys(SCENARIO_TARGET_MODES),
    },
    modes: SCENARIO_TARGET_MODES,
    editor_optional: ["blockId"],
  },
  delay: {
    fields: {
      // The web client labels RESET "single timer" and CONTINUE "new timer";
      // the run of either is not observed on a hub.
      mode: ["RESET", "CONTINUE"],
      index: { type: "integer", minimum: 1, unique: true },
      // Native delay.time is milliseconds; auto_off_after_seconds stays a separate public unit.
      time: { type: "integer", minimum: 1, unit: "milliseconds" },
    },
    modes: {
      RESET: "single_timer_new_entry_restarts_the_full_delay",
      CONTINUE:
        "new_timer_each_entry_starts_another_delay_expected_from_editor_label",
    },
    editor_optional: ["blockId"],
  },
  // The web client's Notify: text, mode and to. Its new node is
  // {text:"", mode:"MESSAGE"} without to, and a mode change sets to null.
  notify: {
    fields: {
      text: "the_message_itself_owner_data_not_empty",
      mode: Object.keys(NOTIFY_MODES),
      to: NOTIFY_RECIPIENTS,
    },
    modes: NOTIFY_MODES,
    when_omitted: { to: null },
    editor_optional: ["blockId"],
  },
  http: {
    fields: { method: HTTP_METHODS, url: HTTP_URL },
    editor_optional: ["blockId"],
  },
  // The web client offers index 0 as "All delays"; stored as sent on
  // SprutHub 3.0.0 with a delay index, its run is not observed.
  clear_delay: {
    fields: {
      index: {
        type: "integer",
        all_delays: CLEAR_ALL_DELAYS,
        refers_to: "index of a delay in this BLOCK",
      },
    },
    editor_optional: ["blockId"],
  },
};

// A cron in condition.conditions fires its BLOCK at its moment. Only the
// daily form 0 MM HH ? * * * is observed on a hub
// (research/protocol/2026-09-13-native-daily-interval.md). The other forms
// follow what the official web client writes
// (research/protocol/2026-09-24-web-client-evidence.md): a seven-field
// Quartz cron with seconds first, day names in field 5, and for
// SUNRISE/SUNSET the cron 0 0 0 ? * DAYS * with offset in seconds, negative
// before the event, up to 12 hours. No hub has been observed firing them.
const CRON_DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SUN_OFFSET = {
  type: "integer",
  unit: "seconds",
  minimum: -43_200,
  maximum: 43_200,
  negative: "before",
};

// The periods the web client offers for "every N".
const EVERY_N_HOURS = [1, 2, 3, 4, 6, 8, 12];
const EVERY_N_MINUTES_OR_SECONDS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];

export const TIME_TRIGGER = {
  node: "cron",
  position: "condition.conditions",
  native_trigger: true,
  clock: "selected_hub_local_wall_clock",
  forms: {
    days_at_time: { mode: "NONE", cron: "0 MM HH ? * DAYS *", offset: 0 },
    every_n_hours: {
      mode: "NONE",
      cron: "0 0 0/N ? * DAYS *",
      offset: 0,
      N: EVERY_N_HOURS,
    },
    every_n_minutes: {
      mode: "NONE",
      cron: "0 0/N * ? * DAYS *",
      offset: 0,
      N: EVERY_N_MINUTES_OR_SECONDS,
    },
    every_n_seconds: {
      mode: "NONE",
      cron: "0/N * * ? * DAYS *",
      offset: 0,
      N: EVERY_N_MINUTES_OR_SECONDS,
    },
    one_date: {
      mode: "NONE",
      cron: "0 MM HH D M ? YYYY",
      offset: 0,
      official_editor: "never_writes_this_form",
    },
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
    N: "one_of_the_form_N_list",
    DAYS: `* for every day, or comma-separated names from ${CRON_DAY_NAMES.join(",")}; all seven names are sent as *`,
  },
  evidence: {
    forms: "official_web_client_code",
    one_date: "official_editor_schema_only",
    hub: "days_at_time, one_date and sun stored as sent on SprutHub 3.0.0; a days_at_time for every day fired at its minute of the hub clock (live-conformance-3); firing of one_date and sun not observed",
  },
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
const EVERY_N_FORMS = [
  "every_n_hours",
  "every_n_minutes",
  "every_n_seconds",
].map((name) => ({
  form: TIME_TRIGGER.forms[name],
  pattern: cronTemplatePattern(TIME_TRIGGER.forms[name].cron),
}));

// The form template as a pattern that captures N and then DAYS.
function cronTemplatePattern(template) {
  const parts = { N: "(\\d+)", DAYS: "(\\S+)" };
  const source = template
    .split(/([A-Z]+)/)
    .map((piece) => parts[piece] ?? piece.replace(/[?*/]/g, "\\$&"))
    .join("");
  return new RegExp(`^${source}$`);
}

// Returns why a standalone cron is outside TIME_TRIGGER, or null.
export function timeTriggerProblem(node) {
  const { forms } = TIME_TRIGGER;
  const days = `DAYS is ${TIME_TRIGGER.fields.DAYS}`;
  if (typeof node.cron !== "string") return "time trigger needs a cron string";
  if (node.mode === "NONE") {
    if (node.offset !== 0) return "time trigger at a clock time needs offset 0";
    const weekly = DAYS_AT_TIME_CRON.exec(node.cron);
    if (weekly && cronDaysValid(weekly[3])) return null;
    for (const { form, pattern } of EVERY_N_FORMS) {
      const every = pattern.exec(node.cron);
      if (
        every &&
        form.N.map(String).includes(every[1]) &&
        cronDaysValid(every[2])
      ) {
        return null;
      }
    }
    const date = ONE_DATE_CRON.exec(node.cron);
    if (date && calendarDateValid(date[3], date[4], date[5])) return null;
    return `time trigger cron must be ${forms.days_at_time.cron}; ${forms.every_n_hours.cron} with N from ${forms.every_n_hours.N.join(",")}; ${forms.every_n_minutes.cron} or ${forms.every_n_seconds.cron} with N from ${forms.every_n_minutes.N.join(",")}; or ${forms.one_date.cron}, in the selected hub's local wall clock; ${days}`;
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
    const constraints = structuredClone(BLOCK_NODE_CONSTRAINTS[kind] ?? {});
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
        ...(rule.optional ? { omitted_or_null: "no_branch" } : {}),
      };
    }
  }
  return children;
}

// Brings requested BLOCK data to the form the official editor writes before
// it is validated, previewed and sent.
export function normalizeBlockRequest(data) {
  wrapDirectCharacteristicIfPredicates(data);
  visitKnownBlockNodes(data, (node, kind) => {
    // The web client writes to null for every PUSH it creates.
    if (kind === "notify" && node.mode === "PUSH" && node.to === undefined) {
      node.to = null;
      return;
    }
    if (kind === "inc" || kind === "dec") {
      // Sent in the form the hub stores (relativeStepNumber).
      const step = relativeStepNumber(node.value);
      if (step !== null) node.value = step;
      return;
    }
    if (kind !== "cron" || typeof node.cron !== "string") return;
    // The web client writes every day as *, never as all seven names.
    const fields = node.cron.split(" ");
    const days = fields[5]?.split(",") ?? [];
    if (
      fields.length === 7 &&
      days.length === CRON_DAY_NAMES.length &&
      CRON_DAY_NAMES.every((day) => days.includes(day))
    ) {
      fields[5] = "*";
      node.cron = fields.join(" ");
    }
  });
}

// The one form in which BLOCK data is compared: a request with its readback,
// an applied or baseline snapshot with the current data, a kept subtree with
// the stored one, a requested rule with an existing one, a configuration
// point with the current scenario. Both sides of every comparison take this
// form; it is never sent to the hub. It folds only what the hub or the
// official web client write differently for the same meaning. Anything
// else, a changed value, mode, delay, branch or field, stays a difference,
// so a manual edit is still detected. An inc/dec step is compared as it is:
// normalizeBlockRequest sends it as a number, and SprutHub 3.0.0 stored a
// step sent as the string "10" as the number 10.
export function canonicalBlock(data) {
  return canonicalNode(data, "root");
}

// A node of BLOCK data as canonicalBlock gives it, by its own type.
export function canonicalBlockNode(node) {
  if (!isRecord(node) || typeof node.type !== "string") {
    return structuredClone(node);
  }
  return canonicalNode(node, node.type);
}

function canonicalNode(node, kind) {
  if (!isRecord(node)) return structuredClone(node);
  // Live-observed: the hub numbers every node it stores in a BLOCK child
  // field again after a write, also nodes outside this contract such as code
  // (research/protocol/2026-09-09-automations.md). Only that blockId is
  // dropped from a node outside the contract; the rest of it stays exact.
  const { blockId: _blockId, ...fields } = node;
  if (!Object.hasOwn(BLOCK_ALLOWED_KEYS, kind)) return structuredClone(fields);
  const canonical = {};
  for (const [key, value] of Object.entries(fields)) {
    const rule = BLOCK_CHILD_FIELDS[kind]?.[key];
    if (rule?.shape === "array" && Array.isArray(value)) {
      canonical[key] = value.map(canonicalBlockNode);
    } else if (rule?.shape === "single") {
      canonical[key] = canonicalBlockNode(value);
    } else {
      canonical[key] = structuredClone(value);
    }
  }
  if (kind === "if") {
    // state is runtime, not configuration: live reads carry it on stored
    // ifs, SprutHub 3.0.0 did not add it at create but added state: true
    // when a time trigger fired and changes it during runs (no nextRun
    // appeared; live-conformance-3), and the web client sets it to null
    // when it switches to ONCE.
    delete canonical.state;
    // Client code (research/protocol/2026-09-24-web-client-evidence.md): the
    // web client creates an if without mode, then_delay and else_delay and
    // with else null, and shows it as EVERY without a repeat period or an
    // else branch. SprutHub 3.0.0 stored such an if with mode EVERY and both
    // delays 0, and without else (live-conformance-3).
    if (!Object.hasOwn(canonical, "mode")) canonical.mode = "EVERY";
    for (const key of ["then_delay", "else_delay"]) {
      if (!Object.hasOwn(canonical, key)) canonical[key] = 0;
    }
    if (canonical.else === undefined || canonical.else === null) {
      canonical.else = [];
    }
  }
  if (kind === "notify" && !Object.hasOwn(canonical, "to")) {
    // Client code: a new notify has no to, and a mode change writes to
    // null; both mean no recipients were chosen.
    canonical.to = null;
  }
  if (
    kind === "condition" &&
    canonical.mode === "OR" &&
    Array.isArray(canonical.conditions) &&
    canonical.conditions.length === 1
  ) {
    // Client code (research/protocol/2026-09-24-web-client-evidence.md): the
    // web client creates every condition group with mode OR, the agent writes
    // AND; over one condition both mean that condition. A group of none or of
    // several keeps its mode.
    canonical.mode = "AND";
  }
  return canonical;
}

function wrapDirectCharacteristicIfPredicates(data) {
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

// invalidChild gets the path, the reason, the invalid value and the node
// that holds it.
export function visitKnownBlockNodes(data, visitor, invalidChild) {
  const visit = (node, kind, path) => {
    if (!isRecord(node)) return;
    visitor(node, kind, path);
    for (const [key, rule] of Object.entries(BLOCK_CHILD_FIELDS[kind] ?? {})) {
      const value = node[key];
      const childPath = `${path}.${key}`;
      if (rule.optional && (value === undefined || value === null)) continue;
      if (rule.shape === "array") {
        if (!Array.isArray(value)) {
          invalidChild?.(
            childPath,
            rule.optional
              ? `${key} must be an array of nodes, null or omitted`
              : `${key} must be an array of nodes`,
            value,
            node,
          );
          continue;
        }
        value.forEach((child, index) => {
          visitBlockChild(child, `${childPath}[${index}]`, rule, {
            visit,
            invalidChild,
            parent: node,
          });
        });
        continue;
      }
      if (Array.isArray(value) || !isRecord(value)) {
        invalidChild?.(childPath, `${key} must be one node`, value, node);
        continue;
      }
      visitBlockChild(value, childPath, rule, {
        visit,
        invalidChild,
        parent: node,
      });
    }
  };
  visit(data, "root", "root");
}

// A node that starts its BLOCK: a characteristic or interval with
// trigger=true, or a cron directly in condition.conditions (TIME_TRIGGER).
// A cron in interval.start or interval.end only bounds its interval.
export function isBlockTrigger(node, kind, path) {
  if (kind === "characteristic" || kind === "interval") {
    return node.trigger === true;
  }
  return kind === "cron" && /\.conditions\[\d+\]$/.test(path);
}

export function blockSubgraphHasTrigger(node) {
  return blockDataHasTrigger({ targets: [node] });
}

export function blockDataHasTrigger(data) {
  let found = false;
  visitKnownBlockNodes(data, (candidate, kind, path) => {
    if (isBlockTrigger(candidate, kind, path)) found = true;
  });
  return found;
}

// Scenario targets that run their scenario (FIRE, ACTIVATE_AND_FIRE).
export function blockScenarioRuns(data) {
  return blockScenarioTargets(data).filter(({ mode }) =>
    scenarioTargetRuns(mode),
  );
}

// Scenario targets of any mode anywhere in BLOCK data, including under nodes
// outside this contract, with JSON pointers relative to the data.
export function blockScenarioTargets(data) {
  const runs = [];
  const visit = (value, pointer) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        visit(child, `${pointer}/${index}`);
      });
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "scenario" && typeof value.index === "string") {
      runs.push({ index: value.index, mode: value.mode, pointer });
    }
    for (const [key, child] of Object.entries(value)) {
      visit(
        child,
        `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
    }
  };
  visit(data, "");
  return runs;
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

// code is read only as sprut-agent's own pause condition; writers never get it.
function publishedChildTypes(rule) {
  return [...rule.kinds].filter((type) => type !== "code");
}

function visitBlockChild(child, path, rule, { visit, invalidChild, parent }) {
  if (!isRecord(child) || !rule.kinds.has(child.type)) {
    invalidChild?.(path, unsupportedChildMessage(child, rule), child, parent);
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
