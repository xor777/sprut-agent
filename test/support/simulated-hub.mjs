// Stateful in-process SprutHub simulator for offline integration tests and
// agent evaluations. It speaks the JSON-RPC-over-WebSocket form the client
// sends (`params.<domain>.<method>` -> `result.<domain>.<method>`), keeps one
// home in memory and records every request. Response shapes follow the
// client parsers, the captures under research/protocol/ and the fake hubs of
// the integration tests. Where the live hub was not observed, the simulator
// stays conservative instead of being more convenient than the real hub; such
// places carry a short note. It is not evidence about a live SprutHub.
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { WebSocketServer } from "ws";

export const SIMULATED_HUB_TOKEN = "simulated-hub-token";
export const SIMULATED_HUB_CID = "simulated-hub-client";

const fixturesDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "homes",
);

// Methods that only read. Everything else, including a method the simulator
// does not implement, is recorded as a write: an unknown native method may
// change a live home, so a grader must not take it for a read.
export const READ_METHODS = new Set([
  "hub.list",
  "server.ping",
  "room.list",
  "room.get",
  "accessory.list",
  "accessory.get",
  "service.types",
  "characteristic.get",
  "characteristic.getOptions",
  "link.list",
  "logic.types",
  "logic.list",
  "logic.get",
  "logic.getOptions",
  "scenario.list",
  "scenario.get",
  "scenario.sdk",
  "scenario.subscribe",
  "scenario.unsubscribe",
  "log.list",
  "log.subscribe",
  "log.unsubscribe",
  "window.get",
  "extension.list",
  "extension.get",
  "extensionChild.list",
  "extensionChild.get",
]);

export function isWriteMethod(method) {
  return !READ_METHODS.has(method);
}

// How much of each simulated method rests on evidence about a live hub:
// observed (live traffic or a live experiment under research/protocol/ or a
// dated commit), schema_only (declared in the public protobuf or sent by the
// official UI code, never seen answered live) or guess (the simulator's own
// assumption). A run reports the methods it touched with these levels, so a
// pass that depends on schema_only or guessed behavior is visible.
const OBSERVED = "observed";
const SCHEMA_ONLY = "schema_only";
export const METHOD_EVIDENCE = {
  "hub.list": [OBSERVED, "2026-09-09-home-entities"],
  "server.ping": [SCHEMA_ONLY],
  "room.list": [OBSERVED, "2026-09-09-room-reading"],
  "room.get": [OBSERVED, "2026-09-09-room-reading"],
  "room.create": [
    OBSERVED,
    "2026-09-24-live-conformance-2: applied; 2026-09-24-live-conformance-3: the first 32 characters kept, Cyrillic and Latin alike, emoji dropped, the answer carrying the kept name",
  ],
  "room.delete": [
    OBSERVED,
    "2026-09-24-live-conformance-2: an empty created room deleted, its absence read back",
  ],
  "room.update": [
    OBSERVED,
    "{id, name}: a rename and its restore read back (2026-09-24-live-conformance-3, step 1b); {id, visible} is sent by the web client (2026-09-24-web-client-evidence) and was not sent live",
  ],
  "accessory.list": [
    OBSERVED,
    "2026-09-09-motion-reading; an empty room omits accessories (owner hub, 2026-09-24); no virtual field (2026-09-24-live-conformance-2)",
  ],
  "accessory.get": [
    OBSERVED,
    "2026-09-11-device-placement; service visible seen in an owner-hub read on 2026-09-24; virtual=true on a created virtual accessory (2026-09-24-live-conformance-2); virtual=false, present, on a physical accessory (2026-09-24-live-conformance-3-read-only)",
  ],
  "accessory.create": [OBSERVED, "2026-09-11-virtual-light-group"],
  "accessory.update": [OBSERVED, "2026-09-11-device-placement"],
  "accessory.delete": [OBSERVED, "2026-09-11-virtual-light-group"],
  "service.types": [OBSERVED, "2026-09-09-type-catalog"],
  "service.update": [
    SCHEMA_ONLY,
    "ServiceUpdateRequest in 18003-Service.proto; the web client sends {aId, sId, name} and {aId, sId, visible} (2026-09-24-web-client-evidence); not seen answered live",
  ],
  "characteristic.get": [OBSERVED, "2026-09-09-automations"],
  "characteristic.getOptions": [OBSERVED, "2026-09-09-automations"],
  "characteristic.setOptions": [SCHEMA_ONLY],
  "characteristic.update": [OBSERVED, "2026-09-11-virtual-light-group"],
  "characteristic.update {notify}": [
    OBSERVED,
    "2026-10-12-notifications-live: true and false on a virtual lamp's On, read back in accessory.get only",
  ],
  "link.list": [OBSERVED, "2026-09-11-virtual-light-group"],
  "link.addVirtual": [
    OBSERVED,
    "2026-09-11-virtual-light-group; repeat, re-add after an empty OUT and the value a join copies: 2026-10-14-light-group-relink",
  ],
  "link.remove": [
    OBSERVED,
    "2026-09-11-virtual-light-group; the empty OUT left and a repeated remove: 2026-10-14-light-group-relink",
  ],
  "logic.types": [OBSERVED, "2026-09-10-native-logic"],
  "logic.list": [
    OBSERVED,
    "2026-09-10-native-logic; an assignment made while its LOGIC is on is still listed once the LOGIC is off (2026-09-24-live-conformance-3, step 4n)",
  ],
  "logic.get": [
    OBSERVED,
    "2026-09-10-native-logic; answers for an assignment made while its LOGIC is on once the LOGIC is off (2026-09-24-live-conformance-3, step 4n)",
  ],
  "logic.getOptions": [OBSERVED, "2026-09-10-native-logic"],
  "logic.create": [
    OBSERVED,
    "2026-09-10-native-logic; the type of a turned-off user LOGIC is refused with Not found (2026-09-24-live-conformance-3)",
  ],
  "logic.update": [OBSERVED, "2026-09-10-native-logic"],
  "logic.setOptions": [OBSERVED, "2026-09-10-native-logic"],
  "logic.delete": [OBSERVED, "2026-09-10-native-logic"],
  "scenario.list": [
    OBSERVED,
    "2026-09-09-automations; optionsWindow on every BLOCK, LOGIC, predefined LOGIC and GLOBAL (2026-09-24-live-conformance-3-read-only)",
  ],
  "scenario.get": [
    OBSERVED,
    "2026-09-09-automations; active seen in an owner-hub read on 2026-09-24",
  ],
  "scenario.create": [
    OBSERVED,
    "2026-09-13-native-daily-interval; blockId on every node and numeric inc/dec values (owner hub, 2026-09-24); a LOGIC takes name, desc and onStart from info in its code, sync as sent; a GLOBAL accepted (2026-10-13-wave4-contracts 1.6, 1.9)",
  ],
  "scenario.update": [
    OBSERVED,
    "{index, data}: 2026-09-13-native-daily-interval; a LOGIC takes name, desc and onStart from info in its code on every code write, sync untouched; a GLOBAL's and a BLOCK's flags and name kept (2026-10-13-wave4-contracts 1.5, 1.8, 1.10)",
  ],
  // The product no longer sends it; a run that does shows up here.
  "scenario.update {active}": [
    OBSERVED,
    "acknowledged and ignored for a BLOCK and a LOGIC (2026-09-24-live-conformance-2, steps 3a, 3e, 4)",
  ],
  // The product does not send them; a run that does shows up here.
  "scenario.update {name, desc, onStart, sync}": [
    OBSERVED,
    "acknowledged and ignored for a BLOCK, a LOGIC and a GLOBAL; only data applies (2026-10-13-wave4-contracts 1.3)",
  ],
  "scenario.delete": [OBSERVED, "2026-09-13-native-daily-interval"],
  "scenario.run": [
    OBSERVED,
    "live scenario_run (b95e8a3); a turned-off BLOCK acknowledged and not run, a turned-on one run (2026-09-24-live-conformance-3); the simulator runs only top-level literal set actions",
  ],
  "scenario.sdk": [OBSERVED, "2026-09-09-automations"],
  "scenario.subscribe": [OBSERVED, "2026-09-11-native-event-boundary"],
  "scenario.unsubscribe": [SCHEMA_ONLY],
  "log.list": [
    OBSERVED,
    "owner-hub read on 2026-09-24: newest by count, lastTime pages forward, 128-entry ring buffer; reply order is assumed",
  ],
  "log.subscribe": [OBSERVED, "2026-09-11-native-event-boundary"],
  "log.unsubscribe": [SCHEMA_ONLY],
  "window.get": [
    OBSERVED,
    "2026-09-10-window-setting; scenario options windows with main, primary, footer, Name, Active, OnStart, Sync, Desc and Remove for every type (2026-09-24-live-conformance-3-read-only); a BLOCK's and a GLOBAL's show the scenario's fields, a user LOGIC's Name, Desc and OnStart the last values written to the window or sent at create, a built-in LOGIC's placeholders (2026-10-13-wave4-contracts 1.2, 1.7, 1.8, 1.11); a bridge child's window with a CHECKBOX s:<sId> per exportable service (2026-10-13-wave4-contracts 3.3), none for the service types a bridge type leaves out, and Window not found for an accessory the bridge does not list (2026-10-14-bridge-export-write 3, 11, 12)",
  ],
  "window.update": [
    OBSERVED,
    "2026-09-10-window-setting; Name and Desc of a BLOCK options window (2026-09-24-live-conformance-2)",
  ],
  // The product switches a scenario only with this write.
  "window.update {Active}": [
    OBSERVED,
    "a BLOCK and a LOGIC switched on and off, scenario.get and the window agreeing on the first read (2026-09-24-live-conformance-3); a GLOBAL's and a predefined scenario's window read only, same keys (2026-09-24-live-conformance-3-read-only)",
  ],
  "window.update {Name, Desc, OnStart, Sync}": [
    OBSERVED,
    "applied to scenario.get and scenario.list at once for a user BLOCK, LOGIC and GLOBAL (2026-10-13-wave4-contracts 1.4, 1.8, 1.10)",
  ],
  // A bridge child's s:<sId> checkboxes, one or several in one update.
  "window.update {bridge export}": [
    OBSERVED,
    "a temporary virtual accessory's services ticked and unticked in all four bridges, running or not: read back at once, the child in main while one is ticked (2026-10-14-bridge-export-write 4-8)",
  ],
  // No entry, so a run reports them as unsupported: window.update {Remove}
  // of a scenario window, and its Name, Desc, OnStart or Sync of a built-in
  // scenario. None of these writes was sent to a live hub, and the
  // simulator refuses them.
  "extension.list": [
    OBSERVED,
    "2026-09-16-extension-child-read; spaces with their actions, state and endTimestamp of a running search (2026-10-12-device-pairing, P1)",
  ],
  "extension.get": [OBSERVED, "2026-09-16-extension-child-read"],
  // The start, restart and stop of ZigBee's main ACTION_DISCOVERY with no
  // device in pairing mode. The end by its timer and the action of another
  // space are the simulator's guess.
  "extension.action": [
    OBSERVED,
    "2026-10-12-device-pairing, check 1 (P1-P5): empty answer, state and endTimestamp on DiscoveryTime, a repeat restarts the timer, state false clears it, an extension EVENT_UPDATE pushed to every connection; the end by timer not observed",
  ],
  // A start while a fixture's device is in pairing mode: the device joins
  // as the web client's code suggests (child EVENT_ADD with status and
  // progressBar, then an accessory with extensionKey, deviceId and
  // deviceWindow linked from the child window's AccessoriesList). No
  // pairing was observed on a hub; the room and name of the new accessory
  // are the fixture's assumption.
  "extension.action {pairing}": [
    SCHEMA_ONLY,
    "2026-10-12-device-pairing K7-K9, H6, H9: inferred from the web client's code and reads of devices already paired",
  ],
  "extensionChild.list": [
    OBSERVED,
    "2026-09-17-extension-child-empty-list; a bridge's children, one per exportable accessory with its id, main or notConnected, also of a bridge that does not run (2026-10-13-wave4-contracts 3.2)",
  ],
  "extensionChild.get": [OBSERVED, "2026-09-16-extension-child-read"],
};

// BLOCK forms taken from the official web client's code
// (2026-09-24-web-client-action-map D16, D17, D10, D15, D13, D6), each with
// what a hub has been seen storing. A create or update that carries one is
// keyed by the first of them, so a run names the evidence its pass rests
// on. Storage is observed for all of them; their run on a hub is not.
const LIVE_4 = "2026-09-25-live-conformance-4";
const EDITOR_BLOCK_FORMS = [
  [
    "notify",
    `${LIVE_4}: MESSAGE and PUSH stored, to null and clients null dropped; sending not observed`,
    (node) => node.type === "notify",
  ],
  [
    "http",
    `${LIVE_4}: a GET request stored as sent; sending not observed`,
    (node) => node.type === "http",
  ],
  [
    "from",
    `${LIVE_4}: stored with value "" dropped; the copy not observed`,
    (node) => node.type === "from",
  ],
  [
    "scenario mode",
    `${LIVE_4}: ACTIVATE, DEACTIVATE, ACTIVATE_AND_FIRE and RESET stored as sent; not run`,
    (node) => node.type === "scenario" && node.mode !== "FIRE",
  ],
  [
    "branch repeat",
    `${LIVE_4}: then_delay and else_delay 60000 stored as sent; repeat not observed`,
    (node) =>
      node.type === "if" && (node.then_delay > 0 || node.else_delay > 0),
  ],
  [
    "every N cron",
    `${LIVE_4}: 0 0/15 * ? * * * stored as sent; firing not observed`,
    (node) =>
      node.type === "cron" &&
      typeof node.cron === "string" &&
      node.cron.split(" ").some((field) => /^0\/\d+$/.test(field)),
  ],
];
for (const method of ["scenario.create", "scenario.update"]) {
  for (const [form, source] of EDITOR_BLOCK_FORMS) {
    METHOD_EVIDENCE[`${method} {${form}}`] = [OBSERVED, source];
  }
}

// The first form of EDITOR_BLOCK_FORMS in a BLOCK write, or null.
function editorBlockForm(input) {
  if (!isRecord(input) || typeof input.data !== "string") return null;
  let data;
  try {
    data = JSON.parse(input.data);
  } catch {
    return null;
  }
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isRecord(value)) {
      nodes.push(value);
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(data);
  return (
    EDITOR_BLOCK_FORMS.find(([, , matches]) => nodes.some(matches))?.[0] ?? null
  );
}

// The METHOD_EVIDENCE entry of a request, taken when it arrives: a method
// whose parts rest on different evidence has a key per part. A write to a
// scenario's options window that the simulator refuses as unmodelled is
// keyed by that option, with no entry, so a run reports it as unsupported.
function evidenceKey(state, method, params) {
  if (
    method === "extension.action" &&
    params?.extension?.action?.state === true &&
    pairingDevicesFor(state, params.extension.action).length > 0
  ) {
    return "extension.action {pairing}";
  }
  if (
    method === "characteristic.update" &&
    isRecord(params?.characteristic?.update) &&
    Object.hasOwn(params.characteristic.update, "notify")
  ) {
    return "characteristic.update {notify}";
  }
  if (method === "scenario.update") {
    const input = params?.scenario?.update;
    if (isRecord(input) && Object.hasOwn(input, "active")) {
      return "scenario.update {active}";
    }
    if (
      isRecord(input) &&
      SCENARIO_METADATA_FIELDS.some((field) => Object.hasOwn(input, field))
    ) {
      return "scenario.update {name, desc, onStart, sync}";
    }
  }
  if (method === "scenario.create" || method === "scenario.update") {
    const form = editorBlockForm(params?.scenario?.[method.split(".")[1]]);
    if (form !== null) return `${method} {${form}}`;
  }
  if (method === "window.update") {
    const input = params?.window?.update;
    if (bridgeChildOfWindow(state, input?.windowKey)) {
      return "window.update {bridge export}";
    }
    const scenario = scenarioOfWindow(state, input?.windowKey);
    if (scenario && Array.isArray(input.options)) {
      const keys = input.options.map((option) => option?.key);
      const unmodelled = keys.find((key) =>
        unmodelledScenarioWrite(scenario, key),
      );
      if (unmodelled !== undefined) return `window.update {${unmodelled}}`;
      if (keys.some((key) => SCENARIO_METADATA_OPTIONS.has(key))) {
        return "window.update {Name, Desc, OnStart, Sync}";
      }
      if (keys.includes("Active")) return "window.update {Active}";
    }
  }
  return method ?? "(invalid request)";
}

// Per method: evidence level, request, write and error counts of one run.
function touchedMethods(requests) {
  const counts = new Map();
  for (const { evidence: key, write, error } of requests) {
    const entry = counts.get(key) ?? { requests: 0, writes: 0, errors: 0 };
    entry.requests += 1;
    if (write) entry.writes += 1;
    if (error) entry.errors += 1;
    counts.set(key, entry);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([method, entry]) => {
      const [level, source] = METHOD_EVIDENCE[method] ?? ["unsupported"];
      return { method, level, ...(source ? { source } : {}), ...entry };
    });
}

const VALUE_FIELDS = [
  "boolValue",
  "intValue",
  "longValue",
  "doubleValue",
  "stringValue",
];
const FORMAT_FIELD = {
  bool: "boolValue",
  int: "intValue",
  double: "doubleValue",
  string: "stringValue",
};

function enumValues(entries) {
  return entries.map(([key, value, name]) => ({
    checked: true,
    key,
    name,
    value: { intValue: value },
  }));
}

