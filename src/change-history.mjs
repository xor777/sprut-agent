import { blockAffectedRefs } from "./block-model.mjs";
import {
  catalogAffectedRefs,
  catalogRestoreSupported,
  isCatalogChangeKind,
} from "./catalog-changes.mjs";
import { publicPauseEffect } from "./change-presentation.mjs";
import { groupRef, REDACTED_MARK, stableNativeId } from "./change-refs.mjs";
import {
  changeName,
  restoreIntentTime,
  summaryValue,
} from "./change-restore.mjs";
import {
  dashboardAffectedRefs,
  dashboardRestoreSupported,
  isDashboardChangeKind,
} from "./dashboard-changes.mjs";
import { matchesStems, normalizeName, queryStems } from "./home-reads.mjs";
import {
  changeOperation,
  LIGHT_GROUP_MEMBERS,
} from "./light-group-members.mjs";
import { createdLogicMapping } from "./logic-changes.mjs";
import {
  isNativeValueChange,
  manualValueChangeObserved,
  nativeValueRestoration,
} from "./native-values.mjs";
import {
  isRoomServiceOrderKind,
  roomServiceOrderAffectedRefs,
  roomServiceOrderRestoreSupported,
} from "./room-service-order.mjs";
import {
  isLogicSourceChange,
  scenarioConflictAsksForNewPrepare,
  scenarioRestoreSupported,
} from "./scenario-changes.mjs";
import { SCENARIO_DELETE } from "./scenario-delete.mjs";
import { SprutHubError, zonedTimestamp } from "./spruthub-client.mjs";
import { VIRTUAL_DEVICE, VIRTUAL_DEVICE_DELETE } from "./virtual-device.mjs";
import { WINDOW_BUTTON } from "./window-buttons.mjs";
import { canOwnCreatedAccessories } from "./xiaomi-join.mjs";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_OFFSET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const APPLIED_HISTORY_STATUSES = new Set([
  "applied",
  "restored",
  "completed",
  "superseded",
  "uncertain",
  "applying",
  "restoring",
]);

// When a change was first applied: its first apply intent, else (a draft)
// when it was recorded.
export function applicationTime(change) {
  return changeAppliedAt(change) ?? change.created_at;
}

export function compareApplication(left, right) {
  return (
    applicationTime(left).localeCompare(applicationTime(right)) ||
    (left.group_id !== undefined && left.group_id === right.group_id
      ? left.group_index - right.group_index
      : 0) ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}

// Whether a stored history record can currently be passed to
// restore_native_change, matching publicNativeChange's per-kind ownership,
// restoration rules, and recoverable post-apply conflicts while marking
// unsent, terminal, and right-lost statuses false.
export function summaryRestoreSupported(change) {
  if (change.kind === "scenario_run" || change.kind === WINDOW_BUTTON) {
    return false;
  }
  const activeStatus =
    change.status === "applied" ||
    change.status === "uncertain" ||
    ((change.status === "applying" || change.status === "restoring") &&
      change.native_write_sent === true);
  const isConflict = change.status === "conflict";
  if (!activeStatus && !isConflict) return false;
  if (change.kind === "room_create") {
    return change.room_creation_owned === true;
  }
  if (change.kind === "virtual_light_group") {
    return change.virtual_accessory_creation_owned === true;
  }
  if (change.kind === VIRTUAL_DEVICE) {
    return change.creation_owned === true;
  }
  if (change.kind === VIRTUAL_DEVICE_DELETE) {
    return change.status === "applied";
  }
  if (change.kind === "logic_assignment") {
    return isConflict
      ? change.applied_snapshot !== undefined &&
          change.assignment_ownership_lost !== true
      : change.assignment_ownership_lost !== true;
  }
  if (change.kind === "accessory_placement") {
    return isConflict
      ? change.applied_snapshot !== undefined &&
          change.conflict_reason === "later_owned_change"
      : true;
  }
  if (change.kind === LIGHT_GROUP_MEMBERS) {
    return isConflict
      ? change.conflict_reason === "later_owned_change" &&
          Boolean(change.steps?.some(({ sent }) => sent))
      : true;
  }
  if (
    change.kind === "block_create" ||
    change.kind === "block_data_update" ||
    isLogicSourceChange(change)
  ) {
    if (!scenarioRestoreSupported(change)) return false;
    return isConflict ? !scenarioConflictAsksForNewPrepare(change) : true;
  }
  if (isNativeValueChange(change)) {
    if (
      change.lamp_level === true ||
      !nativeValueRestoration(change).supported
    ) {
      return false;
    }
    return isConflict
      ? change.applied_value_observed === true &&
          !manualValueChangeObserved(change)
      : true;
  }
  if (change.kind === "block_action_pause" || change.kind === SCENARIO_DELETE) {
    return activeStatus;
  }
  if (isDashboardChangeKind(change.kind)) {
    return dashboardRestoreSupported(change, { activeStatus, isConflict });
  }
  if (isRoomServiceOrderKind(change.kind)) {
    return roomServiceOrderRestoreSupported(change, {
      activeStatus,
      isConflict,
    });
  }
  if (isCatalogChangeKind(change.kind)) {
    return catalogRestoreSupported(change, { activeStatus, isConflict });
  }
  return activeStatus;
}

export function isAppliedHistoryChange(change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "rejected" ||
    (change.status === "not_owned" &&
      (change.conflict_reason === "change_was_not_applied" ||
        (change.write_intent?.direction === "apply" &&
          change.write_intent?.rejection !== undefined)))
  ) {
    return false;
  }
  if (APPLIED_HISTORY_STATUSES.has(change.status)) return true;
  return (
    change.native_write_sent === true ||
    change.caused_by_change_id !== undefined ||
    change.applied_value_observed === true
  );
}

