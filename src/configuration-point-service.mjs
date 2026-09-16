import { isDeepStrictEqual } from "node:util";
import { comparableScenarioConfigurationData } from "./automation-service.mjs";
import {
  CONFIGURATION_POINT_FORMAT_VERSION,
  ConfigurationPointStore,
  configurationPointRef,
  parseConfigurationPointRef,
} from "./configuration-point-store.mjs";
import {
  isRedactedNode,
  parseEntityRef,
  SprutHubError,
} from "./spruthub-client.mjs";

const SUPPORTED_KINDS = new Set([
  "scenario",
  "accessory",
  "logic",
  "window",
  "characteristic",
]);
// Observed control parameters for this history slice, not a restore
// allowlist and not every writable characteristic.
const CONTROL_SETTING_TYPES = new Set([
  "TargetTemperature",
  "TargetHeatingCoolingState",
  "C_FanSpeed",
]);

export class ConfigurationPointService {
  constructor({ client = null, stateDirectory, hubUrl, hubSerial }) {
    this.client = client;
    this.stateDirectory = stateDirectory;
    this.hubUrl = hubUrl;
    this.configuredSerial = hubSerial ?? null;
  }

  storeFor(serial) {
    return new ConfigurationPointStore({
      directory: this.stateDirectory,
      hubUrl: this.hubUrl,
      hubSerial: serial,
    });
  }

  async save({ home_ref: homeRef, entity_refs: entityRefs }) {
    const serial = this.#requireHome(homeRef);
    this.#requireClient();
    const started = new Date().toISOString();
    const captured = [];
    const notCaptured = [];
    const selected = [];
    const seen = new Set();
    for (const entityRef of entityRefs) {
      if (seen.has(entityRef)) continue;
      seen.add(entityRef);
      selected.push(entityRef);
      const result = await this.#captureEntity(serial, entityRef);
      if (result.captured) captured.push(result.captured);
      notCaptured.push(...result.not_captured);
    }
    const finished = new Date().toISOString();
    const store = this.storeFor(serial);
    const id = store.newId();
    const point = {
      version: CONFIGURATION_POINT_FORMAT_VERSION,
      id,
      hub_fingerprint: store.hubFingerprint,
      home_ref: homeRef,
      capture_started_at: started,
      capture_finished_at: finished,
      selected_entity_refs: selected,
      captured,
      not_captured: notCaptured,
    };
    await store.save(point);
    const pointRef = configurationPointRef(serial, id);
    return {
      status: "ok",
      point_ref: pointRef,
      home_ref: homeRef,
      capture_started_at: started,
      capture_finished_at: finished,
      coverage: "selected_entities",
      house_complete: false,
      atomic_snapshot: false,
      captured: captured.map(({ entity_ref, kind }) => ({ entity_ref, kind })),
      not_captured: notCaptured,
      next: {
        tool: "get_configuration_point",
        arguments: { point_ref: pointRef },
      },
    };
  }

  async list({ home_ref: homeRef, entity_ref: entityRef, limit = 10, cursor }) {
    const serial = this.#requireHome(homeRef);
    if (entityRef !== undefined) this.#requireEntityHome(entityRef, serial);
    const { points, unavailable } = await this.storeFor(serial).list();
    const filtered = points
      .filter(
        (point) =>
          entityRef === undefined ||
          point.selected_entity_refs.includes(entityRef) ||
          point.captured.some(({ entity_ref }) => entity_ref === entityRef),
      )
      .sort(comparePoints);
    const after = decodeListCursor(cursor, homeRef, entityRef);
    const remaining =
      after === null
        ? filtered
        : filtered.filter((point) => comparePoints(point, after) > 0);
    const page = remaining.slice(0, limit);
    const nextCursor =
      page.length < remaining.length
        ? encodeListCursor(page.at(-1), homeRef, entityRef)
        : null;
    return {
      status: "ok",
      home_ref: homeRef,
      ...(entityRef ? { entity_ref: entityRef } : {}),
      coverage: "selected_entities",
      house_complete: false,
      points: page.map((point) => summarizePoint(point, serial)),
      unavailable,
      page: {
        limit,
        returned_points: page.length,
        remaining_points: remaining.length - page.length,
        snapshot: false,
        next_cursor: nextCursor,
      },
      next: nextCursor
        ? {
            tool: "list_configuration_points",
            arguments: {
              home_ref: homeRef,
              ...(entityRef ? { entity_ref: entityRef } : {}),
              limit,
              cursor: nextCursor,
            },
          }
        : null,
    };
  }