// Native characteristic metadata by control type. Names, units and ranges
// follow service.types/characteristic.types and room/motion captures from
// 2026-09-09; types that were not captured use HomeKit ranges.
const CHARACTERISTIC_TYPES = {
  Identify: {
    name: "Идентифицировать",
    format: "bool",
    read: false,
    write: true,
    events: false,
  },
  Manufacturer: { name: "Производитель", format: "string", events: false },
  Model: { name: "Модель", format: "string", events: false },
  Name: { name: "Имя", format: "string", events: false },
  SerialNumber: { name: "Серийный номер", format: "string", events: false },
  FirmwareRevision: {
    name: "Версия прошивки",
    format: "string",
    events: false,
  },
  // A physical device's online state in its information service (Aqara
  // motion sensor, 2026-09-09-motion-reading): read-only, with events.
  C_Online: { name: "В сети", format: "bool" },
  On: { name: "Включено", format: "bool", write: true },
  Brightness: {
    name: "Яркость",
    format: "int",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
    write: true,
  },
  Hue: {
    name: "Оттенок",
    format: "double",
    unit: "arcdegrees",
    minValue: 0,
    maxValue: 360,
    minStep: 1,
    write: true,
  },
  Saturation: {
    name: "Насыщенность",
    format: "double",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
    write: true,
  },
  ColorTemperature: {
    name: "Цветовая температура",
    format: "int",
    minValue: 140,
    maxValue: 500,
    minStep: 1,
    write: true,
  },
  // A color lamp's mode on the owner's hub (get_entity, 2026-09-24):
  // read-only, 0..2.
  C_ColorMode: {
    name: "Режим",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    validValues: enumValues([
      ["UNKNOWN", 0, "Неизвестно"],
      ["HUE", 1, "Цвет"],
      ["TEMPERATURE", 2, "Температура"],
    ]),
  },
  OutletInUse: { name: "Используется", format: "bool" },
  MotionDetected: { name: "Обнаружено движение", format: "bool" },
  CurrentAmbientLightLevel: {
    name: "Освещенность",
    format: "double",
    unit: "lux",
    minValue: 0,
    maxValue: 100000,
  },
  ContactSensorState: {
    name: "Состояние контакта",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    validValues: enumValues([
      ["CONTACT_DETECTED", 0, "Закрыто"],
      ["CONTACT_NOT_DETECTED", 1, "Открыто"],
    ]),
  },
  LeakDetected: {
    name: "Обнаружена протечка",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    validValues: enumValues([
      ["LEAK_NOT_DETECTED", 0, "Нет"],
      ["LEAK_DETECTED", 1, "Да"],
    ]),
  },
  CurrentTemperature: {
    name: "Текущая температура",
    format: "double",
    unit: "°C",
    minValue: -100,
    maxValue: 100,
    minStep: 0.1,
  },
  CurrentRelativeHumidity: {
    name: "Текущая влажность",
    format: "double",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
  },
  CarbonDioxideDetected: {
    name: "Обнаружен CO2",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    validValues: enumValues([
      ["CO2_LEVELS_NORMAL", 0, "Нормальный"],
      ["CO2_LEVELS_ABNORMAL", 1, "Повышенный"],
    ]),
  },
  CarbonDioxideLevel: {
    name: "Уровень CO2",
    format: "double",
    unit: "ppm",
    minValue: 0,
    maxValue: 100000,
  },
  BatteryLevel: {
    name: "Уровень заряда",
    format: "int",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
  },
  StatusLowBattery: {
    name: "Батарея разряжена",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    validValues: enumValues([
      ["BATTERY_LEVEL_NORMAL", 0, "Нет"],
      ["BATTERY_LEVEL_LOW", 1, "Да"],
    ]),
  },
  ChargingState: {
    name: "Идет зарядка",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    validValues: enumValues([
      ["NOT_CHARGING", 0, "Нет"],
      ["CHARGING", 1, "Да"],
      ["NOT_CHARGEABLE", 2, "Не заряжаемый"],
    ]),
  },
  CurrentPosition: {
    name: "Текущее положение",
    format: "int",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
  },
  TargetPosition: {
    name: "Целевое положение",
    format: "int",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
    write: true,
  },
  PositionState: {
    name: "Состояние движения",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    validValues: enumValues([
      ["DECREASING", 0, "Закрывается"],
      ["INCREASING", 1, "Открывается"],
      ["STOPPED", 2, "Остановлено"],
    ]),
  },
  CurrentHeatingCoolingState: {
    name: "Текущий режим",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    validValues: enumValues([
      ["OFF", 0, "Выключено"],
      ["HEAT", 1, "Нагрев"],
      ["COOL", 2, "Охлаждение"],
    ]),
  },
  TargetHeatingCoolingState: {
    name: "Целевой режим",
    format: "int",
    minValue: 0,
    maxValue: 3,
    minStep: 1,
    write: true,
    validValues: enumValues([
      ["OFF", 0, "Выключено"],
      ["HEAT", 1, "Нагрев"],
      ["COOL", 2, "Охлаждение"],
      ["AUTO", 3, "Авто"],
    ]),
  },
  TargetTemperature: {
    name: "Целевая температура",
    format: "double",
    unit: "°C",
    minValue: 16,
    maxValue: 30,
    minStep: 0.5,
    write: true,
  },
  Active: {
    name: "Активно",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    write: true,
    validValues: enumValues([
      ["INACTIVE", 0, "Нет"],
      ["ACTIVE", 1, "Да"],
    ]),
  },
  CurrentAirPurifierState: {
    name: "Текущее состояние",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    validValues: enumValues([
      ["INACTIVE", 0, "Не активен"],
      ["IDLE", 1, "Ожидание"],
      ["PURIFYING_AIR", 2, "Очистка"],
    ]),
  },
  TargetAirPurifierState: {
    name: "Режим",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    write: true,
    validValues: enumValues([
      ["MANUAL", 0, "Ручной"],
      ["AUTO", 1, "Авто"],
    ]),
  },
  C_FanSpeed: {
    name: "Скорость",
    format: "int",
    minValue: 0,
    maxValue: 6,
    minStep: 1,
    write: true,
  },
  // The types below appear in the owner's home (2026-09-24 type counts) but
  // their metadata was not captured: HomeKit ranges, and C_WattMeter
  // characteristic names are the simulator's guess.
  ProgrammableSwitchEvent: {
    name: "Событие кнопки",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
    validValues: enumValues([
      ["SINGLE_PRESS", 0, "Одиночное нажатие"],
      ["DOUBLE_PRESS", 1, "Двойное нажатие"],
      ["LONG_PRESS", 2, "Долгое нажатие"],
    ]),
  },
  ServiceLabelIndex: {
    name: "Номер кнопки",
    format: "int",
    minValue: 1,
    maxValue: 255,
    minStep: 1,
    events: false,
  },
  SlatType: {
    name: "Тип ламелей",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    events: false,
  },
  CurrentSlatState: {
    name: "Состояние ламелей",
    format: "int",
    minValue: 0,
    maxValue: 2,
    minStep: 1,
  },
  CurrentTiltAngle: {
    name: "Текущий угол",
    format: "int",
    unit: "arcdegrees",
    minValue: -90,
    maxValue: 90,
    minStep: 1,
  },
  TargetTiltAngle: {
    name: "Целевой угол",
    format: "int",
    unit: "arcdegrees",
    minValue: -90,
    maxValue: 90,
    minStep: 1,
    write: true,
  },
  FilterChangeIndication: {
    name: "Требуется замена фильтра",
    format: "int",
    minValue: 0,
    maxValue: 1,
    minStep: 1,
    validValues: enumValues([
      ["FILTER_OK", 0, "Нет"],
      ["CHANGE_FILTER", 1, "Да"],
    ]),
  },
  FilterLifeLevel: {
    name: "Ресурс фильтра",
    format: "double",
    unit: "%",
    minValue: 0,
    maxValue: 100,
    minStep: 1,
  },
  AirQuality: {
    name: "Качество воздуха",
    format: "int",
    minValue: 0,
    maxValue: 5,
    minStep: 1,
    validValues: enumValues([
      ["UNKNOWN", 0, "Неизвестно"],
      ["EXCELLENT", 1, "Отличное"],
      ["GOOD", 2, "Хорошее"],
      ["FAIR", 3, "Среднее"],
      ["INFERIOR", 4, "Плохое"],
      ["POOR", 5, "Очень плохое"],
    ]),
  },
  PM2_5Density: {
    name: "Плотность PM2.5",
    format: "double",
    unit: "µg/m³",
    minValue: 0,
    maxValue: 1000,
    minStep: 1,
  },
  C_Watt: {
    name: "Мощность",
    format: "double",
    unit: "W",
    minValue: 0,
    maxValue: 100000,
  },
  C_Volt: {
    name: "Напряжение",
    format: "double",
    unit: "V",
    minValue: 0,
    maxValue: 1000,
  },
  C_KiloWattHour: {
    name: "Энергия",
    format: "double",
    unit: "kWh",
    minValue: 0,
    maxValue: 10000000,
  },
  SecuritySystemCurrentState: {
    name: "Текущее состояние охраны",
    format: "int",
    minValue: 0,
    maxValue: 4,
    minStep: 1,
    validValues: enumValues([
      ["STAY_ARM", 0, "Дома"],
      ["AWAY_ARM", 1, "Не дома"],
      ["NIGHT_ARM", 2, "Ночь"],
      ["DISARMED", 3, "Снята"],
      ["ALARM_TRIGGERED", 4, "Тревога"],
    ]),
  },
  SecuritySystemTargetState: {
    name: "Целевое состояние охраны",
    format: "int",
    minValue: 0,
    maxValue: 3,
    minStep: 1,
    write: true,
    validValues: enumValues([
      ["STAY_ARM", 0, "Дома"],
      ["AWAY_ARM", 1, "Не дома"],
      ["NIGHT_ARM", 2, "Ночь"],
      ["DISARM", 3, "Снять"],
    ]),
  },
};

const SERVICE_TYPES = [
  [
    "AccessoryInformation",
    "Информация об аксессуаре",
    [
      "Identify",
      "Manufacturer",
      "Model",
      "Name",
      "SerialNumber",
      "FirmwareRevision",
    ],
    [],
  ],
  [
    "Lightbulb",
    "Лампочка",
    ["On"],
    ["Brightness", "Hue", "Saturation", "ColorTemperature", "Name"],
  ],
  ["Outlet", "Розетка", ["On", "OutletInUse"], ["Name"]],
  ["Switch", "Выключатель", ["On"], ["Name"]],
  ["Fan", "Вентилятор", ["On"], ["Name"]],
  [
    "MotionSensor",
    "Датчик движения",
    ["MotionDetected"],
    ["Name", "StatusLowBattery"],
  ],
  [
    "ContactSensor",
    "Датчик открытия",
    ["ContactSensorState"],
    ["Name", "StatusLowBattery"],
  ],
  [
    "LeakSensor",
    "Датчик протечки",
    ["LeakDetected"],
    ["Name", "StatusLowBattery"],
  ],
  [
    "TemperatureSensor",
    "Датчик температуры",
    ["CurrentTemperature"],
    ["Name", "StatusLowBattery"],
  ],
  [
    "HumiditySensor",
    "Датчик влажности",
    ["CurrentRelativeHumidity"],
    ["Name", "StatusLowBattery"],
  ],
  [
    "CarbonDioxideSensor",
    "Датчик углекислого газа",
    ["CarbonDioxideDetected"],
    ["CarbonDioxideLevel", "Name"],
  ],
  [
    "LightSensor",
    "Датчик освещенности",
    ["CurrentAmbientLightLevel"],
    ["Name"],
  ],
  [
    "BatteryService",
    "Батарея",
    ["BatteryLevel", "ChargingState", "StatusLowBattery"],
    ["Name"],
  ],
  [
    "WindowCovering",
    "Шторы",
    ["CurrentPosition", "PositionState", "TargetPosition"],
    ["Name"],
  ],
  [
    "Thermostat",
    "Термостат",
    [
      "CurrentHeatingCoolingState",
      "TargetHeatingCoolingState",
      "CurrentTemperature",
      "TargetTemperature",
    ],
    ["Name"],
  ],
  [
    "AirPurifier",
    "Очиститель воздуха",
    ["Active", "CurrentAirPurifierState", "TargetAirPurifierState"],
    ["C_FanSpeed", "Name"],
  ],
  [
    "StatelessProgrammableSwitch",
    "Кнопка",
    ["ProgrammableSwitchEvent"],
    ["ServiceLabelIndex", "Name"],
  ],
  [
    "Slat",
    "Ламели",
    ["SlatType", "CurrentSlatState"],
    ["CurrentTiltAngle", "TargetTiltAngle", "Name"],
  ],
  [
    "FilterMaintenance",
    "Обслуживание фильтра",
    ["FilterChangeIndication"],
    ["FilterLifeLevel", "Name"],
  ],
  [
    "AirQualitySensor",
    "Датчик качества воздуха",
    ["AirQuality"],
    ["PM2_5Density", "Name"],
  ],
  [
    "C_WattMeter",
    "Счётчик электроэнергии",
    ["C_Watt"],
    ["C_Volt", "C_KiloWattHour", "Name"],
  ],
  [
    "SecuritySystem",
    "Охранная система",
    ["SecuritySystemCurrentState", "SecuritySystemTargetState"],
    ["Name"],
  ],
].map(([type, name, required, optional]) => ({
  system: false,
  type,
  name,
  required: required.map((item) => ({
    type: item,
    name: CHARACTERISTIC_TYPES[item].name,
  })),
  optional: optional.map((item) => ({
    type: item,
    name: CHARACTERISTIC_TYPES[item].name,
  })),
}));

// Declarations shaped like the hub's scenario.sdk reply (the live one is
// ~38 KB); this is a reduced synthetic text, not a copy of the hub SDK.
// Hub's methods by accessory id have the live signatures (owner hub,
// 2026-09-09-automations; the same text read again on 2026-10-13).
const SCENARIO_SDK = `interface Hub {
  getAccessory(id: number): Accessory;
  getAccessories(): Accessory[];
  getCharacteristicValue(aid: number, cid: number): any;
  setCharacteristicValue(aid: number, cid: number, value: any);
  toggleCharacteristicValue(aid: number, cid: number);
  getCharacteristic(aid: number, cid: number): Characteristic;
  getRooms(): Room[];
}
interface Accessory {
  getUUID(): string;
  getName(): string;
  getRoom(): Room;
  getService(type: HS): Service;
  getServices(): Service[];
}
interface Service {
  getAccessory(): Accessory;
  getType(): HS;
  getName(): string;
  getCharacteristic(type: HC): Characteristic;
}
interface Characteristic {
  getService(): Service;
  getType(): HC;
  getValue(): any;
  setValue(value: any): void;
}
interface Room { getName(): string; }
interface Cron { schedule(expression: String, handler: Function): Task; }
interface Task { clear(): void; }
declare const Hub: Hub;
declare const Cron: Cron;
declare function setTimeout(handler: Function, timeout?: number, ...arguments: any[]): Task;
declare function log(message: any): void;
`;

class SimulatorError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function notFound(what) {
  // Live hubs answered -32603 "Not found" for a missing scenario and logic.
  return new SimulatorError(-32603, `Not found: '${what}'`);
}

function invalidParams(message) {
  return new SimulatorError(-32602, message);
}

// A fixture is a JSON home, or an .mjs module whose default export builds
// one (the large house extends the apartment programmatically).
export async function loadHomeFixture(nameOrPath) {
  if (nameOrPath.includes("/") || /\.(json|mjs)$/.test(nameOrPath)) {
    return loadFixtureFile(path.resolve(nameOrPath));
  }
  const module = path.join(fixturesDirectory, `${nameOrPath}.mjs`);
  return loadFixtureFile(
    existsSync(module)
      ? module
      : path.join(fixturesDirectory, `${nameOrPath}.json`),
  );
}

async function loadFixtureFile(file) {
  if (file.endsWith(".mjs")) {
    const { default: build } = await import(pathToFileURL(file).href);
    return build({ loadHomeFixture });
  }
  return JSON.parse(await readFile(file, "utf8"));
}

