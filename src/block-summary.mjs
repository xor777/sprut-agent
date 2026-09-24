// Decodes a stored BLOCK scenario into what it does, with devices named, for
// get_entity summaries and relations. Reading only: every node the decoder
// does not know is reported as unrecognized, never dropped.
//
// Time fields follow the official web client (research/protocol/
// 2026-09-24-web-client-evidence.md): seven-field Quartz cron in the hub's
// local wall clock, weekday names in field 5, "0/N" for every N, sun offset
// in seconds; characteristic hold time and delay time in milliseconds.

const BASE_POINTER = "/configuration/value";
const VALUE_FIELDS = [
  "boolValue",
  "intValue",
  "longValue",
  "doubleValue",
  "stringValue",
];
const NUMBER_FIELDS = new Set(["intValue", "longValue", "doubleValue"]);
const DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const ACTION_OPS = {
  set: "set",
  toggle: "toggle",
  inc: "increase",
  dec: "decrease",
};

// Accessory ids and FIRE scenario indexes a BLOCK names, so the caller reads
// only the catalogs that the decoding needs.
export function blockBindings(data) {
  const accessoryIds = new Set();
  const scenarioIndexes = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (Number.isSafeInteger(value.aId)) accessoryIds.add(value.aId);
    if (value.type === "scenario" && typeof value.index === "string") {
      scenarioIndexes.add(value.index);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(data);
  return { accessoryIds, scenarioIndexes };
}

// context: { homeRef, accessories: Map|null, rooms: Map|null,
// scenarios: Map|null, isSensitiveControl }. A null catalog was not read.
export function decodeBlock(data, context) {
  const state = {
    context,
    triggers: [],
    unrecognized: [],
    codeConditions: [],
    records: [],
    usesTime: false,
  };
  let steps = [];
  if (isRecord(data) && Array.isArray(data.targets)) {
    steps = decodeSteps(
      data.targets,
      `${BASE_POINTER}/targets`,
      [],
      null,
      state,
    );
  } else {
    unrecognized(state, BASE_POINTER, data, "invalid_root");
  }
  return {
    steps,
    triggers: state.triggers,
    unrecognized: state.unrecognized,
    codeConditions: state.codeConditions,
    records: state.records,
    usesTime: state.usesTime,
  };
}

export function blockSummary(decoded, { namesResolved }) {
  return {
    format: "block",
    ...(decoded.usesTime ? { clock: "hub_local" } : {}),
    ...(namesResolved ? {} : { names: "not_resolved" }),
    triggers: decoded.triggers,
    steps: decoded.steps,
    unrecognized: decoded.unrecognized,
  };
}

function decodeSteps(list, pointer, chain, delay, state) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    return [unrecognized(state, pointer, list, "not_a_list")];
  }
  return list.flatMap((node, index) =>
    decodeStep(node, `${pointer}/${index}`, chain, delay, state),
  );
}

function decodeStep(node, pointer, chain, delay, state) {
  if (!isRecord(node) || isRedacted(node)) {
    return [unrecognized(state, pointer, node)];
  }
  if (node.type === "if") return [decodeIf(node, pointer, chain, delay, state)];
  if (node.type === "service") {
    return decodeService(node, pointer, chain, delay, state);
  }
  if (node.type === "delay") {
    const seconds = millisecondsToSeconds(node.time);
    const inner = {
      seconds: (delay?.seconds ?? 0) + (seconds ?? 0),
      mode: typeof node.mode === "string" ? node.mode : null,
      ...(delay ? { nested: true } : {}),
    };
    return [
      {
        type: "delay",
        seconds,
        mode: inner.mode,
        index: Number.isSafeInteger(node.index) ? node.index : null,
        steps: decodeSteps(
          node.targets,
          `${pointer}/targets`,
          chain,
          inner,
          state,
        ),
      },
    ];
  }
  if (node.type === "clear_delay") {
    return [
      {
        type: "clear_delay",
        delay: node.index === 0 ? "all" : (node.index ?? null),
      },
    ];
  }
  if (node.type === "scenario") {
    return [decodeScenarioRun(node, state)];
  }
  return [unrecognized(state, pointer, node)];
}