// Pure syntactic validation of history filters so malformed dates, inverted
// comparable bounds, and punctuation-only queries fail before hub contact.
export function parseHistoryFilterSyntax({ since, until, query } = {}) {
  const parsedSince =
    since === undefined ? null : parseHistoryBound(since, "since");
  const parsedUntil =
    until === undefined ? null : parseHistoryBound(until, "until");
  if (parsedSince !== null && parsedUntil !== null) {
    if (
      parsedSince.kind === "date" &&
      parsedUntil.kind === "date" &&
      parsedSince.raw > parsedUntil.raw
    ) {
      throw invertedTimeRange();
    }
    if (
      parsedSince.kind === "timestamp" &&
      parsedUntil.kind === "timestamp" &&
      parsedSince.ms > parsedUntil.ms
    ) {
      throw invertedTimeRange();
    }
  }
  let parsedQuery = null;
  if (query !== undefined) {
    const raw = typeof query === "string" ? query.trim() : "";
    const normalized = normalizeName(raw);
    if (normalized.length === 0) {
      throw new SprutHubError(
        "invalid_history_query",
        "query must contain at least one letter or digit.",
        "get_native_change",
      );
    }
    const tokens = normalized.split(" ");
    parsedQuery = {
      raw,
      normalized,
      tokens,
      stems: queryStems(raw),
      numericTokens: tokens.filter((token) => /^\d+$/.test(token)),
    };
  }
  return {
    since: parsedSince,
    until: parsedUntil,
    needsTimeZone: parsedSince?.kind === "date" || parsedUntil?.kind === "date",
    query: parsedQuery,
  };
}

export function resolveHistoryTimeRange(parsed, hubTimeZone) {
  const { since, until, needsTimeZone } = parsed;
  if (since === null && until === null) {
    return {
      sinceMs: null,
      untilMs: null,
      sinceAt: null,
      untilAt: null,
      timeZone: null,
      timeZoneSource: null,
    };
  }
  let zone = null;
  let timeZoneSource;
  if (needsTimeZone) {
    zone = isValidIanaTimeZone(hubTimeZone) ? hubTimeZone : null;
    timeZoneSource = zone !== null ? "hub" : "utc_fallback";
  } else {
    timeZoneSource = "explicit";
  }
  const sinceMs =
    since === null
      ? null
      : since.kind === "date"
        ? startOfCalendarDayMs(since.year, since.month, since.day, zone)
        : since.ms;
  const untilMs =
    until === null
      ? null
      : until.kind === "date"
        ? endOfCalendarDayMs(until.year, until.month, until.day, zone)
        : until.ms;
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    throw invertedTimeRange();
  }
  const formatBound = (ms) =>
    ms === null
      ? null
      : zone !== null
        ? (zonedTimestamp(ms, zone) ?? new Date(ms).toISOString())
        : new Date(ms).toISOString();
  return {
    sinceMs,
    untilMs,
    sinceAt: formatBound(sinceMs),
    untilAt: formatBound(untilMs),
    timeZone: zone ?? "UTC",
    timeZoneSource,
  };
}