// Opt-in hub faults for a case; none is active by default. Their behavior is
// the simulator's guess at what a live hub does in these situations:
// - delayedReadback [{aId, sId, cId, ms}]: a value write is acknowledged at
//   once and its value appears ms later (hub.settle() applies it at once);
// - droppedReply [{method, aId?, sId?, cId?, times = 1, applied = true}]: a
//   matching request is applied and never answered, so the client times
//   out; with applied: false it is lost before the hub and changes nothing;
// - stuckActuators [{aId}]: the accessory reads as offline and acknowledges
//   value writes without changing anything;
// - lampLogic [{aId, sId}]: an active LightbulbControl logic is assigned to
//   the service (see applyLampLogic).
// hubTime ("12:00" or "12:00:00") starts the hub clock at that hub-local
// wall clock on the machine's hub-local date; the clock then runs at the
// machine's pace. It places the seeded log, the settings window's time and
// the log lines of later runs. Without it the hub clock is the machine's.
// Events go only to a connection that has sent a request with the home's
// serial, without a subscription: on the owner's hub a socket that only
// listed homes got none in 19 minutes, one that read room.list once got the
// whole stream (2026-10-13-voice-latency-baseline, section 5). A change the
// simulator makes pushes the events the hub pushes for it: a value write
// one characteristic EVENT_UPDATE per characteristic, the written one even
// when its value stays, after the reply (2026-10-13-lamp-logic-undo 4.2,
// 4.5); a created accessory EVENT_ADD with its services and
// characteristics; a room created, renamed or deleted room EVENT_ADD,
// EVENT_UPDATE with the room or EVENT_REMOVE with its id; an accessory
// renamed or moved EVENT_UPDATE with its id and the changed field only, a
// rename then the new value of its information service's Name; a service
// renamed service EVENT_UPDATE {aId, sId, name}, then its Name value; a
// deleted accessory EVENT_REMOVE with its id (2026-10-13-structure-events).
// On the owner's hub the event of a configuration write reached the
// writing socket before or after the reply; here always after. A service's
// visibility pushes the same form as its name, which was not observed.
// hub.emit pushes a frame as the hub would for an edit made in the
// SprutHub app.
// eventEveryMs sends such a connection, this often, a characteristic
// EVENT_UPDATE with the current value of the home's characteristics in turn
// and every third time a room EVENT_UPDATE with a room's id, name, order
// and visibility, as the owner's hub does at rest (about 14 and 6 a minute,
// voice baseline, section 5). Without it the simulator sends no events at
// rest, only those its own changes cause.
// latencyMs, a number or ({method, arrival}) => ms with arrival counting the
// requests of a connection from 1, handles each request that long after it
// arrives and answers it at once, as a hub about 90 ms away does
// (2026-10-13-voice-latency-baseline). Requests in flight together then
// overlap, and with different delays they are handled and answered in
// another order than sent, as the owner's hub handled several writes on one
// socket (2026-10-13-parallel-writes, 1.2, 2 and 3). Each request record
// gets received_ms and answered_ms on one monotonic clock.
// onRequest({method, params}) is called as each request arrives, before
// it waits or is handled: a test can see what the client had saved by the
// time the request left it.
export async function startSimulatedHub(
  fixture,
  {
    host = "127.0.0.1",
    port = 0,
    token = SIMULATED_HUB_TOKEN,
    cid = SIMULATED_HUB_CID,
    faults = {},
    hubTime,
    eventEveryMs,
    latencyMs,
    onRequest,
  } = {},
) {
  const state = buildState(withFixtureFaults(fixture, faults), hubTime);
  const initialState = structuredClone(state);
  state.faults = {
    delayedReadback: structuredClone(faults.delayedReadback ?? []),
    droppedReply: (faults.droppedReply ?? []).map((rule) => ({
      ...structuredClone(rule),
      remaining: rule.times ?? 1,
    })),
    stuckActuators: new Set(
      (faults.stuckActuators ?? []).map(({ aId }) => aId),
    ),
  };
  state.faultEvents = [];
  // Characteristics the owner changed by hand (changeByHand), with the time.
  state.handChanges = [];
  state.pending = new Set();
  // Timers of the hub's own later steps (a search ending, a device joining);
  // close() clears them.
  state.timers = new Set();
  state.timerHandles = new Map();
  const requests = [];
  // Queued explicit JSON-RPC error replies by method, for tests of a hub that
  // receives a request and refuses it without changing the home.
  const refusals = new Map();
  // Milliseconds by method before a reply is sent, for tests of a hub that
  // answers slowly (the owner's 81 accessory.get took about 9 s,
  // 2026-10-12-notifications-live). The request is handled at once.
  const replyDelays = new Map();
  const server = new WebSocketServer({
    host,
    port,
    handleProtocols: (protocols) =>
      protocols.has("json-rpc") ? "json-rpc" : false,
  });
  await once(server, "listening");
  // The hub pushes event frames to every connection that has sent the home's
  // serial, without a subscription (owner's hub: characteristic and room
  // events, and the extension event after a search action,
  // 2026-10-12-device-pairing H12 and P5).
  const receivesEvents = new WeakSet();
  // Events this matches are lost on the way to every connection
  // (dropEvents).
  let lostEvents = null;
  // Events this matches reach every connection later (delayEvents).
  let lateEvents = null;
  state.emit = (event) => {
    if (lostEvents?.(event)) return;
    const text = JSON.stringify({ event });
    const send = () => {
      for (const client of server.clients) {
        if (client.readyState === client.OPEN && receivesEvents.has(client)) {
          client.send(text);
        }
      }
    };
    if (!lateEvents?.match(event)) {
      send();
      return;
    }
    const timer = setTimeout(() => {
      state.timers.delete(timer);
      send();
    }, lateEvents.ms);
    state.timers.add(timer);
  };
  // Events of a change a request makes go out after its reply.
  state.emitAfterReply = (event) => {
    if (state.replyEvents) state.replyEvents.push(event);
    else state.emit(event);
  };
  const handleWithEvents = (raw, connectionId) => {
    state.replyEvents = [];
    try {
      return {
        reply: handleMessage(
          state,
          requests,
          token,
          raw,
          refusals,
          connectionId,
        ),
        events: state.replyEvents,
      };
    } finally {
      state.replyEvents = null;
    }
  };
  // Every WebSocket connection with the time of its first request and its
  // close, so a grader can tell the MCP server's connection from another.
  const connections = [];
  server.on("connection", (socket) => {
    const connection = {
      id: connections.length + 1,
      opened_at: Date.now(),
      first_request_at: null,
      closed_at: null,
      requests: 0,
    };
    connections.push(connection);
    let nextEvent = 0;
    let nextCharacteristic = 0;
    let nextRoom = 0;
    const sendEvent = () => {
      if (!receivesEvents.has(socket)) return;
      const room = nextEvent++ % 3 === 2 && state.rooms.length > 0;
      if (room) {
        const { id, name, order, visible } =
          state.rooms[nextRoom++ % state.rooms.length];
        socket.send(
          JSON.stringify({
            event: {
              room: {
                event: "EVENT_UPDATE",
                rooms: [{ id, name, order, visible }],
              },
            },
          }),
        );
        return;
      }
      const characteristics = state.accessories.flatMap(({ services }) =>
        services.flatMap((service) => service.characteristics),
      );
      if (characteristics.length === 0) return;
      socket.send(
        JSON.stringify({
          event: valueEvent(
            characteristics[nextCharacteristic++ % characteristics.length],
          ),
        }),
      );
    };
    const events = eventEveryMs
      ? setInterval(sendEvent, eventEveryMs)
      : undefined;
    socket.on("close", () => {
      connection.closed_at = Date.now();
      clearInterval(events);
    });
    const handle = (raw, receivedAt) => {
      const recorded = requests.length;
      const { reply, events: replyEvents } = handleWithEvents(
        raw,
        connection.id,
      );
      if (
        requests.length > recorded &&
        requests.at(-1).serial === state.hub.serial &&
        requests.at(-1).error?.code !== 401
      ) {
        receivesEvents.add(socket);
      }
      const text = reply ? JSON.stringify(reply) : null;
      const entry = requests.length > recorded ? requests.at(-1) : undefined;
      // The hub-side cost of the request: bytes of the reply frame sent (0
      // for a dropped reply).
      if (entry) {
        entry.responseBytes = text ? Buffer.byteLength(text) : 0;
        entry.received_ms = receivedAt;
      }
      const delay = entry ? replyDelays.get(entry.method) : undefined;
      // The events of what the request changed go out after its reply.
      const send = () => {
        if (text) {
          if (entry) entry.answered_ms = performance.now();
          if (socket.readyState === socket.OPEN) socket.send(text);
        }
        for (const event of replyEvents) state.emit(event);
      };
      if (text && delay) {
        setTimeout(send, delay);
      } else {
        send();
      }
    };
    let arrivals = 0;
    socket.on("message", (raw) => {
      connection.requests += 1;
      connection.first_request_at ??= Date.now();
      arrivals += 1;
      const receivedAt = performance.now();
      if (onRequest) {
        const params = paramsOfRaw(raw);
        if (params) onRequest({ method: methodOf(params), params });
      }
      const latency =
        typeof latencyMs === "function"
          ? latencyMs({ method: methodOfRaw(raw), arrival: arrivals })
          : (latencyMs ?? 0);
      if (latency <= 0) {
        handle(raw, receivedAt);
        return;
      }
      const timer = setTimeout(() => {
        state.timers.delete(timer);
        if (socket.readyState === socket.OPEN) handle(raw, receivedAt);
      }, latency);
      state.timers.add(timer);
    });
  });
  const address = server.address();
  const url = `ws://${host}:${address.port}`;
  return {
    url,
    serial: state.hub.serial,
    token,
    cid,
    state,
    initialState,
    requests,
    writes: () => requests.filter(({ write }) => write),
    // Handles native params as a request of a client without a socket, for
    // replaying what a run sent; returns the reply, null if it is dropped.
    request: (params) => {
      const { reply, events } = handleWithEvents(
        JSON.stringify({
          id: requests.length + 1,
          token,
          serial: state.hub.serial,
          cid,
          params,
        }),
        null,
      );
      for (const event of events) state.emit(event);
      return reply;
    },
    // Pushes an event frame to the connections that receive events, as the
    // hub does for an edit made in the SprutHub app.
    emit: (event) => state.emit(event),
    // Pushes one event as the owner's hub does at rest, a room
    // EVENT_UPDATE with the room's own fields (about 6 a minute,
    // 2026-10-13-voice-latency-baseline, section 5): a client sees that
    // the hub pushes events down its connection.
    restEvent: () => {
      const { id, name, order, visible } = state.rooms[0];
      state.emit({
        room: { event: "EVENT_UPDATE", rooms: [{ id, name, order, visible }] },
      });
    },
    // From now on the events of changes (emit, writes, changeByHand) that
    // match(event) accepts reach no connection, as a frame lost between the
    // hub and a client; null delivers them again.
    dropEvents: (match) => {
      lostEvents = match;
    },
    // From now on the events that match(event) accepts reach the
    // connections ms later, as the owner's hub pushed a write's event to
    // the writing socket up to 556 ms after the write's reply, with the
    // reply of the next write (2026-10-13-structure-events); null sends
    // them at once again.
    delayEvents: (match, ms) => {
      lateEvents = match ? { match, ms } : null;
    },
    // Pushes text as it is to the connections that receive events, as a
    // frame a client cannot read.
    pushRaw: (text) => {
      for (const client of server.clients) {
        if (client.readyState === client.OPEN && receivesEvents.has(client)) {
          client.send(text);
        }
      }
    },
    refuseNext: (method, error) => {
      const queue = refusals.get(method) ?? [];
      queue.push(
        error ?? {
          code: -32601,
          message: `unsupported by simulator: ${method}`,
        },
      );
      refusals.set(method, queue);
    },
    // The next request of this method is lost on its way: the hub never
    // handles it, so nothing changes and no reply comes; the client times
    // out (a droppedReply fault, by contrast, is applied).
    loseNext: (method) => {
      const queue = refusals.get(method) ?? [];
      queue.push(LOST_REQUEST);
      refusals.set(method, queue);
    },
    // Replies to this method from now on are sent ms after the request is
    // handled; 0 sends them at once again.
    delayReplies: (method, ms) => {
      if (ms > 0) replyDelays.set(method, ms);
      else replyDelays.delete(method);
    },
    touchedMethods: () => touchedMethods(requests),
    // Lets a device in pairing mode (a fixture's pairing entry) join the
    // controller now, outside any search, as the hub would one whose join
    // it accepted just before the network closed (not observed).
    joinNow: (input) => {
      const device = pairingDevice(input);
      state.pairing.push(device);
      announceJoining(
        state,
        state.extensions.find(
          ({ extensionKey }) => extensionKey === device.extensionKey,
        ),
        device,
      );
    },
    // Changes a value as the owner does with a wall switch or the SprutHub
    // app: the home changes, links and lamp logic follow, and no request
    // is recorded, so a grader tells it apart from the MCP server's writes.
    changeByHand: ({ aId, sId, cId, value }) => {
      const characteristic = requireCharacteristic(state, { aId, sId, cId });
      writeValue(
        state,
        characteristic,
        checkedValue(characteristic.control, value),
      );
      state.handChanges.push({
        at: new Date().toISOString(),
        // Requests the hub had received by then: later ones have a larger seq.
        after_seq: requests.length,
        aId,
        sId,
        cId,
        value: structuredClone(value),
      });
    },
    faultEvents: () => structuredClone(state.faultEvents),
    connections: () => structuredClone(connections),
    // Cuts every open connection, as a network drop or a relay restart
    // does; resolves once they have closed.
    dropConnections: async () => {
      const closing = [...server.clients].map((client) =>
        client.readyState === client.CLOSED ? null : once(client, "close"),
      );
      for (const client of server.clients) client.terminate();
      await Promise.all(closing);
    },
    // Applies delayed writes now, as the hub would have by the time a
    // grader looks at the home.
    settle: () => {
      for (const pending of [...state.pending]) pending.apply();
    },
    connectionEnv: () => ({
      SPRUTHUB_URL: url,
      SPRUTHUB_TOKEN: token,
      SPRUTHUB_SERIAL: state.hub.serial,
      SPRUTHUB_CID: cid,
    }),
    snapshot: () => homeSnapshot(state),
    exportState: () => {
      const {
        pending: _pending,
        currentRequest: _request,
        timers: _timers,
        timerHandles: _timerHandles,
        emit: _emit,
        emitAfterReply: _emitAfterReply,
        replyEvents: _replyEvents,
        ...rest
      } = state;
      return {
        ...structuredClone(rest),
        faults: {
          ...rest.faults,
          stuckActuators: [...rest.faults.stuckActuators],
        },
        links: Object.fromEntries(state.links),
      };
    },
    initialSnapshot: () => homeSnapshot(initialState),
    close: async () => {
      for (const pending of state.pending) clearTimeout(pending.timer);
      state.pending.clear();
      for (const timer of state.timers) clearTimeout(timer);
      state.timers.clear();
      state.timerHandles.clear();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// A queued refusal that loses the request instead (loseNext).
const LOST_REQUEST = Symbol("lost request");

function handleMessage(
  state,
  requests,
  token,
  raw,
  refusals,
  connection = null,
) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return { id: null, error: { code: -32700, message: "Parse error" } };
  }
  const method = methodOf(message?.params);
  const entry = {
    seq: requests.length + 1,
    at: new Date().toISOString(),
    method,
    serial: message?.serial ?? null,
    cid: message?.cid ?? null,
    connection,
    write: isWriteMethod(method),
    params: structuredClone(message?.params ?? null),
    evidence: evidenceKey(state, method, message?.params),
  };
  requests.push(entry);
  const fail = (error) => {
    entry.error = { code: error.code, message: error.message };
    return { id: message?.id ?? null, error: entry.error };
  };
  if (message?.token !== token) {
    return fail(new SimulatorError(401, "Unauthorized"));
  }
  if (method === null) {
    return fail(new SimulatorError(-32600, "Invalid request"));
  }
  if (method !== "hub.list" && message.serial !== state.hub.serial) {
    return fail(new SimulatorError(-32000, "Unknown hub serial"));
  }
  const refusal = refusals.get(method)?.shift();
  if (refusal === LOST_REQUEST) {
    recordFault(state, "lost_request", entry);
    entry.replyDropped = true;
    return null;
  }
  if (refusal) return fail(new SimulatorError(refusal.code, refusal.message));
  const handler = HANDLERS[method];
  state.currentRequest = entry;
  if (!handler) {
    return fail(
      new SimulatorError(-32601, `unsupported by simulator: ${method}`),
    );
  }
  const [domain, operation] = method.split(".");
  try {
    const input = message.params[domain][operation] ?? {};
    if (dropsReply(state, method, input, { applied: false })) {
      recordFault(state, "lost_request", entry);
      entry.replyDropped = true;
      entry.lost = true;
      return null;
    }
    const value = handler(state, input);
    if (dropsReply(state, method, input)) {
      recordFault(state, "dropped_reply", entry);
      entry.replyDropped = true;
      return null;
    }
    return {
      id: message.id,
      result: {
        [domain]: {
          [operation]: structuredClone(
            operation === "list" ? withoutEmptyLists(value) : value,
          ),
        },
      },
    };
  } catch (error) {
    if (error instanceof SimulatorError) return fail(error);
    return fail(new SimulatorError(-32603, `Internal error: ${error.message}`));
  }
}

// A live hub omits an empty repeated field from a list reply (owner hub,
// 2026-09-24: accessory.list {roomId} of an empty room; earlier
// extensionChild.list), as protobuf JSON does.
function withoutEmptyLists(value) {
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => !(Array.isArray(item) && item.length === 0),
    ),
  );
}

function methodOfRaw(raw) {
  return methodOf(paramsOfRaw(raw));
}

function paramsOfRaw(raw) {
  try {
    return JSON.parse(raw.toString())?.params ?? null;
  } catch {
    return null;
  }
}

function methodOf(params) {
  if (!isRecord(params)) return null;
  const domains = Object.keys(params);
  if (domains.length !== 1 || !isRecord(params[domains[0]])) return null;
  const operations = Object.keys(params[domains[0]]);
  if (operations.length !== 1) return null;
  return `${domains[0]}.${operations[0]}`;
}