  async get({ point_ref: pointRef, compare = false }) {
    const { serial, id } = parseConfigurationPointRef(pointRef);
    this.#requireSerial(serial);
    const point = await this.storeFor(serial).get(id);
    if (!point) {
      throw new SprutHubError(
        "configuration_point_not_found",
        "No configuration point with this reference exists for the selected home.",
        "list_configuration_points",
        { next: { tool: "list_configuration_points", arguments: {} } },
      );
    }
    const entity = publicPointEntity(point, serial);
    if (!compare) return { status: "ok", entity };
    this.#requireClient();
    return {
      status: "ok",
      entity,
      comparison: await this.#compare(serial, point),
    };
  }

  async #compare(serial, point) {
    const comparedAt = new Date().toISOString();
    const entities = [];
    for (const captured of point.captured) {
      const current = await this.#captureEntity(serial, captured.entity_ref);
      if (!current.captured) {
        const reason = current.not_captured[0]?.reason ?? "read_error";
        if (
          captured.kind === "characteristic" &&
          (reason === "unsupported_characteristic_type" ||
            reason === "redacted")
        ) {
          entities.push({
            entity_ref: captured.entity_ref,
            kind: captured.kind,
            status: "unchanged",
            changes: [],
            not_compared: [
              {
                path: ["value"],
                reason:
                  reason === "redacted" ? "redacted" : "incomparable_semantics",
              },
            ],
          });
          continue;
        }
        entities.push({
          entity_ref: captured.entity_ref,
          kind: captured.kind,
          status: reason === "entity_not_found" ? "missing" : "read_error",
          changes: [],
          not_compared: [{ path: [], reason }],
        });
        continue;
      }
      const { changes, not_compared } = diffCaptured(
        captured,
        current.captured,
      );
      entities.push({
        entity_ref: captured.entity_ref,
        kind: captured.kind,
        status: changes.length > 0 ? "changed" : "unchanged",
        changes,
        not_compared,
      });
    }
    return {
      compared_at: comparedAt,
      coverage: "selected_entities",
      house_complete: false,
      entities,
    };
  }

  async #captureEntity(serial, entityRef) {
    let parsed;
    try {
      parsed = parseEntityRef(entityRef);
    } catch {
      return notCaptured(entityRef, "invalid_entity_ref");
    }
    if (parsed.serial !== serial) {
      return notCaptured(entityRef, "wrong_home");
    }
    if (parsed.kind === "window" && parsed.windowKey === "") {
      return notCaptured(entityRef, "home_settings_window");
    }
    if (!SUPPORTED_KINDS.has(parsed.kind)) {
      return notCaptured(entityRef, "unsupported_entity_kind");
    }
    let entity;
    try {
      const include =
        parsed.kind === "scenario"
          ? ["configuration"]
          : parsed.kind === "logic"
            ? ["options"]
            : [];
      ({ entity } = await this.client.getEntity(entityRef, include));
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      if (isHubUnavailable(error)) throw error;
      if (error.code === "entity_not_found") {
        return notCaptured(entityRef, "entity_not_found");
      }
      return notCaptured(entityRef, "read_error", {
        error_code: error.code,
      });
    }
    return extractCapturedEntity(entity, entityRef);
  }

  #requireClient() {
    if (!this.client) {
      throw new SprutHubError(
        "connection_failed",
        "Comparing a configuration point requires a live SprutHub read.",
        "retry",
      );
    }
  }

  #requireHome(homeRef) {
    let parsed;
    try {
      parsed = parseEntityRef(homeRef);
    } catch {
      throw invalidHomeRef();
    }
    if (parsed.kind !== "home") throw invalidHomeRef();
    this.#requireSerial(parsed.serial);
    return parsed.serial;
  }

  #requireEntityHome(entityRef, serial) {
    let parsed;
    try {
      parsed = parseEntityRef(entityRef);
    } catch {
      throw new SprutHubError(
        "invalid_entity_ref",
        "Use a home-qualified reference returned by list_homes, inspect_home, or get_entity.",
        "inspect_home",
      );
    }
    if (parsed.serial !== serial) throw wrongHome();
  }

  #requireSerial(serial) {
    if (this.configuredSerial != null && serial !== this.configuredSerial) {
      throw wrongHome();
    }
  }
}