export function matchesHistoryTimeRange(change, sinceMs, untilMs) {
  if (sinceMs === null && untilMs === null) return true;
  if (inTimeRange(Date.parse(applicationTime(change)), sinceMs, untilMs)) {
    return true;
  }
  if (change.status === "restored") {
    const restoredAt = restoreIntentTime(change) ?? change.updated_at;
    if (inTimeRange(Date.parse(restoredAt), sinceMs, untilMs)) {
      return true;
    }
  }
  return false;
}

// Matches against already-sanitized changeSummary fields only, stripping
// REDACTED_MARK so redacted placeholders are never searchable either.
// Stopword/single-char fallbacks and pure numeric tokens match whole words.
export function matchesHistoryQuery(sanitizedSummary, parsedQuery) {
  const searchable = historySearchText(sanitizedSummary);
  if (searchable.length === 0) return false;
  const words = normalizeName(searchable).split(" ");
  if (parsedQuery.stems.length === 0) {
    return parsedQuery.tokens.every((token) => words.includes(token));
  }
  if (!matchesStems(parsedQuery.stems, searchable)) return false;
  return parsedQuery.numericTokens.every((token) => words.includes(token));
}

export function historyFiltersEcho({
  parsed,
  timeRange,
  appliedOnly,
  sanitizedQuery,
}) {
  const hasFilter =
    parsed.since !== null ||
    parsed.until !== null ||
    appliedOnly !== undefined ||
    parsed.query !== null;
  if (!hasFilter) return undefined;
  return {
    ...(parsed.since !== null ? { since: parsed.since.raw } : {}),
    ...(parsed.until !== null ? { until: parsed.until.raw } : {}),
    ...(timeRange.sinceAt !== null ? { since_at: timeRange.sinceAt } : {}),
    ...(timeRange.untilAt !== null ? { until_at: timeRange.untilAt } : {}),
    ...(timeRange.timeZone !== null ? { time_zone: timeRange.timeZone } : {}),
    ...(timeRange.timeZoneSource !== null
      ? { time_zone_source: timeRange.timeZoneSource }
      : {}),
    ...(appliedOnly !== undefined ? { applied_only: appliedOnly } : {}),
    ...(parsed.query !== null
      ? { query: sanitizedQuery ?? parsed.query.raw }
      : {}),
  };
}

// What an owner recognises in a history line: what changed (name, value),
// why (the agent's reason), when, its status and the call it belongs to.
// Affected refs only select (entity_ref); they are not listed, so a line
// stays short however many devices a scenario touches.
export function changeSummary(change) {
  const name = changeName(change);
  const appliedAt = changeAppliedAt(change);
  const described = {
    ...(name ? { name } : {}),
    ...(typeof change.reason === "string" ? { reason: change.reason } : {}),
  };
  const reference = `spruthub-change://native/${change.id}`;
  const value = summaryValue(change);
  return {
    change_ref: reference,
    operation: changeOperation(change),
    ...described,
    target_ref: change.target_ref,
    ...(change.bridge_export ? { bridge: change.bridge_export.bridge } : {}),
    ...(value ? { value } : {}),
    recorded_status: change.status,
    restore_supported: summaryRestoreSupported(change),
    ...(change.kind === "block_action_pause"
      ? {
          effect_status: publicPauseEffect(change).status,
          ...(change.replaces_pause_change_id
            ? {
                replaces_change_ref: `spruthub-change://native/${change.replaces_pause_change_id}`,
              }
            : {}),
          ...(change.superseded_by_change_ref
            ? { superseded_by_change_ref: change.superseded_by_change_ref }
            : {}),
          ...(change.completed_by_change_ref
            ? { completed_by_change_ref: change.completed_by_change_ref }
            : {}),
          ...(change.restored_by_change_ref
            ? { restored_by_change_ref: change.restored_by_change_ref }
            : {}),
        }
      : {}),
    ...(change.group_id ? { group_ref: groupRef(change.group_id) } : {}),
    ...(appliedAt ? { applied_at: appliedAt } : {}),
    created_at: change.created_at,
    updated_at: change.updated_at,
    next: {
      tool: "get_native_change",
      arguments: { change_ref: reference },
    },
  };
}

export function changeAppliedAt(change) {
  return change.history?.find(({ status }) => status === "applying")?.at;
}