const HANDLERS = {
  "hub.list": (state) => ({ hubs: [structuredClone(state.hub)] }),
  "server.ping": () => ({}),

  "room.list": (state) => ({ rooms: state.rooms }),
  "room.get": (state, { id }) =>
    // A missing room is null here; the live form of that answer is unknown.
    state.rooms.find((room) => room.id === id) ?? null,
  "room.create": (state, { name }) => {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw invalidParams("Room name is required");
    }
    const room = {
      id: nextId(state.rooms.map(({ id }) => id)),
      name: storedRoomName(name),
      order: state.rooms.length + 1,
      visible: true,
    };
    state.rooms.push(room);
    emitRooms(state, "EVENT_ADD", [room]);
    return room;
  },
  "room.delete": (state, { id }) => {
    const at = state.rooms.findIndex((room) => room.id === id);
    if (at < 0) throw notFound(`Room ${id}`);
    state.rooms.splice(at, 1);
    emitRooms(state, "EVENT_REMOVE", [{ id }]);
    return {};
  },
  // RoomUpdateRequest {id, name, visible}: only the sent fields change.
  "room.update": (state, input) => {
    const room = requireRoom(state, input.id);
    if (Object.hasOwn(input, "name")) {
      if (typeof input.name !== "string" || input.name.trim().length === 0) {
        throw invalidParams("Room name must be a non-empty string");
      }
      room.name = storedRoomName(input.name);
    }
    if (Object.hasOwn(input, "visible")) {
      if (typeof input.visible !== "boolean") {
        throw invalidParams("Room visible must be a boolean");
      }
      room.visible = input.visible;
    }
    emitRooms(state, "EVENT_UPDATE", [room]);
    return {};
  },

  "accessory.list": (state, { roomId, expand }) => ({
    accessories: state.accessories
      .filter(
        (accessory) => roomId === undefined || accessory.roomId === roomId,
      )
      .map((accessory) => projectAccessory(accessory, expand)),
  }),
  "accessory.get": (state, { id }) => {
    const accessory = state.accessories.find((item) => item.id === id);
    return accessory ? withNotify(accessory) : null;
  },
  "accessory.create": (state, { name, roomId, services }) => {
    requireRoom(state, roomId);
    if (typeof name !== "string" || name.length === 0) {
      throw invalidParams("Accessory name is required");
    }
    if (!Array.isArray(services) || services.length !== 1) {
      throw invalidParams("Exactly one service is supported by the simulator");
    }
    const [serviceInput] = services;
    const catalog = SERVICE_TYPES.find(
      ({ type }) => type === serviceInput.type,
    );
    if (!catalog)
      throw invalidParams(`Unknown service type ${serviceInput.type}`);
    const id = nextId(
      state.accessories.map((accessory) => accessory.id),
      100,
    );
    const types = [
      ...catalog.required.map(({ type }) => type),
      ...(serviceInput.optional ?? []).filter(
        (type) => !catalog.required.some((item) => item.type === type),
      ),
    ];
    const accessory = {
      id,
      roomId,
      name,
      online: true,
      virtual: true,
      ...VIRTUAL_IDENTITY(id),
      services: [
        virtualInformationService(id, name),
        {
          aId: id,
          sId: VIRTUAL_SERVICE_ID,
          name: serviceInput.name ?? name,
          type: serviceInput.type,
          visible: true,
          characteristics: types.map((type, index) =>
            buildCharacteristic(id, VIRTUAL_SERVICE_ID, {
              cId: VIRTUAL_SERVICE_ID + 1 + index,
              type,
              value: defaultValue(type),
            }),
          ),
        },
      ],
    };
    state.accessories.push(accessory);
    emitAccessories(state, "EVENT_ADD", [accessory]);
    // The create reply of the fake hubs omits `virtual`; the stored accessory
    // keeps it, as accessory.get reports it. notify was not seen in it.
    const { virtual: _virtual, ...reply } = accessory;
    return withoutNotifyIn(reply);
  },
  "accessory.update": (state, input) => {
    const accessory = requireAccessory(state, input.id);
    if (Object.hasOwn(input, "roomId")) requireRoom(state, input.roomId);
    const changed = { id: accessory.id };
    let nameCharacteristic;
    if (Object.hasOwn(input, "name")) {
      if (typeof input.name !== "string" || input.name.length === 0) {
        throw invalidParams("Accessory name must be a non-empty string");
      }
      accessory.name = input.name;
      changed.name = input.name;
      nameCharacteristic = accessory.services
        .find(({ type }) => type === "AccessoryInformation")
        ?.characteristics.find(({ control }) => control.type === "Name");
      if (nameCharacteristic) {
        nameCharacteristic.control.value = { stringValue: input.name };
      }
    }
    if (Object.hasOwn(input, "roomId")) {
      accessory.roomId = input.roomId;
      changed.roomId = input.roomId;
    }
    state.emitAfterReply?.({
      accessory: { event: "EVENT_UPDATE", accessories: [changed] },
    });
    if (nameCharacteristic) {
      state.emitAfterReply?.(valueEvent(nameCharacteristic));
    }
    return {};
  },
  "accessory.delete": (state, { id }) => {
    requireAccessory(state, id);
    state.accessories = state.accessories.filter(
      (accessory) => accessory.id !== id,
    );
    state.logics = state.logics.filter(({ aId }) => aId !== id);
    for (const key of [...state.links.keys()]) {
      if (key.startsWith(`${id}.`)) state.links.delete(key);
    }
    state.emitAfterReply?.({
      accessory: { event: "EVENT_REMOVE", accessories: [{ id }] },
    });
    return {};
  },

  "service.types": () => ({ types: SERVICE_TYPES }),
  // ServiceUpdateRequest {aId, sId, order, grid, name, visible}: only the
  // sent name and visible change; order and grid are not modelled.
  "service.update": (state, input) => {
    const service = requireService(state, input.aId, input.sId);
    const changed = { aId: service.aId, sId: service.sId };
    let nameCharacteristic;
    if (Object.hasOwn(input, "name")) {
      if (typeof input.name !== "string" || input.name.trim().length === 0) {
        throw invalidParams("Service name must be a non-empty string");
      }
      service.name = input.name;
      changed.name = input.name;
      nameCharacteristic = service.characteristics.find(
        ({ control }) => control.type === "Name",
      );
      if (nameCharacteristic) {
        nameCharacteristic.control.value = { stringValue: input.name };
      }
    }
    if (Object.hasOwn(input, "visible")) {
      if (typeof input.visible !== "boolean") {
        throw invalidParams("Service visible must be a boolean");
      }
      service.visible = input.visible;
      changed.visible = input.visible;
    }
    state.emitAfterReply?.({
      service: { event: "EVENT_UPDATE", services: [changed] },
    });
    if (nameCharacteristic) {
      state.emitAfterReply?.(valueEvent(nameCharacteristic));
    }
    return {};
  },

  "characteristic.get": (state, input) => {
    const characteristic = findCharacteristic(state, input);
    return characteristic && withoutNotify(characteristic);
  },
  "characteristic.getOptions": (state, input) => {
    requireCharacteristic(state, input);
    return {
      options: state.characteristicOptions[characteristicKey(input)] ?? [],
    };
  },
  "characteristic.setOptions": (state, input) => {
    requireCharacteristic(state, input);
    const options = state.characteristicOptions[characteristicKey(input)] ?? [];
    applyOptions(options, input.options);
    return {};
  },
  "characteristic.update": (state, input) => {
    const characteristic = requireCharacteristic(state, input);
    if (Object.hasOwn(input, "hasLinks")) {
      characteristic.hasLinks = input.hasLinks;
    }
    if (Object.hasOwn(input, "linkProcessing")) {
      characteristic.linkProcessing = input.linkProcessing;
    }
    // CharacteristicUpdateRequest.notify, as the web client's Notifications
    // screen sends it (2026-10-12-notifications-live).
    if (Object.hasOwn(input, "notify")) {
      if (typeof input.notify !== "boolean") {
        throw invalidParams("Characteristic notify must be a boolean");
      }
      characteristic.notify = input.notify;
    }
    if (input.control && Object.hasOwn(input.control, "value")) {
      const value = checkedValue(characteristic.control, input.control.value);
      if (state.faults?.stuckActuators.has(characteristic.aId)) {
        recordFault(state, "stuck_actuator", state.currentRequest);
        return {};
      }
      const delay = state.faults?.delayedReadback.find((rule) =>
        sameCharacteristic(rule, characteristic),
      );
      if (delay) {
        recordFault(state, "delayed_readback", state.currentRequest);
        const pending = {
          apply: () => {
            clearTimeout(pending.timer);
            state.pending.delete(pending);
            writeValue(state, characteristic, value);
          },
        };
        pending.timer = setTimeout(pending.apply, delay.ms);
        state.pending.add(pending);
        return {};
      }
      writeValue(state, characteristic, value);
    }
    return {};
  },

  "link.list": (state, input) => {
    const characteristic = requireCharacteristic(state, input);
    const accessory = requireAccessory(state, input.aId);
    const system =
      accessory.virtual !== true &&
      typeof accessory.extensionKey === "string" &&
      characteristic.control.write === true
        ? [
            {
              type: "SYSTEM",
              index: `${accessory.extensionKey}/${accessory.deviceId}`,
              controller: accessory.extensionKey,
            },
          ]
        : [];
    return {
      links: [...system, ...(state.links.get(characteristicKey(input)) ?? [])],
    };
  },
  "link.addVirtual": (state, input) =>
    structuredClone(addVirtualLink(state, input, { copyValue: true })),
  // Removing an IN link takes the virtual characteristic out of its
  // target's OUT link, which stays as an empty entry under the same index.
  // A linkId the characteristic no longer has is acknowledged and changes
  // nothing (2026-10-14-light-group-relink, 6 and 10;
  // 2026-10-13-wave4-contracts 2.9). hasLinks is not derived from links
  // here, unlike on the hub (wave4 2.5, 2.7): it changes only as written.
  "link.remove": (state, input) => {
    requireCharacteristic(state, input);
    const key = characteristicKey(input);
    const links = state.links.get(key) ?? [];
    const removed = links.find(({ index }) => index === input.linkId);
    if (!removed) return {};
    // The empty OUT left on a lamp stays (wave4 2.9); a non-empty OUT
    // removed from the lamp's side was not tried.
    if (removed.type === "OUT" && removed.characteristics.length === 0) {
      return {};
    }
    const remaining = links.filter(({ index }) => index !== input.linkId);
    state.links.set(key, remaining);
    if (removed.type === "IN") {
      for (const target of removed.characteristics) {
        for (const link of state.links.get(characteristicKey(target)) ?? []) {
          if (link.type !== "OUT") continue;
          link.characteristics = link.characteristics.filter(
            ({ aId, sId, cId }) =>
              aId !== input.aId || sId !== input.sId || cId !== input.cId,
          );
        }
      }
    }
    return {};
  },

  "logic.types": (state, { aId, sId }) => ({
    logicTypes: availableLogicTypes(state, requireService(state, aId, sId)).map(
      ({ options: _options, ...logicType }) => logicType,
    ),
  }),
  // An assignment stays listed whether its LOGIC is on or off (owner hub,
  // 2026-09-24, live-conformance-3).
  "logic.list": (state, { aId, sId }) => {
    requireService(state, aId, sId);
    return {
      logics: state.logics
        .filter((logic) => logic.aId === aId && logic.sId === sId)
        .map(({ type, name, active }) => ({ type, name, active })),
    };
  },
  "logic.get": (state, input) => requireLogic(state, input),
  "logic.getOptions": (state, input) => {
    requireLogic(state, input);
    return { options: logicOptions(state, input) };
  },
  "logic.create": (state, { aId, sId, type }) => {
    const service = requireService(state, aId, sId);
    const logicType = availableLogicTypes(state, service).find(
      (candidate) => candidate.type === type,
    );
    if (!logicType) {
      // SprutHub 3.0.0 answered Not found for the type of a turned-off user
      // LOGIC (owner hub, 2026-09-24, live-conformance-3).
      if (
        state.scenarios.some(
          (scenario) =>
            scenario.type === "LOGIC" &&
            scenario.active !== true &&
            logicTypeForScenario(scenario.index) === type,
        )
      ) {
        throw notFound(`Logic type: ${type}`);
      }
      throw invalidParams(`Logic type ${type} is not available`);
    }
    if (findLogic(state, { aId, sId, type })) {
      throw invalidParams(`Logic ${type} is already assigned`);
    }
    const logic = {
      aId,
      sId,
      type,
      name: logicType.name,
      active: false,
      optionsWindow: `Logic/${type}/${aId}/${sId}`,
    };
    state.logics.push(logic);
    logicOptions(state, logic);
    return logic;
  },
  "logic.update": (state, input) => {
    const logic = requireLogic(state, input);
    if (typeof input.active === "boolean") logic.active = input.active;
    return {};
  },
  "logic.setOptions": (state, input) => {
    requireLogic(state, input);
    applyOptions(logicOptions(state, input), input.options);
    return {};
  },
  "logic.delete": (state, input) => {
    requireLogic(state, input);
    // Options survive deletion on the live hub (2026-09-10 native-logic).
    state.logics = state.logics.filter((logic) => !sameLogic(logic, input));
    return {};
  },

  "scenario.list": (state, { aId }) => {
    const scenarios = state.scenarios
      .filter(
        (scenario) =>
          aId === undefined || scenarioReferencesAccessory(scenario, aId),
      )
      .map(({ data: _data, ...summary }) => summary);
    // Live scenario.list {aId} without matches returned an empty list object.
    return aId !== undefined && scenarios.length === 0 ? {} : { scenarios };
  },
  "scenario.get": (state, { index, expand }) => {
    const scenario = requireScenario(state, index);
    if (expandIncludes(expand, "data")) return scenario;
    const { data: _data, ...summary } = scenario;
    return summary;
  },
  "scenario.create": (state, input) => {
    const scenario = {
      index: String(state.nextScenarioIndex++),
      name: typeof input.name === "string" ? input.name : "",
      desc: typeof input.desc === "string" ? input.desc : "",
      type: input.type,
      predefined: false,
      active: input.active === true,
      onStart: input.onStart === true,
      sync: input.sync === true,
      error: false,
    };
    // The options window of a LOGIC keeps what create sent, even where its
    // code sets other values (2026-10-13-wave4-contracts 1.6, 1.7).
    const sent = {
      name: scenario.name,
      desc: scenario.desc,
      onStart: scenario.onStart,
    };
    if (scenario.type === "BLOCK") {
      scenario.data = normalizeBlockData(input.data);
      scenario.rooms = blockRooms(state, scenario.data);
    } else if (scenario.type === "LOGIC") {
      if (typeof input.data !== "string") {
        throw invalidParams("LOGIC scenario requires source text");
      }
      scenario.data = input.data;
      applyLogicInfo(scenario);
    } else if (scenario.type === "GLOBAL") {
      // Accepted with code and flags as sent (2026-10-13-wave4-contracts
      // 1.9); that a GLOBAL keeps the name and desc sent is assumed.
      if (typeof input.data !== "string") {
        throw invalidParams("GLOBAL scenario requires source text");
      }
      scenario.data = input.data;
    } else {
      throw invalidParams(`Scenario type ${input.type} is not supported`);
    }
    addScenarioWindow(state, scenario, sent);
    state.scenarios.push(scenario);
    return scenario;
  },
  "scenario.update": (state, input) => {
    const scenario = requireScenario(state, input.index);
    // name, desc, onStart and sync, like active, are acknowledged and
    // ignored for every type; only data applies (owner hub, 2026-09-24 for
    // active; 2026-10-13-wave4-contracts 1.3 for the rest). They change
    // through the scenario's options window.
    if (Object.hasOwn(input, "data")) {
      if (scenario.type === "BLOCK") {
        scenario.data = normalizeBlockData(input.data);
        scenario.rooms = blockRooms(state, scenario.data);
      } else {
        if (typeof input.data !== "string") {
          throw invalidParams(`${scenario.type} scenario requires source text`);
        }
        scenario.data = input.data;
        // Every code write of a LOGIC sets its name, desc and onStart from
        // info again, even unchanged; sync is untouched, and a GLOBAL's
        // code leaves its name alone (2026-10-13-wave4-contracts 1.5, 1.8).
        if (scenario.type === "LOGIC") applyLogicInfo(scenario);
      }
    }
    return {};
  },
  "scenario.delete": (state, { index }) => {
    const deleted = requireScenario(state, index);
    if (deleted.optionsWindow) delete state.windows[deleted.optionsWindow];
    state.scenarios = state.scenarios.filter(
      (scenario) => scenario.index !== index,
    );
    const logicType = logicTypeForScenario(index);
    state.logics = state.logics.filter(({ type }) => type !== logicType);
    return {};
  },
  "scenario.run": (state, { index }) => {
    const scenario = requireScenario(state, index);
    // The manual-run log line is the simulator's guess at its form.
    appendLog(state, {
      level: "LOG_LEVEL_INFO",
      path: "Scenario.ScenarioBlock.Target.jBlock",
      message: `Сценарий ${index}: (TRIGGER: SCENARIO[${index}] <- MANUAL)`,
    });
    state.runs.push(runScenario(state, scenario));
    return {};
  },
  "scenario.sdk": () => ({ sdk: SCENARIO_SDK }),
  "scenario.subscribe": (state, { index }) => {
    requireScenario(state, index);
    return { uuid: subscriptionUuid(state, "scenario") };
  },
  "scenario.unsubscribe": () => ({}),
  // Observed on the owner's hub (read-only, firmware 3.0.0, 2026-09-24):
  // time is Unix epoch milliseconds, {count} returns the newest count
  // entries, {lastTime, count} returns entries newer than lastTime (forward,
  // not older), and the hub keeps only a ring buffer (state.logCapacity, 128
  // there). Assumed here: the reply is in console order (oldest first), the
  // forward page starts right after lastTime, and an empty page omits the
  // repeated field as protobuf JSON does.
  "log.list": (state, { lastTime, count }) => {
    const limit = Number.isInteger(count) && count > 0 ? count : 100;
    const page =
      typeof lastTime === "number"
        ? state.log.filter(({ time }) => time > lastTime).slice(0, limit)
        : state.log.slice(-limit);
    return page.length === 0 ? {} : { log: page };
  },
  "log.subscribe": (state) => ({ uuid: subscriptionUuid(state, "log") }),
  "log.unsubscribe": () => ({}),

  "window.get": (state, { windowKey }) => {
    const window = state.windows[windowKey];
    if (!window) {
      const child = bridgeChildWindow(state, windowKey);
      // The hub has no window for an accessory a bridge does not list
      // (2026-10-14-bridge-export-write 11).
      if (!child && bridgeOfChildWindowKey(state, windowKey)) {
        throw notFound(`Window not found: '${windowKey}'`);
      }
      return child;
    }
    if (windowKey === "") return withDiscoveryTime(state, window);
    const scenario = scenarioOfWindow(state, windowKey);
    if (!scenario) return window;
    // The scenario-backed options show the scenario's fields (live-
    // conformance-2; 2026-10-13-wave4-contracts 1.2, 1.8), except those a
    // LOGIC's window keeps itself (windowKeepsOwnValue).
    const view = structuredClone(window);
    for (const option of view.options) {
      const field = SCENARIO_WINDOW_FIELDS[option.key];
      if (field && !windowKeepsOwnValue(scenario, option.key)) {
        option.value = { [field.kind]: scenario[field.name] };
      }
    }
    return view;
  },
  "window.update": (state, { windowKey, options }) => {
    const window = state.windows[windowKey];
    if (!window) {
      const child = bridgeChildOfWindow(state, windowKey);
      if (child) return updateBridgeExport(child, options);
      throw notFound(`Window ${windowKey}`);
    }
    const scenario = scenarioOfWindow(state, windowKey);
    if (scenario) checkScenarioWindowUpdate(scenario, options);
    applyOptions(window.options, options);
    // Only the options this update carries reach the scenario, at once, for
    // a BLOCK, a LOGIC and a GLOBAL (2026-10-13-wave4-contracts 1.4, 1.8,
    // 1.10; Active: 2026-09-24-live-conformance-3).
    for (const { key, value } of scenario ? options : []) {
      const field = SCENARIO_WINDOW_FIELDS[key];
      if (field) scenario[field.name] = value[field.kind];
    }
    return {};
  },

  // The list carries each extension's spaces with their actions, as
  // extension.get does (owner's hub, 2026-10-12-device-pairing P1).
  "extension.list": (state) => ({
    extensions: state.extensions.map((extension) => ({
      ...extensionView(extension),
      childCount: extensionChildren(state, extension.extensionKey).length,
    })),
  }),
  "extension.get": (state, { extensionKey }) => {
    const extension = state.extensions.find(
      (candidate) => candidate.extensionKey === extensionKey,
    );
    if (!extension) return null;
    return {
      ...extensionView(extension),
      childCount: extensionChildren(state, extensionKey).length,
    };
  },
  // A device still joining keeps its status and progressBar in the list, as
  // the web client draws them from the list and its events (K7, K8); a
  // paired device's list entry has neither (owner's hub, H3).
  // An empty list is left out of the answer, as the hub does
  // (2026-09-17-extension-child-empty-list).
  "extensionChild.list": (state, { extensionKey }) => {
    const children = extensionChildren(state, extensionKey).map((child) => {
      if (isJoining(state, child)) return child;
      const { description: _d, status: _s, ...summary } = child;
      return summary;
    });
    return children.length === 0 ? {} : { children };
  },
  "extensionChild.get": (state, { extensionKey, id }) =>
    extensionChildren(state, extensionKey).find((child) => child.id === id) ??
    null,
  // Observed for ZigBee's main ACTION_DISCOVERY only (P1-P5). A missing
  // extension or action, an extension that does not run and other action
  // types were not sent to a hub: the simulator refuses them.
  "extension.action": (
    state,
    { extensionKey, spaceKey, actionId, state: on },
  ) => {
    const extension = state.extensions.find(
      (candidate) => candidate.extensionKey === extensionKey,
    );
    if (!extension) throw notFound(`Extension ${extensionKey}`);
    const space = extension.spaces?.find(({ key }) => key === spaceKey);
    const action = space?.actions?.find(({ id }) => id === actionId);
    if (!action) throw notFound(`Action ${spaceKey}/${actionId}`);
    if (extension.state !== "LOADED" || extension.enabled !== true) {
      throw new SimulatorError(-32603, "Extension is not loaded");
    }
    if (action.type !== "ACTION_DISCOVERY" || typeof on !== "boolean") {
      throw new SimulatorError(
        -32601,
        `unsupported by simulator: extension.action ${action.type} state ${on}`,
      );
    }
    if (on) startDiscovery(state, extension, space, action);
    else endDiscovery(state, extension);
    return {};
  },
};

// ---- device search and pairing ---------------------------------------------

// A fixture may set hub.discoveryTimeMs, the hub's DiscoveryTime (60 s on
// the owner's hub, H8), and list devices in pairing mode:
//   pairing: [{extensionKey, spaceKey = "main", joinAfterMs, interviewMs,
//              childName, error, accessory: {id, name, roomId, deviceId,
//              ...}}]
// Such a device joins joinAfterMs after a search of that space starts and,
// interviewMs later, becomes an accessory in the fixture's form. Both
// stages are inferred from the web client (K7-K9); the room and name the
// hub gives a new accessory were not observed, so they come from the
// fixture (by default the first room). A device with error is one the hub
// cannot add (an unsupported model, a failed interview): after interviewMs
// it stays a child with that error and no accessory, a guess at a form not
// observed (2026-10-12-device-pairing, unsupported device).
const SEARCH_EVENT_DELAY_MS = 10;

