import { canonicalBlock, withHiddenHttpUrls } from "./block-model.mjs";
import {
  CONFIGURATION_POINT_FORMAT_VERSION,
  ConfigurationPointStore,
  configurationPointRef,
  parseConfigurationPointRef,
} from "./configuration-point-store.mjs";
import {
  attributeSelectedComparison,
  CONTROL_SETTING_TYPES,
  captureHomeSnapshot,
  compareHomeSnapshots,
  diffCharacteristicSettings,
  diffSettings,
  HOME_SNAPSHOT_EXCLUDED_CATEGORIES,
  homePointContainsEntity,
  homeSnapshotCounts,
  isHidden,
  isPlainObject,
  redactedMarker,
  withHiddenHomeSnapshotUrls,
} from "./home-configuration-point.mjs";
import { createHubBackup, listHubBackups } from "./hub-backup.mjs";
import {
  homeRef as homeRefOf,
  isRedactedNode,
  isSensitiveNativeNode,
  parseEntityRef,
  SprutHubError,
  sanitizeAgentOutput,
} from "./spruthub-client.mjs";

const SUPPORTED_KINDS = new Set([
  "scenario",
  "accessory",
  "logic",
  "window",
  "characteristic",
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

  async save({
    home_ref: requestedHomeRef,
    entity_refs: entityRefs,
    note,
    sensitiveValues = [],
  }) {
    const sanitizedNote = sanitizePointNote(note, sensitiveValues);
    const homeRef = this.#selectedHomeRef(requestedHomeRef);
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
      coverage: "selected_entities",
      ...(sanitizedNote !== undefined ? { note: sanitizedNote } : {}),
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
      ...(sanitizedNote !== undefined ? { note: sanitizedNote } : {}),
      capture_started_at: started,
      capture_finished_at: finished,
      coverage: "selected_entities",
      house_complete: false,
      atomic_snapshot: false,
      captured: captured.map(({ entity_ref, kind }) => ({ entity_ref, kind })),
      not_captured: notCaptured,
      next: {
        tool: "configuration_point",
        arguments: { point_ref: pointRef },
      },
    };
  }

  async saveHome({
    home_ref: requestedHomeRef,
    note,
    sensitiveValues = [],
  } = {}) {
    const sanitizedNote = sanitizePointNote(note, sensitiveValues);
    const homeRef = this.#selectedHomeRef(requestedHomeRef);
    const serial = this.#requireHome(homeRef);
    this.#requireClient(
      "Saving a whole-home configuration point requires a live SprutHub connection.",
    );
    const started = new Date().toISOString();
    const { home_snapshot: snapshot, not_captured: notCaptured } =
      await captureHomeSnapshot({
        client: this.client,
        serial,
        sensitiveValues,
      });
    const finished = new Date().toISOString();
    const store = this.storeFor(serial);
    const id = store.newId();
    const point = {
      version: CONFIGURATION_POINT_FORMAT_VERSION,
      id,
      hub_fingerprint: store.hubFingerprint,
      home_ref: homeRef,
      coverage: "home",
      house_complete: false,
      excluded_categories: HOME_SNAPSHOT_EXCLUDED_CATEGORIES,
      ...(sanitizedNote !== undefined ? { note: sanitizedNote } : {}),
      capture_started_at: started,
      capture_finished_at: finished,
      selected_entity_refs: [],
      captured: [],
      not_captured: notCaptured,
      home_snapshot: snapshot,
    };
    await store.save(point);
    const pointRef = configurationPointRef(serial, id);
    return {
      status: "ok",
      point_ref: pointRef,
      home_ref: homeRef,
      scope: "home",
      coverage: "home",
      house_complete: false,
      atomic_snapshot: false,
      ...(sanitizedNote !== undefined ? { note: sanitizedNote } : {}),
      capture_started_at: started,
      capture_finished_at: finished,
      counts: homeSnapshotCounts(snapshot),
      not_captured: notCaptured,
      excluded_categories: HOME_SNAPSHOT_EXCLUDED_CATEGORIES,
      next: {
        tool: "configuration_point",
        arguments: { point_ref: pointRef },
      },
    };
  }

  async list({
    home_ref: requestedHomeRef,
    entity_ref: entityRef,
    limit = 10,
    cursor,
  }) {
    const homeRef = this.#selectedHomeRef(requestedHomeRef);
    const serial = this.#requireHome(homeRef);
    if (entityRef !== undefined) this.#requireEntityHome(entityRef, serial);
    const { points, unavailable } = await this.storeFor(serial).list();
    const filtered = points
      .filter(
        (point) =>
          entityRef === undefined || pointContainsEntity(point, entityRef),
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
    const scopes = new Set(page.map((point) => pointCoverage(point)));
    const listCoverage =
      scopes.size === 1
        ? [...scopes][0]
        : scopes.size > 1
          ? "mixed"
          : "selected_entities";
    return {
      status: "ok",
      home_ref: homeRef,
      ...(entityRef ? { entity_ref: entityRef } : {}),
      coverage: listCoverage,
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
            tool: "configuration_point",
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

  async get({ point_ref: pointRef, compare = false, sensitiveValues = [] }) {
    const { serial, id } = parseConfigurationPointRef(pointRef);
    this.#requireSerial(serial);
    const stored = await this.storeFor(serial).get(id);
    if (!stored) {
      throw new SprutHubError(
        "configuration_point_not_found",
        "No configuration point with this reference exists for the selected home.",
        "configuration_point",
        { next: { tool: "configuration_point", arguments: {} } },
      );
    }
    const point =
      pointCoverage(stored) === "home"
        ? withHiddenHomeSnapshotUrls(stored)
        : withSecretOptionsHidden(withRequestUrlsHidden(stored));
    const entity = publicPointEntity(point, serial, {
      compactHome: compare === true,
    });
    if (!compare) return { status: "ok", entity };
    this.#requireClient();
    const comparison =
      pointCoverage(point) === "home"
        ? await this.#compareHome(serial, point, sensitiveValues)
        : await this.#compare(serial, point, sensitiveValues);
    return {
      status: "ok",
      entity,
      comparison,
    };
  }

  async createHubBackup({ home_ref: requestedHomeRef } = {}) {
    const homeRef = this.#selectedHomeRef(requestedHomeRef);
    const serial = this.#requireHome(homeRef);
    this.#requireClient(
      "Creating a hub backup requires a live SprutHub connection.",
    );
    return createHubBackup({
      client: this.client,
      serial,
      homeRef,
      stateDirectory: this.stateDirectory,
      hubUrl: this.hubUrl,
    });
  }

  async listHubBackups({ home_ref: requestedHomeRef, limit = 10 } = {}) {
    const homeRef = this.#selectedHomeRef(requestedHomeRef);
    const serial = this.#requireHome(homeRef);
    return listHubBackups({
      client: this.client,
      serial,
      homeRef,
      stateDirectory: this.stateDirectory,
      hubUrl: this.hubUrl,
      limit,
    });
  }

  async #compareHome(serial, point, sensitiveValues) {
    const currentCapture = await captureHomeSnapshot({
      client: this.client,
      serial,
      sensitiveValues,
    });
    const comparedAt = new Date().toISOString();
    return compareHomeSnapshots({
      point,
      currentCapture,
      comparedAt,
      stateDirectory: this.stateDirectory,
      hubUrl: this.hubUrl,
      serial,
      sensitiveValues,
    });
  }

  async #compare(serial, point, sensitiveValues) {
    const entities = [];
    const currentByRef = new Map();
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
      currentByRef.set(captured.entity_ref, current.captured);
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
        ...currentObservationFrom(current.captured),
      });
    }
    const comparedAt = new Date().toISOString();
    const attributed = await attributeSelectedComparison({
      point,
      entities,
      currentByRef,
      comparedAt,
      stateDirectory: this.stateDirectory,
      hubUrl: this.hubUrl,
      serial,
      sensitiveValues,
    });
    return {
      compared_at: comparedAt,
      coverage: "selected_entities",
      house_complete: false,
      ...attributed,
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

  #requireClient(
    message = "Comparing a configuration point requires a live SprutHub read.",
  ) {
    if (!this.client) {
      throw new SprutHubError("connection_failed", message, "retry");
    }
  }

  #selectedHomeRef(homeRef) {
    if (homeRef !== undefined) return homeRef;
    if (this.configuredSerial == null) {
      throw new SprutHubError(
        "home_ref_required",
        "No home is selected in the connection settings: pass home_ref from home_overview.",
        "home_overview",
        { next: { tool: "home_overview", arguments: {} } },
      );
    }
    return homeRefOf(this.configuredSerial);
  }

  #requireHome(homeRef) {
    return validateConfigurationPointHomeRef(homeRef, this.configuredSerial);
  }

  #requireEntityHome(entityRef, serial) {
    let parsed;
    try {
      parsed = parseEntityRef(entityRef);
    } catch {
      throw new SprutHubError(
        "invalid_entity_ref",
        "Use a home-qualified reference returned by home_overview, find_devices, or get_entity.",
        "home_overview",
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
          // As read; comparableSettings brings it to the compared form.
          configuration,
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

// A point holds a scenario configuration as get_entity returned it when the
// point was saved. Points saved before get_entity hid every request URL
// beyond scheme and host hold such a URL as read, and a key may sit in its
// path (Telegram /bot<token>/), so a point is shown and compared with the
// rule get_entity applies now.
function withRequestUrlsHidden(point) {
  return {
    ...point,
    captured: point.captured.map((captured) => {
      const configuration = captured.settings?.configuration;
      if (captured.kind !== "scenario" || configuration?.format !== "json") {
        return captured;
      }
      return {
        ...captured,
        settings: {
          ...captured.settings,
          configuration: {
            ...configuration,
            value: withHiddenHttpUrls(configuration.value),
          },
        },
      };
    }),
  };
}

// A point holds window and logic options as get_entity showed them when it
// was saved. An option hidden since then, such as a keypad passcode kept as
// an ordinary NUMBER, is shown and compared hidden, as get_entity shows it
// now.
function withSecretOptionsHidden(point) {
  return {
    ...point,
    captured: point.captured.map((captured) => {
      const options = captured.settings?.options;
      if (!isPlainObject(options)) return captured;
      return {
        ...captured,
        settings: {
          ...captured.settings,
          options: Object.fromEntries(
            Object.entries(options).map(([key, option]) => [
              key,
              isPlainObject(option) &&
              !isHidden(option) &&
              isSensitiveNativeNode({ ...option, key })
                ? redactedMarker()
                : option,
            ]),
          ),
        },
      };
    }),
  };
}

function pointCoverage(point) {
  return point.coverage === "home" ? "home" : "selected_entities";
}

function pointContainsEntity(point, entityRef) {
  if (pointCoverage(point) === "home") {
    return homePointContainsEntity(point, entityRef);
  }
  return (
    point.selected_entity_refs.includes(entityRef) ||
    point.captured.some(({ entity_ref }) => entity_ref === entityRef)
  );
}

export function sanitizePointNote(note, sensitiveValues = []) {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new SprutHubError(
      "invalid_point_call",
      "note must contain at least one non-whitespace character.",
      "configuration_point",
    );
  }
  return sanitizeAgentOutput(trimmed, sensitiveValues);
}

function publicPointEntity(point, serial, { compactHome = false } = {}) {
  const ref = configurationPointRef(serial, point.id);
  if (pointCoverage(point) === "home") {
    return {
      kind: "configuration_point",
      ref,
      home_ref: point.home_ref,
      scope: "home",
      coverage: "home",
      house_complete: false,
      atomic_snapshot: false,
      ...(point.note !== undefined ? { note: point.note } : {}),
      capture_started_at: point.capture_started_at,
      capture_finished_at: point.capture_finished_at,
      counts: homeSnapshotCounts(point.home_snapshot),
      excluded_categories:
        point.excluded_categories ?? HOME_SNAPSHOT_EXCLUDED_CATEGORIES,
      ...(compactHome ? {} : { home_snapshot: point.home_snapshot }),
      not_captured: point.not_captured,
    };
  }
  return {
    kind: "configuration_point",
    ref,
    home_ref: point.home_ref,
    ...(point.note !== undefined ? { note: point.note } : {}),
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
  if (pointCoverage(point) === "home") {
    return {
      point_ref: pointRef,
      scope: "home",
      coverage: "home",
      ...(point.note !== undefined ? { note: point.note } : {}),
      capture_started_at: point.capture_started_at,
      capture_finished_at: point.capture_finished_at,
      counts: homeSnapshotCounts(point.home_snapshot),
      not_captured_count: point.not_captured.length,
      next: {
        tool: "configuration_point",
        arguments: { point_ref: pointRef },
      },
    };
  }
  return {
    point_ref: pointRef,
    scope: "selected_entities",
    ...(point.note !== undefined ? { note: point.note } : {}),
    capture_started_at: point.capture_started_at,
    capture_finished_at: point.capture_finished_at,
    entity_refs: point.selected_entity_refs,
    captured_kinds: [...new Set(point.captured.map(({ kind }) => kind))],
    next: {
      tool: "configuration_point",
      arguments: { point_ref: pointRef },
    },
  };
}

function diffCaptured(previous, current) {
  if (previous.kind === "characteristic") {
    return diffCharacteristicSettings(previous.settings, current.settings);
  }
  const { changes, not_compared } = diffSettings(
    comparableSettings(previous),
    comparableSettings(current),
  );
  return foldIncompleteOptions(previous, current, changes, not_compared);
}

// A scenario configuration is compared in canonicalBlock form on both sides.
// A point holds the data as read; points saved by 0.1.44 hold that form
// already, earlier ones the data without blockIds, and both still compare.
function comparableSettings(captured) {
  const configuration = captured.settings?.configuration;
  if (
    captured.kind !== "scenario" ||
    configuration?.format !== "json" ||
    !isPlainObject(configuration.value)
  ) {
    return captured.settings;
  }
  return {
    ...captured.settings,
    configuration: {
      ...configuration,
      value: canonicalBlock(configuration.value),
    },
  };
}

function currentObservationFrom(captured) {
  if (captured?.kind !== "characteristic") return {};
  const settings = captured.settings;
  if (!settings || typeof settings !== "object") return {};
  return {
    current_observation: {
      available: settings.available,
      observed_at: settings.observed_at,
      source_timestamp: settings.source_timestamp,
    },
  };
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
    "Use the cursor returned by the configuration_point list for the same home and filter.",
    "configuration_point",
  );
}

export function validateConfigurationPointHomeRef(
  homeRef,
  configuredSerial = null,
) {
  let parsed;
  try {
    parsed = parseEntityRef(homeRef);
  } catch {
    throw invalidHomeRef();
  }
  if (parsed.kind !== "home") throw invalidHomeRef();
  if (configuredSerial != null && parsed.serial !== configuredSerial) {
    throw wrongHome();
  }
  return parsed.serial;
}

function invalidHomeRef() {
  return new SprutHubError(
    "invalid_home_ref",
    "Use a home reference returned by home_overview.",
    "home_overview",
  );
}

function wrongHome() {
  return new SprutHubError(
    "wrong_home",
    "This configuration point belongs to another home. Use a home_ref for the configured SprutHub connection.",
    "home_overview",
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