export function compareChangeSummaries(left, right) {
  const updated = right.updated_at.localeCompare(left.updated_at);
  return updated || left.change_ref.localeCompare(right.change_ref);
}

export function historySelection(
  homeRef,
  entityRef,
  limit,
  cursor,
  filters = {},
) {
  const since = filters.since ?? null;
  const until = filters.until ?? null;
  const sinceMs = filters.sinceMs ?? null;
  const untilMs = filters.untilMs ?? null;
  const appliedOnly = filters.appliedOnly === true;
  const query = filters.query ?? null;
  const scope = JSON.stringify({
    home_ref: homeRef,
    entity_ref: entityRef ?? null,
    since,
    until,
    since_ms: sinceMs,
    until_ms: untilMs,
    applied_only: appliedOnly,
    query,
  });
  const selection = {
    homeRef,
    entityRef: entityRef ?? null,
    since,
    until,
    appliedOnly,
    query,
    limit,
    scope,
  };
  return {
    ...selection,
    after: decodeHistoryCursor(cursor, scope, selection),
  };
}

export function decodeHistoryCursor(cursor, expectedScope, selection) {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed?.v !== 2 ||
      typeof parsed.after_ref !== "string" ||
      parsed.after_ref.length === 0 ||
      typeof parsed.after_updated_at !== "string" ||
      parsed.after_updated_at.length === 0 ||
      parsed.scope !== expectedScope
    ) {
      throw new Error("invalid cursor");
    }
    return {
      change_ref: parsed.after_ref,
      updated_at: parsed.after_updated_at,
    };
  } catch {
    throw invalidHistoryCursor(selection);
  }
}

export function encodeHistoryCursor(after, scope) {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      after_ref: after.change_ref,
      after_updated_at: after.updated_at,
      scope,
    }),
  ).toString("base64url");
}

export function historyNext(selection, cursor) {
  return {
    tool: "get_native_change",
    arguments: {
      home_ref: selection.homeRef,
      ...(selection.entityRef ? { entity_ref: selection.entityRef } : {}),
      ...(selection.since !== null ? { since: selection.since } : {}),
      ...(selection.until !== null ? { until: selection.until } : {}),
      ...(selection.appliedOnly ? { applied_only: true } : {}),
      ...(selection.query !== null ? { query: selection.query } : {}),
      limit: selection.limit,
      ...(cursor ? { cursor } : {}),
    },
  };
}

export function invalidHistoryCursor(selection) {
  return new SprutHubError(
    "invalid_cursor",
    "Use the cursor returned by the history of get_native_change for the same home and filters.",
    "restart_history",
    { next: historyNext(selection, null) },
  );
}

function parseHistoryBound(raw, field) {
  if (typeof raw !== "string") throw invalidTimeBound(field);
  const dateOnly = DATE_ONLY_PATTERN.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (!isValidCalendarDate(year, month, day)) {
      throw invalidTimeBound(field);
    }
    return { kind: "date", raw, year, month, day };
  }
  const iso = ISO_OFFSET_PATTERN.exec(raw);
  if (!iso) throw invalidTimeBound(field);
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  const hour = Number(iso[4]);
  const minute = Number(iso[5]);
  const second = Number(iso[6]);
  const frac = iso[7] ?? "";
  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw invalidTimeBound(field);
  }
  let offsetMinutes = 0;
  if (iso[8] !== "Z") {
    const sign = iso[9] === "-" ? -1 : 1;
    const offsetHour = Number(iso[10]);
    const offsetMinute = Number(iso[11]);
    if (offsetHour > 23 || offsetMinute > 59) {
      throw invalidTimeBound(field);
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  const millisecond =
    frac.length > 0 ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  const ms =
    utcMillis(year, month, day, hour, minute, second, millisecond) -
    offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) throw invalidTimeBound(field);
  return { kind: "timestamp", raw, ms };
}

function invalidTimeBound(field) {
  return new SprutHubError(
    "invalid_time_range",
    `${field} must be a valid calendar date (YYYY-MM-DD) or an ISO-8601 timestamp with an explicit timezone offset (Z or ±HH:MM), e.g. 2026-11-20 or 2026-11-20T10:00:00+03:00.`,
    "get_native_change",
  );
}

function invertedTimeRange() {
  return new SprutHubError(
    "invalid_time_range",
    "since must be earlier than or equal to until.",
    "get_native_change",
  );
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidCalendarDate(year, month, day) {
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  );
}