function startDiscovery(state, extension, space, action) {
  // endTimestamp is on the machine's clock, not the simulated hub clock:
  // the owner's hub put it DiscoveryTime after the request on the clock of
  // the machine that sent it (P1), and a client counts what is left from
  // its own clock.
  const endTimestamp = Date.now() + state.discoveryTimeMs;
  action.state = true;
  // Every action of the extension shows the end; only the started one has
  // state true (P2). A repeat restarts the timer (P3).
  for (const other of extensionActions(extension)) {
    other.endTimestamp = endTimestamp;
  }
  // The end by timer is inferred: as a stop, with an event.
  setNamedTimer(
    state,
    `search:${extension.extensionKey}`,
    state.discoveryTimeMs,
    () => endDiscovery(state, extension),
  );
  pushExtension(state, extension);
  for (const device of pairingDevicesFor(state, {
    extensionKey: extension.extensionKey,
    spaceKey: space.key,
  })) {
    const name = `join:${state.pairing.indexOf(device)}`;
    if (state.timerHandles.has(name)) continue;
    setNamedTimer(state, name, device.joinAfterMs ?? 0, () =>
      announceJoining(state, extension, device),
    );
  }
}

// A stop clears endTimestamp on every action and sets state false (P4);
// with several running actions the simulator ends them all (a guess). A
// device in pairing mode that has not joined yet waits for the next search.
function endDiscovery(state, extension) {
  clearNamedTimer(state, `search:${extension.extensionKey}`);
  for (const action of extensionActions(extension)) {
    if (action.type === "ACTION_DISCOVERY") action.state = false;
    delete action.endTimestamp;
  }
  state.pairing.forEach((device, index) => {
    if (device.extensionKey === extension.extensionKey) {
      clearNamedTimer(state, `join:${index}`);
    }
  });
  pushExtension(state, extension);
}

// A fixture's device in pairing mode, with the child id its accessory
// carries.
function pairingDevice(input) {
  const device = structuredClone(input);
  device.accessory.deviceId ??= `device-${device.accessory.id}`;
  return device;
}

function extensionActions(extension) {
  return (extension.spaces ?? []).flatMap(({ actions }) => actions ?? []);
}

// Devices in pairing mode that a start of this space would let in. A
// device that has joined is one device while its interview runs too: a
// start meanwhile does not announce it again.
function pairingDevicesFor(state, { extensionKey, spaceKey }) {
  return state.pairing.filter(
    (device) =>
      device.joined !== true &&
      device.extensionKey === extensionKey &&
      (device.spaceKey ?? "main") === spaceKey,
  );
}

function isJoining(state, child) {
  return state.joining.some(
    (joining) =>
      joining.extensionKey === child.extensionKey && joining.id === child.id,
  );
}

function announceJoining(state, extension, device) {
  device.joined = true;
  const child = {
    extensionKey: extension.extensionKey,
    id: device.accessory.deviceId,
    spaceKey: device.spaceKey ?? "main",
    name: device.childName ?? device.accessory.model ?? device.accessory.name,
    online: true,
    status: "Подключение",
    progressBar: 10,
    optionsWindow: "",
  };
  state.joining.push(child);
  later(state, SEARCH_EVENT_DELAY_MS, () =>
    state.emit({
      extensionChild: {
        event: "EVENT_ADD",
        children: [structuredClone(child)],
      },
    }),
  );
  later(state, device.interviewMs ?? 0, () =>
    completeJoin(state, extension, device, child),
  );
}

function completeJoin(state, extension, device, child) {
  if (device.error) {
    child.status = "Ошибка подключения";
    delete child.progressBar;
    child.error = device.error;
    later(state, SEARCH_EVENT_DELAY_MS, () =>
      state.emit({
        extensionChild: {
          event: "EVENT_UPDATE",
          children: [structuredClone(child)],
        },
      }),
    );
    return;
  }
  state.joining = state.joining.filter((joining) => joining !== child);
  const input = device.accessory;
  const accessory = buildAccessory(state, {
    ...input,
    roomId: input.roomId ?? state.rooms[0].id,
    extensionKey: extension.extensionKey,
    // The child window links the new accessory read-only, as on the
    // owner's hub (H6, 2026-09-16-extension-child-read).
    deviceWindow: [
      {
        key: "AccessoriesList",
        name: "Аксессуары",
        type: "GenericInteger",
        inputType: "ACCESSORY_LIST",
        read: true,
        write: false,
        events: false,
        value: { intValue: 0 },
        validValues: [{ value: { intValue: input.id }, name: input.name }],
      },
      ...(input.deviceWindow ?? []),
    ],
  });
  state.accessories.push(accessory);
  const {
    description: _description,
    status: _status,
    ...paired
  } = extensionChildren(state, extension.extensionKey).find(
    ({ id }) => id === accessory.deviceId,
  );
  later(state, SEARCH_EVENT_DELAY_MS, () => {
    state.emit({
      accessory: {
        event: "EVENT_ADD",
        accessories: [projectAccessory(accessory, "services,characteristics")],
      },
    });
    state.emit({
      extensionChild: { event: "EVENT_UPDATE", children: [paired] },
    });
  });
}

function pushExtension(state, extension) {
  const event = {
    extension: {
      event: "EVENT_UPDATE",
      extensions: [structuredClone(extensionView(extension))],
    },
  };
  later(state, SEARCH_EVENT_DELAY_MS, () => state.emit(event));
}

function later(state, ms, run) {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    run();
  }, ms);
  state.timers.add(timer);
  return timer;
}

// One pending step per name (a search's end, a device's join): setting it
// again replaces it.
function setNamedTimer(state, name, ms, run) {
  clearNamedTimer(state, name);
  state.timerHandles.set(
    name,
    later(state, ms, () => {
      state.timerHandles.delete(name);
      run();
    }),
  );
}

function clearNamedTimer(state, name) {
  const timer = state.timerHandles.get(name);
  if (!timer) return;
  clearTimeout(timer);
  state.timers.delete(timer);
  state.timerHandles.delete(name);
}

function buildState(fixture, hubTime) {
  const utcOffsetMinutes = fixture.log?.utcOffsetMinutes ?? 180;
  const machineNow = Date.now();
  const startedAt =
    hubTime === undefined
      ? machineNow
      : atHubTime(hubTime, utcOffsetMinutes, machineNow);
  const hub = {
    serial: fixture.hub.serial,
    name: fixture.hub.name,
    online: fixture.hub.online ?? true,
    owner: fixture.hub.owner ?? "owner@example.invalid",
    model: fixture.hub.model ?? "Sprut.hub 2",
    optionsWindow: "",
    version: {
      current: {
        version: fixture.hub.version ?? "3.0.0",
        revision: fixture.hub.revision ?? "20131",
      },
    },
  };
  const state = {
    hub,
    rooms: fixture.rooms.map((room, index) => ({
      id: room.id,
      name: room.name,
      order: index + 1,
      visible: true,
    })),
    accessories: [],
    characteristicOptions: {},
    windows: {
      "": homeSettingsWindow({
        ...fixture.hub,
        clock:
          fixture.hub.clock === "now"
            ? hubClock(startedAt, utcOffsetMinutes)
            : fixture.hub.clock,
      }),
      ...bridgeWindows(fixture.extensions ?? []),
    },
    extensions: structuredClone(fixture.extensions ?? []),
    // The hub's DiscoveryTime and the devices in pairing mode (see
    // startDiscovery); joining holds devices announced and not yet paired.
    discoveryTimeMs: fixture.hub.discoveryTimeMs ?? 60_000,
    pairing: (fixture.pairing ?? []).map(pairingDevice),
    joining: [],
    logicCatalog: structuredClone(fixture.logicTypes ?? {}),
    logics: [],
    logicOptionValues: {},
    scenarios: [],
    links: new Map(),
    runs: [],
    log: seedLog(fixture.log, startedAt),
    logCapacity: fixture.log?.capacity ?? DEFAULT_LOG_CAPACITY,
    clockOffsetMs: startedAt - machineNow,
    nextScenarioIndex: 1,
    nextWindow: 1,
    nextSubscription: 1,
  };
  for (const input of fixture.accessories) {
    state.accessories.push(buildAccessory(state, input));
  }
  // A fixture's links are as the web client's link.addVirtual leaves them,
  // without the value the hub copies at that moment: the fixture states
  // the values it means.
  for (const link of fixture.links ?? []) {
    addVirtualLink(state, link, { copyValue: false });
  }
  for (const input of fixture.scenarios ?? []) {
    const scenario = {
      index: input.index,
      name: input.name,
      desc: input.desc ?? "",
      type: input.type,
      predefined: input.predefined === true,
      active: input.active !== false,
      onStart: input.onStart === true,
      sync: input.sync === true,
      error: input.error === true,
    };
    if (input.type === "BLOCK") {
      scenario.data = normalizeBlockData(JSON.stringify(input.data));
      scenario.rooms = blockRooms(state, scenario.data);
    } else {
      scenario.data = Array.isArray(input.data)
        ? input.data.join("\n")
        : input.data;
      if (input.type === "LOGIC" && input.desc === undefined) {
        scenario.desc = logicInfo(scenario.data)?.description ?? scenario.desc;
      }
    }
    // A fixture's scenario is at rest: its window shows what it stores.
    addScenarioWindow(state, scenario, scenario);
    state.scenarios.push(scenario);
  }
  state.nextScenarioIndex =
    Math.max(0, ...state.scenarios.map(({ index }) => Number(index) || 0)) + 1;
  for (const logic of fixture.logics ?? []) {
    const service = requireService(state, logic.aId, logic.sId);
    const logicType = availableLogicTypes(state, service).find(
      ({ type }) => type === logic.type,
    );
    if (!logicType) {
      throw new Error(`Fixture logic ${logic.type} is not available`);
    }
    const assigned = {
      aId: logic.aId,
      sId: logic.sId,
      type: logic.type,
      name: logicType.name,
      active: logic.active === true,
      optionsWindow: `Logic/${logic.type}/${logic.aId}/${logic.sId}`,
    };
    state.logics.push(assigned);
    logicOptions(state, assigned);
  }
  return state;
}

function buildAccessory(state, input) {
  const services = [];
  // A virtual accessory of a fixture: as accessory.create leaves it, an
  // information service at sId 1 and no controller.
  if (input.virtual === true) {
    services.push(virtualInformationService(input.id, input.name));
  } else if (input.manufacturer || input.model) {
    const characteristics = [
      ["Identify", false],
      ["Manufacturer", input.manufacturer ?? ""],
      ["Model", input.model ?? ""],
      ["Name", input.name],
      ["SerialNumber", input.deviceId ?? `SN-${input.id}`],
      ["FirmwareRevision", input.firmware ?? "1.0"],
      ["C_Online", input.online !== false],
    ].map(([type, value], index) =>
      buildCharacteristic(input.id, 1, { cId: index + 2, type, value }),
    );
    // onlineNotify: the device's offline notification is on, as on a new
    // virtual accessory and, likely, on most of the owner's devices (90 of
    // their 1395 characteristics notify, 2026-10-12-notifications-live).
    if (input.onlineNotify === true) characteristics.at(-1).notify = true;
    services.push({
      aId: input.id,
      sId: 1,
      name: "Информация об аксессуаре",
      type: "AccessoryInformation",
      characteristics,
    });
  }
  for (const service of input.services) {
    services.push({
      aId: input.id,
      sId: service.sId,
      name: service.name,
      type: service.type,
      // A live accessory.get reports service visible (owner hub, 2026-09-24).
      visible: service.visible !== false,
      characteristics: service.characteristics.map((characteristic) => {
        const built = buildCharacteristic(
          input.id,
          service.sId,
          characteristic,
        );
        if (characteristic.options) {
          built.hasOptions = true;
          state.characteristicOptions[characteristicKey(built)] =
            structuredClone(characteristic.options);
        }
        return built;
      }),
    });
  }
  if (typeof input.battery === "number") {
    services.push({
      aId: input.id,
      sId: 90,
      name: "Батарея",
      type: "BatteryService",
      characteristics: [
        { cId: 91, type: "BatteryLevel", value: input.battery },
        {
          cId: 92,
          type: "StatusLowBattery",
          value: input.battery < 15 ? 1 : 0,
        },
        { cId: 93, type: "ChargingState", value: 2 },
      ].map((characteristic) =>
        buildCharacteristic(input.id, 90, characteristic),
      ),
    });
  }
  const accessory = {
    id: input.id,
    roomId: input.roomId,
    name: input.name,
    online: input.online !== false,
    // accessory.get of a physical accessory read virtual: false, present
    // rather than omitted (owner hub, 3.0.0, live-conformance-3-read-only).
    virtual: input.virtual === true,
    ...(input.virtual === true ? VIRTUAL_IDENTITY(input.id) : {}),
    ...(input.extensionKey && input.virtual !== true
      ? {
          extensionKey: input.extensionKey,
          deviceId: input.deviceId ?? `device-${input.id}`,
        }
      : {}),
    services,
  };
  if (Array.isArray(input.deviceWindow)) {
    const windowKey = `Controller/${String(input.extensionKey).split(":").at(-1)}/Child/${accessory.deviceId}/`;
    accessory.deviceWindow = windowKey;
    state.windows[windowKey] = {
      windowKey,
      label: { text: `Настройки: ${input.name}` },
      options: structuredClone(input.deviceWindow),
    };
  }
  return accessory;
}

// A created virtual accessory has an information service at sId 1 with
// C_Online at cId 8, its notification on from the start, and its own
// service at sId 13 (owner hub, 3.0.0, 2026-10-12-notifications-live). The
// other information characteristics follow a physical device's; they were
// not read on a virtual one.
const VIRTUAL_SERVICE_ID = 13;

// accessory.list and accessory.get give a virtual accessory these fields,
// and the list has no other sign that it is virtual (owner hub, 3.0.0, all
// 9 virtual lamp groups, 2026-10-14-light-group-relink). Physical
// accessories' manufacturer, model and serial are left out here.
const VIRTUAL_IDENTITY = (id) => ({
  manufacturer: "MakeSimple",
  model: "Virtual",
  manufacturerId: "MakeSimple",
  modelId: "Virtual",
  serial: String(id),
});

function virtualInformationService(id, name) {
  const characteristics = [
    ["Identify", false],
    ["Manufacturer", ""],
    ["Model", ""],
    ["Name", name],
    ["SerialNumber", `SN-${id}`],
    ["FirmwareRevision", "1.0"],
    ["C_Online", true],
  ].map(([type, value], index) =>
    buildCharacteristic(id, 1, { cId: index + 2, type, value }),
  );
  characteristics.at(-1).notify = true;
  return {
    aId: id,
    sId: 1,
    name: "Информация об аксессуаре",
    type: "AccessoryInformation",
    characteristics,
  };
}

function buildCharacteristic(aId, sId, { cId, type, value, control = {} }) {
  const meta = CHARACTERISTIC_TYPES[type];
  if (!meta) throw new Error(`Unknown characteristic type ${type}`);
  const { format, write = false, read = true, events = true, ...rest } = meta;
  return {
    aId,
    sId,
    cId,
    hasOptions: false,
    control: {
      ...structuredClone(rest),
      type,
      read,
      write,
      events,
      value: { [FORMAT_FIELD[format]]: value },
      ...structuredClone(control),
    },
  };
}

function defaultValue(type) {
  const format = CHARACTERISTIC_TYPES[type]?.format;
  if (format === "bool") return false;
  if (format === "string") return "";
  return 0;
}

function homeSettingsWindow(hub) {
  const group = (key, name, inputType, parent) => ({
    key,
    name,
    type: "GenericInteger",
    inputType,
    parent,
    read: true,
    write: false,
    value: { intValue: 0 },
  });
  const status = (key, name, value) => ({
    key,
    name,
    type: "GenericString",
    inputType: "STATUS",
    parent: "clock",
    read: true,
    write: false,
    events: false,
    value: { stringValue: value },
  });
  const timeZone = hub.timeZone ?? "Europe/Moscow";
  return {
    windowKey: "",
    label: { text: "Настройки хаба" },
    options: [
      group("main", "Основное", "GROUP", ""),
      group("datetime", "Дата и время", "FOLDER", "main"),
      group("clock", "Часы", "GROUP", "datetime"),
      {
        key: "TimeZone",
        name: "Часовой пояс",
        type: "GenericString",
        inputType: "LIST",
        parent: "clock",
        read: true,
        write: true,
        events: false,
        value: { stringValue: timeZone },
        validValues: [
          { name: "Москва", value: { stringValue: "Europe/Moscow" } },
          { name: "UTC", value: { stringValue: "UTC" } },
        ],
      },
      status("Time", "Время", hub.clock ?? "2026-09-24 - 12:00:00 (GMT+03:00)"),
      status("Sunrise", "Восход", hub.sunrise ?? "06:32"),
      status("Sunset", "Закат", hub.sunset ?? "18:41"),
      // The search time of device searches, a choice of 1 to 60 minutes
      // that showed 60 on the owner's hub (2026-10-12-device-pairing H8);
      // its value is in seconds, as the search started there ended 60 s
      // later (P1). Its parent and choice names were not recorded. window.get
      // shows the simulator's discoveryTimeMs (withDiscoveryTime).
      {
        key: "DiscoveryTime",
        name: "Время поиска устройств",
        type: "GenericInteger",
        inputType: "LIST",
        parent: "main",
        read: true,
        write: true,
        events: false,
        value: { intValue: 60 },
        validValues: [1, 3, 5, 10, 30, 60].map((minutes) => ({
          name: `${minutes} мин`,
          value: { intValue: minutes * 60 },
        })),
      },
    ],
  };
}

// The hub settings window as window.get shows it: DiscoveryTime is the
// simulator's discoveryTimeMs, which a test may change at any moment, in
// whole seconds (a test's sub-minute time rounds up).
function withDiscoveryTime(state, window) {
  const view = structuredClone(window);
  const option = view.options.find(({ key }) => key === "DiscoveryTime");
  if (option) {
    option.value = { intValue: Math.ceil(state.discoveryTimeMs / 1_000) };
  }
  return view;
}

// The instant a hub-local wall clock ("12:00" or "12:00:00") falls on the
// hub-local date of now.
function atHubTime(wallClock, utcOffsetMinutes, now) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallClock);
  if (!match) throw new Error(`hubTime ${wallClock} is not HH:MM[:SS]`);
  const [hours, minutes, seconds] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const offsetMs = utcOffsetMinutes * 60_000;
  const localDate = new Date(now + offsetMs);
  return (
    Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate(),
      hours,
      minutes,
      seconds,
    ) - offsetMs
  );
}

// The hub's clock: the machine's, moved by the start's hubTime.
function hubNow(state) {
  return Date.now() + state.clockOffsetMs;
}

