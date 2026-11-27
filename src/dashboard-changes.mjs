// Native SprutHub 3.0 dashboard write operations (0 new MCP tools):
// dashboard_create, dashboard_update, dashboard_delete,
// dashboard_column_create, dashboard_column_update, dashboard_column_delete,
// dashboard_widget_create, dashboard_widget_update, dashboard_widget_delete,
// dashboard_widget_move.
// Protocol verified live on SprutHub 3.0.0 rev 20131
// (research/protocol/2026-11-26-dashboards.md).
import { isDeepStrictEqual } from "node:util";
import {
  configuredHomeRef,
  dashboardColumnRef,
  dashboardRef,
  dashboardWidgetRef,
  isRecord,
  isUncertainWriteError,
  parseCharacteristicRef,
  parseConfiguredHomeRef,
  parseDashboardColumnRef,
  parseDashboardRef,
  parseDashboardWidgetRef,
  parseServiceRef,
  refuseRedactionMark,
  writeRejection,
} from "./change-refs.mjs";
import {
  failedVerification,
  freshVerification,
  nativeIntentDirection,
} from "./native-values.mjs";
import {
  characteristicRef,
  redactSensitiveText,
  SprutHubError,
  serviceRef,
} from "./spruthub-client.mjs";

export const DASHBOARD_CREATE = "dashboard_create";
export const DASHBOARD_UPDATE = "dashboard_update";
export const DASHBOARD_DELETE = "dashboard_delete";
export const DASHBOARD_COLUMN_CREATE = "dashboard_column_create";
export const DASHBOARD_COLUMN_UPDATE = "dashboard_column_update";
export const DASHBOARD_COLUMN_DELETE = "dashboard_column_delete";
export const DASHBOARD_WIDGET_CREATE = "dashboard_widget_create";
export const DASHBOARD_WIDGET_UPDATE = "dashboard_widget_update";
export const DASHBOARD_WIDGET_DELETE = "dashboard_widget_delete";
export const DASHBOARD_WIDGET_MOVE = "dashboard_widget_move";

export const DASHBOARD_OPERATIONS = [
  DASHBOARD_CREATE,
  DASHBOARD_UPDATE,
  DASHBOARD_DELETE,
  DASHBOARD_COLUMN_CREATE,
  DASHBOARD_COLUMN_UPDATE,
  DASHBOARD_COLUMN_DELETE,
  DASHBOARD_WIDGET_CREATE,
  DASHBOARD_WIDGET_UPDATE,
  DASHBOARD_WIDGET_DELETE,
  DASHBOARD_WIDGET_MOVE,
];

const DASHBOARD_OPERATION_SET = new Set(DASHBOARD_OPERATIONS);
const DEFAULT_COLUMN_NAMES = ["Основная"];
export const DASHBOARD_HUB_NAME_MAX_LENGTH = 32;
const MAX_NAME_LENGTH = 120;
const MAX_COLUMNS = 20;
const MAX_ITEMS = 50;
const HISTORY_GROUPS = new Set(["MINUTE", "HOUR", "DAY"]);
const WIDGET_TYPES = [
  "characteristic",
  "service",
  "chart",
  "camera",
  "weather",
  "clock",
  "tile",
  "shortcut",
];
const WIDGET_TYPE_SET = new Set(WIDGET_TYPES);
const DEVICE_WIDGET_TYPES = new Set([
  "characteristic",
  "chart",
  "service",
  "camera",
]);
const DASHBOARD_NAME_RULE_NOTE =
  "SprutHub 3.0 truncates names to 32 chars and strips punctuation outside letters, digits, spaces, and - _ ' `.";
const HISTORY_MISSING_WARNING =
  "The History app («История») is not installed and running on this hub, so this chart widget will stay empty. Do not add empty chart widgets by default unless the owner explicitly asked for placeholders — prefer service widgets (with show_rooms: true) or characteristic widgets for live values, and tell the owner that History requires an external microSD/USB drive plus the History app.";
const CHART_DAY_GROUP_WARNING =
  "SprutHub 3.0's web UI maps chart history_group omitted -> 1 hour («Час»), MINUTE -> 24 hours («Сутки»), HOUR -> 1 week («Неделя»); DAY is unbound in the web UI and falls back to 1 hour («Час»).";
const TILE_UNRENDERED_WARNING =
  "SprutHub 3.0's current web UI does not render tile widgets (they are ignored by Column.vue). Use a service widget with show_rooms: true for tile grids.";
const WEATHER_PLACEHOLDER_WARNING =
  "SprutHub 3.0's current web UI renders weather widgets as a hardcoded placeholder («Москва, 21°, Облачно»).";

// Single source of truth for SprutHub 3.0.0 rev 20131 dashboard, column, and
// widget name normalization: trims & collapses whitespace, strips characters
// outside Unicode letters, digits, spaces, and - _ ' `, trims edges, and takes
// the first 32 Unicode code points. Accepts both the raw 32-code-point slice
// and the trimEnd() form (plus collapsed-space variants) so a trailing space at
// code point #32 never triggers a false conflict.
function hubNormalizedDashboardNameVariants(name) {
  if (typeof name !== "string") return [];
  const primaryCleaned = name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s\-_'`]/gu, "")
    .trim();
  const primaryCut = [...primaryCleaned]
    .slice(0, DASHBOARD_HUB_NAME_MAX_LENGTH)
    .join("");
  const collapsedCleaned = name
    .replace(/[^\p{L}\p{N}\s\-_'`]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const collapsedCut = [...collapsedCleaned]
    .slice(0, DASHBOARD_HUB_NAME_MAX_LENGTH)
    .join("");
  return [
    primaryCut.trimEnd(),
    primaryCut,
    collapsedCut.trimEnd(),
    collapsedCut,
  ];
}

export function predictSprutHubDashboardName(name) {
  if (typeof name !== "string") return "";
  return hubNormalizedDashboardNameVariants(name)[0];
}

export function isHubNormalizedDashboardName(requested, observed) {
  if (typeof requested !== "string" || typeof observed !== "string") {
    return false;
  }
  if (observed === requested) return false;
  return hubNormalizedDashboardNameVariants(requested).includes(observed);
}

function matchesDashboardName(requested, observed) {
  return (
    observed === requested || isHubNormalizedDashboardName(requested, observed)
  );
}

function nameNormalizationWarning(label, name) {
  const predicted = predictSprutHubDashboardName(name);
  if (predicted === name) return null;
  const shownStored = predicted === "" ? '"" (empty)' : `«${predicted}»`;
  return `SprutHub 3.0 truncates ${label} to ${DASHBOARD_HUB_NAME_MAX_LENGTH} chars and strips punctuation outside letters, digits, spaces, and - _ ' \`; expected stored name: ${shownStored}.`;
}

function duplicateCharacteristicWarning(
  repeatedTypes,
  widgetType = "characteristic",
) {
  const typesList = repeatedTypes.join(", ");
  if (widgetType === "chart") {
    return `SprutHub 3.0 chart widgets label each stacked graph header only by characteristic name and current value (without device or room), so repeating ${typesList} across multiple devices produces identical unreadable graph headers. Prefer one chart widget per device with device and room in widget.name.`;
  }
  return `SprutHub 3.0 characteristic widgets render form-control rows labeled only by characteristic name (without device or room), so repeating ${typesList} across multiple devices produces identical unreadable rows. For sensor/meter tiles across rooms, prefer a service widget with show_rooms: true (3-column tile grid with icon, value, service name, and room); for direct controls, prefer one characteristic widget per device with device and room in widget.name.`;
}

function warningRecordFields(warnings, historyAppMissing = false) {
  const list = (warnings ?? []).filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
  return {
    ...(historyAppMissing === true ? { history_app_missing: true } : {}),
    ...(list.length > 0
      ? {
          warning: list.join(" "),
          warnings: list,
        }
      : {}),
  };
}

export function isDashboardChangeKind(kind) {
  return DASHBOARD_OPERATION_SET.has(kind);
}

function isPendingRestoreIntent(change) {
  return (
    ["restoring", "uncertain"].includes(change?.status) &&
    nativeIntentDirection(change) === "restore"
  );
}

export function dashboardHubStepsSent(change, direction) {
  if (!isDashboardChangeKind(change?.kind)) return false;
  if (direction === "apply" && change.status === "applied") return false;
  const createdBy =
    direction === "apply"
      ? (change.created_dashboard_id ??
        change.created_column_id ??
        change.created_widget_id)
      : (change.recreated_dashboard_id ??
        change.recreated_column_id ??
        change.recreated_widget_id);
  return (
    createdBy !== undefined ||
    (["applying", "restoring", "uncertain"].includes(change.status) &&
      nativeIntentDirection(change) === direction)
  );
}

// Compact contracts (each well under INLINE_CONTRACT_MAX_BYTES = 4096 B) so
// prepare_native_change attaches them inline on caller field errors.
export function dashboardContract(operation) {
  switch (operation) {
    case DASHBOARD_CREATE:
      return {
        write: "dashboard.create({name}) + dashboardColumn.create per column",
        fields: {
          target_ref: "home_ref",
          name: {
            required: true,
            min_length: 1,
            max_length: MAX_NAME_LENGTH,
            hub_max_length: DASHBOARD_HUB_NAME_MAX_LENGTH,
            note: DASHBOARD_NAME_RULE_NOTE,
          },
          column_names: {
            optional: true,
            max_items: MAX_COLUMNS,
            default: DEFAULT_COLUMN_NAMES,
            note: "column.name is not rendered on the dashboard view (only dashboard.name and widget.name show; omitting widget.name hides the widget header). Columns are 350px wide: 1 swipe screen on phones (<720px), 2-4 side-by-side on tablet/desktop. Default to 1 column for phone-first dashboards; pass [] for 0 columns.",
          },
          reason: "required",
        },
        restore:
          "deletes the created dashboard only while its name and empty created columns are unchanged (refuses dashboard_not_empty / dashboard_changed_since).",
        restore_supported: true,
      };
    case DASHBOARD_UPDATE:
      return {
        write: "dashboard.update({id,name})",
        fields: {
          target_ref: "dashboard_ref",
          name: {
            required: true,
            min_length: 1,
            max_length: MAX_NAME_LENGTH,
            hub_max_length: DASHBOARD_HUB_NAME_MAX_LENGTH,
            note: DASHBOARD_NAME_RULE_NOTE,
          },
          reason: "required",
        },
        restore:
          "restores the previous dashboard name while live state matches the applied snapshot.",
        restore_supported: true,
      };
    case DASHBOARD_DELETE:
      return {
        write: "dashboard.delete({id})",
        fields: { target_ref: "dashboard_ref", reason: "required" },
        confirmation:
          "if widget_count > 0, prepare returns tell_owner with no next call until owner confirms.",
        restore:
          "recreates dashboard, columns and widgets under a new dashboard ID, skipping widgets whose devices or shortcut dashboards no longer exist (reported in skipped_widgets).",
        restore_supported: true,
      };
    case DASHBOARD_COLUMN_CREATE:
      return {
        write: "dashboardColumn.create({dashboardId,name?})",
        fields: {
          target_ref: "dashboard_ref",
          name: {
            optional: true,
            max_length: MAX_NAME_LENGTH,
            hub_max_length: DASHBOARD_HUB_NAME_MAX_LENGTH,
            note: `column.name is not rendered on the dashboard view (only dashboard.name and widget.name show). Columns are 350px wide (1 swipe screen on phones <720px, 2-4 side-by-side on tablet/desktop). ${DASHBOARD_NAME_RULE_NOTE}`,
          },
          reason: "required",
        },
        restore:
          "deletes the created column only while its name is unchanged and it has 0 widgets (refuses column_not_empty).",
        restore_supported: true,
      };
    case DASHBOARD_COLUMN_UPDATE:
      return {
        write: "dashboardColumn.update({dashboardId,id,name})",
        fields: {
          target_ref: "dashboard_column_ref",
          name: {
            required: true,
            max_length: MAX_NAME_LENGTH,
            hub_max_length: DASHBOARD_HUB_NAME_MAX_LENGTH,
            note: `column.name is not rendered on the dashboard view (only dashboard.name and widget.name show). Columns are 350px wide (1 swipe screen on phones <720px, 2-4 side-by-side on tablet/desktop). ${DASHBOARD_NAME_RULE_NOTE}`,
          },
          reason: "required",
        },
        restore:
          "restores the previous column name while live state matches the applied snapshot.",
        restore_supported: true,
      };
    case DASHBOARD_COLUMN_DELETE:
      return {
        write: "dashboardColumn.delete({dashboardId,id})",
        fields: { target_ref: "dashboard_column_ref", reason: "required" },
        confirmation:
          "cascades widgets in the column; if widget_count > 0, prepare returns tell_owner with no next call.",
        restore:
          "recreates column and widgets if the parent dashboard still exists (refuses dashboard_missing), skipping widgets whose devices or shortcut dashboards are gone.",
        restore_supported: true,
      };
    case DASHBOARD_WIDGET_CREATE:
    case DASHBOARD_WIDGET_UPDATE:
      return {
        write:
          operation === DASHBOARD_WIDGET_CREATE
            ? "dashboardWidget.create({dashboardId,columnId,name?,<kind>})"
            : "dashboardWidget.update({dashboardId,id,name?,<kind>})",
        fields: {
          target_ref:
            operation === DASHBOARD_WIDGET_CREATE
              ? "dashboard_column_ref"
              : "dashboard_widget_ref",
          widget: {
            required: true,
            name: {
              optional: true,
              max_length: MAX_NAME_LENGTH,
              hub_max_length: DASHBOARD_HUB_NAME_MAX_LENGTH,
              note: `Put widget title in widget.name, not top-level name; omitting widget.name hides the widget header cleanly. ${DASHBOARD_NAME_RULE_NOTE}`,
            },
            types: {
              service:
                "item_refs: service refs (1..50), optional show_rooms (boolean). 3-column tile grid (icon, value+unit, service name, room when show_rooms=true) for BOTH controls AND sensors/meters (tile span via service_grid).",
              characteristic:
                "item_refs: characteristic refs (1..50). Form-control rows labeled only by characteristic name (no device/room): best for direct controls of one device, not multi-device sensor grids.",
              chart:
                "item_refs: characteristic refs (1..50), optional history_group (omitted=1h Hour, MINUTE=24h Day, HOUR=7d Week; DAY falls back to 1h in 3.0 web UI). Stacked per-item graphs showing only characteristic name + value (1 chart per device for same metric). Requires running History app + microSD/USB.",
              shortcut:
                "shortcut_ids: existing dashboard IDs (1..50). Navigation menu linking to other dashboards with automatic Back history (not hub scenes/scenarios).",
              camera:
                "item_refs: service refs (1..50). Live camera stream cards.",
              clock:
                "no extra fields. Live clock + sunrise/sunset timeline (hardcoded to Europe/Moscow in 3.0 UI).",
              tile: "no extra fields. Not rendered by SprutHub 3.0 web UI (use service widget with show_rooms: true).",
              weather:
                "no extra fields. Hardcoded placeholder («Москва, 21°, Облачно») in SprutHub 3.0 web UI.",
            },
          },
          reason: "required",
        },
        restore:
          operation === DASHBOARD_WIDGET_CREATE
            ? "deletes the created widget while live state matches the applied snapshot."
            : "restores the previous widget payload while live state matches the applied snapshot.",
        restore_supported: true,
      };
    case DASHBOARD_WIDGET_DELETE:
      return {
        write: "dashboardWidget.delete({dashboardId,id})",
        fields: { target_ref: "dashboard_widget_ref", reason: "required" },
        restore:
          "recreates the widget in the same column if dashboard, column and referenced devices or shortcut dashboards still exist.",
        restore_supported: true,
      };
    case DASHBOARD_WIDGET_MOVE:
      return {
        write:
          "dashboardWidget.orders({orders: [{dashboardId,columnId,id,order}, ...]}) for all widgets in affected columns",
        fields: {
          target_ref: "dashboard_widget_ref",
          column_ref: {
            optional: true,
            note: "Destination dashboard_column_ref on the same dashboard; omit to reorder within current column.",
          },
          position: {
            optional: true,
            note: "0-based target index in destination column (required when staying in the same column; defaults to end when moving across columns).",
          },
          reason: "required",
        },
        restore:
          "restores original column membership and orders for all affected columns while live layout matches the applied layout.",
        restore_supported: true,
      };
    default:
      return null;
  }
}

// ---- Snapshots & equality --------------------------------------------------

function widgetSnapshot(widget) {
  return {
    dashboard_id: widget.dashboardId,
    column_id: widget.columnId,
    id: widget.id,
    name: typeof widget.name === "string" ? widget.name : "",
    order: widget.order ?? 0,
    type: widget.type,
    payload: canonicalWidgetPayload(widget.type, widget.payload),
  };
}

function columnSnapshot(column) {
  return {
    dashboard_id: column.dashboardId,
    id: column.id,
    name: typeof column.name === "string" ? column.name : "",
    order: column.order ?? 0,
    widgets: (column.widgets ?? []).map(widgetSnapshot),
  };
}

function dashboardSnapshot(dashboard) {
  return {
    id: dashboard.id,
    name: typeof dashboard.name === "string" ? dashboard.name : "",
    order: dashboard.order ?? 0,
    columns: (dashboard.columns ?? []).map(columnSnapshot),
  };
}

function canonicalWidgetPayload(type, raw = {}) {
  const payload = isRecord(raw) ? raw : {};
  if (type === "characteristic") {
    return {
      items: (payload.items ?? []).map(({ aId, sId, cId }) => ({
        aId,
        sId,
        cId,
      })),
    };
  }
  if (type === "chart") {
    return {
      items: (payload.items ?? []).map(({ aId, sId, cId }) => ({
        aId,
        sId,
        cId,
      })),
      ...(payload.group !== undefined ? { group: payload.group } : {}),
    };
  }
  if (type === "service") {
    return {
      items: (payload.items ?? []).map(({ aId, sId }) => ({ aId, sId })),
      ...(typeof payload.showRooms === "boolean"
        ? { showRooms: payload.showRooms }
        : {}),
    };
  }
  if (type === "camera") {
    return {
      items: (payload.items ?? []).map(({ aId, sId }) => ({ aId, sId })),
    };
  }
  if (type === "shortcut") {
    return {
      items: (payload.items ?? []).map(({ id }) => ({ id })),
    };
  }
  return {};
}

function widgetNeedsHomeCatalog(widget) {
  return (
    DEVICE_WIDGET_TYPES.has(widget?.type) &&
    Array.isArray(widget.payload?.items) &&
    widget.payload.items.length > 0
  );
}

function widgetNeedsDashboardList(widget) {
  return (
    widget?.type === "shortcut" &&
    Array.isArray(widget.payload?.items) &&
    widget.payload.items.length > 0
  );
}

function sameWidgetPayloadAndType(left, right) {
  if (!left || !right) return false;
  return (
    left.type === right.type &&
    isDeepStrictEqual(
      canonicalWidgetPayload(left.type, left.payload),
      canonicalWidgetPayload(right.type, right.payload),
    )
  );
}

function sameWidgetContent(left, right, { allowNormalizedName = false } = {}) {
  if (!sameWidgetPayloadAndType(left, right)) return false;
  const leftName = left.name ?? "";
  const rightName = right.name ?? "";
  if (leftName === rightName) return true;
  return (
    allowNormalizedName && isHubNormalizedDashboardName(rightName, leftName)
  );
}

function sortColumnWidgets(widgets = []) {
  return [...widgets].sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.id - right.id,
  );
}

function columnLayoutEntries(column) {
  return sortColumnWidgets(column.widgets).map((widget) => ({
    id: widget.id,
    order: widget.order ?? 0,
  }));
}

function sameColumnsLayout(dashboard, expectedColumns) {
  if (!dashboard || !Array.isArray(expectedColumns)) return false;
  return expectedColumns.every(({ column_id: columnId, widgets }) => {
    const liveColumn = dashboard.columns.find(({ id }) => id === columnId);
    if (!liveColumn) return false;
    return isDeepStrictEqual(columnLayoutEntries(liveColumn), widgets);
  });
}

function sameColumnStructure(left, right) {
  if (!left || !right) return false;
  if ((left.name ?? "") !== (right.name ?? "")) return false;
  const leftWidgets = left.widgets ?? [];
  const rightWidgets = right.widgets ?? [];
  if (leftWidgets.length !== rightWidgets.length) return false;
  return leftWidgets.every(
    (widget, index) =>
      widget.id === rightWidgets[index].id &&
      sameWidgetContent(widget, rightWidgets[index]),
  );
}

function sameDashboardStructure(left, right) {
  if (!left || !right) return false;
  if ((left.name ?? "") !== (right.name ?? "")) return false;
  const leftCols = left.columns ?? [];
  const rightCols = right.columns ?? [];
  if (leftCols.length !== rightCols.length) return false;
  return leftCols.every(
    (column, index) =>
      column.id === rightCols[index].id &&
      sameColumnStructure(column, rightCols[index]),
  );
}

// ---- Validation helpers ----------------------------------------------------

function forbidUnexpectedFields(input, fields, operation) {
  for (const field of fields) {
    if (input[field] !== undefined) {
      const hint =
        field === "name" &&
        (operation === DASHBOARD_WIDGET_CREATE ||
          operation === DASHBOARD_WIDGET_UPDATE)
          ? "Put the widget title in widget.name, not top-level name."
          : `${field} is not accepted by ${operation}.`;
      throw new SprutHubError("invalid_native_change", hint);
    }
  }
}

function validateRequiredName(value, operation) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SprutHubError(
      "name_required",
      `A non-empty name is required for ${operation}.`,
      "prepare_native_change",
    );
  }
  refuseRedactionMark(value, "name");
  if ([...value].length > MAX_NAME_LENGTH) {
    throw new SprutHubError(
      "name_too_long",
      `name must be at most ${MAX_NAME_LENGTH} characters.`,
      "prepare_native_change",
    );
  }
  if (predictSprutHubDashboardName(value) === "") {
    throw new SprutHubError(
      "invalid_native_value",
      "name would become empty on SprutHub 3.0 because it strips punctuation outside letters, digits, spaces, and - _ ' `.",
      "prepare_native_change",
    );
  }
  return value;
}