function decodeIf(node, pointer, chain, delay, state) {
  const condition = decodeCondition(node.if, `${pointer}/if`, chain, state);
  const decoded = {
    type: "if",
    mode: node.mode === "ONCE" ? "ONCE" : "EVERY",
    condition: condition.value,
    // biome-ignore lint/suspicious/noThenProperty: mirrors the native BLOCK branch name.
    then: decodeSteps(
      node.then,
      `${pointer}/then`,
      [...chain, { text: condition.text, branch: "then" }],
      delay,
      state,
    ),
    else: decodeSteps(
      node.else,
      `${pointer}/else`,
      [...chain, { text: condition.text, branch: "else" }],
      delay,
      state,
    ),
  };
  // then_delay/else_delay repeat a branch; 0 means no repetition.
  const repeatThen = millisecondsToSeconds(node.then_delay);
  const repeatElse = millisecondsToSeconds(node.else_delay);
  if (repeatThen) decoded.repeat_then_every_seconds = repeatThen;
  if (repeatElse) decoded.repeat_else_every_seconds = repeatElse;
  return decoded;
}

function decodeCondition(node, pointer, chain, state, nested = false) {
  if (!isRecord(node) || isRedacted(node)) {
    const value = unrecognized(state, pointer, node);
    return { value, text: "unrecognized condition" };
  }
  if (node.type === "condition") {
    const items = Array.isArray(node.conditions)
      ? node.conditions.map((child, index) =>
          decodeCondition(
            child,
            `${pointer}/conditions/${index}`,
            chain,
            state,
            true,
          ),
        )
      : [];
    const any = node.mode === "OR";
    const joined = items.map(({ text }) => text).join(any ? " OR " : " AND ");
    return {
      value: { [any ? "any" : "all"]: items.map(({ value }) => value) },
      text: items.length > 1 && nested ? `(${joined})` : joined,
    };
  }
  if (node.type === "characteristic") {
    return decodeCharacteristicCondition(node, pointer, chain, state);
  }
  if (node.type === "interval") {
    state.usesTime = true;
    const from = decodeCron(node.start);
    const to = decodeCron(node.end);
    const text =
      from && to
        ? `${momentText(from)}–${momentText(to)}${daysSuffix(from.days)}`
        : "unrecognized interval";
    if (!from) unrecognized(state, `${pointer}/start`, node.start);
    if (!to) unrecognized(state, `${pointer}/end`, node.end);
    const trigger = node.trigger === true;
    if (trigger) state.triggers.push(`${text} (at start and at end)`);
    return {
      value: {
        type: "interval",
        trigger,
        from: from ? withoutDays(from) : null,
        to: to ? withoutDays(to) : null,
        ...(from ? { days: from.days } : {}),
        text,
      },
      text,
    };
  }
  if (node.type === "cron") {
    state.usesTime = true;
    const time = decodeCron(node);
    if (!time) {
      const value = unrecognized(state, pointer, node);
      return { value, text: "unrecognized time" };
    }
    // A cron among conditions starts the BLOCK at its moment.
    state.triggers.push(time.text);
    return {
      value: { type: "time", trigger: true, ...time },
      text: time.text,
    };
  }
  if (node.type === "code") {
    state.codeConditions.push(pointer);
    return {
      value: { type: "code", status: "not_analyzed", pointer },
      text: "code condition (not analyzed)",
    };
  }
  const value = unrecognized(state, pointer, node);
  return { value, text: "unrecognized condition" };
}

function decodeCharacteristicCondition(node, pointer, chain, state) {
  const target = describeTarget(state.context, node.aId, node.sId, node.cId, {
    nativeType: node.hc,
  });
  if (!target.ref) {
    const value = unrecognized(state, pointer, node, "invalid_reference");
    return { value, text: "unrecognized condition" };
  }
  const op = typeof node.cond === "string" ? node.cond : null;
  const compared = decodeValue(node.value, target);
  const held = decodeHeld(node);
  const trigger = node.trigger === true;
  const text = `${targetText(target)} ${op ?? "?"} ${valueText(compared)}${held ? ` ${held.text}` : ""}`;
  if (trigger) state.triggers.push(text);
  state.records.push({
    ref: target.ref,
    accessoryId: node.aId,
    characteristic: target.control?.name ?? null,
    role: trigger ? "trigger" : "condition",
    pointer,
    chain,
    op,
    ...compared,
    ...(held ? { held: withoutText(held) } : {}),
  });
  return {
    value: {
      type: "characteristic",
      trigger,
      ...targetNames(target),
      op,
      ...compared,
      ...(held ? { held: withoutText(held) } : {}),
      ref: target.ref,
    },
    text,
  };
}