// Wall clock of the hub settings window: "2026-09-24 - 21:40:12 (GMT+03:00)".
function hubClock(now, utcOffsetMinutes) {
  const local = new Date(now + utcOffsetMinutes * 60_000).toISOString();
  const sign = utcOffsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(utcOffsetMinutes);
  const zone = `${String(Math.floor(offset / 60)).padStart(2, "0")}:${String(offset % 60).padStart(2, "0")}`;
  return `${local.slice(0, 10)} - ${local.slice(11, 19)} (GMT${sign}${zone})`;
}

const DEFAULT_LOG_CAPACITY = 128;

// Native log entries {time, level, path, message}, oldest first, cut to the
// ring buffer. A fixture entry is placed at day (calendar offset from the
// start's hub-local date) and time (hub-local wall clock), or minutesAgo
// (+ offsetMs) before the start; a recurring group repeats its entries
// (4 ms apart, shifted by offsetMs) every everyMinutes from firstMinutesAgo. Entries after the
// start are dropped.
function seedLog(log, now) {
  if (!log) return [];
  const offsetMs = (log.utcOffsetMinutes ?? 0) * 60_000;
  const local = new Date(now + offsetMs);
  const localMidnight =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    offsetMs;
  const placed = (log.entries ?? []).map(
    ({ day, time: wallClock, minutesAgo, offsetMs: extra, ...entry }) => {
      if (typeof minutesAgo === "number") {
        return { time: now - minutesAgo * 60_000 + (extra ?? 0), ...entry };
      }
      const [hours, minutes, seconds] = wallClock.split(":").map(Number);
      return {
        time:
          localMidnight +
          day * 86_400_000 +
          (hours * 3_600 + minutes * 60) * 1_000 +
          Math.round(seconds * 1_000),
        ...entry,
      };
    },
  );
  for (const group of log.recurring ?? []) {
    for (let repeat = 0; repeat < group.times; repeat += 1) {
      const start =
        now -
        (group.firstMinutesAgo - repeat * group.everyMinutes) * 60_000 +
        (group.offsetMs ?? 0);
      group.entries.forEach((entry, index) => {
        placed.push({ time: start + index * 4, ...entry });
      });
    }
  }
  return placed
    .filter(({ time }) => time <= now)
    .sort((left, right) => left.time - right.time)
    .slice(-(log.capacity ?? DEFAULT_LOG_CAPACITY));
}

function appendLog(state, entry) {
  const time = Math.max(hubNow(state), (state.log.at(-1)?.time ?? 0) + 1);
  state.log.push({ time, ...entry });
  if (state.log.length > state.logCapacity) {
    state.log.splice(0, state.log.length - state.logCapacity);
  }
}

// Every scenario has an options window. On the owner's hub (3.0.0,
// 2026-09-24) scenario.list carried optionsWindow for every BLOCK, LOGIC,
// predefined LOGIC and GLOBAL, and the windows of a BLOCK
// (live-conformance-2) and of a LOGIC, a GLOBAL and a predefined scenario
// (live-conformance-3-read-only) had the same options: main, primary, footer
// (GROUP), Name (TEXT), Active, OnStart, Sync (CHECKBOX), Desc
// (TEXT_MULTILINE) and Remove (BUTTON_DANGER), all writable and not disabled,
// labelled as below (2026-10-13-wave4-contracts 1.1); the order here is the
// simulator's own. A BLOCK's and a GLOBAL's window stores no values of the
// scenario-backed options: window.get shows the scenario's fields in them. A
// LOGIC's window keeps its own Name, Desc and OnStart (windowKeepsOwnValue):
// shown, the values the scenario opened with or create sent.
function addScenarioWindow(state, scenario, shown) {
  scenario.optionsWindow = scenarioWindowKey(state);
  // The groups and the Remove button: no value, type or access recorded.
  const control = (key, name, inputType) => ({ key, name, inputType });
  const option = (key, name, type, inputType) => ({
    key,
    name,
    type,
    inputType,
    read: true,
    write: true,
    disabled: false,
  });
  const window = {
    windowKey: scenario.optionsWindow,
    label: { text: "Настройки сценария" },
    options: [
      control("main", "Основное", "GROUP"),
      control("primary", "Сценарий", "GROUP"),
      option("Name", "Название", "GenericString", "TEXT"),
      option("Active", "Активный", "GenericBoolean", "CHECKBOX"),
      option(
        "OnStart",
        "Выполнить на старте хаба",
        "GenericBoolean",
        "CHECKBOX",
      ),
      option(
        "Sync",
        "Последовательное выполнение",
        "GenericBoolean",
        "CHECKBOX",
      ),
      option("Desc", "Описание", "GenericString", "TEXT_MULTILINE"),
      control("footer", "", "GROUP"),
      control("Remove", "Удалить", "BUTTON_DANGER"),
    ],
  };
  // A built-in LOGIC's window shows placeholders, OnStart on whatever the
  // scenario's flag (2026-10-13-wave4-contracts 1.11).
  const kept =
    scenario.predefined === true
      ? { name: "name", desc: "desc", onStart: true }
      : shown;
  for (const item of window.options) {
    const field = SCENARIO_WINDOW_FIELDS[item.key];
    if (field && windowKeepsOwnValue(scenario, item.key)) {
      item.value = { [field.kind]: kept[field.name] };
    }
  }
  state.windows[scenario.optionsWindow] = window;
}

// The scenario field each scenario-backed option of the window shows.
const SCENARIO_WINDOW_FIELDS = {
  Name: { name: "name", kind: "stringValue" },
  Active: { name: "active", kind: "boolValue" },
  OnStart: { name: "onStart", kind: "boolValue" },
  Sync: { name: "sync", kind: "boolValue" },
  Desc: { name: "desc", kind: "stringValue" },
};
const SCENARIO_METADATA_OPTIONS = new Set(["Name", "Desc", "OnStart", "Sync"]);
const SCENARIO_METADATA_FIELDS = ["name", "desc", "onStart", "sync"];

// A LOGIC's window keeps the Name, Desc and OnStart last written to it or
// sent at create and does not follow what its code sets; a built-in LOGIC's
// shows placeholders there. Active and Sync agree with scenario.get
// (2026-10-13-wave4-contracts 1.7, 1.11).
function windowKeepsOwnValue(scenario, key) {
  return (
    scenario.type === "LOGIC" &&
    (key === "Name" || key === "Desc" || key === "OnStart")
  );
}

// Writes to a scenario's options window that the simulator applies: Name,
// Desc, OnStart and Sync of a user BLOCK, LOGIC or GLOBAL (2026-10-13-
// wave4-contracts 1.4, 1.8, 1.10) and Active of any scenario. Remove, and
// these options of a built-in scenario (its window was only read, 1.11),
// were never sent to a live hub; rather than invent their effect the
// simulator refuses the whole update as unsupported (-32601) before
// anything is stored.
function unmodelledScenarioWrite(scenario, key) {
  if (key === "Remove") return true;
  return SCENARIO_METADATA_OPTIONS.has(key) && scenario.predefined === true;
}

function checkScenarioWindowUpdate(scenario, options) {
  if (!Array.isArray(options)) throw invalidParams("options must be an array");
  for (const option of options) {
    if (unmodelledScenarioWrite(scenario, option?.key)) {
      throw new SimulatorError(
        -32601,
        `unsupported by simulator: window.update {${option.key}} of a ${scenario.predefined === true ? "built-in " : ""}${scenario.type} scenario`,
      );
    }
    const field = SCENARIO_WINDOW_FIELDS[option?.key];
    const type = field?.kind === "boolValue" ? "boolean" : "string";
    if (field && typeof option.value?.[field.kind] !== type) {
      throw invalidParams(`${option.key} must be a ${field.kind}`);
    }
  }
}

// A bridge's options window with the one option read on the owner's hub:
// AutoAddNewAccessory was false on all four bridges (live-conformance-2).
// Its other options are not modelled.
function bridgeWindows(extensions) {
  return Object.fromEntries(
    extensions
      .filter(({ bundleType, optionsWindow }) => {
        return bundleType === "BRIDGE" && optionsWindow;
      })
      .map(({ name, optionsWindow }) => [
        optionsWindow,
        {
          windowKey: optionsWindow,
          label: { text: name },
          options: [
            {
              key: "AutoAddNewAccessory",
              name: "Добавлять новые аксессуары",
              type: "GenericBoolean",
              inputType: "CHECKBOX",
              parent: "",
              read: true,
              write: true,
              disabled: false,
              value: { boolValue: false },
            },
          ],
        },
      ]),
  );
}

const SCENARIO_WINDOW_PREFIX = "scenario-options-";

function scenarioWindowKey(state) {
  return `${SCENARIO_WINDOW_PREFIX}${state.nextWindow++}`;
}

function scenarioOfWindow(state, windowKey) {
  if (typeof windowKey !== "string") return undefined;
  return state.scenarios.find(
    (candidate) => candidate.optionsWindow === windowKey,
  );
}

// The hub adds editor blockIds (and runtime `state` on `if`) to stored BLOCK
// data, and rejects a direct characteristic as an `if` predicate.
const BLOCK_CHILDREN = {
  root: ["targets"],
  if: ["if", "then", "else"],
  condition: ["conditions"],
  interval: ["start", "end"],
  service: ["characteristics"],
  delay: ["targets"],
};

function normalizeBlockData(data) {
  let parsed;
  try {
    parsed = typeof data === "string" ? JSON.parse(data) : null;
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.targets)) {
    throw new SimulatorError(
      400,
      "BLOCK data must be a JSON object with targets",
    );
  }
  let nextBlockId = 1;
  const visit = (node, kind) => {
    if (!isRecord(node)) return structuredClone(node);
    if (kind === "if" && node.if?.type === "characteristic") {
      throw new SimulatorError(400, "if predicate must be a condition group");
    }
    // Live data lists blockId right after type; `if` also carries state.
    const { type, blockId: _blockId, state: _state, ...rest } = node;
    const normalized =
      kind === "root"
        ? { blockId: 0, ...structuredClone(rest) }
        : {
            type,
            blockId: nextBlockId++,
            ...structuredClone(rest),
            ...(kind === "if" ? { state: false } : {}),
          };
    // The hub stores inc/dec values as numbers even when sent as strings;
    // set values stay strings (owner hub, 2026-09-24).
    if (
      (kind === "inc" || kind === "dec") &&
      typeof normalized.value === "string" &&
      normalized.value.trim() !== "" &&
      Number.isFinite(Number(normalized.value))
    ) {
      normalized.value = Number(normalized.value);
    }
    // The hub drops a from action's value "", a notify's to null and the
    // clients null of a recipient entry (owner hub, 3.0.0,
    // 2026-09-25-live-conformance-4).
    if (kind === "from" && normalized.value === "") delete normalized.value;
    if (kind === "notify" && normalized.to === null) delete normalized.to;
    if (kind === "notify" && Array.isArray(normalized.to)) {
      for (const entry of normalized.to) {
        if (isRecord(entry) && entry.clients === null) delete entry.clients;
      }
    }
    for (const key of BLOCK_CHILDREN[kind] ?? []) {
      if (Array.isArray(node[key])) {
        normalized[key] = node[key].map((child) => visit(child, child?.type));
      } else if (isRecord(node[key])) {
        normalized[key] = visit(node[key], node[key].type);
      }
    }
    return normalized;
  };
  return JSON.stringify(visit(parsed, "root"));
}

function blockNodes(data) {
  const nodes = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isRecord(value)) {
      nodes.push(value);
      for (const child of Object.values(value)) visit(child);
    }
  };
  try {
    visit(JSON.parse(data));
  } catch {}
  return nodes;
}

function blockRooms(state, data) {
  const rooms = new Set();
  for (const node of blockNodes(data)) {
    if (!Number.isInteger(node.aId)) continue;
    const accessory = state.accessories.find(({ id }) => id === node.aId);
    if (accessory) rooms.add(accessory.roomId);
  }
  return [...rooms].sort((left, right) => left - right);
}

function scenarioReferencesAccessory(scenario, aId) {
  if (scenario.type !== "BLOCK") return false;
  return blockNodes(scenario.data).some((node) => node.aId === aId);
}

// Executes the literal service/set actions at the top level of a BLOCK.
// Conditional branches and delays are not evaluated; they are reported as
// skipped in state.runs so a test can see the simulator limit.
function runScenario(state, scenario) {
  const run = {
    index: scenario.index,
    at: new Date().toISOString(),
    executed: [],
    skipped: [],
  };
  if (scenario.type !== "BLOCK") {
    run.skipped.push({ type: scenario.type });
    return run;
  }
  // SprutHub 3.0.0 acknowledged a run of a turned-off BLOCK and ran none of
  // its actions (live-conformance-3).
  if (scenario.active !== true) {
    run.skipped.push({ type: scenario.type, active: false });
    return run;
  }
  for (const target of JSON.parse(scenario.data).targets) {
    if (target.type !== "service") {
      run.skipped.push({ type: target.type, blockId: target.blockId });
      continue;
    }
    for (const action of target.characteristics ?? []) {
      const characteristic = findCharacteristic(state, {
        aId: target.aId,
        sId: target.sId,
        cId: action.cId,
      });
      if (action.type !== "set" || !characteristic) {
        run.skipped.push({ type: action.type, blockId: action.blockId });
        continue;
      }
      characteristic.control.value = nativeValue(
        characteristic.control.value,
        action.value,
      );
      state.emitAfterReply?.(valueEvent(characteristic));
      run.executed.push({ aId: target.aId, sId: target.sId, cId: action.cId });
    }
  }
  return run;
}

// BLOCK set/condition values are native scalars as strings.
function nativeValue(current, text) {
  const [field] = Object.keys(current);
  return {
    [field]:
      field === "boolValue"
        ? text === "true"
        : field === "stringValue"
          ? text
          : Number(text),
  };
}

function nativeText(value) {
  return String(firstValue(value));
}

// Grader-side evaluation of the home's active BLOCK rules for one
// characteristic change: preset values are applied silently, then change is
// applied and every active BLOCK with a trigger leaf on that characteristic
// fires once. A fired BLOCK runs all its top-level steps in order, as the
// editor lays them out (not observed on a hub): service/set actions, ifs
// with condition groups (AND/OR) of characteristic leaves (=, ==, !=, <>,
// >, <, >=, <=), then/else branches, nested ifs, RESET delays and
// clear_delay. An if without mode is EVERY; ONCE runs a branch only when
// the condition differs from its value before the change. A RESET delay
// runs its steps when it ends inside windowMs after the change, so a
// switch-off after 0 or 120 ms leaves the light off; a longer one is only
// listed in skipped. Actions do not trigger further rules. A hold ">"
// ("has not changed for") is false while its leaf does not hold, and false
// inside the window on the changed characteristic when it is at least
// windowMs long, since that value is younger. Anything else (another hold,
// a repeating branch, another delay mode, interval, cron, code, toggle,
// unknown refs) is reported as unsupported rather than guessed. It is not a
// model of the hub's scheduler.
//
// A trigger inside a nested «Если» runs only its own part after the
// conditions above it are checked (vendor wiki «Триггеры в сценариях»),
// while a trigger of a top-level «Если» is read as running the whole
// BLOCK. For a nested trigger both readings are run; where their values
// differ, or its own part cannot be run, the BLOCK is unsupported.
const RULE_WINDOW_MS = 10_000;

export function evaluateRulesOnChange(
  state,
  { preset = [], change, windowMs = RULE_WINDOW_MS },
) {
  const home = { accessories: structuredClone(state.accessories) };
  const set = ({ aId, sId, cId, value }) => {
    const characteristic = findCharacteristic(home, { aId, sId, cId });
    if (!characteristic) {
      throw new Error(`No characteristic ${aId}.${sId}.${cId}`);
    }
    characteristic.control.value = nativeValue(
      characteristic.control.value,
      String(value),
    );
  };
  for (const value of preset) set(value);
  const before = characteristicValues(home);
  const previous = structuredClone(home);
  set(change);
  const result = { fired: [], writes: [], skipped: [], unsupported: [] };
  for (const scenario of state.scenarios) {
    if (scenario.type !== "BLOCK" || scenario.active !== true) continue;
    const data = JSON.parse(scenario.data);
    if (!blockNodes(scenario.data).some((node) => isTrigger(node, change))) {
      continue;
    }
    result.fired.push(scenario.index);
    const fire = (target, steps) =>
      fireRule(
        { home: target, previous, index: scenario.index, change, windowMs },
        steps,
      );
    const paths = triggerPaths(data.targets, change);
    if (paths.length > 0 && paths.every((path) => path.length > 1)) {
      const whole = fire(structuredClone(home), (run) =>
        runRuleActions(run, data.targets),
      );
      const own = fire(structuredClone(home), (run) =>
        paths.forEach((path) => {
          runOwnPart(run, path);
        }),
      );
      if (
        own.result.unsupported.length > 0 ||
        JSON.stringify(characteristicValues(whole.home)) !==
          JSON.stringify(characteristicValues(own.home))
      ) {
        result.unsupported.push({
          index: scenario.index,
          node: "nested trigger",
        });
        continue;
      }
    }
    const { result: fired } = fire(home, (run) =>
      runRuleActions(run, data.targets),
    );
    for (const key of ["writes", "skipped", "unsupported"]) {
      result[key].push(...fired[key]);
    }
  }
  const after = characteristicValues(home);
  const eventKey = characteristicKey(change);
  result.changed = Object.keys(after)
    .filter((key) => key !== eventKey && before[key] !== after[key])
    .map((key) => ({ key, before: before[key], after: after[key] }));
  result.after = after;
  return result;
}

// Runs steps of one fired BLOCK on home, then its timers that end inside
// the window, in the order they end.
function fireRule({ home, previous, index, change, windowMs }, steps) {
  const result = { writes: [], skipped: [], unsupported: [] };
  const run = {
    home,
    previous,
    result,
    index,
    now: 0,
    timers: [],
    change,
    windowMs,
  };
  steps(run);
  for (;;) {
    run.timers.sort((left, right) => left.at - right.at);
    const timer = run.timers.shift();
    if (!timer) break;
    if (timer.at >= windowMs) {
      result.skipped.push({ index, node: "delay", time: timer.time });
      continue;
    }
    run.now = timer.at;
    runRuleActions(run, timer.targets);
  }
  return { home, result };
}

// For every if whose condition holds a trigger leaf on change, the path to
// it: the ifs above it, each with the branch that leads down ("then" or
// "else"), or a delay on the way, and last the if itself. A path of one
// step: a top-level if.
function triggerPaths(steps, change, above = []) {
  const paths = [];
  for (const node of steps ?? []) {
    if (node?.type === "if") {
      if (conditionLeaves(node.if).some((leaf) => isTrigger(leaf, change))) {
        paths.push([...above, { node, branch: null }]);
      }
      for (const branch of ["then", "else"]) {
        paths.push(
          ...triggerPaths(node[branch], change, [...above, { node, branch }]),
        );
      }
    } else if (node?.type === "delay") {
      paths.push(
        ...triggerPaths(node.targets, change, [
          ...above,
          { node, branch: null },
        ]),
      );
    }
  }
  return paths;
}