function validateOptionalColumnName(value, { required = false } = {}) {
  if (value === undefined) {
    if (required) {
      throw new SprutHubError(
        "name_required",
        "name is required for dashboard_column_update.",
        "prepare_native_change",
      );
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new SprutHubError(
      "invalid_native_value",
      "Column name must be a string.",
      "prepare_native_change",
    );
  }
  refuseRedactionMark(value, "name");
  if ([...value].length > MAX_NAME_LENGTH) {
    throw new SprutHubError(
      "name_too_long",
      `Column name must be at most ${MAX_NAME_LENGTH} characters.`,
      "prepare_native_change",
    );
  }
  if (
    required &&
    value.length > 0 &&
    predictSprutHubDashboardName(value) === ""
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "Column name would become empty on SprutHub 3.0 because it strips punctuation outside letters, digits, spaces, and - _ ' `.",
      "prepare_native_change",
    );
  }
  return value;
}

function validateColumnNames(raw) {
  if (raw === undefined) return [...DEFAULT_COLUMN_NAMES];
  if (!Array.isArray(raw)) {
    throw new SprutHubError(
      "invalid_native_value",
      "column_names must be an array of strings.",
    );
  }
  if (raw.length > MAX_COLUMNS) {
    throw new SprutHubError(
      "invalid_native_value",
      `column_names accepts at most ${MAX_COLUMNS} columns.`,
    );
  }
  return raw.map((name) => {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new SprutHubError(
        "invalid_native_value",
        "Every entry in column_names must be a non-empty string.",
      );
    }
    refuseRedactionMark(name, "column_names");
    if ([...name].length > MAX_NAME_LENGTH) {
      throw new SprutHubError(
        "name_too_long",
        `Every column name must be at most ${MAX_NAME_LENGTH} characters.`,
      );
    }
    if (predictSprutHubDashboardName(name) === "") {
      throw new SprutHubError(
        "invalid_native_value",
        "A column_names entry would become empty on SprutHub 3.0 because it strips punctuation outside letters, digits, spaces, and - _ ' `.",
      );
    }
    return name;
  });
}

async function resolveHomeCatalog(client, serial, { refresh = false } = {}) {
  const deadline = Date.now() + client.timeoutMs;
  const { catalog } = await client.homeCatalog(serial, deadline, { refresh });
  return catalog;
}

async function verifyCharacteristicExists(client, catalog, target, rawRef) {
  let accessory = catalog.byId.get(target.aId) ?? null;
  if (!accessory) {
    accessory = await client.getAccessoryOrNull(target.aId);
  }
  const service = accessory?.services?.find(({ sId }) => sId === target.sId);
  const characteristic = service?.characteristics?.find(
    ({ cId }) => cId === target.cId,
  );
  if (!characteristic) {
    throw new SprutHubError(
      "entity_not_found",
      `Characteristic ${rawRef} was not found on the hub.`,
      "find_devices",
    );
  }
  return characteristic;
}

async function verifyServiceExists(client, catalog, target, rawRef) {
  let accessory = catalog.byId.get(target.aId) ?? null;
  if (!accessory) {
    accessory = await client.getAccessoryOrNull(target.aId);
  }
  const service = accessory?.services?.find(({ sId }) => sId === target.sId);
  if (!service) {
    throw new SprutHubError(
      "entity_not_found",
      `Service ${rawRef} was not found on the hub.`,
      "find_devices",
    );
  }
}

function findMissingWidgetRefs(catalog, homeRef, widget, dashboardIds = null) {
  const missing = [];
  if (catalog && widgetNeedsHomeCatalog(widget)) {
    if (widget.type === "characteristic" || widget.type === "chart") {
      for (const item of widget.payload?.items ?? []) {
        const accessory = catalog.byId.get(item.aId);
        const service = accessory?.services?.find(
          ({ sId }) => sId === item.sId,
        );
        const characteristic = service?.characteristics?.find(
          ({ cId }) => cId === item.cId,
        );
        if (!characteristic) {
          missing.push(
            `${homeRef}/accessory/${item.aId}/service/${item.sId}/characteristic/${item.cId}`,
          );
        }
      }
    } else if (widget.type === "service" || widget.type === "camera") {
      for (const item of widget.payload?.items ?? []) {
        const accessory = catalog.byId.get(item.aId);
        const service = accessory?.services?.find(
          ({ sId }) => sId === item.sId,
        );
        if (!service) {
          missing.push(`${homeRef}/accessory/${item.aId}/service/${item.sId}`);
        }
      }
    }
  }
  if (dashboardIds && widgetNeedsDashboardList(widget)) {
    const seen = new Set();
    for (const item of widget.payload?.items ?? []) {
      if (!dashboardIds.has(item.id) && !seen.has(item.id)) {
        seen.add(item.id);
        missing.push(`${homeRef}/dashboard/${item.id}`);
      }
    }
  }
  return missing;
}

async function findMissingLiveWidgetRefs(
  ctx,
  homeRef,
  widget,
  { refreshCatalog = false } = {},
) {
  const catalog = widgetNeedsHomeCatalog(widget)
    ? await resolveHomeCatalog(ctx.client, ctx.hubSerial, {
        refresh: refreshCatalog,
      })
    : null;
  const dashboardIds = widgetNeedsDashboardList(widget)
    ? new Set((await ctx.client.listDashboards()).map(({ id }) => id))
    : null;
  return findMissingWidgetRefs(catalog, homeRef, widget, dashboardIds);
}

function isHistoryExtension(extension) {
  const type = String(extension?.type ?? "").toLowerCase();
  const key = String(extension?.key ?? "").toLowerCase();
  const index = String(extension?.index ?? "").toLowerCase();
  return (
    type === "history" ||
    key.endsWith(":history") ||
    key.includes(":history_") ||
    index === "history" ||
    index.startsWith("history_")
  );
}

async function checkHistoryApp(client, serial) {
  const deadline = Date.now() + client.timeoutMs;
  const { extensions } = await client.nativeExtensions(serial, deadline);
  const running = extensions.some(
    (extension) =>
      isHistoryExtension(extension) &&
      extension.enabled === true &&
      extension.state === "LOADED",
  );
  return running
    ? { history_app_missing: false }
    : { history_app_missing: true, warning: HISTORY_MISSING_WARNING };
}

function forbidWidgetKeys(widget, forbidden, type) {
  for (const key of forbidden) {
    if (widget[key] !== undefined) {
      throw new SprutHubError(
        "invalid_native_value",
        `${key} is not allowed on a ${type} dashboard widget.`,
      );
    }
  }
}

async function validateAndBuildWidget(client, serial, rawWidget, fallbackName) {
  if (!isRecord(rawWidget)) {
    throw new SprutHubError(
      "invalid_native_change",
      "widget object is required for dashboard widget operations.",
    );
  }
  const type = rawWidget.type;
  if (typeof type !== "string" || !WIDGET_TYPE_SET.has(type)) {
    throw new SprutHubError(
      "invalid_native_value",
      `widget.type must be one of: ${WIDGET_TYPES.join(", ")}.`,
    );
  }
  let name = fallbackName;
  if (rawWidget.name !== undefined) {
    if (typeof rawWidget.name !== "string") {
      throw new SprutHubError(
        "invalid_native_value",
        "widget.name must be a string.",
      );
    }
    refuseRedactionMark(rawWidget.name, "widget.name");
    if ([...rawWidget.name].length > MAX_NAME_LENGTH) {
      throw new SprutHubError(
        "name_too_long",
        `widget.name must be at most ${MAX_NAME_LENGTH} characters.`,
      );
    }
    name = rawWidget.name;
  }

  const warnings = [];
  if (typeof name === "string" && name.length > 0) {
    const nameWarning = nameNormalizationWarning("widget.name", name);
    if (nameWarning) warnings.push(nameWarning);
  }

  let payload;
  if (type === "characteristic") {
    forbidWidgetKeys(
      rawWidget,
      ["show_rooms", "history_group", "shortcut_ids"],
      type,
    );
    const { items, repeatedTypes } = await parseAndVerifyCharacteristicRefs(
      client,
      serial,
      rawWidget.item_refs,
      type,
    );
    if (repeatedTypes.length > 0) {
      warnings.push(
        duplicateCharacteristicWarning(repeatedTypes, "characteristic"),
      );
    }
    payload = { items };
  } else if (type === "chart") {
    forbidWidgetKeys(rawWidget, ["show_rooms", "shortcut_ids"], type);
    const { items, repeatedTypes } = await parseAndVerifyCharacteristicRefs(
      client,
      serial,
      rawWidget.item_refs,
      type,
    );
    if (
      rawWidget.history_group !== undefined &&
      !HISTORY_GROUPS.has(rawWidget.history_group)
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "widget.history_group must be MINUTE, HOUR, or DAY.",
      );
    }
    if (repeatedTypes.length > 0) {
      warnings.push(duplicateCharacteristicWarning(repeatedTypes, "chart"));
    }
    if (rawWidget.history_group === "DAY") {
      warnings.push(CHART_DAY_GROUP_WARNING);
    }
    payload = {
      items,
      ...(rawWidget.history_group !== undefined
        ? { group: rawWidget.history_group }
        : {}),
    };
  } else if (type === "service") {
    forbidWidgetKeys(rawWidget, ["history_group", "shortcut_ids"], type);
    const items = await parseAndVerifyServiceRefs(
      client,
      serial,
      rawWidget.item_refs,
      type,
    );
    if (
      rawWidget.show_rooms !== undefined &&
      typeof rawWidget.show_rooms !== "boolean"
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "widget.show_rooms must be a boolean.",
      );
    }
    payload = {
      items,
      ...(rawWidget.show_rooms !== undefined
        ? { showRooms: rawWidget.show_rooms }
        : {}),
    };
  } else if (type === "camera") {
    forbidWidgetKeys(
      rawWidget,
      ["show_rooms", "history_group", "shortcut_ids"],
      type,
    );
    const items = await parseAndVerifyServiceRefs(
      client,
      serial,
      rawWidget.item_refs,
      type,
    );
    payload = { items };
  } else if (type === "shortcut") {
    forbidWidgetKeys(
      rawWidget,
      ["item_refs", "show_rooms", "history_group"],
      type,
    );
    if (
      !Array.isArray(rawWidget.shortcut_ids) ||
      rawWidget.shortcut_ids.length === 0 ||
      rawWidget.shortcut_ids.length > MAX_ITEMS ||
      !rawWidget.shortcut_ids.every((id) => Number.isSafeInteger(id) && id > 0)
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        `widget.shortcut_ids must be a non-empty array of positive integers (max ${MAX_ITEMS}) for shortcut widgets.`,
      );
    }
    if (
      new Set(rawWidget.shortcut_ids).size !== rawWidget.shortcut_ids.length
    ) {
      throw new SprutHubError(
        "invalid_native_value",
        "widget.shortcut_ids must not contain duplicate dashboard IDs.",
      );
    }
    const dashboards = await client.listDashboards();
    const existingIds = new Set(dashboards.map(({ id }) => id));
    const missingIds = rawWidget.shortcut_ids.filter(
      (id) => !existingIds.has(id),
    );
    if (missingIds.length > 0) {
      throw new SprutHubError(
        "entity_not_found",
        `Shortcut target dashboard(s) not found: ${missingIds.map((id) => dashboardRef(serial, id)).join(", ")}.`,
        "home_overview",
        {
          next: { tool: "home_overview", arguments: { list: "dashboards" } },
        },
      );
    }
    payload = { items: rawWidget.shortcut_ids.map((id) => ({ id })) };
  } else {
    // weather, clock, tile
    forbidWidgetKeys(
      rawWidget,
      ["item_refs", "show_rooms", "history_group", "shortcut_ids"],
      type,
    );
    if (type === "tile") {
      warnings.push(TILE_UNRENDERED_WARNING);
    } else if (type === "weather") {
      warnings.push(WEATHER_PLACEHOLDER_WARNING);
    }
    payload = {};
  }

  return {
    widget: {
      ...(name !== undefined ? { name } : {}),
      type,
      payload,
    },
    warnings,
  };
}

function findRepeatedCharacteristicTypesAcrossDevices(resolvedItems) {
  const accessoriesByType = new Map();
  for (const { target, characteristicType } of resolvedItems) {
    if (typeof characteristicType !== "string" || characteristicType === "") {
      continue;
    }
    let aIds = accessoriesByType.get(characteristicType);
    if (!aIds) {
      aIds = new Set();
      accessoriesByType.set(characteristicType, aIds);
    }
    aIds.add(target.aId);
  }
  const repeated = [];
  for (const [characteristicType, aIds] of accessoriesByType.entries()) {
    if (aIds.size >= 2) repeated.push(characteristicType);
  }
  return repeated;
}

async function parseAndVerifyCharacteristicRefs(
  client,
  serial,
  itemRefs,
  type,
) {
  if (
    !Array.isArray(itemRefs) ||
    itemRefs.length === 0 ||
    itemRefs.length > MAX_ITEMS
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      `widget.item_refs must be a non-empty array of characteristic refs (max ${MAX_ITEMS}) for ${type} widgets.`,
    );
  }
  const parsed = itemRefs.map((ref) => {
    try {
      return { ref, target: parseCharacteristicRef(ref, serial) };
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        error.code === "invalid_characteristic_ref"
      ) {
        throw new SprutHubError(
          "invalid_native_value",
          `${type} widget item_refs must be characteristic refs; got ${String(ref)}.`,
        );
      }
      throw error;
    }
  });
  const catalog = await resolveHomeCatalog(client, serial);
  const resolved = [];
  for (const { ref, target } of parsed) {
    const characteristic = await verifyCharacteristicExists(
      client,
      catalog,
      target,
      ref,
    );
    resolved.push({
      target,
      characteristicType:
        characteristic.control?.type ??
        characteristic.control?.key ??
        characteristic.type,
    });
  }
  const repeatedTypes =
    (type === "characteristic" || type === "chart") && resolved.length > 1
      ? findRepeatedCharacteristicTypesAcrossDevices(resolved)
      : [];
  return {
    items: parsed.map(({ target }) => target),
    repeatedTypes,
  };
}