function decodeService(node, pointer, chain, delay, state) {
  if (!Array.isArray(node.characteristics)) {
    return [unrecognized(state, pointer, node)];
  }
  const actions = [];
  const records = [];
  node.characteristics.forEach((action, index) => {
    const actionPointer = `${pointer}/characteristics/${index}`;
    if (
      !isRecord(action) ||
      isRedacted(action) ||
      !Object.hasOwn(ACTION_OPS, action.type)
    ) {
      actions.push(unrecognized(state, actionPointer, action));
      return;
    }
    const target = describeTarget(
      state.context,
      node.aId,
      node.sId,
      action.cId,
      { nativeType: action.hc },
    );
    if (!target.ref) {
      actions.push(
        unrecognized(state, actionPointer, action, "invalid_reference"),
      );
      return;
    }
    const op = ACTION_OPS[action.type];
    const value =
      action.type === "toggle" ? {} : decodeValue(action.value, target);
    actions.push({
      op,
      ...targetNames(target),
      ...value,
      ref: target.ref,
    });
    records.push({
      ref: target.ref,
      accessoryId: node.aId,
      characteristic: target.control?.name ?? null,
      role: "action",
      pointer: actionPointer,
      chain,
      op,
      ...value,
      ...(delay ? { delay } : {}),
    });
  });
  for (const record of records) {
    const siblings = records
      .filter((other) => other !== record)
      .map(({ characteristic, op, value, unit, value_name: valueName }) => ({
        characteristic,
        op,
        ...(value === undefined ? {} : { value }),
        ...(unit === undefined ? {} : { unit }),
        ...(valueName === undefined ? {} : { value_name: valueName }),
      }));
    if (siblings.length > 0) record.same_device_actions = siblings;
    state.records.push(record);
  }
  return actions;
}

function decodeScenarioRun(node, state) {
  const { context } = state;
  const index = typeof node.index === "string" ? node.index : null;
  const known = index === null ? null : context.scenarios?.get(index);
  return {
    type: "run_scenario",
    mode: typeof node.mode === "string" ? node.mode : null,
    scenario_ref:
      index === null
        ? null
        : `${context.homeRef}/scenario/${encodeURIComponent(index)}`,
    scenario_name: known?.name ?? null,
    ...(known ? { active: known.active === true } : {}),
    ...(context.scenarios && index !== null && !known
      ? { binding: "not_found" }
      : {}),
  };
}

// Public fields of one relation role: what the scenario does with the
// selected entity, in which branch, under which conditions and after which
// delay. `when` joins the enclosing if conditions, time included.
export function relationRole(record) {
  const grouped = record.chain.length > 1;
  const when = record.chain
    .map(({ text, branch }) => {
      if (branch === "else") return `not (${text})`;
      return grouped && / (?:AND|OR) /.test(text) ? `(${text})` : text;
    })
    .join(" AND ");
  return {
    role: record.role,
    op: record.op,
    ...(Object.hasOwn(record, "value") ? { value: record.value } : {}),
    ...(record.unit === undefined ? {} : { unit: record.unit }),
    ...(record.value_name === undefined
      ? {}
      : { value_name: record.value_name }),
    ...(record.value_status === undefined
      ? {}
      : { value_status: record.value_status }),
    ...(record.held ? { held: record.held } : {}),
    ...(record.role === "action"
      ? { branch: record.chain.at(-1)?.branch ?? null }
      : {}),
    ...(when ? { when } : {}),
    ...(record.delay ? { delay: record.delay } : {}),
    ...(record.same_device_actions
      ? { same_device_actions: record.same_device_actions }
      : {}),
    pointer: record.pointer,
  };
}