function nextCalendarDay(year, month, day) {
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1 };
  if (month < 12) return { year, month: month + 1, day: 1 };
  return { year: year + 1, month: 1, day: 1 };
}

function utcMillis(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

function isValidIanaTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Earliest UTC epoch millisecond (aligned to whole seconds) whose wall-clock
// calendar date in timeZone is >= (year, month, day), handling DST transitions
// including midnight jumps and fall-backs.
function startOfCalendarDayMs(year, month, day, timeZone) {
  const baseUtc = utcMillis(year, month, day);
  if (timeZone === null || timeZone === "UTC") return baseUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const targetCode = year * 10_000 + month * 100 + day;
  let lo = baseUtc - 18 * 3_600_000;
  let hi = baseUtc + 18 * 3_600_000;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2_000) * 1_000;
    if (dateCodeInZone(formatter, mid) < targetCode) lo = mid + 1_000;
    else hi = mid;
  }
  return lo;
}

function endOfCalendarDayMs(year, month, day, timeZone) {
  const next = nextCalendarDay(year, month, day);
  return startOfCalendarDayMs(next.year, next.month, next.day, timeZone) - 1;
}

function dateCodeInZone(formatter, ms) {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return year * 10_000 + month * 100 + day;
}

function inTimeRange(timestampMs, sinceMs, untilMs) {
  return (
    Number.isFinite(timestampMs) &&
    (sinceMs === null || timestampMs >= sinceMs) &&
    (untilMs === null || timestampMs <= untilMs)
  );
}

function historySearchText(summary) {
  const parts = [];
  for (const field of [
    summary.name,
    summary.reason,
    summary.operation,
    summary.bridge,
  ]) {
    if (typeof field === "string" && field.length > 0) {
      parts.push(field.replaceAll(REDACTED_MARK, " "));
    }
  }
  if (summary.value !== undefined && summary.value !== null) {
    for (const bound of [summary.value.from, summary.value.to]) {
      if (
        typeof bound === "string" ||
        typeof bound === "number" ||
        typeof bound === "boolean"
      ) {
        parts.push(String(bound).replaceAll(REDACTED_MARK, " "));
      }
    }
  }
  return parts.join(" ");
}