async function parseAndVerifyServiceRefs(client, serial, itemRefs, type) {
  if (
    !Array.isArray(itemRefs) ||
    itemRefs.length === 0 ||
    itemRefs.length > MAX_ITEMS
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      `widget.item_refs must be a non-empty array of service refs (max ${MAX_ITEMS}) for ${type} widgets.`,
    );
  }
  const parsed = itemRefs.map((ref) => {
    try {
      return { ref, target: parseServiceRef(ref, serial) };
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        error.code === "invalid_service_ref"
      ) {
        throw new SprutHubError(
          "invalid_native_value",
          `${type} widget item_refs must be service refs; got ${String(ref)}.`,
        );
      }
      throw error;
    }
  });
  const catalog = await resolveHomeCatalog(client, serial);
  for (const { ref, target } of parsed) {
    await verifyServiceExists(client, catalog, target, ref);
  }
  return parsed.map(({ target }) => target);
}

function notFoundError(kind) {
  return new SprutHubError(
    "entity_not_found",
    `The selected SprutHub ${kind} was not found.`,
    "home_overview",
  );
}

function attachPartialRefusalDetails(change, error, rejection) {
  const changeRef = `spruthub-change://native/${change.id}`;
  error.details = {
    ...(error.details ?? {}),
    change_ref: changeRef,
    hub_effect: "partial",
    ...(rejection ? { rejection } : {}),
    next: {
      tool: "restore_native_change",
      arguments: { change_ref: changeRef },
    },
  };
  return error;
}

// ---- Prepare ---------------------------------------------------------------

export async function prepareDashboardChange(ctx, input) {
  switch (input.operation) {
    case DASHBOARD_CREATE:
      return prepareDashboardCreate(ctx, input);
    case DASHBOARD_UPDATE:
      return prepareDashboardUpdate(ctx, input);
    case DASHBOARD_DELETE:
      return prepareDashboardDelete(ctx, input);
    case DASHBOARD_COLUMN_CREATE:
      return prepareDashboardColumnCreate(ctx, input);
    case DASHBOARD_COLUMN_UPDATE:
      return prepareDashboardColumnUpdate(ctx, input);
    case DASHBOARD_COLUMN_DELETE:
      return prepareDashboardColumnDelete(ctx, input);
    case DASHBOARD_WIDGET_CREATE:
      return prepareDashboardWidgetCreate(ctx, input);
    case DASHBOARD_WIDGET_UPDATE:
      return prepareDashboardWidgetUpdate(ctx, input);
    case DASHBOARD_WIDGET_DELETE:
      return prepareDashboardWidgetDelete(ctx, input);
    case DASHBOARD_WIDGET_MOVE:
      return prepareDashboardWidgetMove(ctx, input);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function prepareDashboardCreate(ctx, input) {
  parseConfiguredHomeRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(
    input,
    ["widget", "column_ref", "position"],
    DASHBOARD_CREATE,
  );
  const name = validateRequiredName(input.name, DASHBOARD_CREATE);
  const columnNames = validateColumnNames(input.column_names);
  const warnings = [];
  const dashNameWarning = nameNormalizationWarning("dashboard name", name);
  if (dashNameWarning) warnings.push(dashNameWarning);
  for (const [index, columnName] of columnNames.entries()) {
    const colWarning = nameNormalizationWarning(
      `column_names[${index}]`,
      columnName,
    );
    if (colWarning) warnings.push(colWarning);
  }
  const existing = await ctx.client.listDashboards();
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_CREATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    requested_name: name,
    requested_column_names: columnNames,
    baseline_dashboard_ids: existing.map(({ id }) => id),
    ...warningRecordFields(warnings),
    created_columns: [],
    creation_owned: false,
    creation_complete: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_absent"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardUpdate(ctx, input) {
  const { id } = parseDashboardRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(
    input,
    ["column_names", "widget", "column_ref", "position"],
    DASHBOARD_UPDATE,
  );
  const name = validateRequiredName(input.name, DASHBOARD_UPDATE);
  const warnings = [];
  const nameWarning = nameNormalizationWarning("dashboard name", name);
  if (nameWarning) warnings.push(nameWarning);
  const dashboard = await ctx.client.getDashboard(id);
  if (!dashboard) throw notFoundError("dashboard");
  if (dashboard.name === name) {
    return {
      status: "already_desired",
      operation: DASHBOARD_UPDATE,
      target_ref: input.target_ref,
      current_name: dashboard.name,
      requested_name: name,
    };
  }
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_UPDATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: id,
    baseline_snapshot: { id, name: dashboard.name },
    requested_name: name,
    ...warningRecordFields(warnings),
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardDelete(ctx, input) {
  const { id } = parseDashboardRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(
    input,
    ["name", "column_names", "widget", "column_ref", "position"],
    DASHBOARD_DELETE,
  );
  const dashboard = await ctx.client.getDashboard(id);
  if (!dashboard) throw notFoundError("dashboard");
  const snapshot = dashboardSnapshot(dashboard);
  const columnCount = snapshot.columns.length;
  const widgetCount = snapshot.columns.reduce(
    (sum, column) => sum + column.widgets.length,
    0,
  );
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_DELETE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: id,
    baseline_snapshot: snapshot,
    column_count: columnCount,
    widget_count: widgetCount,
    delete_confirmed: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  const tellOwner =
    widgetCount > 0
      ? `Deleting dashboard «${redactSensitiveText(snapshot.name)}» cascades and removes ${columnCount} column(s) and ${widgetCount} widget(s). Confirm with the owner before calling apply_native_change.`
      : undefined;
  return {
    ...publicDashboardChange(change),
    ...(tellOwner ? { tell_owner: tellOwner } : {}),
  };
}

async function prepareDashboardColumnCreate(ctx, input) {
  const { id: dashboardId } = parseDashboardRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["column_names", "widget", "column_ref", "position"],
    DASHBOARD_COLUMN_CREATE,
  );
  const name = validateOptionalColumnName(input.name, { required: false });
  const warnings = [];
  if (typeof name === "string" && name.length > 0) {
    const nameWarning = nameNormalizationWarning("column name", name);
    if (nameWarning) warnings.push(nameWarning);
  }
  const dashboard = await ctx.client.getDashboard(dashboardId);
  if (!dashboard) throw notFoundError("dashboard");
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_COLUMN_CREATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    dashboard_name: dashboard.name,
    requested_name: name ?? "",
    has_requested_name: name !== undefined,
    baseline_column_ids: dashboard.columns.map(({ id }) => id),
    ...warningRecordFields(warnings),
    creation_owned: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardColumnUpdate(ctx, input) {
  const { dashboardId, columnId } = parseDashboardColumnRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["column_names", "widget", "column_ref", "position"],
    DASHBOARD_COLUMN_UPDATE,
  );
  const name = validateOptionalColumnName(input.name, { required: true });
  const warnings = [];
  if (name.length > 0) {
    const nameWarning = nameNormalizationWarning("column name", name);
    if (nameWarning) warnings.push(nameWarning);
  }
  const column = await ctx.client.getDashboardColumn(dashboardId, columnId);
  if (!column) throw notFoundError("dashboard column");
  if (column.name === name) {
    return {
      status: "already_desired",
      operation: DASHBOARD_COLUMN_UPDATE,
      target_ref: input.target_ref,
      current_name: column.name,
      requested_name: name,
    };
  }
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_COLUMN_UPDATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    column_id: columnId,
    baseline_snapshot: {
      dashboard_id: dashboardId,
      id: columnId,
      name: column.name,
    },
    requested_name: name,
    ...warningRecordFields(warnings),
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardColumnDelete(ctx, input) {
  const { dashboardId, columnId } = parseDashboardColumnRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["name", "column_names", "widget", "column_ref", "position"],
    DASHBOARD_COLUMN_DELETE,
  );
  const column = await ctx.client.getDashboardColumn(dashboardId, columnId);
  if (!column) throw notFoundError("dashboard column");
  const snapshot = columnSnapshot(column);
  const widgetCount = snapshot.widgets.length;
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_COLUMN_DELETE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    column_id: columnId,
    baseline_snapshot: snapshot,
    widget_count: widgetCount,
    delete_confirmed: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  const tellOwner =
    widgetCount > 0
      ? `Deleting column «${redactSensitiveText(snapshot.name || `#${columnId}`)}» cascades and removes ${widgetCount} widget(s). Confirm with the owner before calling apply_native_change.`
      : undefined;
  return {
    ...publicDashboardChange(change),
    ...(tellOwner ? { tell_owner: tellOwner } : {}),
  };
}

async function prepareDashboardWidgetCreate(ctx, input) {
  const { dashboardId, columnId } = parseDashboardColumnRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["name", "column_names", "column_ref", "position"],
    DASHBOARD_WIDGET_CREATE,
  );
  const { widget: requestedWidget, warnings } = await validateAndBuildWidget(
    ctx.client,
    ctx.hubSerial,
    input.widget,
    undefined,
  );
  const column = await ctx.client.getDashboardColumn(dashboardId, columnId);
  if (!column) throw notFoundError("dashboard column");
  const historyCheck =
    requestedWidget.type === "chart"
      ? await checkHistoryApp(ctx.client, ctx.hubSerial)
      : { history_app_missing: false };
  if (historyCheck.history_app_missing) {
    warnings.push(historyCheck.warning);
  }
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_WIDGET_CREATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    column_id: columnId,
    requested_widget: requestedWidget,
    baseline_widget_ids: column.widgets.map(({ id }) => id),
    ...warningRecordFields(warnings, historyCheck.history_app_missing),
    creation_owned: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardWidgetUpdate(ctx, input) {
  const { dashboardId, widgetId } = parseDashboardWidgetRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["name", "column_names", "column_ref", "position"],
    DASHBOARD_WIDGET_UPDATE,
  );
  const existing = await ctx.client.getDashboardWidget(dashboardId, widgetId);
  if (!existing) throw notFoundError("dashboard widget");
  if (!existing.type || !WIDGET_TYPE_SET.has(existing.type)) {
    throw new SprutHubError(
      "unsupported_widget_type",
      "This widget uses a native SprutHub widget type not supported in this slice.",
    );
  }
  const baseline = widgetSnapshot(existing);
  const { widget: requestedWidget, warnings } = await validateAndBuildWidget(
    ctx.client,
    ctx.hubSerial,
    input.widget,
    baseline.name,
  );
  const historyCheck =
    requestedWidget.type === "chart"
      ? await checkHistoryApp(ctx.client, ctx.hubSerial)
      : { history_app_missing: false };
  if (historyCheck.history_app_missing) {
    warnings.push(historyCheck.warning);
  }
  const warningFields = warningRecordFields(
    warnings,
    historyCheck.history_app_missing,
  );
  if (sameWidgetContent(baseline, requestedWidget)) {
    return {
      status: "already_desired",
      operation: DASHBOARD_WIDGET_UPDATE,
      target_ref: input.target_ref,
      ...warningFields,
    };
  }
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_WIDGET_UPDATE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    column_id: baseline.column_id,
    widget_id: widgetId,
    baseline_snapshot: baseline,
    requested_widget: requestedWidget,
    ...warningFields,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardWidgetDelete(ctx, input) {
  const { dashboardId, widgetId } = parseDashboardWidgetRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["name", "column_names", "widget", "column_ref", "position"],
    DASHBOARD_WIDGET_DELETE,
  );
  const existing = await ctx.client.getDashboardWidget(dashboardId, widgetId);
  if (!existing) throw notFoundError("dashboard widget");
  if (!existing.type || !WIDGET_TYPE_SET.has(existing.type)) {
    throw new SprutHubError(
      "unsupported_widget_type",
      "This widget uses a native SprutHub widget type not supported in this slice.",
    );
  }
  const baseline = widgetSnapshot(existing);
  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_WIDGET_DELETE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    column_id: baseline.column_id,
    widget_id: widgetId,
    baseline_snapshot: baseline,
    delete_confirmed: false,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

async function prepareDashboardWidgetMove(ctx, input) {
  const { dashboardId, widgetId } = parseDashboardWidgetRef(
    input.target_ref,
    ctx.hubSerial,
  );
  forbidUnexpectedFields(
    input,
    ["name", "column_names", "widget"],
    DASHBOARD_WIDGET_MOVE,
  );
  let targetColumnId;
  if (input.column_ref !== undefined) {
    const parsedCol = parseDashboardColumnRef(input.column_ref, ctx.hubSerial);
    if (parsedCol.dashboardId !== dashboardId) {
      throw new SprutHubError(
        "invalid_native_value",
        "dashboard_widget_move cannot move a widget to a column on a different dashboard.",
        "prepare_native_change",
      );
    }
    targetColumnId = parsedCol.columnId;
  }
  if (
    input.position !== undefined &&
    (!Number.isSafeInteger(input.position) || input.position < 0)
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "position must be a non-negative integer (0-based index).",
      "prepare_native_change",
    );
  }
  const dashboard = await ctx.client.getDashboard(dashboardId);
  if (!dashboard) throw notFoundError("dashboard widget");
  let sourceCol = null;
  let widget = null;
  for (const column of dashboard.columns) {
    const found = column.widgets.find(({ id }) => id === widgetId);
    if (found) {
      sourceCol = column;
      widget = found;
      break;
    }
  }
  if (!sourceCol || !widget) throw notFoundError("dashboard widget");
  const destColId = targetColumnId ?? sourceCol.id;
  const destCol = dashboard.columns.find(({ id }) => id === destColId);
  if (!destCol) throw notFoundError("dashboard column");

  const sameColumn = sourceCol.id === destCol.id;
  if (sameColumn && input.position === undefined) {
    throw new SprutHubError(
      "invalid_native_change",
      "position is required when moving a widget within the same column (or pass a different column_ref).",
      "prepare_native_change",
    );
  }

  const sourceSorted = sortColumnWidgets(sourceCol.widgets);
  const currentPosition = sourceSorted.findIndex(({ id }) => id === widgetId);
  const destSorted = sameColumn
    ? sourceSorted
    : sortColumnWidgets(destCol.widgets);
  const destWithoutSelf = destSorted.filter(({ id }) => id !== widgetId);
  const maxPosition = destWithoutSelf.length;
  const targetPosition =
    input.position !== undefined ? input.position : maxPosition;
  if (targetPosition < 0 || targetPosition > maxPosition) {
    throw new SprutHubError(
      "invalid_native_value",
      `position must be between 0 and ${maxPosition} for the destination column.`,
      "prepare_native_change",
    );
  }

  const nextDestIds = destWithoutSelf.map(({ id }) => id);
  nextDestIds.splice(targetPosition, 0, widgetId);

  const baselineColumns = sameColumn
    ? [{ column_id: sourceCol.id, widgets: columnLayoutEntries(sourceCol) }]
    : [
        { column_id: sourceCol.id, widgets: columnLayoutEntries(sourceCol) },
        { column_id: destCol.id, widgets: columnLayoutEntries(destCol) },
      ];
  const targetColumns = sameColumn
    ? [
        {
          column_id: sourceCol.id,
          widgets: nextDestIds.map((id, order) => ({ id, order })),
        },
      ]
    : [
        {
          column_id: sourceCol.id,
          widgets: sourceSorted
            .filter(({ id }) => id !== widgetId)
            .map(({ id }, order) => ({ id, order })),
        },
        {
          column_id: destCol.id,
          widgets: nextDestIds.map((id, order) => ({ id, order })),
        },
      ];
  const targetOrders = targetColumns.flatMap(({ column_id, widgets }) =>
    widgets.map(({ id, order }) => ({
      dashboardId,
      columnId: column_id,
      id,
      order,
    })),
  );

  const sourceColumnRef = dashboardColumnRef(
    ctx.hubSerial,
    dashboardId,
    sourceCol.id,
  );
  const destColumnRef = dashboardColumnRef(
    ctx.hubSerial,
    dashboardId,
    destCol.id,
  );

  if (
    sameColumn &&
    currentPosition === targetPosition &&
    sameColumnsLayout(dashboard, targetColumns)
  ) {
    return {
      status: "already_desired",
      operation: DASHBOARD_WIDGET_MOVE,
      target_ref: input.target_ref,
      column_ref: destColumnRef,
      position: targetPosition,
    };
  }

  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: DASHBOARD_WIDGET_MOVE,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    dashboard_id: dashboardId,
    widget_id: widgetId,
    widget_name: widget.name ?? "",
    widget_type: widget.type ?? undefined,
    source_column_id: sourceCol.id,
    source_column_ref: sourceColumnRef,
    source_column_name: sourceCol.name ?? "",
    source_position: currentPosition,
    column_id: destCol.id,
    column_ref: destColumnRef,
    dest_column_name: destCol.name ?? "",
    target_position: targetPosition,
    baseline_columns: baselineColumns,
    target_columns: targetColumns,
    target_orders: targetOrders,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicDashboardChange(change);
}

// ---- Apply -----------------------------------------------------------------

export async function applyDashboardChange(ctx, change) {
  if (change.status === "restored") return ctx.publicStored(change);
  switch (change.kind) {
    case DASHBOARD_CREATE:
      return applyDashboardCreate(ctx, change);
    case DASHBOARD_UPDATE:
      return applyDashboardUpdate(ctx, change);
    case DASHBOARD_DELETE:
      return applyDashboardDelete(ctx, change);
    case DASHBOARD_COLUMN_CREATE:
      return applyDashboardColumnCreate(ctx, change);
    case DASHBOARD_COLUMN_UPDATE:
      return applyDashboardColumnUpdate(ctx, change);
    case DASHBOARD_COLUMN_DELETE:
      return applyDashboardColumnDelete(ctx, change);
    case DASHBOARD_WIDGET_CREATE:
      return applyDashboardWidgetCreate(ctx, change);
    case DASHBOARD_WIDGET_UPDATE:
      return applyDashboardWidgetUpdate(ctx, change);
    case DASHBOARD_WIDGET_DELETE:
      return applyDashboardWidgetDelete(ctx, change);
    case DASHBOARD_WIDGET_MOVE:
      return applyDashboardWidgetMove(ctx, change);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function recordUnknownDashboardCreate(ctx, change, baselineIds, name) {
  let candidates;
  try {
    const known = new Set(baselineIds ?? []);
    candidates = (await ctx.client.listDashboards())
      .filter(
        (dashboard) =>
          !known.has(dashboard.id) &&
          matchesDashboardName(name, dashboard.name ?? ""),
      )
      .map((dashboard) => ({
        id: dashboard.id,
        ref: dashboardRef(ctx.hubSerial, dashboard.id),
        name: dashboard.name ?? "",
      }));
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    candidate_dashboards: candidates,
    conflict_reason: "dashboard_creation_outcome_unknown",
    last_verification: freshVerification(
      candidates.length > 0
        ? "unowned_matching_dashboard_observed"
        : "matching_dashboard_missing",
    ),
  });
}

async function applyDashboardCreate(ctx, change) {
  if (change.created_dashboard_id !== undefined) {
    return getDashboardCreate(ctx, change);
  }
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return recordUnknownDashboardCreate(
      ctx,
      change,
      change.baseline_dashboard_ids,
      change.requested_name,
    );
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  let created;
  try {
    created = await ctx.client.createDashboard({ name: change.requested_name });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return recordUnknownDashboardCreate(
      ctx,
      change,
      change.baseline_dashboard_ids,
      change.requested_name,
    );
  }
  change.created_dashboard_id = created.id;
  change.created_dashboard_ref = dashboardRef(ctx.hubSerial, created.id);
  change.applied_dashboard_name = created.name;
  if (created.name !== change.requested_name) {
    change.hub_normalized_name = {
      requested: change.requested_name,
      stored: created.name,
    };
  }
  change.creation_owned = true;
  change.creation_complete = false;
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  change.created_columns = [];
  change.column_steps = change.requested_column_names.map((name) => ({
    name,
    status: "pending",
    sent: false,
    acknowledged: false,
  }));
  await ctx.store.save(change);

  for (const step of change.column_steps) {
    step.status = "sent";
    step.sent = true;
    await ctx.store.save(change);
    let column;
    try {
      column = await ctx.client.createDashboardColumn({
        dashboardId: created.id,
        name: step.name,
      });
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        step.status = "refused";
        const rejection = writeRejection(error);
        const live = await ctx.client
          .getDashboard(created.id)
          .catch(() => null);
        await ctx.finishNative(change, "conflict", undefined, {
          creation_complete: false,
          ...(live ? { observed_snapshot: dashboardSnapshot(live) } : {}),
          ...(rejection && change.write_intent
            ? { write_intent: { ...change.write_intent, rejection } }
            : {}),
          conflict_reason: "partial_column_creation_refused",
          last_verification: freshVerification("partial_dashboard_created"),
        });
        throw attachPartialRefusalDetails(change, error, rejection);
      }
      const live = await ctx.client.getDashboard(created.id).catch(() => null);
      return ctx.finishNative(change, "uncertain", undefined, {
        creation_complete: false,
        ...(live ? { observed_snapshot: dashboardSnapshot(live) } : {}),
        conflict_reason: "dashboard_column_creation_outcome_unknown",
        last_verification: live
          ? freshVerification("partial_dashboard_observed")
          : failedVerification(error),
      });
    }
    step.status = "created";
    step.acknowledged = true;
    step.created_id = column.id;
    change.created_columns.push({
      ref: dashboardColumnRef(ctx.hubSerial, created.id, column.id),
      id: column.id,
      name: column.name,
      ...(column.name !== step.name
        ? {
            hub_normalized_name: {
              requested: step.name,
              stored: column.name,
            },
          }
        : {}),
    });
    await ctx.store.save(change);
  }

  const live = await ctx.client.getDashboard(created.id);
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      creation_complete: false,
      conflict_reason: "created_dashboard_missing",
      last_verification: freshVerification("created_dashboard_missing"),
    });
  }
  return ctx.finishNative(change, "applied", undefined, {
    creation_complete: true,
    applied_snapshot: dashboardSnapshot(live),
    last_verification: freshVerification("created_dashboard_observed"),
  });
}