function extractCapturedEntity(entity, entityRef) {
  if (isRedactedNode(entity)) {
    return notCaptured(entityRef, "redacted");
  }
  if (entity.kind === "characteristic") {
    return extractCapturedCharacteristic(entity, entityRef);
  }
  if (entity.kind === "accessory") {
    return {
      captured: {
        entity_ref: entity.ref,
        kind: "accessory",
        settings: {
          name: entity.name,
          room_ref: entity.room_ref,
        },
      },
      not_captured: [],
    };
  }
  if (entity.kind === "scenario") {
    const configuration = entity.configuration ?? {
      format: "not_returned",
      value: null,
    };
    return {
      captured: {
        entity_ref: entity.ref,
        kind: "scenario",
        settings: {
          name: entity.name,
          description: entity.description ?? null,
          type: entity.type,
          predefined: entity.predefined === true,
          active: entity.active === true,
          on_start: entity.on_start === true,
          sync: entity.sync === true,
          configuration:
            configuration.format === "json" &&
            configuration.value &&
            typeof configuration.value === "object"
              ? {
                  format: "json",
                  value: comparableScenarioConfigurationData(
                    configuration.value,
                  ),
                }
              : configuration,
        },
      },
      not_captured: [],
    };
  }
  if (entity.kind === "logic" || entity.kind === "window") {
    const { options, not_captured } = extractOptions(
      entity.ref,
      entity.options ?? [],
    );
    return {
      captured: {
        entity_ref: entity.ref,
        kind: entity.kind,
        settings:
          entity.kind === "logic"
            ? {
                type: entity.type,
                name: entity.name,
                active: entity.active === true,
                options,
              }
            : {
                name: entity.name ?? null,
                options,
              },
        ...(not_captured.length > 0
          ? { not_captured_options: not_captured }
          : {}),
      },
      not_captured: [],
    };
  }
  return notCaptured(entity.ref, "unsupported_entity_kind");
}

function extractCapturedCharacteristic(entity, entityRef) {
  if (!CONTROL_SETTING_TYPES.has(entity.type)) {
    return notCaptured(entityRef, "unsupported_characteristic_type");
  }
  const current = entity.current_value;
  if (!current || typeof current !== "object") {
    return notCaptured(entityRef, "read_error");
  }
  const settings = {
    type: entity.type,
    name: entity.name,
    value: Object.hasOwn(current, "value") ? current.value : null,
    unit: entity.capabilities?.unit ?? null,
    available: entity.available === true,
    observed_at: entity.freshness?.observed_at ?? null,
    source_timestamp:
      current.source_timestamp ?? entity.freshness?.source_timestamp ?? null,
  };
  if (current.enum && typeof current.enum === "object") {
    settings.enum = {
      key: current.enum.key,
      name: current.enum.name,
    };
  }
  return {
    captured: {
      entity_ref: entityRef,
      kind: "characteristic",
      settings,
    },
    not_captured: [],
  };
}

function extractOptions(entityRef, options) {
  const captured = {};
  const notCaptured = [];
  for (const option of options) {
    if (isHidden(option)) {
      const key = typeof option.key === "string" ? option.key : null;
      if (key) captured[key] = redactedMarker();
      else notCaptured.push(notCapturedOption(entityRef, null, "redacted"));
      continue;
    }
    if (typeof option.key !== "string") {
      notCaptured.push(
        notCapturedOption(entityRef, null, "unsupported_option"),
      );
      continue;
    }
    if (option.native_change?.supported === true) {
      captured[option.key] = {
        name: option.name ?? "",
        type: option.type ?? null,
        input_type: option.input_type ?? null,
        configured_value: Object.hasOwn(option, "configured_value")
          ? option.configured_value
          : option.value,
      };
      continue;
    }
    notCaptured.push(
      notCapturedOption(
        entityRef,
        option.key,
        option.native_change?.reason ?? "unsupported_option",
      ),
    );
  }
  return { options: captured, not_captured: notCaptured };
}