export function nativeAffectedRefs(change, homeRef) {
  const refs = [change.target_ref];
  if (isNativeValueChange(change)) {
    if (typeof change.window_ref === "string") refs.push(change.window_ref);
    refs.push(...canonicalAncestors(refs[0]));
    // A bridge export is the service's and its accessory's.
    if (change.bridge_export) {
      const { service_ref: ref } = change.bridge_export;
      refs.push(ref, ref.replace(/\/service\/\d+$/, ""));
    }
  }
  if (change.kind === "accessory_placement") {
    refs.push(
      `${homeRef}/room/${change.baseline_snapshot.room_id}`,
      `${homeRef}/room/${change.requested_snapshot.room_id}`,
    );
  } else if (change.kind === "room_create") {
    if (change.created_room_id !== undefined) {
      refs.push(`${homeRef}/room/${change.created_room_id}`);
    }
    for (const candidate of change.candidate_rooms ?? []) {
      refs.push(`${homeRef}/room/${candidate.id}`);
    }
  } else if (change.kind === "virtual_light_group") {
    refs.push(change.room_ref, ...change.member_service_refs);
    if (change.created_accessory_id !== undefined) {
      refs.push(`${homeRef}/accessory/${change.created_accessory_id}`);
      for (const type of change.characteristic_types) {
        const target = change.virtual_target.characteristics[type];
        refs.push(...bindingRefs(homeRef, target.aId, target.sId, target.cId));
      }
    }
    for (const ref of change.member_service_refs) {
      refs.push(...canonicalAncestors(ref));
    }
  } else if (
    change.kind === "virtual_device" ||
    change.kind === "virtual_device_delete"
  ) {
    // The device created, deleted or made again, and its room.
    refs.push(`${homeRef}/room/${change.room_id}`);
    for (const id of [
      change.created_id,
      change.baseline_snapshot?.id,
      change.recreated_id,
    ]) {
      if (id !== undefined) refs.push(`${homeRef}/accessory/${id}`);
    }
  } else if (change.kind === LIGHT_GROUP_MEMBERS) {
    // The group and the lamps that join or leave it.
    refs.push(...canonicalAncestors(change.target_ref));
    for (const member of change.members) {
      if (member.change === "stays") continue;
      refs.push(member.service_ref, ...canonicalAncestors(member.service_ref));
    }
  }
  if (change.kind === WINDOW_BUTTON) {
    if (typeof change.extension_key === "string") {
      const extRef = `${homeRef}/extension/${encodeURIComponent(change.extension_key)}`;
      refs.push(extRef);
      const childId =
        change.device_remove?.child_id ??
        change.xiaomi_join?.child_id ??
        change.child_id;
      if (typeof childId === "string") {
        refs.push(`${extRef}/child/${encodeURIComponent(childId)}`);
      }
    }
    for (const accessory of change.device_remove?.linked_accessories ?? []) {
      if (typeof accessory?.ref === "string") refs.push(accessory.ref);
    }
    if (canOwnCreatedAccessories(change)) {
      for (const ref of change.created_accessory_refs ?? []) {
        if (typeof ref === "string") refs.push(ref);
      }
      for (const accessory of change.observed_effect?.created_accessories ??
        []) {
        if (typeof accessory?.ref === "string") refs.push(accessory.ref);
      }
    }
  } else if (change.kind === "logic_assignment") {
    refs.push(...canonicalAncestors(refs[0]));
  } else if (
    [
      "block_create",
      "block_data_update",
      "block_action_pause",
      "scenario_run",
    ].includes(change.kind)
  ) {
    if (change.scenario_index) {
      refs.push(
        `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
      );
    }
    const configurations =
      change.kind === "block_create"
        ? [change.requested_snapshot?.data]
        : change.kind === "scenario_run"
          ? [change.baseline_snapshot?.data]
          : [
              change.baseline_snapshot?.data,
              change.requested_snapshot?.data,
              change.restore_snapshot?.data,
            ];
    for (const data of configurations) {
      refs.push(...blockAffectedRefs(data, homeRef));
    }
  } else if (isLogicSourceChange(change)) {
    if (change.scenario_index) {
      refs.push(
        `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
      );
    }
    const { type } =
      change.kind === "logic_source_create" ? createdLogicMapping(change) : {};
    if (type !== undefined) {
      refs.push(`${change.target_ref}/logic/${encodeURIComponent(type)}`);
    }
  } else if (isDashboardChangeKind(change.kind)) {
    refs.push(...dashboardAffectedRefs(change, homeRef, canonicalAncestors));
  } else if (isRoomServiceOrderKind(change.kind)) {
    refs.push(
      ...roomServiceOrderAffectedRefs(change, homeRef, canonicalAncestors),
    );
  } else if (isCatalogChangeKind(change.kind)) {
    refs.push(...catalogAffectedRefs(change));
  }
  return uniqueRefs(refs);
}

export function bindingRefs(homeRef, aId, sId, cId) {
  if (!stableNativeId(aId)) return [];
  const accessory = `${homeRef}/accessory/${aId}`;
  if (!stableNativeId(sId)) return [accessory];
  const service = `${accessory}/service/${sId}`;
  return stableNativeId(cId)
    ? [accessory, service, `${service}/characteristic/${cId}`]
    : [accessory, service];
}

export function canonicalAncestors(ref) {
  const logic =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+\/service\/\d+)\/logic\/[^/]+$/.exec(
      ref,
    );
  if (logic) {
    const service = logic[1];
    return [service.replace(/\/service\/\d+$/, ""), service];
  }
  const characteristic =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+\/service\/\d+)\/characteristic\/\d+$/.exec(
      ref,
    );
  if (characteristic) {
    const service = characteristic[1];
    return [service.replace(/\/service\/\d+$/, ""), service];
  }
  const service =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+)\/service\/\d+$/.exec(ref);
  if (service) return [service[1]];
  const dashboardChild =
    /^((spruthub:\/\/hub\/[^/]+)\/dashboard\/[1-9]\d*)\/(?:column|widget)\/[1-9]\d*$/.exec(
      ref,
    );
  if (dashboardChild) {
    return [dashboardChild[2], dashboardChild[1]];
  }
  const dashboard = /^(spruthub:\/\/hub\/[^/]+)\/dashboard\/[1-9]\d*$/.exec(
    ref,
  );
  return dashboard ? [dashboard[1]] : [];
}

export function uniqueRefs(refs) {
  return [...new Set(refs.filter((ref) => typeof ref === "string"))];
}