function decodeCron(node) {
  if (!isRecord(node) || typeof node.cron !== "string") return null;
  const fields = node.cron.trim().split(/\s+/);
  if (fields.length !== 7) return null;
  const [second, minute, hour, dayOfMonth, month, dayOfWeek, year] = fields;
  const mode = node.mode ?? "NONE";
  const offset = node.offset ?? 0;
  if (!Number.isSafeInteger(offset)) return null;
  if (mode === "SUNRISE" || mode === "SUNSET") {
    const days = decodeDays(dayOfWeek);
    if (
      !days ||
      second !== "0" ||
      minute !== "0" ||
      !["0", "12"].includes(hour) ||
      dayOfMonth !== "?" ||
      month !== "*" ||
      year !== "*"
    ) {
      return null;
    }
    const sun = mode === "SUNRISE" ? "sunrise" : "sunset";
    return withText({ sun, offset_seconds: offset, days });
  }
  if (mode !== "NONE") return null;
  const suffix = offset === 0 ? {} : { offset_seconds: offset };
  const clock = clockTime(hour, minute, second);
  if (clock && dayOfMonth === "?" && month === "*" && year === "*") {
    const days = decodeDays(dayOfWeek);
    return days ? withText({ at: clock, days, ...suffix }) : null;
  }
  if (
    clock &&
    /^\d{1,2}$/.test(dayOfMonth) &&
    /^\d{1,2}$/.test(month) &&
    dayOfWeek === "?" &&
    /^\d{4}$/.test(year)
  ) {
    const date = `${year}-${month.padStart(2, "0")}-${dayOfMonth.padStart(2, "0")}`;
    return withText({ date, at: clock, ...suffix });
  }
  const every = everyInterval(second, minute, hour);
  if (every && dayOfMonth === "?" && month === "*" && year === "*") {
    const days = decodeDays(dayOfWeek);
    return days ? withText({ every, days, ...suffix }) : null;
  }
  return null;
}