function notCaptured(entityRef, reason, extra = {}) {
  return {
    captured: null,
    not_captured: [{ entity_ref: entityRef, reason, ...extra }],
  };
}

function notCapturedOption(entityRef, optionKey, reason) {
  return {
    entity_ref: entityRef,
    ...(optionKey ? { option_key: optionKey } : {}),
    reason,
  };
}

function publicPointEntity(point, serial) {
  return {
    kind: "configuration_point",
    ref: configurationPointRef(serial, point.id),
    home_ref: point.home_ref,
    capture_started_at: point.capture_started_at,
    capture_finished_at: point.capture_finished_at,
    coverage: "selected_entities",
    house_complete: false,
    atomic_snapshot: false,
    selected_entity_refs: point.selected_entity_refs,
    entities: point.captured,
    not_captured: point.not_captured,
  };
}

function summarizePoint(point, serial) {
  const pointRef = configurationPointRef(serial, point.id);
  return {
    point_ref: pointRef,
    capture_started_at: point.capture_started_at,
    capture_finished_at: point.capture_finished_at,
    entity_refs: point.selected_entity_refs,
    captured_kinds: [...new Set(point.captured.map(({ kind }) => kind))],
    next: {
      tool: "get_configuration_point",
      arguments: { point_ref: pointRef },
    },
  };
}

function diffCaptured(previous, current) {
  if (previous.kind === "characteristic") {
    return diffCharacteristicSettings(previous.settings, current.settings);
  }
  const { changes, not_compared } = diffSettings(
    previous.settings,
    current.settings,
  );
  return foldIncompleteOptions(previous, current, changes, not_compared);
}

function diffCharacteristicSettings(previous, current) {
  if (!climateSemanticsComparable(previous, current)) {
    return {
      changes: [],
      not_compared: [{ path: ["value"], reason: "incomparable_semantics" }],
    };
  }
  if (
    !isKnownClimateValue(previous.value) ||
    !isKnownClimateValue(current.value)
  ) {
    return {
      changes: [],
      not_compared: [{ path: ["value"], reason: "unknown_value" }],
    };
  }
  if (
    Object.is(previous.value, current.value) &&
    (previous.enum?.key ?? null) === (current.enum?.key ?? null)
  ) {
    return { changes: [], not_compared: [] };
  }
  return {
    changes: [
      {
        path: ["value"],
        from: comparableClimateValue(previous),
        to: comparableClimateValue(current),
      },
    ],
    not_compared: [],
  };
}

function climateSemanticsComparable(previous, current) {
  if (previous.type !== current.type) return false;
  if (!Object.is(previous.unit, current.unit)) return false;
  const previousKey = previous.enum?.key ?? null;
  const currentKey = current.enum?.key ?? null;
  if (previousKey === currentKey) return true;
  // Same type with different keys is an ordinary mode/speed change only when
  // the numeric codes also differ; the same code with a new key changed meaning.
  return (
    Boolean(previousKey) &&
    Boolean(currentKey) &&
    !Object.is(previous.value, current.value)
  );
}

function isKnownClimateValue(value) {
  return ["boolean", "number", "string"].includes(typeof value);
}

function comparableClimateValue(settings) {
  return {
    value: settings.value,
    ...(settings.enum
      ? { enum: { key: settings.enum.key, name: settings.enum.name } }
      : {}),
    unit: settings.unit,
  };
}

function diffSettings(previous, current) {
  const changes = [];
  const notCompared = [];
  diffValues([], previous, current, changes, notCompared);
  return { changes, not_compared: notCompared };
}