async function applyDashboardUpdate(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardUpdate(ctx, change);
  }
  const live = await ctx.client.getDashboard(change.dashboard_id);
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  if (live.name !== change.baseline_snapshot.name) {
    return ctx.finishNative(change, "conflict", undefined, {
      observed_name: live.name,
      conflict_reason: "dashboard_changed_since",
      last_verification: freshVerification("dashboard_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.updateDashboard(change.dashboard_id, {
      name: change.requested_name,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardUpdate(ctx, change, "apply", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardUpdate(ctx, change, "apply", false);
}

async function applyDashboardDelete(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardDelete(ctx, change);
  }
  const live = await ctx.client.getDashboard(change.dashboard_id);
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  if (
    !sameDashboardStructure(dashboardSnapshot(live), change.baseline_snapshot)
  ) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_changed_since",
      last_verification: freshVerification("dashboard_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.deleteDashboard(change.dashboard_id);
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardDeleteApply(ctx, change, true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardDeleteApply(ctx, change, false);
}

async function recordUnknownColumnCreate(ctx, change, baselineIds, name) {
  let candidates;
  try {
    const dashboard = await ctx.client.getDashboard(change.dashboard_id);
    const known = new Set(baselineIds ?? []);
    candidates = (dashboard?.columns ?? [])
      .filter(
        (column) =>
          !known.has(column.id) &&
          matchesDashboardName(name ?? "", column.name ?? ""),
      )
      .map((column) => ({
        id: column.id,
        ref: dashboardColumnRef(ctx.hubSerial, change.dashboard_id, column.id),
        name: column.name ?? "",
      }));
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    candidate_columns: candidates,
    conflict_reason: "column_creation_outcome_unknown",
    last_verification: freshVerification(
      candidates.length > 0
        ? "unowned_matching_column_observed"
        : "matching_column_missing",
    ),
  });
}

async function applyDashboardColumnCreate(ctx, change) {
  if (change.created_column_id !== undefined) {
    return getDashboardColumnCreate(ctx, change);
  }
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return recordUnknownColumnCreate(
      ctx,
      change,
      change.baseline_column_ids,
      change.requested_name,
    );
  }
  const dashboard = await ctx.client.getDashboard(change.dashboard_id);
  if (!dashboard) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  let created;
  try {
    created = await ctx.client.createDashboardColumn({
      dashboardId: change.dashboard_id,
      ...(change.has_requested_name ? { name: change.requested_name } : {}),
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return recordUnknownColumnCreate(
      ctx,
      change,
      change.baseline_column_ids,
      change.requested_name,
    );
  }
  change.created_column_id = created.id;
  change.created_column_ref = dashboardColumnRef(
    ctx.hubSerial,
    change.dashboard_id,
    created.id,
  );
  if (change.has_requested_name && created.name !== change.requested_name) {
    change.hub_normalized_name = {
      requested: change.requested_name,
      stored: created.name,
    };
  }
  change.creation_owned = true;
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  change.applied_snapshot = columnSnapshot(created);
  await ctx.store.save(change);
  return getDashboardColumnCreate(ctx, change);
}

async function applyDashboardColumnUpdate(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardColumnUpdate(ctx, change);
  }
  const live = await ctx.client.getDashboardColumn(
    change.dashboard_id,
    change.column_id,
  );
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  if (live.name !== change.baseline_snapshot.name) {
    return ctx.finishNative(change, "conflict", undefined, {
      observed_name: live.name,
      conflict_reason: "column_changed_since",
      last_verification: freshVerification("column_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.updateDashboardColumn(
      change.dashboard_id,
      change.column_id,
      { name: change.requested_name },
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardColumnUpdate(ctx, change, "apply", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardColumnUpdate(ctx, change, "apply", false);
}

async function applyDashboardColumnDelete(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardColumnDelete(ctx, change);
  }
  const live = await ctx.client.getDashboardColumn(
    change.dashboard_id,
    change.column_id,
  );
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  if (!sameColumnStructure(columnSnapshot(live), change.baseline_snapshot)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_changed_since",
      last_verification: freshVerification("column_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.deleteDashboardColumn(
      change.dashboard_id,
      change.column_id,
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardColumnDeleteApply(ctx, change, true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardColumnDeleteApply(ctx, change, false);
}

async function recordUnknownWidgetCreate(ctx, change, baselineIds, requested) {
  let candidates;
  try {
    const column = await ctx.client.getDashboardColumn(
      change.dashboard_id,
      change.column_id,
    );
    const known = new Set(baselineIds ?? []);
    candidates = (column?.widgets ?? [])
      .filter(
        (widget) =>
          !known.has(widget.id) &&
          sameWidgetContent(widgetSnapshot(widget), requested, {
            allowNormalizedName: true,
          }),
      )
      .map((widget) => ({
        id: widget.id,
        ref: dashboardWidgetRef(ctx.hubSerial, change.dashboard_id, widget.id),
        name: widget.name ?? "",
        type: widget.type,
      }));
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    candidate_widgets: candidates,
    conflict_reason: "widget_creation_outcome_unknown",
    last_verification: freshVerification(
      candidates.length > 0
        ? "unowned_matching_widget_observed"
        : "matching_widget_missing",
    ),
  });
}

async function applyDashboardWidgetCreate(ctx, change) {
  if (change.created_widget_id !== undefined) {
    return getDashboardWidgetCreate(ctx, change);
  }
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return recordUnknownWidgetCreate(
      ctx,
      change,
      change.baseline_widget_ids,
      change.requested_widget,
    );
  }
  const column = await ctx.client.getDashboardColumn(
    change.dashboard_id,
    change.column_id,
  );
  if (!column) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  const missingRefs = await findMissingLiveWidgetRefs(
    ctx,
    change.home_ref,
    change.requested_widget,
  );
  if (missingRefs.length > 0) {
    return ctx.finishNative(change, "conflict", undefined, {
      missing_refs: missingRefs,
      conflict_reason: "referenced_entity_missing",
      last_verification: freshVerification("referenced_entity_missing"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  let created;
  try {
    created = await ctx.client.createDashboardWidget({
      dashboardId: change.dashboard_id,
      columnId: change.column_id,
      ...(change.requested_widget.name !== undefined
        ? { name: change.requested_widget.name }
        : {}),
      kindKey: change.requested_widget.type,
      payload: change.requested_widget.payload,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return recordUnknownWidgetCreate(
      ctx,
      change,
      change.baseline_widget_ids,
      change.requested_widget,
    );
  }
  change.created_widget_id = created.id;
  change.created_widget_ref = dashboardWidgetRef(
    ctx.hubSerial,
    change.dashboard_id,
    created.id,
  );
  const requestedWidgetName = change.requested_widget.name ?? "";
  if (
    change.requested_widget.name !== undefined &&
    created.name !== requestedWidgetName
  ) {
    change.hub_normalized_name = {
      requested: requestedWidgetName,
      stored: created.name,
    };
  }
  change.creation_owned = true;
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  change.applied_snapshot = widgetSnapshot(created);
  await ctx.store.save(change);
  return getDashboardWidgetCreate(ctx, change);
}

async function applyDashboardWidgetUpdate(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardWidgetUpdate(ctx, change);
  }
  const live = await ctx.client.getDashboardWidget(
    change.dashboard_id,
    change.widget_id,
  );
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  if (!sameWidgetContent(widgetSnapshot(live), change.baseline_snapshot)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_changed_since",
      last_verification: freshVerification("widget_changed_since"),
    });
  }
  const missingRefs = await findMissingLiveWidgetRefs(
    ctx,
    change.home_ref,
    change.requested_widget,
  );
  if (missingRefs.length > 0) {
    return ctx.finishNative(change, "conflict", undefined, {
      missing_refs: missingRefs,
      conflict_reason: "referenced_entity_missing",
      last_verification: freshVerification("referenced_entity_missing"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.updateDashboardWidget(
      change.dashboard_id,
      change.widget_id,
      {
        name: change.requested_widget.name,
        kindKey: change.requested_widget.type,
        payload: change.requested_widget.payload,
      },
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardWidgetUpdate(ctx, change, "apply", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardWidgetUpdate(ctx, change, "apply", false);
}

async function applyDashboardWidgetDelete(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardWidgetDelete(ctx, change);
  }
  const live = await ctx.client.getDashboardWidget(
    change.dashboard_id,
    change.widget_id,
  );
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  if (!sameWidgetContent(widgetSnapshot(live), change.baseline_snapshot)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_changed_since",
      last_verification: freshVerification("widget_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.deleteDashboardWidget(
      change.dashboard_id,
      change.widget_id,
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardWidgetDeleteApply(ctx, change, true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardWidgetDeleteApply(ctx, change, false);
}

async function applyDashboardWidgetMove(ctx, change) {
  if (change.native_write_sent === true && change.status !== "not_applied") {
    return getDashboardWidgetMove(ctx, change);
  }
  const live = await ctx.client.getDashboard(change.dashboard_id);
  if (!live) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  for (const { column_id: columnId } of change.baseline_columns) {
    if (!live.columns.some(({ id }) => id === columnId)) {
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "column_missing",
        last_verification: freshVerification("column_missing"),
      });
    }
  }
  const hasWidget = live.columns.some((column) =>
    column.widgets.some(({ id }) => id === change.widget_id),
  );
  if (!hasWidget) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  if (!sameColumnsLayout(live, change.baseline_columns)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_layout_changed_since",
      last_verification: freshVerification("dashboard_layout_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.reorderDashboardWidgets(change.target_orders);
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileDashboardWidgetMove(ctx, change, "apply", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardWidgetMove(ctx, change, "apply", false);
}

// ---- Get & Reconcile -------------------------------------------------------
// Read-only get_native_change MUST NOT call finishNative on already-settled
// (applied / restored / conflict) records so updated_at and history ordering
// remain stable, and MUST NEVER flip in-flight restore/uncertain/conflict
// records back to applied.

export async function getDashboardChange(ctx, change) {
  switch (change.kind) {
    case DASHBOARD_CREATE:
      return getDashboardCreate(ctx, change);
    case DASHBOARD_UPDATE:
      return getDashboardUpdate(ctx, change);
    case DASHBOARD_DELETE:
      return getDashboardDelete(ctx, change);
    case DASHBOARD_COLUMN_CREATE:
      return getDashboardColumnCreate(ctx, change);
    case DASHBOARD_COLUMN_UPDATE:
      return getDashboardColumnUpdate(ctx, change);
    case DASHBOARD_COLUMN_DELETE:
      return getDashboardColumnDelete(ctx, change);
    case DASHBOARD_WIDGET_CREATE:
      return getDashboardWidgetCreate(ctx, change);
    case DASHBOARD_WIDGET_UPDATE:
      return getDashboardWidgetUpdate(ctx, change);
    case DASHBOARD_WIDGET_DELETE:
      return getDashboardWidgetDelete(ctx, change);
    case DASHBOARD_WIDGET_MOVE:
      return getDashboardWidgetMove(ctx, change);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

function hasIncompleteColumnSteps(change) {
  return (
    change.creation_complete === false ||
    (Array.isArray(change.column_steps) &&
      change.column_steps.some((step) => step.status !== "created"))
  );
}

async function getDashboardCreate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (change.created_dashboard_id === undefined) {
    if (change.native_write_sent === true) {
      return recordUnknownDashboardCreate(
        ctx,
        change,
        change.baseline_dashboard_ids,
        change.requested_name,
      );
    }
    return ctx.publicStored(change);
  }
  let live;
  try {
    live = await ctx.client.getDashboard(change.created_dashboard_id);
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (live === null) {
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        ...(change.write_intent?.acknowledged === false
          ? { recovered_after_uncertain_write: true }
          : {}),
        last_verification: freshVerification("created_dashboard_absent"),
      });
    }
    if (change.status === "conflict") {
      return publicDashboardChange(change, {
        verification: freshVerification("created_dashboard_missing"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_dashboard_missing",
      last_verification: freshVerification("created_dashboard_missing"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    if (change.status === "restoring") {
      return ctx.finishNative(change, "uncertain", undefined, {
        observed_snapshot: dashboardSnapshot(live),
        last_verification: freshVerification("created_dashboard_still_present"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("created_dashboard_still_present"),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      verification: freshVerification(change.conflict_reason ?? "conflict"),
    });
  }
  if (change.status === "uncertain" || hasIncompleteColumnSteps(change)) {
    if (change.status === "applying") {
      return ctx.finishNative(change, "uncertain", undefined, {
        observed_snapshot: dashboardSnapshot(live),
        conflict_reason: "dashboard_column_creation_outcome_unknown",
        last_verification: freshVerification("partial_dashboard_observed"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("partial_dashboard_observed"),
    });
  }
  if (change.status === "applying") {
    return ctx.finishNative(change, "applied", undefined, {
      creation_complete: true,
      applied_snapshot: dashboardSnapshot(live),
      last_verification: freshVerification("created_dashboard_observed"),
    });
  }
  return publicDashboardChange(change, {
    verification: freshVerification("created_dashboard_observed"),
  });
}

async function reconcileDashboardUpdate(
  ctx,
  change,
  direction,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getDashboard(change.dashboard_id);
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  const targetName =
    direction === "apply"
      ? change.requested_name
      : change.baseline_snapshot.name;
  const previousName =
    direction === "apply"
      ? change.baseline_snapshot.name
      : change.applied_snapshot?.name;
  const exactMatch = live.name === targetName;
  const normalizedMatch =
    isHubNormalizedDashboardName(targetName, live.name) &&
    (!uncertainWrite || live.name !== previousName);
  if (exactMatch || normalizedMatch) {
    return ctx.finishNative(
      change,
      direction === "apply" ? "applied" : "restored",
      undefined,
      {
        ...(direction === "apply"
          ? { applied_snapshot: { id: live.id, name: live.name } }
          : {}),
        ...(direction === "apply" && normalizedMatch
          ? {
              hub_normalized_name: {
                requested: targetName,
                stored: live.name,
              },
            }
          : {}),
        observed_name: live.name,
        ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
        last_verification: freshVerification(
          direction === "apply"
            ? "requested_name_observed"
            : "baseline_name_observed",
        ),
      },
    );
  }
  if (live.name === previousName) {
    return ctx.finishNative(change, "uncertain", undefined, {
      observed_name: live.name,
      last_verification: freshVerification("previous_name_still_present"),
    });
  }
  return ctx.finishNative(change, "conflict", undefined, {
    observed_name: live.name,
    conflict_reason: "dashboard_changed_since",
    last_verification: freshVerification("dashboard_changed_since"),
  });
}

async function getDashboardUpdate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (["applying", "restoring", "uncertain"].includes(change.status)) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileDashboardUpdate(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  let live;
  try {
    live = await ctx.client.getDashboard(change.dashboard_id);
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      ...(live ? { observedName: live.name } : {}),
      verification: freshVerification(
        live === null
          ? "dashboard_missing"
          : (change.conflict_reason ?? "conflict"),
      ),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  return publicDashboardChange(change, {
    observedName: live.name,
    verification: freshVerification(
      live.name === change.applied_snapshot?.name
        ? "applied_name_observed"
        : "dashboard_changed_since",
    ),
  });
}

async function reconcileDashboardDeleteApply(ctx, change, uncertainWrite) {
  let live;
  try {
    live = await ctx.client.getDashboard(change.dashboard_id);
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "applied", undefined, {
      delete_confirmed: true,
      ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("deleted_dashboard_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification("dashboard_still_present"),
  });
}

async function getDashboardDelete(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned"
  ) {
    return ctx.publicStored(change);
  }
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    return reconcileDashboardDeleteApply(
      ctx,
      change,
      change.write_intent?.acknowledged !== true,
    );
  }
  if (change.recreated_dashboard_id !== undefined) {
    let live;
    try {
      live = await ctx.client.getDashboard(change.recreated_dashboard_id);
    } catch (error) {
      return publicDashboardChange(change, {
        verification: failedVerification(error),
      });
    }
    if (live === null) {
      if (change.status === "conflict" || change.status === "restored") {
        return publicDashboardChange(change, {
          verification: freshVerification("recreated_dashboard_missing"),
        });
      }
      return ctx.finishNative(change, "conflict", undefined, {
        recreation_complete: false,
        conflict_reason: "recreated_dashboard_missing",
        last_verification: freshVerification("recreated_dashboard_missing"),
      });
    }
    // NEVER mark incomplete multi-step recreation as restored!
    if (change.recreation_complete !== true) {
      if (change.status === "restoring") {
        return ctx.finishNative(change, "uncertain", undefined, {
          observed_snapshot: dashboardSnapshot(live),
          conflict_reason: "recreation_step_outcome_unknown",
          last_verification: freshVerification("partial_recreation_observed"),
        });
      }
      return publicDashboardChange(change, {
        verification: freshVerification("partial_recreation_observed"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("recreated_dashboard_observed"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownDashboardCreate(
      ctx,
      change,
      change.restore_baseline_dashboard_ids,
      change.baseline_snapshot.name,
    );
  }
  return ctx.publicStored(change);
}

async function getDashboardColumnCreate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (change.created_column_id === undefined) {
    if (change.native_write_sent === true) {
      return recordUnknownColumnCreate(
        ctx,
        change,
        change.baseline_column_ids,
        change.requested_name,
      );
    }
    return ctx.publicStored(change);
  }
  let live;
  try {
    live = await ctx.client.getDashboardColumn(
      change.dashboard_id,
      change.created_column_id,
    );
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (live === null) {
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        ...(change.write_intent?.acknowledged === false
          ? { recovered_after_uncertain_write: true }
          : {}),
        last_verification: freshVerification("created_column_absent"),
      });
    }
    if (change.status === "conflict") {
      return publicDashboardChange(change, {
        verification: freshVerification("created_column_missing"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_column_missing",
      last_verification: freshVerification("created_column_missing"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    if (change.status === "restoring") {
      return ctx.finishNative(change, "uncertain", undefined, {
        observed_snapshot: columnSnapshot(live),
        last_verification: freshVerification("created_column_still_present"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("created_column_still_present"),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      verification: freshVerification(change.conflict_reason ?? "conflict"),
    });
  }
  if (change.status === "applying") {
    return ctx.finishNative(change, "applied", undefined, {
      applied_snapshot: change.applied_snapshot ?? columnSnapshot(live),
      last_verification: freshVerification("created_column_observed"),
    });
  }
  return publicDashboardChange(change, {
    verification: freshVerification("created_column_observed"),
  });
}

async function reconcileDashboardColumnUpdate(
  ctx,
  change,
  direction,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getDashboardColumn(
      change.dashboard_id,
      change.column_id,
    );
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  const targetName =
    direction === "apply"
      ? change.requested_name
      : change.baseline_snapshot.name;
  const previousName =
    direction === "apply"
      ? change.baseline_snapshot.name
      : change.applied_snapshot?.name;
  const exactMatch = live.name === targetName;
  const normalizedMatch =
    isHubNormalizedDashboardName(targetName, live.name) &&
    (!uncertainWrite || live.name !== previousName);
  if (exactMatch || normalizedMatch) {
    return ctx.finishNative(
      change,
      direction === "apply" ? "applied" : "restored",
      undefined,
      {
        ...(direction === "apply"
          ? {
              applied_snapshot: {
                dashboard_id: change.dashboard_id,
                id: change.column_id,
                name: live.name,
              },
            }
          : {}),
        ...(direction === "apply" && normalizedMatch
          ? {
              hub_normalized_name: {
                requested: targetName,
                stored: live.name,
              },
            }
          : {}),
        observed_name: live.name,
        ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
        last_verification: freshVerification(
          direction === "apply"
            ? "requested_name_observed"
            : "baseline_name_observed",
        ),
      },
    );
  }
  if (live.name === previousName) {
    return ctx.finishNative(change, "uncertain", undefined, {
      observed_name: live.name,
      last_verification: freshVerification("previous_name_still_present"),
    });
  }
  return ctx.finishNative(change, "conflict", undefined, {
    observed_name: live.name,
    conflict_reason: "column_changed_since",
    last_verification: freshVerification("column_changed_since"),
  });
}

async function getDashboardColumnUpdate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (["applying", "restoring", "uncertain"].includes(change.status)) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileDashboardColumnUpdate(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  let live;
  try {
    live = await ctx.client.getDashboardColumn(
      change.dashboard_id,
      change.column_id,
    );
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      ...(live ? { observedName: live.name } : {}),
      verification: freshVerification(
        live === null
          ? "column_missing"
          : (change.conflict_reason ?? "conflict"),
      ),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  return publicDashboardChange(change, {
    observedName: live.name,
    verification: freshVerification(
      live.name === change.applied_snapshot?.name
        ? "applied_name_observed"
        : "column_changed_since",
    ),
  });
}

async function reconcileDashboardColumnDeleteApply(
  ctx,
  change,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getDashboardColumn(
      change.dashboard_id,
      change.column_id,
    );
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "applied", undefined, {
      delete_confirmed: true,
      ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("deleted_column_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification("column_still_present"),
  });
}

async function getDashboardColumnDelete(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned"
  ) {
    return ctx.publicStored(change);
  }
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    return reconcileDashboardColumnDeleteApply(
      ctx,
      change,
      change.write_intent?.acknowledged !== true,
    );
  }
  if (change.recreated_column_id !== undefined) {
    let live;
    try {
      live = await ctx.client.getDashboardColumn(
        change.dashboard_id,
        change.recreated_column_id,
      );
    } catch (error) {
      return publicDashboardChange(change, {
        verification: failedVerification(error),
      });
    }
    if (live === null) {
      if (change.status === "conflict" || change.status === "restored") {
        return publicDashboardChange(change, {
          verification: freshVerification("recreated_column_missing"),
        });
      }
      return ctx.finishNative(change, "conflict", undefined, {
        recreation_complete: false,
        conflict_reason: "recreated_column_missing",
        last_verification: freshVerification("recreated_column_missing"),
      });
    }
    if (change.recreation_complete !== true) {
      if (change.status === "restoring") {
        return ctx.finishNative(change, "uncertain", undefined, {
          observed_snapshot: columnSnapshot(live),
          conflict_reason: "recreation_step_outcome_unknown",
          last_verification: freshVerification("partial_recreation_observed"),
        });
      }
      return publicDashboardChange(change, {
        verification: freshVerification("partial_recreation_observed"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("recreated_column_observed"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownColumnCreate(
      ctx,
      change,
      change.restore_baseline_column_ids,
      change.baseline_snapshot.name,
    );
  }
  return ctx.publicStored(change);
}

async function getDashboardWidgetCreate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (change.created_widget_id === undefined) {
    if (change.native_write_sent === true) {
      return recordUnknownWidgetCreate(
        ctx,
        change,
        change.baseline_widget_ids,
        change.requested_widget,
      );
    }
    return ctx.publicStored(change);
  }
  let live;
  try {
    live = await ctx.client.getDashboardWidget(
      change.dashboard_id,
      change.created_widget_id,
    );
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (live === null) {
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        ...(change.write_intent?.acknowledged === false
          ? { recovered_after_uncertain_write: true }
          : {}),
        last_verification: freshVerification("created_widget_absent"),
      });
    }
    if (change.status === "conflict") {
      return publicDashboardChange(change, {
        verification: freshVerification("created_widget_missing"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_widget_missing",
      last_verification: freshVerification("created_widget_missing"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    if (change.status === "restoring") {
      return ctx.finishNative(change, "uncertain", undefined, {
        observed_snapshot: widgetSnapshot(live),
        last_verification: freshVerification("created_widget_still_present"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("created_widget_still_present"),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      verification: freshVerification(change.conflict_reason ?? "conflict"),
    });
  }
  if (change.status === "applying") {
    return ctx.finishNative(change, "applied", undefined, {
      applied_snapshot: change.applied_snapshot ?? widgetSnapshot(live),
      last_verification: freshVerification("created_widget_observed"),
    });
  }
  return publicDashboardChange(change, {
    verification: freshVerification("created_widget_observed"),
  });
}

async function reconcileDashboardWidgetUpdate(
  ctx,
  change,
  direction,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getDashboardWidget(
      change.dashboard_id,
      change.widget_id,
    );
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  const liveSnap = widgetSnapshot(live);
  const expected =
    direction === "apply" ? change.requested_widget : change.baseline_snapshot;
  const previous =
    direction === "apply" ? change.baseline_snapshot : change.applied_snapshot;
  const exactMatch = sameWidgetContent(liveSnap, expected);
  const expectedName = expected.name ?? "";
  const liveName = liveSnap.name ?? "";
  const normalizedMatch =
    sameWidgetPayloadAndType(liveSnap, expected) &&
    isHubNormalizedDashboardName(expectedName, liveName) &&
    (!uncertainWrite || !previous || !sameWidgetContent(liveSnap, previous));
  if (exactMatch || normalizedMatch) {
    return ctx.finishNative(
      change,
      direction === "apply" ? "applied" : "restored",
      undefined,
      {
        ...(direction === "apply" ? { applied_snapshot: liveSnap } : {}),
        ...(direction === "apply" && normalizedMatch
          ? {
              hub_normalized_name: {
                requested: expectedName,
                stored: liveName,
              },
            }
          : {}),
        observed_snapshot: liveSnap,
        ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
        last_verification: freshVerification(
          direction === "apply"
            ? "requested_widget_observed"
            : "baseline_widget_observed",
        ),
      },
    );
  }
  if (previous && sameWidgetContent(liveSnap, previous)) {
    return ctx.finishNative(change, "uncertain", undefined, {
      observed_snapshot: liveSnap,
      last_verification: freshVerification("previous_widget_still_present"),
    });
  }
  return ctx.finishNative(change, "conflict", undefined, {
    observed_snapshot: liveSnap,
    conflict_reason: "widget_changed_since",
    last_verification: freshVerification("widget_changed_since"),
  });
}

async function getDashboardWidgetUpdate(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (["applying", "restoring", "uncertain"].includes(change.status)) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileDashboardWidgetUpdate(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  let live;
  try {
    live = await ctx.client.getDashboardWidget(
      change.dashboard_id,
      change.widget_id,
    );
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      verification: freshVerification(
        live === null
          ? "widget_missing"
          : (change.conflict_reason ?? "conflict"),
      ),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  const liveSnap = widgetSnapshot(live);
  return publicDashboardChange(change, {
    verification: freshVerification(
      change.applied_snapshot &&
        sameWidgetContent(liveSnap, change.applied_snapshot)
        ? "applied_widget_observed"
        : "widget_changed_since",
    ),
  });
}

async function reconcileDashboardWidgetDeleteApply(
  ctx,
  change,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getDashboardWidget(
      change.dashboard_id,
      change.widget_id,
    );
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "applied", undefined, {
      delete_confirmed: true,
      ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("deleted_widget_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification("widget_still_present"),
  });
}

async function getDashboardWidgetDelete(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned"
  ) {
    return ctx.publicStored(change);
  }
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    return reconcileDashboardWidgetDeleteApply(
      ctx,
      change,
      change.write_intent?.acknowledged !== true,
    );
  }
  if (change.recreated_widget_id !== undefined) {
    let live;
    try {
      live = await ctx.client.getDashboardWidget(
        change.dashboard_id,
        change.recreated_widget_id,
      );
    } catch (error) {
      return publicDashboardChange(change, {
        verification: failedVerification(error),
      });
    }
    if (live === null) {
      if (change.status === "conflict" || change.status === "restored") {
        return publicDashboardChange(change, {
          verification: freshVerification("recreated_widget_missing"),
        });
      }
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "recreated_widget_missing",
        last_verification: freshVerification("recreated_widget_missing"),
      });
    }
    if (change.status === "restoring") {
      return ctx.finishNative(change, "restored", undefined, {
        recreated_snapshot: widgetSnapshot(live),
        last_verification: freshVerification("recreated_widget_observed"),
      });
    }
    return publicDashboardChange(change, {
      verification: freshVerification("recreated_widget_observed"),
    });
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownWidgetCreate(
      ctx,
      change,
      change.restore_baseline_widget_ids,
      change.baseline_snapshot,
    );
  }
  return ctx.publicStored(change);
}

async function reconcileDashboardWidgetMove(
  ctx,
  change,
  direction,
  uncertainWrite,
) {
  let live;
  try {
    live = await ctx.client.getDashboard(change.dashboard_id);
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  const expectedColumns =
    direction === "apply" ? change.target_columns : change.baseline_columns;
  const previousColumns =
    direction === "apply"
      ? change.baseline_columns
      : (change.applied_columns ?? change.target_columns);
  if (sameColumnsLayout(live, expectedColumns)) {
    return ctx.finishNative(
      change,
      direction === "apply" ? "applied" : "restored",
      undefined,
      {
        ...(direction === "apply"
          ? { applied_columns: structuredClone(expectedColumns) }
          : {}),
        ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
        last_verification: freshVerification(
          direction === "apply"
            ? "requested_layout_observed"
            : "baseline_layout_observed",
        ),
      },
    );
  }
  if (sameColumnsLayout(live, previousColumns)) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: freshVerification("previous_layout_still_present"),
    });
  }
  for (const { column_id: columnId } of change.baseline_columns ?? []) {
    if (!live.columns.some(({ id }) => id === columnId)) {
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "column_missing",
        last_verification: freshVerification("column_missing"),
      });
    }
  }
  const hasWidget = live.columns.some((column) =>
    column.widgets.some(({ id }) => id === change.widget_id),
  );
  if (!hasWidget) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  return ctx.finishNative(change, "conflict", undefined, {
    conflict_reason: "dashboard_layout_changed_since",
    last_verification: freshVerification("dashboard_layout_changed_since"),
  });
}

async function getDashboardWidgetMove(ctx, change) {
  if (
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned" ||
    change.status === "restored"
  ) {
    return ctx.publicStored(change);
  }
  if (["applying", "restoring", "uncertain"].includes(change.status)) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileDashboardWidgetMove(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  let live;
  try {
    live = await ctx.client.getDashboard(change.dashboard_id);
  } catch (error) {
    return publicDashboardChange(change, {
      verification: failedVerification(error),
    });
  }
  if (change.status === "conflict") {
    return publicDashboardChange(change, {
      verification: freshVerification(
        live === null
          ? "dashboard_missing"
          : (change.conflict_reason ?? "conflict"),
      ),
    });
  }
  if (live === null) {
    return publicDashboardChange(change, {
      verification: freshVerification("dashboard_missing"),
    });
  }
  return publicDashboardChange(change, {
    verification: freshVerification(
      change.applied_columns && sameColumnsLayout(live, change.applied_columns)
        ? "applied_layout_observed"
        : "dashboard_layout_changed_since",
    ),
  });
}

// ---- Restore (Undo) --------------------------------------------------------

function changeApplicationTime(change) {
  return (
    change.history?.find(({ status }) => status === "applying")?.at ??
    change.created_at
  );
}

function isAppliedAfter(other, base) {
  const otherTime = changeApplicationTime(other);
  const baseTime = changeApplicationTime(base);
  if (otherTime !== baseTime) return otherTime > baseTime;
  if (other.created_at !== base.created_at) {
    return other.created_at > base.created_at;
  }
  return other.id > base.id;
}

async function findLaterAppliedChange(ctx, change, kinds) {
  const stored = await ctx.store.list();
  const kindSet = new Set(kinds);
  const later = stored
    .filter(
      (other) =>
        other.id !== change.id &&
        other.home_ref === change.home_ref &&
        other.target_ref === change.target_ref &&
        kindSet.has(other.kind) &&
        other.status === "applied" &&
        isAppliedAfter(other, change),
    )
    .sort((left, right) =>
      changeApplicationTime(right).localeCompare(changeApplicationTime(left)),
    );
  return later[0] ?? null;
}

async function findLaterAppliedDashboardLayoutChange(ctx, change) {
  const stored = await ctx.store.list();
  const affectedColumnIds = new Set(
    (change.baseline_columns ?? []).map(({ column_id }) => column_id),
  );
  const later = stored
    .filter((other) => {
      if (
        other.id === change.id ||
        other.home_ref !== change.home_ref ||
        other.dashboard_id !== change.dashboard_id ||
        other.status !== "applied" ||
        !isAppliedAfter(other, change)
      ) {
        return false;
      }
      if (other.kind === DASHBOARD_DELETE) return true;
      if (
        other.kind === DASHBOARD_WIDGET_CREATE ||
        other.kind === DASHBOARD_WIDGET_DELETE ||
        other.kind === DASHBOARD_COLUMN_DELETE
      ) {
        return affectedColumnIds.has(other.column_id);
      }
      if (other.kind === DASHBOARD_WIDGET_MOVE) {
        return (
          affectedColumnIds.has(other.source_column_id) ||
          affectedColumnIds.has(other.column_id) ||
          (other.baseline_columns ?? []).some(({ column_id }) =>
            affectedColumnIds.has(column_id),
          )
        );
      }
      return false;
    })
    .sort((left, right) =>
      changeApplicationTime(right).localeCompare(changeApplicationTime(left)),
    );
  return later[0] ?? null;
}

export async function restoreDashboardChange(ctx, change) {
  if (change.status === "restored") return ctx.publicStored(change);
  // Single shared pre-write gate across all 10 dashboard operations:
  // prepared, hub-refused not_applied, or pre-write conflict (native_write_sent=false)
  // must NEVER write to the hub or recreate/overwrite owner state.
  if (
    change.native_write_sent !== true ||
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned"
  ) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  // Unconfirmed apply gate: reconcile apply first before any restore write.
  if (
    ["applying", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === "apply"
  ) {
    const ownedPartialDashboard =
      change.kind === DASHBOARD_CREATE &&
      change.creation_owned === true &&
      change.created_dashboard_id !== undefined;
    if (!ownedPartialDashboard) {
      const reconciled = await getDashboardChange(ctx, change);
      if (change.status !== "applied") return reconciled;
    }
  }
  switch (change.kind) {
    case DASHBOARD_CREATE:
      return restoreDashboardCreate(ctx, change);
    case DASHBOARD_UPDATE:
      return restoreDashboardUpdate(ctx, change);
    case DASHBOARD_DELETE:
      return restoreDashboardDelete(ctx, change);
    case DASHBOARD_COLUMN_CREATE:
      return restoreDashboardColumnCreate(ctx, change);
    case DASHBOARD_COLUMN_UPDATE:
      return restoreDashboardColumnUpdate(ctx, change);
    case DASHBOARD_COLUMN_DELETE:
      return restoreDashboardColumnDelete(ctx, change);
    case DASHBOARD_WIDGET_CREATE:
      return restoreDashboardWidgetCreate(ctx, change);
    case DASHBOARD_WIDGET_UPDATE:
      return restoreDashboardWidgetUpdate(ctx, change);
    case DASHBOARD_WIDGET_DELETE:
      return restoreDashboardWidgetDelete(ctx, change);
    case DASHBOARD_WIDGET_MOVE:
      return restoreDashboardWidgetMove(ctx, change);
    default:
      throw new SprutHubError(
        "unsupported_native_operation",
        "This native operation is not supported.",
      );
  }
}

async function restoreDashboardCreate(ctx, change) {
  if (
    change.creation_owned !== true ||
    change.created_dashboard_id === undefined
  ) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "dashboard_creation_not_confirmed",
      last_verification: freshVerification("dashboard_creation_not_confirmed"),
    });
  }
  const live = await ctx.client.getDashboard(change.created_dashboard_id);
  if (live === null) {
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_dashboard_absent"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_dashboard_missing",
      last_verification: freshVerification("created_dashboard_missing"),
    });
  }
  const expectedName =
    change.applied_snapshot?.name ??
    change.applied_dashboard_name ??
    change.requested_name;
  const totalWidgets = live.columns.reduce(
    (sum, column) => sum + column.widgets.length,
    0,
  );
  if (totalWidgets > 0) {
    return ctx.finishNative(change, "conflict", undefined, {
      observed_snapshot: dashboardSnapshot(live),
      conflict_reason: "dashboard_not_empty",
      last_verification: freshVerification("dashboard_not_empty"),
    });
  }
  const confirmedColumns = change.created_columns ?? [];
  const inFlightStep = (change.column_steps ?? []).find(
    (step) => step.status === "sent" && step.acknowledged !== true,
  );
  const prefixMatches =
    live.columns.length >= confirmedColumns.length &&
    confirmedColumns.every(
      (column, index) =>
        live.columns[index].id === column.id &&
        live.columns[index].name === column.name,
    );
  const columnsMatch =
    prefixMatches &&
    (live.columns.length === confirmedColumns.length ||
      (inFlightStep !== undefined &&
        live.columns.length === confirmedColumns.length + 1 &&
        matchesDashboardName(
          inFlightStep.name,
          live.columns[confirmedColumns.length].name,
        )));
  if (live.name !== expectedName || !columnsMatch) {
    const later = await findLaterAppliedChange(
      ctx,
      { ...change, target_ref: change.created_dashboard_ref },
      [DASHBOARD_UPDATE, DASHBOARD_COLUMN_CREATE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      observed_snapshot: dashboardSnapshot(live),
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "dashboard_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "dashboard_changed_since",
      ),
    });
  }
  const priorStatus =
    change.creation_complete === true ? "applied" : change.status;
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.deleteDashboard(change.created_dashboard_id);
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, priorStatus, error);
    }
    const after = await ctx.client
      .getDashboard(change.created_dashboard_id)
      .catch(() => undefined);
    if (after === null) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_dashboard_absent"),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification:
        after === undefined
          ? failedVerification(error)
          : freshVerification("created_dashboard_still_present"),
    });
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  const after = await ctx.client.getDashboard(change.created_dashboard_id);
  if (after === null) {
    return ctx.finishNative(change, "restored", undefined, {
      last_verification: freshVerification("created_dashboard_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification("created_dashboard_still_present"),
  });
}

async function restoreDashboardUpdate(ctx, change) {
  if (!change.applied_snapshot) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const live = await ctx.client.getDashboard(change.dashboard_id);
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  const pendingRestore = isPendingRestoreIntent(change);
  if (
    live.name === change.baseline_snapshot.name ||
    (pendingRestore &&
      live.name !== change.applied_snapshot.name &&
      isHubNormalizedDashboardName(change.baseline_snapshot.name, live.name))
  ) {
    return ctx.finishNative(change, "restored", undefined, {
      observed_name: live.name,
      ...(pendingRestore ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("baseline_name_observed"),
    });
  }
  if (live.name !== change.applied_snapshot.name) {
    const later = await findLaterAppliedChange(ctx, change, [DASHBOARD_UPDATE]);
    return ctx.finishNative(change, "conflict", undefined, {
      observed_name: live.name,
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "dashboard_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "dashboard_changed_since",
      ),
    });
  }
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.updateDashboard(change.dashboard_id, {
      name: change.baseline_snapshot.name,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return reconcileDashboardUpdate(ctx, change, "restore", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardUpdate(ctx, change, "restore", false);
}

function buildDashboardRecreationPlan(snapshot) {
  return snapshot.columns.map((column, columnIndex) => ({
    index: columnIndex,
    name: column.name,
    order: column.order,
    status: "pending",
    widgets: column.widgets.map((widget, widgetIndex) => ({
      index: widgetIndex,
      name: widget.name,
      order: widget.order,
      type: widget.type,
      payload: widget.payload,
      status: "pending",
    })),
  }));
}

function buildColumnRecreationWidgets(snapshot) {
  return snapshot.widgets.map((widget, widgetIndex) => ({
    index: widgetIndex,
    name: widget.name,
    order: widget.order,
    type: widget.type,
    payload: widget.payload,
    status: "pending",
  }));
}

function planHasSentStep(plan) {
  return (plan ?? []).some(
    (column) =>
      column.status === "sent" ||
      (column.widgets ?? []).some((widget) => widget.status === "sent"),
  );
}

async function runDashboardDeleteRecreation(ctx, change) {
  const plan = change.recreation_plan ?? [];
  const dashboardId = change.recreated_dashboard_id;

  // Never blindly resend a column/widget create whose prior attempt lost reply.
  if (planHasSentStep(plan)) {
    let live;
    try {
      live = await ctx.client.getDashboard(dashboardId);
    } catch (error) {
      return ctx.finishNative(change, "uncertain", undefined, {
        recreation_complete: false,
        conflict_reason: "recreation_step_outcome_unknown",
        last_verification: failedVerification(error),
      });
    }
    if (live === null) {
      return ctx.finishNative(change, "conflict", undefined, {
        recreation_complete: false,
        conflict_reason: "recreated_dashboard_missing",
        last_verification: freshVerification("recreated_dashboard_missing"),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      recreation_complete: false,
      observed_snapshot: dashboardSnapshot(live),
      conflict_reason: "recreation_step_outcome_unknown",
      last_verification: freshVerification("partial_recreation_observed"),
    });
  }

  // On explicit retry after a hub refusal, re-enable refused steps to pending.
  for (const columnStep of plan) {
    if (columnStep.status === "refused") columnStep.status = "pending";
    for (const widgetStep of columnStep.widgets) {
      if (widgetStep.status === "refused") widgetStep.status = "pending";
    }
  }

  const needsCatalog = plan.some((columnStep) =>
    columnStep.widgets.some(
      (widgetStep) =>
        widgetStep.status === "pending" && widgetNeedsHomeCatalog(widgetStep),
    ),
  );
  const needsDashboards = plan.some((columnStep) =>
    columnStep.widgets.some(
      (widgetStep) =>
        widgetStep.status === "pending" && widgetNeedsDashboardList(widgetStep),
    ),
  );
  const catalog = needsCatalog
    ? await resolveHomeCatalog(ctx.client, ctx.hubSerial, { refresh: true })
    : null;
  const dashboardIds = needsDashboards
    ? new Set((await ctx.client.listDashboards()).map(({ id }) => id))
    : null;

  for (const columnStep of plan) {
    if (columnStep.status === "pending") {
      columnStep.status = "sent";
      await ctx.store.save(change);
      let createdCol;
      try {
        createdCol = await ctx.client.createDashboardColumn({
          dashboardId,
          ...(columnStep.name !== "" ? { name: columnStep.name } : {}),
          order: columnStep.order,
        });
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          columnStep.status = "refused";
          const rejection = writeRejection(error);
          const live = await ctx.client
            .getDashboard(dashboardId)
            .catch(() => null);
          await ctx.finishNative(change, "conflict", undefined, {
            recreation_complete: false,
            ...(live ? { observed_snapshot: dashboardSnapshot(live) } : {}),
            ...(rejection && change.write_intent
              ? { write_intent: { ...change.write_intent, rejection } }
              : {}),
            conflict_reason: "partial_recreation_refused",
            last_verification: freshVerification("partial_recreation_refused"),
          });
          throw attachPartialRefusalDetails(change, error, rejection);
        }
        const live = await ctx.client
          .getDashboard(dashboardId)
          .catch(() => null);
        return ctx.finishNative(change, "uncertain", undefined, {
          recreation_complete: false,
          ...(live ? { observed_snapshot: dashboardSnapshot(live) } : {}),
          conflict_reason: "recreation_step_outcome_unknown",
          last_verification: live
            ? freshVerification("partial_recreation_observed")
            : failedVerification(error),
        });
      }
      const colRef = dashboardColumnRef(
        ctx.hubSerial,
        dashboardId,
        createdCol.id,
      );
      columnStep.status = "created";
      columnStep.created_id = createdCol.id;
      columnStep.created_ref = colRef;
      change.recreated_columns.push({
        ref: colRef,
        id: createdCol.id,
        name: createdCol.name,
      });
      await ctx.store.save(change);
    }

    if (columnStep.status !== "created") continue;
    for (const widgetStep of columnStep.widgets) {
      if (widgetStep.status !== "pending") continue;
      const missingRefs = findMissingWidgetRefs(
        catalog,
        change.home_ref,
        widgetStep,
        dashboardIds,
      );
      if (missingRefs.length > 0) {
        widgetStep.status = "skipped";
        widgetStep.missing_refs = missingRefs;
        change.skipped_widgets.push({
          column_name: columnStep.name,
          widget_name: widgetStep.name,
          type: widgetStep.type,
          reason: "referenced_entity_missing",
          missing_refs: missingRefs,
        });
        await ctx.store.save(change);
        continue;
      }
      widgetStep.status = "sent";
      await ctx.store.save(change);
      let createdWidget;
      try {
        createdWidget = await ctx.client.createDashboardWidget({
          dashboardId,
          columnId: columnStep.created_id,
          ...(widgetStep.name !== "" ? { name: widgetStep.name } : {}),
          order: widgetStep.order,
          kindKey: widgetStep.type,
          payload: widgetStep.payload,
        });
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          widgetStep.status = "refused";
          const rejection = writeRejection(error);
          const live = await ctx.client
            .getDashboard(dashboardId)
            .catch(() => null);
          await ctx.finishNative(change, "conflict", undefined, {
            recreation_complete: false,
            ...(live ? { observed_snapshot: dashboardSnapshot(live) } : {}),
            ...(rejection && change.write_intent
              ? { write_intent: { ...change.write_intent, rejection } }
              : {}),
            conflict_reason: "partial_recreation_refused",
            last_verification: freshVerification("partial_recreation_refused"),
          });
          throw attachPartialRefusalDetails(change, error, rejection);
        }
        const live = await ctx.client
          .getDashboard(dashboardId)
          .catch(() => null);
        return ctx.finishNative(change, "uncertain", undefined, {
          recreation_complete: false,
          ...(live ? { observed_snapshot: dashboardSnapshot(live) } : {}),
          conflict_reason: "recreation_step_outcome_unknown",
          last_verification: live
            ? freshVerification("partial_recreation_observed")
            : failedVerification(error),
        });
      }
      const widgetRef = dashboardWidgetRef(
        ctx.hubSerial,
        dashboardId,
        createdWidget.id,
      );
      widgetStep.status = "created";
      widgetStep.created_id = createdWidget.id;
      widgetStep.created_ref = widgetRef;
      change.recreated_widgets.push({
        ref: widgetRef,
        id: createdWidget.id,
        column_ref: columnStep.created_ref,
        name: createdWidget.name,
        type: createdWidget.type,
      });
      await ctx.store.save(change);
    }
  }

  const live = await ctx.client.getDashboard(dashboardId);
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      recreation_complete: false,
      conflict_reason: "recreated_dashboard_missing",
      last_verification: freshVerification("recreated_dashboard_missing"),
    });
  }
  return ctx.finishNative(change, "restored", undefined, {
    recreation_complete: true,
    recreated_snapshot: dashboardSnapshot(live),
    last_verification: freshVerification("recreated_dashboard_observed"),
  });
}

async function restoreDashboardDelete(ctx, change) {
  if (change.recreated_dashboard_id !== undefined) {
    if (change.recreation_complete === true) {
      return getDashboardDelete(ctx, change);
    }
    const liveParent = await ctx.client.getDashboard(
      change.recreated_dashboard_id,
    );
    if (liveParent === null) {
      return ctx.finishNative(change, "conflict", undefined, {
        recreation_complete: false,
        conflict_reason: "recreated_dashboard_missing",
        last_verification: freshVerification("recreated_dashboard_missing"),
      });
    }
    return runDashboardDeleteRecreation(ctx, change);
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownDashboardCreate(
      ctx,
      change,
      change.restore_baseline_dashboard_ids,
      change.baseline_snapshot.name,
    );
  }
  if (change.delete_confirmed !== true) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const existing = await ctx.client.getDashboard(change.dashboard_id);
  if (existing !== null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_still_present",
      last_verification: freshVerification("dashboard_still_present"),
    });
  }
  const beforeList = await ctx.client.listDashboards();
  change.restore_baseline_dashboard_ids = beforeList.map(({ id }) => id);
  const snapshot = change.baseline_snapshot;
  await ctx.persistNativeIntent(change, "restoring", "restore");
  let created;
  try {
    created = await ctx.client.createDashboard({
      name: snapshot.name,
      order: snapshot.order,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return recordUnknownDashboardCreate(
      ctx,
      change,
      change.restore_baseline_dashboard_ids,
      snapshot.name,
    );
  }
  change.recreated_dashboard_id = created.id;
  change.recreated_dashboard_ref = dashboardRef(ctx.hubSerial, created.id);
  change.recreation_complete = false;
  change.recreation_plan = buildDashboardRecreationPlan(snapshot);
  change.recreated_columns = [];
  change.recreated_widgets = [];
  change.skipped_widgets = [];
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  await ctx.store.save(change);
  return runDashboardDeleteRecreation(ctx, change);
}

async function restoreDashboardColumnCreate(ctx, change) {
  if (
    change.creation_owned !== true ||
    change.created_column_id === undefined ||
    !change.applied_snapshot
  ) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "column_creation_not_confirmed",
      last_verification: freshVerification("column_creation_not_confirmed"),
    });
  }
  const live = await ctx.client.getDashboardColumn(
    change.dashboard_id,
    change.created_column_id,
  );
  if (live === null) {
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_column_absent"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_column_missing",
      last_verification: freshVerification("created_column_missing"),
    });
  }
  if (live.widgets.length > 0) {
    return ctx.finishNative(change, "conflict", undefined, {
      observed_snapshot: columnSnapshot(live),
      conflict_reason: "column_not_empty",
      last_verification: freshVerification("column_not_empty"),
    });
  }
  if (live.name !== change.applied_snapshot.name) {
    const later = await findLaterAppliedChange(
      ctx,
      { ...change, target_ref: change.created_column_ref },
      [DASHBOARD_COLUMN_UPDATE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      observed_snapshot: columnSnapshot(live),
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "column_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "column_changed_since",
      ),
    });
  }
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.deleteDashboardColumn(
      change.dashboard_id,
      change.created_column_id,
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    const after = await ctx.client
      .getDashboardColumn(change.dashboard_id, change.created_column_id)
      .catch(() => undefined);
    if (after === null) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_column_absent"),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification:
        after === undefined
          ? failedVerification(error)
          : freshVerification("created_column_still_present"),
    });
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  const after = await ctx.client.getDashboardColumn(
    change.dashboard_id,
    change.created_column_id,
  );
  if (after === null) {
    return ctx.finishNative(change, "restored", undefined, {
      last_verification: freshVerification("created_column_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification("created_column_still_present"),
  });
}

async function restoreDashboardColumnUpdate(ctx, change) {
  if (!change.applied_snapshot) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const live = await ctx.client.getDashboardColumn(
    change.dashboard_id,
    change.column_id,
  );
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  const pendingRestore = isPendingRestoreIntent(change);
  if (
    live.name === change.baseline_snapshot.name ||
    (pendingRestore &&
      live.name !== change.applied_snapshot.name &&
      isHubNormalizedDashboardName(change.baseline_snapshot.name, live.name))
  ) {
    return ctx.finishNative(change, "restored", undefined, {
      observed_name: live.name,
      ...(pendingRestore ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("baseline_name_observed"),
    });
  }
  if (live.name !== change.applied_snapshot.name) {
    const later = await findLaterAppliedChange(ctx, change, [
      DASHBOARD_COLUMN_UPDATE,
    ]);
    return ctx.finishNative(change, "conflict", undefined, {
      observed_name: live.name,
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "column_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "column_changed_since",
      ),
    });
  }
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.updateDashboardColumn(
      change.dashboard_id,
      change.column_id,
      { name: change.baseline_snapshot.name },
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return reconcileDashboardColumnUpdate(ctx, change, "restore", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardColumnUpdate(ctx, change, "restore", false);
}

async function runColumnDeleteRecreation(ctx, change) {
  const widgetSteps = change.recreation_widgets ?? [];
  const dashboardId = change.dashboard_id;
  const columnId = change.recreated_column_id;
  const colRef = change.recreated_column_ref;

  if (widgetSteps.some((step) => step.status === "sent")) {
    let live;
    try {
      live = await ctx.client.getDashboardColumn(dashboardId, columnId);
    } catch (error) {
      return ctx.finishNative(change, "uncertain", undefined, {
        recreation_complete: false,
        conflict_reason: "recreation_step_outcome_unknown",
        last_verification: failedVerification(error),
      });
    }
    if (live === null) {
      return ctx.finishNative(change, "conflict", undefined, {
        recreation_complete: false,
        conflict_reason: "recreated_column_missing",
        last_verification: freshVerification("recreated_column_missing"),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      recreation_complete: false,
      observed_snapshot: columnSnapshot(live),
      conflict_reason: "recreation_step_outcome_unknown",
      last_verification: freshVerification("partial_recreation_observed"),
    });
  }

  for (const step of widgetSteps) {
    if (step.status === "refused") step.status = "pending";
  }

  const needsCatalog = widgetSteps.some(
    (step) => step.status === "pending" && widgetNeedsHomeCatalog(step),
  );
  const needsDashboards = widgetSteps.some(
    (step) => step.status === "pending" && widgetNeedsDashboardList(step),
  );
  const catalog = needsCatalog
    ? await resolveHomeCatalog(ctx.client, ctx.hubSerial, { refresh: true })
    : null;
  const dashboardIds = needsDashboards
    ? new Set((await ctx.client.listDashboards()).map(({ id }) => id))
    : null;

  for (const widgetStep of widgetSteps) {
    if (widgetStep.status !== "pending") continue;
    const missingRefs = findMissingWidgetRefs(
      catalog,
      change.home_ref,
      widgetStep,
      dashboardIds,
    );
    if (missingRefs.length > 0) {
      widgetStep.status = "skipped";
      widgetStep.missing_refs = missingRefs;
      change.skipped_widgets.push({
        column_name: change.baseline_snapshot.name,
        widget_name: widgetStep.name,
        type: widgetStep.type,
        reason: "referenced_entity_missing",
        missing_refs: missingRefs,
      });
      await ctx.store.save(change);
      continue;
    }
    widgetStep.status = "sent";
    await ctx.store.save(change);
    let createdWidget;
    try {
      createdWidget = await ctx.client.createDashboardWidget({
        dashboardId,
        columnId,
        ...(widgetStep.name !== "" ? { name: widgetStep.name } : {}),
        order: widgetStep.order,
        kindKey: widgetStep.type,
        payload: widgetStep.payload,
      });
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        widgetStep.status = "refused";
        const rejection = writeRejection(error);
        const live = await ctx.client
          .getDashboardColumn(dashboardId, columnId)
          .catch(() => null);
        await ctx.finishNative(change, "conflict", undefined, {
          recreation_complete: false,
          ...(live ? { observed_snapshot: columnSnapshot(live) } : {}),
          ...(rejection && change.write_intent
            ? { write_intent: { ...change.write_intent, rejection } }
            : {}),
          conflict_reason: "partial_recreation_refused",
          last_verification: freshVerification("partial_recreation_refused"),
        });
        throw attachPartialRefusalDetails(change, error, rejection);
      }
      const live = await ctx.client
        .getDashboardColumn(dashboardId, columnId)
        .catch(() => null);
      return ctx.finishNative(change, "uncertain", undefined, {
        recreation_complete: false,
        ...(live ? { observed_snapshot: columnSnapshot(live) } : {}),
        conflict_reason: "recreation_step_outcome_unknown",
        last_verification: live
          ? freshVerification("partial_recreation_observed")
          : failedVerification(error),
      });
    }
    const widgetRef = dashboardWidgetRef(
      ctx.hubSerial,
      dashboardId,
      createdWidget.id,
    );
    widgetStep.status = "created";
    widgetStep.created_id = createdWidget.id;
    widgetStep.created_ref = widgetRef;
    change.recreated_widgets.push({
      ref: widgetRef,
      id: createdWidget.id,
      column_ref: colRef,
      name: createdWidget.name,
      type: createdWidget.type,
    });
    await ctx.store.save(change);
  }

  const live = await ctx.client.getDashboardColumn(dashboardId, columnId);
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      recreation_complete: false,
      conflict_reason: "recreated_column_missing",
      last_verification: freshVerification("recreated_column_missing"),
    });
  }
  return ctx.finishNative(change, "restored", undefined, {
    recreation_complete: true,
    recreated_snapshot: columnSnapshot(live),
    last_verification: freshVerification("recreated_column_observed"),
  });
}

async function restoreDashboardColumnDelete(ctx, change) {
  if (change.recreated_column_id !== undefined) {
    if (change.recreation_complete === true) {
      return getDashboardColumnDelete(ctx, change);
    }
    const liveCol = await ctx.client.getDashboardColumn(
      change.dashboard_id,
      change.recreated_column_id,
    );
    if (liveCol === null) {
      return ctx.finishNative(change, "conflict", undefined, {
        recreation_complete: false,
        conflict_reason: "recreated_column_missing",
        last_verification: freshVerification("recreated_column_missing"),
      });
    }
    return runColumnDeleteRecreation(ctx, change);
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownColumnCreate(
      ctx,
      change,
      change.restore_baseline_column_ids,
      change.baseline_snapshot.name,
    );
  }
  if (change.delete_confirmed !== true) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const dashboard = await ctx.client.getDashboard(change.dashboard_id);
  if (dashboard === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  if (dashboard.columns.some(({ id }) => id === change.column_id)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_still_present",
      last_verification: freshVerification("column_still_present"),
    });
  }
  change.restore_baseline_column_ids = dashboard.columns.map(({ id }) => id);
  const snapshot = change.baseline_snapshot;
  await ctx.persistNativeIntent(change, "restoring", "restore");
  let createdCol;
  try {
    createdCol = await ctx.client.createDashboardColumn({
      dashboardId: change.dashboard_id,
      ...(snapshot.name !== "" ? { name: snapshot.name } : {}),
      order: snapshot.order,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return recordUnknownColumnCreate(
      ctx,
      change,
      change.restore_baseline_column_ids,
      snapshot.name,
    );
  }
  const colRef = dashboardColumnRef(
    ctx.hubSerial,
    change.dashboard_id,
    createdCol.id,
  );
  change.recreated_column_id = createdCol.id;
  change.recreated_column_ref = colRef;
  change.recreation_complete = false;
  change.recreation_widgets = buildColumnRecreationWidgets(snapshot);
  change.recreated_widgets = [];
  change.skipped_widgets = [];
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  await ctx.store.save(change);
  return runColumnDeleteRecreation(ctx, change);
}

async function restoreDashboardWidgetCreate(ctx, change) {
  if (
    change.creation_owned !== true ||
    change.created_widget_id === undefined ||
    !change.applied_snapshot
  ) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "widget_creation_not_confirmed",
      last_verification: freshVerification("widget_creation_not_confirmed"),
    });
  }
  const live = await ctx.client.getDashboardWidget(
    change.dashboard_id,
    change.created_widget_id,
  );
  if (live === null) {
    if (isPendingRestoreIntent(change)) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_widget_absent"),
      });
    }
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "created_widget_missing",
      last_verification: freshVerification("created_widget_missing"),
    });
  }
  const liveSnap = widgetSnapshot(live);
  if (
    liveSnap.column_id !== change.column_id ||
    !sameWidgetContent(liveSnap, change.applied_snapshot)
  ) {
    const later = await findLaterAppliedChange(
      ctx,
      { ...change, target_ref: change.created_widget_ref },
      [DASHBOARD_WIDGET_UPDATE, DASHBOARD_WIDGET_MOVE],
    );
    return ctx.finishNative(change, "conflict", undefined, {
      observed_snapshot: liveSnap,
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "widget_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "widget_changed_since",
      ),
    });
  }
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.deleteDashboardWidget(
      change.dashboard_id,
      change.created_widget_id,
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    const after = await ctx.client
      .getDashboardWidget(change.dashboard_id, change.created_widget_id)
      .catch(() => undefined);
    if (after === null) {
      return ctx.finishNative(change, "restored", undefined, {
        recovered_after_uncertain_write: true,
        last_verification: freshVerification("created_widget_absent"),
      });
    }
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification:
        after === undefined
          ? failedVerification(error)
          : freshVerification("created_widget_still_present"),
    });
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  const after = await ctx.client.getDashboardWidget(
    change.dashboard_id,
    change.created_widget_id,
  );
  if (after === null) {
    return ctx.finishNative(change, "restored", undefined, {
      last_verification: freshVerification("created_widget_absent"),
    });
  }
  return ctx.finishNative(change, "uncertain", undefined, {
    last_verification: freshVerification("created_widget_still_present"),
  });
}

async function restoreDashboardWidgetUpdate(ctx, change) {
  if (!change.applied_snapshot) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const live = await ctx.client.getDashboardWidget(
    change.dashboard_id,
    change.widget_id,
  );
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  const liveSnap = widgetSnapshot(live);
  const pendingRestore = isPendingRestoreIntent(change);
  if (
    sameWidgetContent(liveSnap, change.baseline_snapshot) ||
    (pendingRestore &&
      !sameWidgetContent(liveSnap, change.applied_snapshot) &&
      sameWidgetContent(liveSnap, change.baseline_snapshot, {
        allowNormalizedName: true,
      }))
  ) {
    return ctx.finishNative(change, "restored", undefined, {
      observed_snapshot: liveSnap,
      ...(pendingRestore ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("baseline_widget_observed"),
    });
  }
  if (!sameWidgetContent(liveSnap, change.applied_snapshot)) {
    const later = await findLaterAppliedChange(ctx, change, [
      DASHBOARD_WIDGET_UPDATE,
    ]);
    return ctx.finishNative(change, "conflict", undefined, {
      observed_snapshot: liveSnap,
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "widget_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "widget_changed_since",
      ),
    });
  }
  const missingRefs = await findMissingLiveWidgetRefs(
    ctx,
    change.home_ref,
    change.baseline_snapshot,
    { refreshCatalog: true },
  );
  if (missingRefs.length > 0) {
    return ctx.finishNative(change, "conflict", undefined, {
      missing_refs: missingRefs,
      conflict_reason: "referenced_entity_missing",
      last_verification: freshVerification("referenced_entity_missing"),
    });
  }
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.updateDashboardWidget(
      change.dashboard_id,
      change.widget_id,
      {
        name: change.baseline_snapshot.name,
        kindKey: change.baseline_snapshot.type,
        payload: change.baseline_snapshot.payload,
      },
    );
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return reconcileDashboardWidgetUpdate(ctx, change, "restore", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardWidgetUpdate(ctx, change, "restore", false);
}

async function restoreDashboardWidgetDelete(ctx, change) {
  if (change.recreated_widget_id !== undefined) {
    return getDashboardWidgetDelete(ctx, change);
  }
  if (isPendingRestoreIntent(change)) {
    return recordUnknownWidgetCreate(
      ctx,
      change,
      change.restore_baseline_widget_ids,
      change.baseline_snapshot,
    );
  }
  if (change.delete_confirmed !== true) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const dashboard = await ctx.client.getDashboard(change.dashboard_id);
  if (dashboard === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  const column = dashboard.columns.find(
    ({ id }) => id === change.baseline_snapshot.column_id,
  );
  if (!column) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "column_missing",
      last_verification: freshVerification("column_missing"),
    });
  }
  if (column.widgets.some(({ id }) => id === change.widget_id)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_still_present",
      last_verification: freshVerification("widget_still_present"),
    });
  }
  const missingRefs = await findMissingLiveWidgetRefs(
    ctx,
    change.home_ref,
    change.baseline_snapshot,
    { refreshCatalog: true },
  );
  if (missingRefs.length > 0) {
    return ctx.finishNative(change, "conflict", undefined, {
      missing_refs: missingRefs,
      conflict_reason: "referenced_entity_missing",
      last_verification: freshVerification("referenced_entity_missing"),
    });
  }
  change.restore_baseline_widget_ids = column.widgets.map(({ id }) => id);
  await ctx.persistNativeIntent(change, "restoring", "restore");
  let created;
  try {
    created = await ctx.client.createDashboardWidget({
      dashboardId: change.dashboard_id,
      columnId: change.baseline_snapshot.column_id,
      ...(change.baseline_snapshot.name !== ""
        ? { name: change.baseline_snapshot.name }
        : {}),
      order: change.baseline_snapshot.order,
      kindKey: change.baseline_snapshot.type,
      payload: change.baseline_snapshot.payload,
    });
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return recordUnknownWidgetCreate(
      ctx,
      change,
      change.restore_baseline_widget_ids,
      change.baseline_snapshot,
    );
  }
  change.recreated_widget_id = created.id;
  change.recreated_widget_ref = dashboardWidgetRef(
    ctx.hubSerial,
    change.dashboard_id,
    created.id,
  );
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  await ctx.store.save(change);
  const live = await ctx.client.getDashboardWidget(
    change.dashboard_id,
    created.id,
  );
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "recreated_widget_missing",
      last_verification: freshVerification("recreated_widget_missing"),
    });
  }
  return ctx.finishNative(change, "restored", undefined, {
    recreated_snapshot: widgetSnapshot(live),
    last_verification: freshVerification("recreated_widget_observed"),
  });
}

async function restoreDashboardWidgetMove(ctx, change) {
  if (!change.applied_columns) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const live = await ctx.client.getDashboard(change.dashboard_id);
  if (live === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "dashboard_missing",
      last_verification: freshVerification("dashboard_missing"),
    });
  }
  for (const { column_id: columnId } of change.baseline_columns) {
    if (!live.columns.some(({ id }) => id === columnId)) {
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "column_missing",
        last_verification: freshVerification("column_missing"),
      });
    }
  }
  const hasWidget = live.columns.some((column) =>
    column.widgets.some(({ id }) => id === change.widget_id),
  );
  if (!hasWidget) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "widget_missing",
      last_verification: freshVerification("widget_missing"),
    });
  }
  const pendingRestore = isPendingRestoreIntent(change);
  if (!pendingRestore) {
    const later = await findLaterAppliedDashboardLayoutChange(ctx, change);
    if (later) {
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "later_owned_change",
        restore_first_change_id: later.id,
        last_verification: freshVerification("later_owned_change"),
      });
    }
  }
  if (sameColumnsLayout(live, change.baseline_columns)) {
    return ctx.finishNative(change, "restored", undefined, {
      ...(pendingRestore ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("baseline_layout_observed"),
    });
  }
  if (!sameColumnsLayout(live, change.applied_columns)) {
    const later = await findLaterAppliedDashboardLayoutChange(ctx, change);
    return ctx.finishNative(change, "conflict", undefined, {
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "dashboard_layout_changed_since" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "dashboard_layout_changed_since",
      ),
    });
  }
  const restoreOrders = change.baseline_columns.flatMap(
    ({ column_id, widgets }) =>
      widgets.map(({ id, order }) => ({
        dashboardId: change.dashboard_id,
        columnId: column_id,
        id,
        order,
      })),
  );
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.reorderDashboardWidgets(restoreOrders);
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return reconcileDashboardWidgetMove(ctx, change, "restore", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileDashboardWidgetMove(ctx, change, "restore", false);
}

// ---- Presentation, History & Summary Helpers -------------------------------

function widgetDiffView(homeRef, widget) {
  if (!widget) return null;
  const base = {
    name: widget.name ?? "",
    type: widget.type,
  };
  if (widget.type === "characteristic" || widget.type === "chart") {
    return {
      ...base,
      item_refs: (widget.payload?.items ?? []).map(
        ({ aId, sId, cId }) =>
          `${homeRef}/accessory/${aId}/service/${sId}/characteristic/${cId}`,
      ),
      ...(widget.type === "chart" && widget.payload?.group !== undefined
        ? { history_group: widget.payload.group }
        : {}),
    };
  }
  if (widget.type === "service" || widget.type === "camera") {
    return {
      ...base,
      item_refs: (widget.payload?.items ?? []).map(
        ({ aId, sId }) => `${homeRef}/accessory/${aId}/service/${sId}`,
      ),
      ...(widget.type === "service" &&
      typeof widget.payload?.showRooms === "boolean"
        ? { show_rooms: widget.payload.showRooms }
        : {}),
    };
  }
  if (widget.type === "shortcut") {
    return {
      ...base,
      shortcut_ids: (widget.payload?.items ?? []).map(({ id }) => id),
    };
  }
  return base;
}

export function publicDashboardChange(change, options = {}) {
  const verification = Object.hasOwn(options, "verification")
    ? options.verification
    : change.last_verification;
  const common = {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
  };
  const warnings = Array.isArray(change.warnings)
    ? [...change.warnings]
    : typeof change.warning === "string" && change.warning.length > 0
      ? [change.warning]
      : [];
  const tail = {
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(verification ? { verification } : {}),
    ...(change.recovered_after_uncertain_write
      ? { recovered_after_uncertain_write: true }
      : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...(change.conflict_reason === "later_owned_change" &&
    typeof change.restore_first_change_id === "string"
      ? {
          restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
        }
      : {}),
    ...(change.missing_refs ? { missing_refs: [...change.missing_refs] } : {}),
    ...(change.history_app_missing === true
      ? { history_app_missing: true }
      : {}),
    ...(warnings.length > 0
      ? {
          warning:
            typeof change.warning === "string" && change.warning.length > 0
              ? change.warning
              : warnings.join(" "),
          warnings,
        }
      : {}),
    ...(change.hub_normalized_name
      ? {
          hub_normalized_name: structuredClone(change.hub_normalized_name),
          name_normalized: true,
        }
      : {}),
  };

  if (change.kind === DASHBOARD_CREATE) {
    return {
      ...common,
      diff: {
        dashboard: {
          from: null,
          to: {
            name: change.requested_name,
            columns: [...(change.requested_column_names ?? [])],
          },
        },
      },
      ...(change.created_dashboard_ref
        ? {
            created_dashboard_ref: change.created_dashboard_ref,
            created_columns: (change.created_columns ?? []).map((col) => ({
              ...col,
            })),
            creation_complete: change.creation_complete === true,
          }
        : {}),
      ...(change.candidate_dashboards
        ? {
            candidate_dashboards: structuredClone(change.candidate_dashboards),
          }
        : {}),
      creation_owned: change.creation_owned === true,
      ...tail,
      restore_supported: change.creation_owned === true,
      limitations: [
        "SprutHub creates dashboards with 0 columns; dashboard_create creates the requested columns sequentially.",
        "Restore deletes the dashboard only while its name and empty created columns are unchanged.",
      ],
    };
  }

  if (change.kind === DASHBOARD_UPDATE) {
    return {
      ...common,
      diff: {
        name: {
          from: change.baseline_snapshot.name,
          to: change.requested_name,
        },
      },
      ...(options.observedName !== undefined
        ? { observed_name: options.observedName }
        : change.observed_name !== undefined
          ? { observed_name: change.observed_name }
          : {}),
      ...tail,
      restore_supported: true,
      limitations: [
        "SprutHub exposes no native compare-and-set; restore checks live name before writing.",
      ],
    };
  }

  if (change.kind === DASHBOARD_DELETE) {
    return {
      ...common,
      dashboard: {
        ref: change.target_ref,
        name: change.baseline_snapshot.name,
        column_count: change.column_count,
        widget_count: change.widget_count,
      },
      ...(change.recreated_dashboard_ref
        ? {
            recreated_dashboard_ref: change.recreated_dashboard_ref,
            recreation_complete: change.recreation_complete === true,
            recreated_columns: structuredClone(change.recreated_columns ?? []),
            recreated_widgets: structuredClone(change.recreated_widgets ?? []),
            skipped_widgets: structuredClone(change.skipped_widgets ?? []),
          }
        : {}),
      ...(change.candidate_dashboards
        ? {
            candidate_dashboards: structuredClone(change.candidate_dashboards),
          }
        : {}),
      ...tail,
      restore_supported:
        ["prepared", "applying", "uncertain", "applied"].includes(
          change.status,
        ) ||
        (change.status === "conflict" &&
          change.recreated_dashboard_id !== undefined &&
          change.recreation_complete !== true),
      limitations: [
        "Deleting a dashboard cascades all columns and widgets; undo recreates them under a new dashboard ID and skips widgets whose referenced devices no longer exist.",
      ],
    };
  }

  if (change.kind === DASHBOARD_COLUMN_CREATE) {
    return {
      ...common,
      dashboard_ref: change.target_ref,
      diff: {
        column: { from: null, to: { name: change.requested_name } },
      },
      ...(change.created_column_ref
        ? { created_column_ref: change.created_column_ref }
        : {}),
      ...(change.candidate_columns
        ? { candidate_columns: structuredClone(change.candidate_columns) }
        : {}),
      creation_owned: change.creation_owned === true,
      ...tail,
      restore_supported: change.creation_owned === true,
      limitations: [
        "Restore deletes the created column only while its name is unchanged and it has 0 widgets.",
      ],
    };
  }

  if (change.kind === DASHBOARD_COLUMN_UPDATE) {
    return {
      ...common,
      dashboard_ref: `${change.home_ref}/dashboard/${change.dashboard_id}`,
      diff: {
        name: {
          from: change.baseline_snapshot.name,
          to: change.requested_name,
        },
      },
      ...(options.observedName !== undefined
        ? { observed_name: options.observedName }
        : change.observed_name !== undefined
          ? { observed_name: change.observed_name }
          : {}),
      ...tail,
      restore_supported: true,
      limitations: [
        "SprutHub exposes no native compare-and-set; restore checks live column name before writing.",
      ],
    };
  }

  if (change.kind === DASHBOARD_COLUMN_DELETE) {
    return {
      ...common,
      dashboard_ref: `${change.home_ref}/dashboard/${change.dashboard_id}`,
      column: {
        ref: change.target_ref,
        name: change.baseline_snapshot.name,
        widget_count: change.widget_count,
      },
      ...(change.recreated_column_ref
        ? {
            recreated_column_ref: change.recreated_column_ref,
            recreation_complete: change.recreation_complete === true,
            recreated_widgets: structuredClone(change.recreated_widgets ?? []),
            skipped_widgets: structuredClone(change.skipped_widgets ?? []),
          }
        : {}),
      ...(change.candidate_columns
        ? { candidate_columns: structuredClone(change.candidate_columns) }
        : {}),
      ...tail,
      restore_supported:
        ["prepared", "applying", "uncertain", "applied"].includes(
          change.status,
        ) ||
        (change.status === "conflict" &&
          change.recreated_column_id !== undefined &&
          change.recreation_complete !== true),
      limitations: [
        "Deleting a column cascades all widgets inside it; undo recreates the column and widgets while the dashboard still exists.",
      ],
    };
  }

  if (change.kind === DASHBOARD_WIDGET_CREATE) {
    return {
      ...common,
      dashboard_ref: `${change.home_ref}/dashboard/${change.dashboard_id}`,
      column_ref: change.target_ref,
      diff: {
        widget: {
          from: null,
          to: widgetDiffView(change.home_ref, change.requested_widget),
        },
      },
      ...(change.created_widget_ref
        ? { created_widget_ref: change.created_widget_ref }
        : {}),
      ...(change.candidate_widgets
        ? { candidate_widgets: structuredClone(change.candidate_widgets) }
        : {}),
      creation_owned: change.creation_owned === true,
      ...tail,
      restore_supported: change.creation_owned === true,
      limitations: [
        "Restore deletes the created widget only while its live payload still matches the applied snapshot.",
      ],
    };
  }

  if (change.kind === DASHBOARD_WIDGET_UPDATE) {
    return {
      ...common,
      dashboard_ref: `${change.home_ref}/dashboard/${change.dashboard_id}`,
      column_ref: `${change.home_ref}/dashboard/${change.dashboard_id}/column/${change.column_id}`,
      diff: {
        widget: {
          from: widgetDiffView(change.home_ref, change.baseline_snapshot),
          to: widgetDiffView(change.home_ref, change.requested_widget),
        },
      },
      ...tail,
      restore_supported: true,
      limitations: [
        "Restore writes the previous widget payload back only while live state still matches the applied snapshot and referenced devices still exist.",
      ],
    };
  }

  if (change.kind === DASHBOARD_WIDGET_MOVE) {
    return {
      ...common,
      dashboard_ref: `${change.home_ref}/dashboard/${change.dashboard_id}`,
      source_column_ref: change.source_column_ref,
      column_ref: change.column_ref,
      diff: {
        from: {
          column_ref: change.source_column_ref,
          column_name: redactSensitiveText(change.source_column_name ?? ""),
          position: change.source_position,
        },
        to: {
          column_ref: change.column_ref,
          column_name: redactSensitiveText(change.dest_column_name ?? ""),
          position: change.target_position,
        },
      },
      ...tail,
      restore_supported: true,
      limitations: [
        "Reorders all widgets in every affected column contiguously (0..N-1) in one dashboardWidget.orders RPC.",
        "Restore puts back the original column membership and orders only while affected columns still match the applied layout.",
      ],
    };
  }

  // DASHBOARD_WIDGET_DELETE
  return {
    ...common,
    dashboard_ref: `${change.home_ref}/dashboard/${change.dashboard_id}`,
    column_ref: `${change.home_ref}/dashboard/${change.dashboard_id}/column/${change.column_id}`,
    widget: widgetDiffView(change.home_ref, change.baseline_snapshot),
    ...(change.recreated_widget_ref
      ? { recreated_widget_ref: change.recreated_widget_ref }
      : {}),
    ...(change.candidate_widgets
      ? { candidate_widgets: structuredClone(change.candidate_widgets) }
      : {}),
    ...tail,
    restore_supported: [
      "prepared",
      "applying",
      "uncertain",
      "applied",
    ].includes(change.status),
    limitations: [
      "Undo recreates the widget in the same column under a new widget ID if dashboard, column and referenced devices still exist.",
    ],
  };
}

export function dashboardChangeName(change) {
  switch (change.kind) {
    case DASHBOARD_CREATE:
      return (
        change.applied_snapshot?.name ??
        change.applied_dashboard_name ??
        change.requested_name
      );
    case DASHBOARD_UPDATE:
      return change.baseline_snapshot?.name;
    case DASHBOARD_DELETE:
      return change.baseline_snapshot?.name;
    case DASHBOARD_COLUMN_CREATE:
      return (
        change.applied_snapshot?.name ||
        change.requested_name ||
        change.dashboard_name
      );
    case DASHBOARD_COLUMN_UPDATE:
      return change.baseline_snapshot?.name || change.requested_name;
    case DASHBOARD_COLUMN_DELETE:
      return change.baseline_snapshot?.name;
    case DASHBOARD_WIDGET_CREATE:
      return (
        change.applied_snapshot?.name ||
        change.requested_widget?.name ||
        change.requested_widget?.type
      );
    case DASHBOARD_WIDGET_UPDATE:
      return (
        change.applied_snapshot?.name ||
        change.requested_widget?.name ||
        change.baseline_snapshot?.name ||
        change.baseline_snapshot?.type
      );
    case DASHBOARD_WIDGET_DELETE:
      return change.baseline_snapshot?.name || change.baseline_snapshot?.type;
    case DASHBOARD_WIDGET_MOVE:
      return (
        (change.widget_name
          ? redactSensitiveText(change.widget_name)
          : undefined) || change.widget_type
      );
    default:
      return undefined;
  }
}

export function dashboardSummaryValue(change) {
  if (
    (change.kind === DASHBOARD_UPDATE ||
      change.kind === DASHBOARD_COLUMN_UPDATE) &&
    change.baseline_snapshot &&
    typeof change.requested_name === "string"
  ) {
    return {
      from: change.baseline_snapshot.name,
      to: change.applied_snapshot?.name ?? change.requested_name,
    };
  }
  if (change.kind === DASHBOARD_WIDGET_MOVE) {
    const fromCol = redactSensitiveText(
      change.source_column_name || `#${change.source_column_id}`,
    );
    const toCol = redactSensitiveText(
      change.dest_column_name || `#${change.column_id}`,
    );
    return {
      from: `${fromCol}[${change.source_position}]`,
      to: `${toCol}[${change.target_position}]`,
    };
  }
  return undefined;
}

export function dashboardRestoreSupported(
  change,
  { activeStatus, isConflict },
) {
  if (change.native_write_sent !== true) return false;
  if (
    change.kind === DASHBOARD_CREATE ||
    change.kind === DASHBOARD_COLUMN_CREATE ||
    change.kind === DASHBOARD_WIDGET_CREATE
  ) {
    return change.creation_owned === true;
  }
  if (
    change.kind === DASHBOARD_UPDATE ||
    change.kind === DASHBOARD_COLUMN_UPDATE ||
    change.kind === DASHBOARD_WIDGET_UPDATE ||
    change.kind === DASHBOARD_WIDGET_MOVE
  ) {
    return isConflict
      ? (change.applied_snapshot !== undefined ||
          change.applied_columns !== undefined) &&
          change.conflict_reason === "later_owned_change"
      : activeStatus;
  }
  if (
    change.kind === DASHBOARD_DELETE ||
    change.kind === DASHBOARD_COLUMN_DELETE
  ) {
    if (isConflict) {
      return (
        change.conflict_reason === "partial_recreation_refused" &&
        change.recreation_complete !== true
      );
    }
    return activeStatus;
  }
  return activeStatus;
}

export function dashboardAffectedRefs(change, homeRef, canonicalAncestors) {
  const refs = [change.target_ref, ...canonicalAncestors(change.target_ref)];
  if (change.dashboard_id !== undefined) {
    refs.push(`${homeRef}/dashboard/${change.dashboard_id}`);
  }
  if (change.dashboard_id !== undefined && change.column_id !== undefined) {
    refs.push(
      `${homeRef}/dashboard/${change.dashboard_id}/column/${change.column_id}`,
    );
  }
  if (
    change.dashboard_id !== undefined &&
    change.source_column_id !== undefined
  ) {
    refs.push(
      `${homeRef}/dashboard/${change.dashboard_id}/column/${change.source_column_id}`,
    );
  }
  for (const ref of [
    change.source_column_ref,
    change.column_ref,
    change.created_dashboard_ref,
    change.recreated_dashboard_ref,
    change.created_column_ref,
    change.recreated_column_ref,
    change.created_widget_ref,
    change.recreated_widget_ref,
  ]) {
    if (typeof ref === "string") {
      refs.push(ref, ...canonicalAncestors(ref));
    }
  }
  for (const list of [
    change.created_columns,
    change.recreated_columns,
    change.recreated_widgets,
    change.candidate_dashboards,
    change.candidate_columns,
    change.candidate_widgets,
  ]) {
    for (const item of list ?? []) {
      if (typeof item?.ref === "string") {
        refs.push(item.ref, ...canonicalAncestors(item.ref));
      }
    }
  }
  if (change.kind === DASHBOARD_DELETE && change.baseline_snapshot) {
    const dashId = change.baseline_snapshot.id;
    for (const column of change.baseline_snapshot.columns ?? []) {
      refs.push(`${homeRef}/dashboard/${dashId}/column/${column.id}`);
      for (const widget of column.widgets ?? []) {
        refs.push(`${homeRef}/dashboard/${dashId}/widget/${widget.id}`);
      }
    }
  } else if (
    change.kind === DASHBOARD_COLUMN_DELETE &&
    change.baseline_snapshot
  ) {
    for (const widget of change.baseline_snapshot.widgets ?? []) {
      refs.push(
        `${homeRef}/dashboard/${change.dashboard_id}/widget/${widget.id}`,
      );
    }
  }
  // Include referenced device/service/characteristic items for widget ops.
  const serial = decodeURIComponent(homeRef.slice("spruthub://hub/".length));
  for (const widget of [change.baseline_snapshot, change.requested_widget]) {
    if (!widget?.payload?.items) continue;
    if (widget.type === "characteristic" || widget.type === "chart") {
      for (const { aId, sId, cId } of widget.payload.items) {
        const ref = characteristicRef(serial, aId, sId, cId);
        refs.push(ref, ...canonicalAncestors(ref));
      }
    } else if (widget.type === "service" || widget.type === "camera") {
      for (const { aId, sId } of widget.payload.items) {
        const ref = serviceRef(serial, aId, sId);
        refs.push(ref, ...canonicalAncestors(ref));
      }
    }
  }
  return refs;
}