function conditionLeaves(node) {
  if (!node || typeof node !== "object") return [];
  if (node.type === "condition") {
    return (node.conditions ?? []).flatMap(conditionLeaves);
  }
  return [node];
}

// A nested trigger's own part: each if above it must be an EVERY if whose
// condition selects the branch that leads down, then the trigger's if
// runs. A delay or another mode on the way cannot be run.
function runOwnPart(run, path) {
  for (const { node, branch } of path.slice(0, -1)) {
    if (node.type !== "if" || (node.mode ?? "EVERY") !== "EVERY") {
      run.result.unsupported.push({ index: run.index, node: "nested trigger" });
      return;
    }
    const verdict = evaluateRuleCondition(
      run.home,
      node.if,
      run.result.unsupported,
      run.index,
      { change: run.change, windowMs: run.windowMs },
    );
    if (verdict === null) return;
    if (verdict !== (branch === "then")) return;
  }
  runRuleIf(run, path.at(-1).node);
}

// Refs of a BLOCK that do not resolve in the home, or whose hs/hc do not
// match the service and characteristic types.
export function blockRefProblems(state, data) {
  const problems = [];
  const home = { accessories: state.accessories };
  for (const node of blockNodes(data)) {
    if (node.type === "characteristic") {
      const characteristic = findCharacteristic(home, node);
      const service = findService(home, node);
      if (!characteristic) {
        problems.push(`characteristic ${characteristicKey(node)} is missing`);
      } else if (
        node.hc !== characteristic.control.type ||
        node.hs !== service.type
      ) {
        problems.push(
          `characteristic ${characteristicKey(node)} is ${service.type}.${characteristic.control.type}, not ${node.hs}.${node.hc}`,
        );
      }
    }
    if (node.type === "service") {
      const service = findService(home, node);
      if (!service) {
        problems.push(`service ${node.aId}.${node.sId} is missing`);
        continue;
      }
      if (node.hs !== service.type) {
        problems.push(
          `service ${node.aId}.${node.sId} is ${service.type}, not ${node.hs}`,
        );
      }
      for (const action of node.characteristics ?? []) {
        const characteristic = service.characteristics.find(
          ({ cId }) => cId === action.cId,
        );
        if (!characteristic || characteristic.control.type !== action.hc) {
          problems.push(
            `set ${node.aId}.${node.sId}.${action.cId} ${action.hc} does not match`,
          );
        }
      }
    }
  }
  return problems;
}

function findService(home, { aId, sId }) {
  return (
    home.accessories
      .find((accessory) => accessory.id === aId)
      ?.services.find((service) => service.sId === sId) ?? null
  );
}

function characteristicValues(home) {
  const values = {};
  for (const accessory of home.accessories) {
    for (const service of accessory.services) {
      for (const characteristic of service.characteristics) {
        values[characteristicKey(characteristic)] = firstValue(
          characteristic.control.value,
        );
      }
    }
  }
  return values;
}

function isTrigger(node, target) {
  return (
    node.type === "characteristic" &&
    node.trigger === true &&
    node.aId === target.aId &&
    node.sId === target.sId &&
    node.cId === target.cId
  );
}

// true, false, or null with the reason in unsupported (when given). within
// is { change, windowMs } for the values inside the evaluation window, and
// null for the values before the change, whose age is unknown.
function evaluateRuleCondition(home, node, unsupported, index, within = null) {
  if (node?.type === "condition") {
    const values = (node.conditions ?? []).map((child) =>
      evaluateRuleCondition(home, child, unsupported, index, within),
    );
    if (values.includes(null)) return null;
    if (node.mode === "OR") return values.some(Boolean);
    if (node.mode === "AND") return values.every(Boolean);
  }
  const held =
    node?.type === "characteristic" &&
    ((node.timeCond ?? "") !== "" || (node.time ?? 0) !== 0);
  if (node?.type === "characteristic") {
    const characteristic = findCharacteristic(home, node);
    const verdict = characteristic
      ? compareNative(nativeText(characteristic.control.value), node)
      : null;
    if (!held && verdict !== null) return verdict;
    // "Has not changed for": false while the leaf does not hold, and false
    // inside the window on the value that just changed when the hold is at
    // least as long as the window. Other holds need time the grader does
    // not run.
    if (node.timeCond === ">" && verdict === false) return false;
    if (
      node.timeCond === ">" &&
      verdict === true &&
      within !== null &&
      characteristicKey(node) === characteristicKey(within.change) &&
      node.time >= within.windowMs
    ) {
      return false;
    }
  }
  unsupported?.push({
    index,
    node: node?.type ?? null,
    ...(node?.cond ? { cond: node.cond } : {}),
    ...(held ? { hold: `${node.timeCond ?? ""} ${node.time ?? 0}` } : {}),
  });
  return null;
}

function compareNative(actual, { cond, value }) {
  const expected = String(value);
  const numbers = [Number(actual), Number(expected)];
  const numeric =
    actual.trim() !== "" &&
    expected.trim() !== "" &&
    numbers.every(Number.isFinite);
  const equal = numeric ? numbers[0] === numbers[1] : actual === expected;
  if (cond === "=" || cond === "==") return equal;
  if (cond === "!=" || cond === "<>") return !equal;
  if (!numeric) return null;
  if (cond === ">") return numbers[0] > numbers[1];
  if (cond === "<") return numbers[0] < numbers[1];
  if (cond === ">=") return numbers[0] >= numbers[1];
  if (cond === "<=") return numbers[0] <= numbers[1];
  return null;
}

function runRuleIf(run, node) {
  const { result, index } = run;
  const mode = node.mode ?? "EVERY";
  const repeats = ["then_delay", "else_delay"].filter(
    (key) => (node[key] ?? 0) !== 0,
  );
  if ((mode !== "EVERY" && mode !== "ONCE") || repeats.length > 0) {
    result.unsupported.push({
      index,
      node: "if",
      ...(repeats.length > 0 ? { repeats } : { mode }),
    });
    return;
  }
  const verdict = evaluateRuleCondition(
    run.home,
    node.if,
    result.unsupported,
    index,
    { change: run.change, windowMs: run.windowMs },
  );
  if (verdict === null) return;
  if (mode === "ONCE") {
    // The value before the change stands in for the stored if state, which
    // is known only for the change itself, not later inside a delay.
    const earlier =
      run.now === 0
        ? evaluateRuleCondition(run.previous, node.if, null, index)
        : null;
    if (earlier === null) {
      result.unsupported.push({ index, node: "if", mode });
      return;
    }
    if (earlier === verdict) return;
  }
  runRuleActions(run, verdict ? node.then : node.else);
}

function runRuleActions(run, nodes) {
  const { home, result, index } = run;
  for (const node of nodes ?? []) {
    if (node.type === "if") {
      runRuleIf(run, node);
    } else if (node.type === "delay") {
      if (
        node.mode !== "RESET" ||
        !Number.isFinite(node.time) ||
        node.time < 0
      ) {
        result.unsupported.push({ index, node: "delay", mode: node.mode });
        continue;
      }
      // A RESET delay started again replaces its running timer.
      run.timers = run.timers.filter((timer) => timer.delay !== node.index);
      run.timers.push({
        delay: node.index,
        at: run.now + node.time,
        time: node.time,
        targets: node.targets,
      });
    } else if (node.type === "clear_delay") {
      run.timers = run.timers.filter(
        (timer) => node.index !== 0 && timer.delay !== node.index,
      );
    } else if (node.type === "service") {
      for (const action of node.characteristics ?? []) {
        const characteristic = findCharacteristic(home, {
          aId: node.aId,
          sId: node.sId,
          cId: action.cId,
        });
        if (action.type !== "set" || !characteristic) {
          result.unsupported.push({ index, node: action.type ?? null });
          continue;
        }
        characteristic.control.value = nativeValue(
          characteristic.control.value,
          String(action.value),
        );
        result.writes.push({
          index,
          key: characteristicKey({
            aId: node.aId,
            sId: node.sId,
            cId: action.cId,
          }),
          value: String(action.value),
          at: run.now,
        });
      }
    } else {
      result.unsupported.push({ index, node: node.type ?? null });
    }
  }
}

// SprutHub 3.0.0 (owner hub, 2026-09-24, live-conformance-3): a user LOGIC's
// native type is the string of its scenario index.
function logicTypeForScenario(index) {
  return String(index);
}

// The hub takes a LOGIC's name, description and onStart from info in its
// code: a create kept info.name (2026-09-24-live-conformance-2), a source
// update of info.name renamed the scenario (2026-09-24-live-conformance-3),
// and every code write and create sets all three again, unchanged or not
// (2026-10-13-wave4-contracts 1.5, 1.6). The hub runs the code; so does the
// simulator, its top level in an empty context where HS and HC name types,
// so info is read as code, not by matching its text. A field info lacks,
// or code that does not run here, leaves the scenario's value as it is
// (not observed). The context holds no object of this process (an agent
// under evaluation writes the code); node:vm is still no security boundary.
function logicInfo(source) {
  const context = vm.createContext(Object.create(null));
  vm.runInContext(
    'HS = new Proxy({}, { get: (_, key) => typeof key === "string" ? key : undefined }); HC = HS;',
    context,
  );
  try {
    vm.runInContext(source, context, { timeout: 100 });
  } catch {
    // Assumed, not observed: the hub still takes info that the code's top
    // level assigned before it threw (here, often on a name such as Hub
    // that this empty context lacks).
  }
  try {
    const info = vm.runInContext(
      'typeof info === "undefined" ? undefined : info',
      context,
    );
    return isRecord(info) ? info : undefined;
  } catch {
    return undefined;
  }
}

function applyLogicInfo(scenario) {
  const info = logicInfo(scenario.data);
  if (typeof info?.name === "string") scenario.name = info.name;
  if (typeof info?.description === "string") scenario.desc = info.description;
  if (typeof info?.onStart === "boolean") scenario.onStart = info.onStart;
}

function logicSourceServices(source) {
  const list = /sourceServices\s*:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "";
  return [...list.matchAll(/HS\.(\w+)/g)].map(([, type]) => type);
}

// A user LOGIC's type is listed on the services of its sourceServices only
// while the LOGIC is on, with the scenario's current name and description
// (owner hub, 2026-09-24, live-conformance-3; listing on every service of
// sourceServices is assumed from the one anchor observed).
function availableLogicTypes(state, service) {
  const builtIn = state.logicCatalog[service.type] ?? [];
  const user = state.scenarios
    .filter(
      (scenario) =>
        scenario.type === "LOGIC" &&
        scenario.active === true &&
        logicSourceServices(scenario.data).includes(service.type),
    )
    .map((scenario) => ({
      type: logicTypeForScenario(scenario.index),
      name: scenario.name,
      desc: scenario.desc,
    }));
  return [...builtIn, ...user];
}

function logicOptions(state, { aId, sId, type }) {
  const key = `${aId}.${sId}.${type}`;
  if (!state.logicOptionValues[key]) {
    const service = requireService(state, aId, sId);
    const logicType = availableLogicTypes(state, service).find(
      (candidate) => candidate.type === type,
    );
    state.logicOptionValues[key] = structuredClone(logicType?.options ?? []);
  }
  return state.logicOptionValues[key];
}

// Children of an extension: the recipients a fixture declares on a
// notification service (the owner's web service lists one, id "2", on
// 2026-09-24), then the devices of a controller, then the devices still
// joining it. A bridge lists the accessories it can export instead.
function extensionChildren(state, extensionKey) {
  const extension = state.extensions.find(
    (candidate) => candidate.extensionKey === extensionKey,
  );
  if (extension?.bundleType === "BRIDGE") {
    return bridgeChildren(state, extension);
  }
  const declared = (extension?.children ?? []).map((child) => ({
    extensionKey,
    id: child.id,
    spaceKey: "main",
    name: child.name,
    online: child.online ?? true,
    optionsWindow: child.optionsWindow ?? "",
  }));
  const devices = state.accessories
    .filter(
      (accessory) =>
        accessory.extensionKey === extensionKey && accessory.virtual !== true,
    )
    .map((accessory) => ({
      extensionKey,
      id: accessory.deviceId,
      spaceKey: "main",
      name: accessory.name,
      online: accessory.online,
      optionsWindow: accessory.deviceWindow ?? "",
      description: `Устройство ${accessory.deviceId}`,
      status: accessory.online ? "В сети" : "Не в сети",
    }));
  const joining = state.joining
    .filter((child) => child.extensionKey === extensionKey)
    .map((child) => structuredClone(child));
  return [...declared, ...devices, ...joining];
}

// A bridge (HomeKit, Yandex, Google) lists one child per accessory it can
// export, the accessory id as its id, in main when exported and in
// notConnected when not, and the child's window under
// <extensionKey with / for :>/Child/<aId>/; a new accessory shows in every
// bridge as notConnected (owner's hub, 2026-10-13-wave4-contracts 3.2, 3.4).
// A bridge lists an accessory with at least one service it can export
// (BRIDGE_SERVICES_LEFT_OUT; 2026-10-14-bridge-export-write 12, 13). A
// fixture bridge names its exported services by accessory id (exported:
// {"16": [13]}) and may leave out more accessories (unexportable: [39]).
// The child's name and online are the accessory's (assumed).
function bridgeChildren(state, extension) {
  const unexportable = new Set(extension.unexportable ?? []);
  return state.accessories
    .filter(
      (accessory) =>
        !unexportable.has(accessory.id) &&
        bridgeExportableServices(extension, accessory).length > 0,
    )
    .map((accessory) => ({
      extensionKey: extension.extensionKey,
      id: String(accessory.id),
      spaceKey:
        bridgeExportedServices(extension, accessory).size > 0
          ? "main"
          : "notConnected",
      name: accessory.name,
      online: accessory.online,
      optionsWindow: bridgeChildWindowKey(extension, accessory.id),
    }));
}

// Service types whose bridge child window has no checkbox, by bridge type,
// as read on the owner's hub; HomeKit had one for every service but the
// accessory information. SecuritySystem was never listed by Yandex or
// Google (2026-10-14-bridge-export-write 12, 13).
const BRIDGE_SERVICES_LEFT_OUT = {
  google: new Set([
    "StatelessProgrammableSwitch",
    "LightSensor",
    "FilterMaintenance",
    "C_WattMeter",
    "C_VoltMeter",
    "C_AmpereMeter",
    "C_KiloWattHourMeter",
    "C_TemperatureControl",
    "SecuritySystem",
  ]),
  yandex: new Set([
    "FilterMaintenance",
    "C_TemperatureControl",
    "SecuritySystem",
  ]),
};

function bridgeExportableServices(extension, accessory) {
  const leftOut = BRIDGE_SERVICES_LEFT_OUT[extension.type];
  return accessory.services.filter(
    ({ type }) => type !== "AccessoryInformation" && !leftOut?.has(type),
  );
}

function bridgeExportedServices(extension, accessory) {
  const exportable = new Set(
    bridgeExportableServices(extension, accessory).map(({ sId }) => sId),
  );
  return new Set(
    (extension.exported?.[accessory.id] ?? []).filter((sId) =>
      exportable.has(sId),
    ),
  );
}

function bridgeChildWindowKey(extension, aId) {
  return `${extension.extensionKey.replaceAll(":", "/")}/Child/${aId}/`;
}

// The bridge whose child window key this is, listed or not.
function bridgeOfChildWindowKey(state, windowKey) {
  const match = /^(.+)\/Child\/\d+\/$/.exec(windowKey ?? "");
  return match
    ? (state.extensions.find(
        (extension) =>
          extension.bundleType === "BRIDGE" &&
          extension.extensionKey.replaceAll(":", "/") === match[1],
      ) ?? null)
    : null;
}

// The listed bridge child whose window this is, with its bridge and
// accessory; null otherwise.
function bridgeChildOfWindow(state, windowKey) {
  const extension = bridgeOfChildWindowKey(state, windowKey);
  if (!extension) return null;
  const child = bridgeChildren(state, extension).find(
    ({ optionsWindow }) => optionsWindow === windowKey,
  );
  if (!child) return null;
  const accessory = state.accessories.find(({ id }) => String(id) === child.id);
  return { extension, child, accessory };
}

// A bridge child's window, in the order and form read on the owner's hub:
// groups main and AccessoryGroup (no label, write true), the accessory as a
// read-only ACCESSORY_LIST and a CHECKBOX s:<sId> per service the bridge
// can export, labelled with the service name, true when it exports it; it
// reads for a bridge that does not run too (2026-10-13-wave4-contracts 3.3;
// 2026-10-14-bridge-export-write 3, 12).
function bridgeChildWindow(state, windowKey) {
  const found = bridgeChildOfWindow(state, windowKey);
  if (!found) return null;
  const { extension, accessory } = found;
  const exported = bridgeExportedServices(extension, accessory);
  const group = (key) => ({
    key,
    name: "",
    type: "GenericInteger",
    inputType: "GROUP",
    parent: "",
    read: true,
    write: true,
    events: true,
    value: { intValue: 0 },
  });
  return {
    windowKey,
    label: { text: accessory.name },
    options: [
      group("main"),
      {
        key: "Accessory",
        name: "",
        type: "GenericInteger",
        inputType: "ACCESSORY_LIST",
        parent: "AccessoryGroup",
        read: true,
        write: false,
        events: true,
        value: { intValue: 0 },
        validValues: [
          { value: { intValue: accessory.id }, name: accessory.name },
        ],
      },
      group("AccessoryGroup"),
      ...bridgeExportableServices(extension, accessory).map((service) => ({
        key: `s:${service.sId}`,
        name: service.name,
        type: "GenericBoolean",
        inputType: "CHECKBOX",
        parent: "main",
        read: true,
        write: true,
        events: true,
        value: { boolValue: exported.has(service.sId) },
      })),
    ],
  };
}

// window.update of a bridge child's window: each option a checkbox
// s:<sId> with a boolValue, all applied together; the child moves to main
// while one is ticked (2026-10-14-bridge-export-write 4-7). A write of its
// groups was not sent to a hub.
function updateBridgeExport({ extension, accessory }, options) {
  if (!Array.isArray(options)) throw invalidParams("options must be an array");
  const exportable = new Set(
    bridgeExportableServices(extension, accessory).map(({ sId }) => sId),
  );
  const updates = options.map((option) => {
    const sId = /^s:(\d+)$/.exec(option?.key ?? "")?.[1];
    if (sId === undefined) {
      if (["main", "AccessoryGroup", "Accessory"].includes(option?.key)) {
        throw new SimulatorError(
          -32601,
          `unsupported by simulator: window.update {${option.key}} of a bridge child`,
        );
      }
      throw invalidParams(`Unknown option ${option?.key}`);
    }
    if (!exportable.has(Number(sId))) {
      throw invalidParams(`Unknown option ${option.key}`);
    }
    if (typeof option.value?.boolValue !== "boolean") {
      throw invalidParams(`${option.key} must be a boolValue`);
    }
    return [Number(sId), option.value.boolValue];
  });
  const exported = bridgeExportedServices(extension, accessory);
  for (const [sId, on] of updates) {
    if (on) exported.add(sId);
    else exported.delete(sId);
  }
  extension.exported ??= {};
  if (exported.size > 0) {
    extension.exported[String(accessory.id)] = [...exported].sort(
      (left, right) => left - right,
    );
  } else {
    delete extension.exported[String(accessory.id)];
  }
  return {};
}