function foldIncompleteOptions(previous, current, changes, notCompared) {
  // Incomplete options are not add/remove: disabled, unsupported, and redacted
  // values stay not_compared, including when the option key is hidden.
  const previousByKey = keyedIncomplete(previous.not_captured_options);
  const currentByKey = keyedIncomplete(current.not_captured_options);
  const keys = new Set([...previousByKey.keys(), ...currentByKey.keys()]);
  const remainingChanges = changes.filter((change) => {
    const optionKey = change.path[0] === "options" ? change.path[1] : undefined;
    return typeof optionKey !== "string" || !keys.has(optionKey);
  });
  for (const key of keys) {
    const reason =
      currentByKey.get(key)?.reason ?? previousByKey.get(key)?.reason;
    notCompared.push({ path: ["options", key], reason });
  }
  const seen = new Set(notCompared.map((item) => JSON.stringify(item)));
  for (const item of [
    ...(previous.not_captured_options ?? []),
    ...(current.not_captured_options ?? []),
  ]) {
    if (item.option_key) continue;
    const entry = { path: ["options"], reason: item.reason };
    const encoded = JSON.stringify(entry);
    if (seen.has(encoded)) continue;
    seen.add(encoded);
    notCompared.push(entry);
  }
  return { changes: remainingChanges, not_compared: notCompared };
}

function keyedIncomplete(items = []) {
  return new Map(
    items
      .filter((item) => typeof item.option_key === "string")
      .map((item) => [item.option_key, item]),
  );
}

function diffValues(path, previous, current, changes, notCompared) {
  if (isHidden(previous) || isHidden(current)) {
    // Hidden values are not evidence of equality: two redacted secrets may differ.
    notCompared.push({ path, reason: "redacted" });
    return;
  }
  if (previous === undefined || current === undefined) {
    if (!isDeepStrictEqual(previous, current)) {
      changes.push({ path, from: previous, to: current });
    }
    return;
  }
  if (isPlainObject(previous) && isPlainObject(current)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const key of keys) {
      diffValues(
        [...path, key],
        Object.hasOwn(previous, key) ? previous[key] : undefined,
        Object.hasOwn(current, key) ? current[key] : undefined,
        changes,
        notCompared,
      );
    }
    return;
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    const length = Math.max(previous.length, current.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(
        [...path, index],
        previous[index],
        current[index],
        changes,
        notCompared,
      );
    }
    return;
  }
  if (!isDeepStrictEqual(previous, current)) {
    changes.push({ path, from: previous, to: current });
  }
}

function isHidden(value) {
  return isRedactedNode(value) || value === "[REDACTED]";
}

function redactedMarker() {
  return { redacted: true, reason: "sensitive_native_data" };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function comparePoints(left, right) {
  if (left.capture_finished_at < right.capture_finished_at) return 1;
  if (left.capture_finished_at > right.capture_finished_at) return -1;
  if (left.id < right.id) return 1;
  if (left.id > right.id) return -1;
  return 0;
}

function encodeListCursor(point, homeRef, entityRef) {
  return Buffer.from(
    JSON.stringify({
      home_ref: homeRef,
      entity_ref: entityRef ?? null,
      finished_at: point.capture_finished_at,
      id: point.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeListCursor(cursor, homeRef, entityRef) {
  if (cursor === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (
    parsed?.home_ref !== homeRef ||
    (parsed.entity_ref ?? null) !== (entityRef ?? null) ||
    typeof parsed.finished_at !== "string" ||
    typeof parsed.id !== "string"
  ) {
    throw invalidCursor();
  }
  return { capture_finished_at: parsed.finished_at, id: parsed.id };
}

function invalidCursor() {
  return new SprutHubError(
    "invalid_cursor",
    "Use the cursor returned by list_configuration_points for the same home and filter.",
    "list_configuration_points",
  );
}

function invalidHomeRef() {
  return new SprutHubError(
    "invalid_home_ref",
    "Use a home reference returned by list_homes.",
    "list_homes",
  );
}

function wrongHome() {
  return new SprutHubError(
    "wrong_home",
    "This configuration point belongs to another home. Use a home_ref for the configured SprutHub connection.",
    "list_homes",
  );
}

function isHubUnavailable(error) {
  return [
    "connection_failed",
    "connection_closed",
    "timeout",
    "invalid_message",
    "authentication_delayed",
  ].includes(error.code);
}