function clockTime(hour, minute, second) {
  if (second !== "0" || !/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) {
    return null;
  }
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function everyInterval(second, minute, hour) {
  const step = (field) => /^0\/(\d{1,2})$/.exec(field)?.[1];
  if (second === "0" && minute === "0" && step(hour)) {
    return { hours: Number(step(hour)) };
  }
  if (second === "0" && step(minute) && hour === "*") {
    return { minutes: Number(step(minute)) };
  }
  if (step(second) && minute === "*" && hour === "*") {
    return { seconds: Number(step(second)) };
  }
  return null;
}

function decodeDays(field) {
  if (field === "*") return "every day";
  const days = [];
  for (const part of field.split(",")) {
    const range = /^([A-Z]{3})-([A-Z]{3})$/.exec(part);
    if (range) {
      const start = DAY_NAMES.indexOf(range[1]);
      const end = DAY_NAMES.indexOf(range[2]);
      if (start < 0 || end < 0) return null;
      for (let day = start; ; day = (day + 1) % 7) {
        days.push(DAY_NAMES[day]);
        if (day === end) break;
      }
      continue;
    }
    if (!DAY_NAMES.includes(part)) return null;
    days.push(part);
  }
  const unique = DAY_NAMES.filter((day) => days.includes(day));
  return unique.length === 7 ? "every day" : unique;
}

function withText(time) {
  const days =
    time.every && time.days === "every day" ? "" : daysSuffix(time.days);
  return { ...time, text: `${momentText(time)}${days}` };
}

function momentText(time) {
  let text;
  if (time.sun) {
    text =
      time.offset_seconds === 0
        ? time.sun
        : `${durationText(Math.abs(time.offset_seconds))} ${time.offset_seconds < 0 ? "before" : "after"} ${time.sun}`;
    return text;
  }
  if (time.every) {
    const [[unit, amount]] = Object.entries(time.every);
    text = `every ${amount} ${{ hours: "h", minutes: "min", seconds: "s" }[unit]}`;
  } else if (time.date) {
    text = `${time.date} ${time.at}`;
  } else {
    text = time.at;
  }
  if (time.offset_seconds) {
    text += ` ${time.offset_seconds < 0 ? "-" : "+"}${durationText(Math.abs(time.offset_seconds))}`;
  }
  return text;
}

function daysSuffix(days) {
  if (days === undefined) return "";
  return days === "every day" ? " every day" : ` ${days.join(",")}`;
}

function withoutDays({ days: _days, text: _text, ...time }) {
  return time;
}

function durationText(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return (
    [
      hours ? `${hours} h` : "",
      minutes ? `${minutes} min` : "",
      rest ? `${rest} s` : "",
    ]
      .filter(Boolean)
      .join(" ") || "0 s"
  );
}

function decodeHeld(node) {
  if (typeof node.timeCond !== "string" || node.timeCond === "") return null;
  const seconds = millisecondsToSeconds(node.time);
  if (node.timeCond === ">") {
    return {
      op: ">",
      seconds,
      text: `and unchanged for more than ${durationText(seconds ?? 0)}`,
    };
  }
  if (node.timeCond === "<") {
    return {
      op: "<",
      seconds,
      text: `and changed back within ${durationText(seconds ?? 0)}`,
    };
  }
  return {
    op: node.timeCond,
    seconds,
    text: `held ${node.timeCond} ${seconds ?? "?"} s`,
  };
}

function describeTarget(context, aId, sId, cId, { nativeType }) {
  const valid = [aId, sId, cId].every(
    (id) => Number.isSafeInteger(id) && id >= 0,
  );
  const accessory = valid ? context.accessories?.get(aId) : undefined;
  const service = accessory?.services?.find((item) => item?.sId === sId);
  const control = service?.characteristics?.find(
    (item) => item?.cId === cId,
  )?.control;
  return {
    ref: valid
      ? `${context.homeRef}/accessory/${aId}/service/${sId}/characteristic/${cId}`
      : null,
    accessoryId: aId,
    serviceId: sId,
    accessory,
    service,
    control: isRecord(control) ? control : undefined,
    nativeType: typeof nativeType === "string" ? nativeType : null,
    room:
      accessory && context.rooms
        ? (context.rooms.get(accessory.roomId) ?? null)
        : null,
    sensitive:
      isRecord(control) && context.isSensitiveControl?.(control) === true,
    resolved: context.accessories != null,
  };
}

function targetNames(target) {
  return {
    device: textOrNull(target.accessory?.name),
    room: textOrNull(target.room),
    service: textOrNull(target.service?.name),
    characteristic: textOrNull(target.control?.name),
    characteristic_type: textOrNull(target.control?.type) ?? target.nativeType,
    ...(target.resolved && !target.control ? { binding: "not_found" } : {}),
  };
}

function targetText(target) {
  if (!target.accessory) {
    return `accessory ${target.accessoryId} / service ${target.serviceId}: ${target.nativeType ?? "characteristic"}`;
  }
  const service =
    target.service?.name && target.service.name !== target.accessory.name
      ? ` / ${target.service.name}`
      : "";
  const characteristic =
    target.control?.name ?? target.nativeType ?? "characteristic";
  return `${target.accessory.name}${service}: ${characteristic}`;
}

function decodeValue(raw, target) {
  if (target.sensitive) return { value: REDACTED };
  if (typeof raw !== "string") {
    return { value: raw === undefined ? null : raw, value_status: "not_text" };
  }
  const field = VALUE_FIELDS.find((candidate) =>
    Object.hasOwn(target.control?.value ?? {}, candidate),
  );
  let value = raw;
  if (field === "boolValue" && (raw === "true" || raw === "false")) {
    value = raw === "true";
  } else if (
    NUMBER_FIELDS.has(field) &&
    raw.trim() !== "" &&
    Number.isFinite(Number(raw))
  ) {
    value = Number(raw);
  }
  const unit =
    typeof value === "number" && typeof target.control?.unit === "string"
      ? target.control.unit
      : undefined;
  const named = Array.isArray(target.control?.validValues)
    ? target.control.validValues.find((candidate) => {
        const typed = candidate?.value?.[field];
        return typed !== undefined && Object.is(typed, value);
      })
    : undefined;
  return {
    value,
    ...(unit === undefined ? {} : { unit }),
    ...(typeof named?.name === "string" ? { value_name: named.name } : {}),
  };
}

function valueText({ value, unit, value_name: valueName }) {
  if (isRecord(value)) return "[REDACTED]";
  const base = `${typeof value === "string" ? JSON.stringify(value) : String(value)}${unit ? ` ${unit}` : ""}`;
  return valueName ? `${base} (${valueName})` : base;
}

function unrecognized(state, pointer, node, reason) {
  const nativeType =
    isRecord(node) && typeof node.type === "string" && !isRedacted(node)
      ? node.type
      : null;
  const entry = {
    pointer,
    native_type: nativeType,
    ...(reason
      ? { reason }
      : isRedacted(node)
        ? { reason: "redacted" }
        : nativeType === null
          ? { reason: "not_a_node" }
          : {}),
  };
  state.unrecognized.push(entry);
  return { type: "unrecognized", ...entry };
}

function textOrNull(value) {
  return typeof value === "string" ? value : null;
}

function millisecondsToSeconds(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? value / 1000
    : null;
}

function withoutText({ text: _text, ...rest }) {
  return rest;
}

const REDACTED = { redacted: true, reason: "sensitive_native_data" };

function isRedacted(value) {
  return (
    isRecord(value) &&
    value.redacted === true &&
    value.reason === "sensitive_native_data"
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