// An extension as the hub shows it: without what a fixture declares for
// its children (children, a bridge's exported and unexportable).
function extensionView(extension) {
  const {
    children: _children,
    exported: _exported,
    unexportable: _unexportable,
    ...view
  } = extension;
  return view;
}

// accessory.list on the owner's hub (3.0.0, 2026-09-24) had no virtual
// field for any accessory; accessory.get has it. Nor has it notify
// (2026-10-12-notifications-live).
function projectAccessory(accessory, expand) {
  const { services, virtual: _virtual, ...summary } = accessory;
  if (!expandIncludes(expand, "services")) return summary;
  return {
    ...summary,
    services: services.map(({ characteristics, ...service }) =>
      expandIncludes(expand, "characteristics")
        ? { ...service, characteristics: characteristics.map(withoutNotify) }
        : service,
    ),
  };
}

// Only accessory.get reports a characteristic's notification setting, on
// every characteristic, false where it was never set; accessory.list and
// characteristic.get leave it out whatever its value (owner hub, 3.0.0,
// 2026-10-12-notifications-live). The state keeps notify only where it was
// written or is on from the start.
function withNotify(accessory) {
  return mapCharacteristics(accessory, (characteristic) => ({
    ...characteristic,
    notify: characteristic.notify ?? false,
  }));
}

function withoutNotifyIn(accessory) {
  return mapCharacteristics(accessory, withoutNotify);
}

function withoutNotify({ notify: _notify, ...characteristic }) {
  return characteristic;
}

function mapCharacteristics(accessory, map) {
  return {
    ...accessory,
    services: accessory.services.map((service) => ({
      ...service,
      characteristics: service.characteristics.map(map),
    })),
  };
}

function expandIncludes(expand, part) {
  return (
    typeof expand === "string" &&
    expand.split(",").some((item) => item.trim() === part)
  );
}

// The owner's hub (3.0.0, 2026-09-24, live-conformance-3) kept the first 32
// characters of a room name on room.create, Cyrillic and Latin alike
// (characters, not bytes), and dropped emoji. room.update is assumed to keep
// a name the same way; which other characters it drops was not seen.
const ROOM_NAME_LIMIT = 32;

function storedRoomName(name) {
  return [...name]
    .filter((character) => character.codePointAt(0) <= 0xffff)
    .slice(0, ROOM_NAME_LIMIT)
    .join("");
}

function requireRoom(state, id) {
  const room = state.rooms.find((candidate) => candidate.id === id);
  if (!room) throw notFound(`Room ${id}`);
  return room;
}

function requireAccessory(state, id) {
  const accessory = state.accessories.find((candidate) => candidate.id === id);
  if (!accessory) throw notFound(`Accessory ${id}`);
  return accessory;
}

function requireService(state, aId, sId) {
  const service = requireAccessory(state, aId).services.find(
    (candidate) => candidate.sId === sId,
  );
  if (!service) throw notFound(`Service ${aId}.${sId}`);
  return service;
}

function findCharacteristic(state, { aId, sId, cId }) {
  return (
    state.accessories
      .find((accessory) => accessory.id === aId)
      ?.services.find((service) => service.sId === sId)
      ?.characteristics.find((characteristic) => characteristic.cId === cId) ??
    null
  );
}

function requireCharacteristic(state, input) {
  const characteristic = findCharacteristic(state, input);
  if (!characteristic)
    throw notFound(`Characteristic ${characteristicKey(input)}`);
  return characteristic;
}

function findLogic(state, input) {
  return state.logics.find((logic) => sameLogic(logic, input)) ?? null;
}

function requireLogic(state, input) {
  const logic = findLogic(state, input);
  if (!logic) throw notFound(`Logic ${input.type}`);
  return logic;
}

function sameLogic(left, right) {
  return (
    left.aId === right.aId && left.sId === right.sId && left.type === right.type
  );
}

function requireScenario(state, index) {
  const scenario = state.scenarios.find(
    (candidate) => candidate.index === index,
  );
  if (!scenario) throw notFound(`Scenario ${index}`);
  return scenario;
}

function characteristicKey({ aId, sId, cId }) {
  return `${aId}.${sId}.${cId}`;
}

// Stricter than the owner's hub, which acknowledges a value out of range or
// of another kind and coerces it (Brightness 150 → 100, −5 → 0 and off, a
// string → on at 100) and refuses only an unknown characteristic
// (2026-10-13-parallel-writes, 5). The product checks range and kind itself
// before any write; a test of that checks that no write was sent.
function checkedValue(control, value) {
  const fields = isRecord(value)
    ? VALUE_FIELDS.filter((field) => Object.hasOwn(value, field))
    : [];
  const [expected] = Object.keys(control.value ?? {});
  if (fields.length !== 1 || fields[0] !== expected) {
    throw invalidParams(`Expected ${expected} for ${control.type}`);
  }
  if (control.write !== true) {
    throw new SimulatorError(-32000, `${control.type} is read-only`);
  }
  const raw = value[expected];
  if (
    typeof raw === "number" &&
    ((typeof control.minValue === "number" && raw < control.minValue) ||
      (typeof control.maxValue === "number" && raw > control.maxValue))
  ) {
    throw invalidParams(`${control.type} value is out of range`);
  }
  return { [expected]: raw };
}

function applyOptions(options, updates) {
  if (!Array.isArray(updates)) throw invalidParams("options must be an array");
  for (const update of updates) {
    const option = options.find(({ key }) => key === update?.key);
    if (!option) throw invalidParams(`Unknown option ${update?.key}`);
    if (option.write !== true) {
      throw new SimulatorError(-32000, `Option ${option.key} is read-only`);
    }
    option.value = structuredClone(update.value);
  }
}

function withFixtureFaults(fixture, faults) {
  const stuck = new Set((faults.stuckActuators ?? []).map(({ aId }) => aId));
  const lamps = faults.lampLogic ?? [];
  if (stuck.size === 0 && lamps.length === 0) return fixture;
  return {
    ...fixture,
    accessories: fixture.accessories.map((accessory) =>
      stuck.has(accessory.id) ? { ...accessory, online: false } : accessory,
    ),
    logics: [
      ...(fixture.logics ?? []),
      ...lamps.map(({ aId, sId }) => ({
        aId,
        sId,
        type: "LightbulbControl",
        active: true,
      })),
    ],
  };
}

function sameCharacteristic(rule, { aId, sId, cId }) {
  return (
    rule.aId === aId &&
    (rule.sId === undefined || rule.sId === sId) &&
    (rule.cId === undefined || rule.cId === cId)
  );
}

function dropsReply(state, method, input, { applied = true } = {}) {
  const rule = state.faults?.droppedReply.find(
    (candidate) =>
      candidate.remaining > 0 &&
      candidate.method === method &&
      (candidate.applied !== false) === applied &&
      ["aId", "sId", "cId"].every(
        (key) => candidate[key] === undefined || candidate[key] === input[key],
      ),
  );
  if (!rule) return false;
  rule.remaining -= 1;
  return true;
}

function recordFault(state, fault, entry) {
  state.faultEvents?.push({
    fault,
    seq: entry?.seq ?? null,
    method: entry?.method ?? null,
    params: structuredClone(entry?.params ?? null),
    at: new Date().toISOString(),
  });
}

// A written value pushes its event even when it stays the same; what links
// and lamp logic change pushes one each (2026-10-13-lamp-logic-undo 4.2,
// 4.5).
function writeValue(state, characteristic, value) {
  const previous = characteristic.control.value;
  characteristic.control.value = value;
  const changed = [characteristic];
  if (!sameValue(previous, value)) {
    changed.push(...propagateVirtualLinks(state, characteristic, value));
  }
  changed.push(...applyLampLogic(state, characteristic, previous));
  for (const item of new Set(changed)) {
    state.emitAfterReply?.(valueEvent(item));
  }
}

function emitRooms(state, event, rooms) {
  state.emitAfterReply?.({
    room: { event, rooms: structuredClone(rooms) },
  });
}

function emitAccessories(state, event, accessories) {
  state.emitAfterReply?.({
    accessory: {
      event,
      accessories: accessories.map((accessory) =>
        projectAccessory(accessory, "services,characteristics"),
      ),
    },
  });
}

function valueEvent({ aId, sId, cId, control }) {
  return {
    characteristic: {
      event: "EVENT_UPDATE",
      characteristics: [
        { aId, sId, cId, control: { value: structuredClone(control.value) } },
      ],
    },
  };
}

// LightbulbControl ("Связь включения и уровня") as observed on the owner's
// hub, 3.0.0, on virtual lamps (2026-10-13-lamp-logic-undo): it acts on
// every Brightness write, even of the level already stored. Brightness
// above 0 turns the lamp on at that level; Brightness 0 turns it off and is
// not stored, the previous level stays (on an off lamp it changes nothing).
// An On write leaves the level alone: the lamp comes on at its stored
// level, even 0.
function applyLampLogic(state, characteristic, previous) {
  const { aId, sId } = characteristic;
  const active = state.logics.some(
    (logic) =>
      logic.aId === aId &&
      logic.sId === sId &&
      logic.type === "LightbulbControl" &&
      logic.active,
  );
  if (!active) return [];
  const service = requireService(state, aId, sId);
  const find = (type) =>
    service.characteristics.find(({ control }) => control.type === type);
  const on = find("On");
  const brightness = find("Brightness");
  if (!on || !brightness || characteristic !== brightness) return [];
  const lit = brightness.control.value.intValue > 0;
  const changed = [];
  if (!lit && !sameValue(brightness.control.value, previous)) {
    brightness.control.value = previous;
    changed.push(brightness);
  }
  if (on.control.value.boolValue !== lit) {
    on.control.value = { boolValue: lit };
    changed.push(on);
  }
  if (changed.length > 0) {
    recordFault(state, "lamp_logic", state.currentRequest);
  }
  return changed;
}

// The characteristics a value written to source sets through its links:
// a virtual characteristic's IN links pass it to their targets, a member's
// OUT links back to the virtual one, with "last value" processing (0), and
// no further: the other members keep theirs
// (2026-10-14-light-group-relink, 3 and 4; 2026-09-11-virtual-light-group).
function propagateVirtualLinks(state, source, value) {
  const changed = [];
  for (const link of state.links.get(characteristicKey(source)) ?? []) {
    if (link.type !== "IN" && link.type !== "OUT") continue;
    for (const target of link.characteristics) {
      const characteristic = findCharacteristic(state, target);
      if (!characteristic) continue;
      characteristic.control.value = structuredClone(value);
      changed.push(characteristic);
    }
  }
  return changed;
}

// link.addVirtual on the virtual side (aId, sId, cId) to a target (tAId,
// tSId, tCId), as on the owner's hub: one IN link per target, indexed
// Virtual/<tAId>.<tCId>, and on the target an OUT link of the same index
// holding the virtual characteristic, reused when an empty one was left
// by an earlier removal; adding a link that exists returns it unchanged.
// A new link copies the target's value to
// the virtual characteristic, as last-value feedback: an off lamp joining
// an on group made it read off, and the other members kept theirs
// (2026-10-14-light-group-relink, 2, 7, 8 and runs 2 and 3; there a
// joining Brightness of 0 left the group's level as it was, which this
// does not model).
function addVirtualLink(state, input, { copyValue }) {
  const source = requireCharacteristic(state, input);
  const target = { aId: input.tAId, sId: input.tSId, cId: input.tCId };
  const member = requireCharacteristic(state, target);
  const key = characteristicKey(input);
  const links = state.links.get(key) ?? [];
  const index = `Virtual/${input.tAId}.${input.tCId}`;
  const existing = links.find(
    (link) => link.type === "IN" && link.index === index,
  );
  if (existing) return existing;
  const incoming = {
    index,
    type: "IN",
    controller: "virtual",
    characteristics: [target],
  };
  links.push(incoming);
  state.links.set(key, links);
  const outgoingKey = characteristicKey(target);
  const outgoingLinks = state.links.get(outgoingKey) ?? [];
  let outgoing = outgoingLinks.find(
    (link) => link.type === "OUT" && link.index === index,
  );
  if (!outgoing) {
    outgoing = {
      index,
      type: "OUT",
      controller: "virtual",
      characteristics: [],
    };
    outgoingLinks.push(outgoing);
    state.links.set(outgoingKey, outgoingLinks);
  }
  outgoing.characteristics.push({
    aId: input.aId,
    sId: input.sId,
    cId: input.cId,
  });
  if (copyValue && !sameValue(source.control.value, member.control.value)) {
    source.control.value = structuredClone(member.control.value);
    state.emitAfterReply?.(valueEvent(source));
  }
  return incoming;
}

// What a group command does through the links of a home: values written
// one after another to target in a copy of state's accessories, links and
// lamp logic, as the hub passes them on (writeValue). Returns the copy's
// accessories; state is left as it is. A grader asks with it whether a
// lamp follows its group.
export function commandThroughLinks(state, target, values) {
  const copy = {
    accessories: structuredClone(state.accessories),
    links: structuredClone(state.links),
    logics: structuredClone(state.logics),
  };
  for (const value of values) {
    const characteristic = requireCharacteristic(copy, target);
    writeValue(
      copy,
      characteristic,
      checkedValue(characteristic.control, value),
    );
  }
  return copy.accessories;
}

function subscriptionUuid(state, domain) {
  const sequence = String(state.nextSubscription++).padStart(12, "0");
  return `00000000-0000-4000-8000-${domain === "log" ? "1" : "2"}${sequence.slice(1)}`;
}

function nextId(ids, minimum = 1) {
  return Math.max(minimum - 1, 0, ...ids) + 1;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Characteristic fields other than the value that a native write can set.
const CHARACTERISTIC_SETTINGS = ["hasLinks", "linkProcessing", "notify"];

// Flat, comparable view of the configurable home: room, accessory and service
// identity and visibility, every characteristic value (the information
// service's Name mirrors accessory/<id>/name and is left out), link settings,
// options, logic assignments, scenario settings (BLOCK data without
// editor/runtime fields), virtual links and bridge exports. Graders diff two snapshots
// instead of guessing requests.
export function homeSnapshot(state) {
  const snapshot = {};
  for (const room of state.rooms) {
    snapshot[`room/${room.id}/name`] = room.name;
    snapshot[`room/${room.id}/visible`] = room.visible;
  }
  for (const accessory of state.accessories) {
    snapshot[`accessory/${accessory.id}/name`] = accessory.name;
    snapshot[`accessory/${accessory.id}/roomId`] = accessory.roomId;
    for (const service of accessory.services) {
      const serviceKey = `service/${accessory.id}.${service.sId}`;
      if (service.type !== "AccessoryInformation") {
        snapshot[`${serviceKey}/name`] = service.name;
      }
      if (Object.hasOwn(service, "visible")) {
        snapshot[`${serviceKey}/visible`] = service.visible;
      }
      for (const characteristic of service.characteristics) {
        const key = `characteristic/${characteristicKey(characteristic)}`;
        for (const setting of CHARACTERISTIC_SETTINGS) {
          if (Object.hasOwn(characteristic, setting)) {
            snapshot[`${key}/${setting}`] = characteristic[setting];
          }
        }
        if (
          service.type === "AccessoryInformation" &&
          characteristic.control.type === "Name"
        ) {
          continue;
        }
        snapshot[`${key}/${characteristic.control.type}`] = firstValue(
          characteristic.control.value,
        );
      }
    }
  }
  for (const [key, options] of Object.entries(state.characteristicOptions)) {
    for (const option of options) {
      snapshot[`characteristic-option/${key}/${option.key}`] = firstValue(
        option.value,
      );
    }
  }
  for (const logic of state.logics) {
    const prefix = `logic/${logic.aId}.${logic.sId}/${logic.type}`;
    snapshot[`${prefix}/active`] = logic.active;
    const key = `${logic.aId}.${logic.sId}.${logic.type}`;
    for (const option of state.logicOptionValues[key] ?? []) {
      snapshot[`${prefix}/option/${option.key}`] = firstValue(option.value);
    }
  }
  for (const scenario of state.scenarios) {
    const prefix = `scenario/${scenario.index}`;
    for (const key of ["name", "desc", "type", "active", "onStart", "sync"]) {
      snapshot[`${prefix}/${key}`] = scenario[key];
    }
    snapshot[`${prefix}/data`] =
      scenario.type === "BLOCK"
        ? JSON.stringify(stripBlockRuntime(JSON.parse(scenario.data)))
        : scenario.data;
  }
  const scenarioWindows = new Set(
    state.scenarios.map(({ optionsWindow }) => optionsWindow),
  );
  for (const [key, window] of Object.entries(state.windows)) {
    if (scenarioWindows.has(key)) continue;
    for (const option of window.options) {
      if (option.write !== true) continue;
      snapshot[`window/${key}/${option.key}`] = firstValue(option.value);
    }
  }
  for (const [key, links] of state.links) {
    if (links.length > 0) snapshot[`link/${key}`] = JSON.stringify(links);
  }
  // Each service a bridge exports. Only exported ones: a new accessory
  // shows in every bridge unexported (2026-10-14-bridge-export-write 2),
  // which is no change of the export.
  for (const extension of state.extensions ?? []) {
    if (extension.bundleType !== "BRIDGE") continue;
    for (const { id } of bridgeChildren(state, extension)) {
      const accessory = state.accessories.find(
        (candidate) => String(candidate.id) === id,
      );
      for (const sId of bridgeExportedServices(extension, accessory)) {
        snapshot[`bridge/${extension.extensionKey}/${id}.${sId}`] = true;
      }
    }
  }
  return snapshot;
}

export function diffHomeSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !sameValue(before[key], after[key]))
    .sort()
    .map((key) => ({ key, before: before[key], after: after[key] }));
}

function stripBlockRuntime(value) {
  if (Array.isArray(value)) return value.map(stripBlockRuntime);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== "blockId" && !(key === "state" && value.type === "if"),
      )
      .map(([key, child]) => [key, stripBlockRuntime(child)]),
  );
}

function firstValue(value) {
  if (!isRecord(value)) return value ?? null;
  for (const field of VALUE_FIELDS) {
    if (Object.hasOwn(value, field)) return value[field];
  }
  return null;
}
