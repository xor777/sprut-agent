// Stateful in-process SprutHub simulator for offline integration tests and
// agent evaluations. It speaks the JSON-RPC-over-WebSocket form the client
// sends (`params.<domain>.<method>` -> `result.<domain>.<method>`), keeps one
// home in memory and records every request. Response shapes follow the
// client parsers, the captures under research/protocol/ and the fake hubs of
// the integration tests. Where the live hub was not observed, the simulator
// stays conservative instead of being more convenient than the real hub; such
// places carry a short note. It is not evidence about a live SprutHub.
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  "room.create": [SCHEMA_ONLY, "UI code, 2026-09-11-device-placement"],
  "room.delete": [SCHEMA_ONLY, "UI code, 2026-09-11-device-placement"],
  "room.update": [SCHEMA_ONLY, "RoomUpdateRequest in 51547-Room.proto"],
  "accessory.list": [OBSERVED, "2026-09-09-motion-reading"],
  "accessory.get": [
    OBSERVED,
    "2026-09-11-device-placement; service visible seen in an owner-hub read on 2026-09-24",
  ],
  "accessory.create": [OBSERVED, "2026-09-11-virtual-light-group"],
  "accessory.update": [OBSERVED, "2026-09-11-device-placement"],
  "accessory.delete": [OBSERVED, "2026-09-11-virtual-light-group"],
  "service.types": [OBSERVED, "2026-09-09-type-catalog"],
  "service.update": [
    SCHEMA_ONLY,
    "ServiceUpdateRequest in 18003-Service.proto",
  ],
  "characteristic.get": [OBSERVED, "2026-09-09-automations"],
  "characteristic.getOptions": [OBSERVED, "2026-09-09-automations"],
  "characteristic.setOptions": [SCHEMA_ONLY],
  "characteristic.update": [OBSERVED, "2026-09-11-virtual-light-group"],
  "link.list": [OBSERVED, "2026-09-11-virtual-light-group"],
  "link.addVirtual": [OBSERVED, "2026-09-11-virtual-light-group"],
  "link.remove": [OBSERVED, "2026-09-11-virtual-light-group"],
  "logic.types": [OBSERVED, "2026-09-10-native-logic"],
  "logic.list": [OBSERVED, "2026-09-10-native-logic"],
  "logic.get": [OBSERVED, "2026-09-10-native-logic"],
  "logic.getOptions": [OBSERVED, "2026-09-10-native-logic"],
  "logic.create": [OBSERVED, "2026-09-10-native-logic"],
  "logic.update": [OBSERVED, "2026-09-10-native-logic"],
  "logic.setOptions": [OBSERVED, "2026-09-10-native-logic"],
  "logic.delete": [OBSERVED, "2026-09-10-native-logic"],
  "scenario.list": [OBSERVED, "2026-09-09-automations"],
  "scenario.get": [
    OBSERVED,
    "2026-09-09-automations; active seen in an owner-hub read on 2026-09-24",
  ],
  "scenario.create": [OBSERVED, "2026-09-13-native-daily-interval"],
  "scenario.update": [OBSERVED, "2026-09-13-native-daily-interval"],
  "scenario.delete": [OBSERVED, "2026-09-13-native-daily-interval"],
  "scenario.run": [
    OBSERVED,
    "live scenario_run (b95e8a3); the simulator runs only top-level literal set actions",
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
  "window.get": [OBSERVED, "2026-09-10-window-setting"],
  "window.update": [OBSERVED, "2026-09-10-window-setting"],
  "extension.list": [OBSERVED, "2026-09-16-extension-child-read"],
  "extension.get": [OBSERVED, "2026-09-16-extension-child-read"],
  "extensionChild.list": [OBSERVED, "2026-09-17-extension-child-empty-list"],
  "extensionChild.get": [OBSERVED, "2026-09-16-extension-child-read"],
};

// Per method: evidence level, request, write and error counts of one run.
function touchedMethods(requests) {
  const counts = new Map();
  for (const { method, write, error } of requests) {
    const key = method ?? "(invalid request)";
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
const SCENARIO_SDK = `interface Hub {
  getAccessory(aId: number): Accessory;
  getAccessories(): Accessory[];
  getCharacteristic(aId: number, sId: number, cId: number): Characteristic;
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

export async function loadHomeFixture(nameOrPath) {
  const file =
    nameOrPath.includes("/") || nameOrPath.endsWith(".json")
      ? path.resolve(nameOrPath)
      : path.join(fixturesDirectory, `${nameOrPath}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}

export async function startSimulatedHub(
  fixture,
  { host = "127.0.0.1", port = 0, token = SIMULATED_HUB_TOKEN } = {},
) {
  const state = buildState(fixture);
  const initialState = structuredClone(state);
  const requests = [];
  // Queued explicit JSON-RPC error replies by method, for tests of a hub that
  // receives a request and refuses it without changing the home.
  const refusals = new Map();
  const server = new WebSocketServer({
    host,
    port,
    handleProtocols: (protocols) =>
      protocols.has("json-rpc") ? "json-rpc" : false,
  });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const reply = handleMessage(state, requests, token, raw, refusals);
      if (reply) socket.send(JSON.stringify(reply));
    });
  });
  const address = server.address();
  const url = `ws://${host}:${address.port}`;
  return {
    url,
    serial: state.hub.serial,
    token,
    state,
    initialState,
    requests,
    writes: () => requests.filter(({ write }) => write),
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
    touchedMethods: () => touchedMethods(requests),
    connectionEnv: () => ({
      SPRUTHUB_URL: url,
      SPRUTHUB_TOKEN: token,
      SPRUTHUB_SERIAL: state.hub.serial,
      SPRUTHUB_CID: SIMULATED_HUB_CID,
    }),
    snapshot: () => homeSnapshot(state),
    exportState: () => ({
      ...structuredClone(state),
      links: Object.fromEntries(state.links),
    }),
    initialSnapshot: () => homeSnapshot(initialState),
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function handleMessage(state, requests, token, raw, refusals) {
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
    write: isWriteMethod(method),
    params: structuredClone(message?.params ?? null),
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
  if (refusal) return fail(new SimulatorError(refusal.code, refusal.message));
  const handler = HANDLERS[method];
  if (!handler) {
    return fail(
      new SimulatorError(-32601, `unsupported by simulator: ${method}`),
    );
  }
  const [domain, operation] = method.split(".");
  try {
    const value = handler(state, message.params[domain][operation] ?? {});
    return {
      id: message.id,
      result: { [domain]: { [operation]: structuredClone(value) } },
    };
  } catch (error) {
    if (error instanceof SimulatorError) return fail(error);
    return fail(new SimulatorError(-32603, `Internal error: ${error.message}`));
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
      name,
      order: state.rooms.length + 1,
      visible: true,
    };
    state.rooms.push(room);
    return room;
  },
  "room.delete": (state, { id }) => {
    const at = state.rooms.findIndex((room) => room.id === id);
    if (at < 0) throw notFound(`Room ${id}`);
    state.rooms.splice(at, 1);
    return {};
  },
  // RoomUpdateRequest {id, name, visible}: only the sent fields change.
  "room.update": (state, input) => {
    const room = requireRoom(state, input.id);
    if (Object.hasOwn(input, "name")) {
      if (typeof input.name !== "string" || input.name.trim().length === 0) {
        throw invalidParams("Room name must be a non-empty string");
      }
      room.name = input.name;
    }
    if (Object.hasOwn(input, "visible")) {
      if (typeof input.visible !== "boolean") {
        throw invalidParams("Room visible must be a boolean");
      }
      room.visible = input.visible;
    }
    return {};
  },

  "accessory.list": (state, { roomId, expand }) => ({
    accessories: state.accessories
      .filter(
        (accessory) => roomId === undefined || accessory.roomId === roomId,
      )
      .map((accessory) => projectAccessory(accessory, expand)),
  }),
  "accessory.get": (state, { id }) =>
    state.accessories.find((accessory) => accessory.id === id) ?? null,
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
      services: [
        {
          aId: id,
          sId: 1,
          name: serviceInput.name ?? name,
          type: serviceInput.type,
          visible: true,
          characteristics: types.map((type, index) =>
            buildCharacteristic(id, 1, {
              cId: index + 1,
              type,
              value: defaultValue(type),
            }),
          ),
        },
      ],
    };
    state.accessories.push(accessory);
    // The create reply of the fake hubs omits `virtual`; the stored accessory
    // keeps it, as accessory.get/list report it.
    const { virtual: _virtual, ...reply } = accessory;
    return reply;
  },
  "accessory.update": (state, input) => {
    const accessory = requireAccessory(state, input.id);
    if (Object.hasOwn(input, "roomId")) requireRoom(state, input.roomId);
    if (Object.hasOwn(input, "name")) {
      if (typeof input.name !== "string" || input.name.length === 0) {
        throw invalidParams("Accessory name must be a non-empty string");
      }
      accessory.name = input.name;
      const nameCharacteristic = accessory.services
        .find(({ type }) => type === "AccessoryInformation")
        ?.characteristics.find(({ control }) => control.type === "Name");
      if (nameCharacteristic) {
        nameCharacteristic.control.value = { stringValue: input.name };
      }
    }
    if (Object.hasOwn(input, "roomId")) accessory.roomId = input.roomId;
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
    return {};
  },

  "service.types": () => ({ types: SERVICE_TYPES }),
  // ServiceUpdateRequest {aId, sId, order, grid, name, visible}: only the
  // sent name and visible change; order and grid are not modelled.
  "service.update": (state, input) => {
    const service = requireService(state, input.aId, input.sId);
    if (Object.hasOwn(input, "name")) {
      if (typeof input.name !== "string" || input.name.trim().length === 0) {
        throw invalidParams("Service name must be a non-empty string");
      }
      service.name = input.name;
    }
    if (Object.hasOwn(input, "visible")) {
      if (typeof input.visible !== "boolean") {
        throw invalidParams("Service visible must be a boolean");
      }
      service.visible = input.visible;
    }
    return {};
  },

  "characteristic.get": (state, input) => findCharacteristic(state, input),
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
    if (input.control && Object.hasOwn(input.control, "value")) {
      const value = checkedValue(characteristic.control, input.control.value);
      const changed = !sameValue(characteristic.control.value, value);
      characteristic.control.value = value;
      if (changed) propagateVirtualLinks(state, input, value);
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
  "link.addVirtual": (state, input) => {
    requireCharacteristic(state, input);
    requireCharacteristic(state, {
      aId: input.tAId,
      sId: input.tSId,
      cId: input.tCId,
    });
    const key = characteristicKey(input);
    const links = state.links.get(key) ?? [];
    const index = `Virtual/${input.tAId}.${input.tCId}`;
    let incoming = links.find(
      (link) => link.type === "IN" && link.index === index,
    );
    if (!incoming) {
      incoming = { index, type: "IN", characteristics: [] };
      links.push(incoming);
      state.links.set(key, links);
    }
    if (
      !incoming.characteristics.some(
        ({ aId, sId, cId }) =>
          aId === input.tAId && sId === input.tSId && cId === input.tCId,
      )
    ) {
      incoming.characteristics.push({
        aId: input.tAId,
        sId: input.tSId,
        cId: input.tCId,
      });
      const outgoingKey = characteristicKey({
        aId: input.tAId,
        sId: input.tSId,
        cId: input.tCId,
      });
      const outgoingLinks = state.links.get(outgoingKey) ?? [];
      let outgoing = outgoingLinks.find(
        (link) => link.type === "OUT" && link.index === index,
      );
      if (!outgoing) {
        outgoing = { index, type: "OUT", characteristics: [] };
        outgoingLinks.push(outgoing);
        state.links.set(outgoingKey, outgoingLinks);
      }
      outgoing.characteristics.push({
        aId: input.aId,
        sId: input.sId,
        cId: input.cId,
      });
    }
    return incoming;
  },
  "link.remove": (state, input) => {
    const key = characteristicKey(input);
    const links = state.links.get(key) ?? [];
    const removed = links.find(({ index }) => index === input.linkId);
    if (!removed) throw notFound(`Link ${input.linkId}`);
    state.links.set(
      key,
      links.filter(({ index }) => index !== input.linkId),
    );
    if (removed.type === "IN") {
      for (const target of removed.characteristics) {
        const outgoingKey = characteristicKey(target);
        state.links.set(
          outgoingKey,
          (state.links.get(outgoingKey) ?? []).flatMap((link) => {
            if (link.type !== "OUT") return [link];
            const characteristics = link.characteristics.filter(
              ({ aId, sId, cId }) =>
                aId !== input.aId || sId !== input.sId || cId !== input.cId,
            );
            return characteristics.length > 0
              ? [{ ...link, characteristics }]
              : [];
          }),
        );
      }
    }
    return {};
  },

  "logic.types": (state, { aId, sId }) => ({
    logicTypes: availableLogicTypes(state, requireService(state, aId, sId)).map(
      ({ options: _options, ...logicType }) => logicType,
    ),
  }),
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
    if (!logicType) throw invalidParams(`Logic type ${type} is not available`);
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
    if (scenario.type === "BLOCK") {
      scenario.data = normalizeBlockData(input.data);
      scenario.optionsWindow = `scenario-options-${state.nextWindow++}`;
      scenario.rooms = blockRooms(state, scenario.data);
    } else if (scenario.type === "LOGIC") {
      if (typeof input.data !== "string") {
        throw invalidParams("LOGIC scenario requires source text");
      }
      scenario.data = input.data;
      scenario.desc = logicSourceDescription(input.data) ?? scenario.desc;
    } else {
      throw invalidParams(`Scenario type ${input.type} is not supported`);
    }
    state.scenarios.push(scenario);
    syncScenarioWindow(state, scenario);
    return scenario;
  },
  "scenario.update": (state, input) => {
    const scenario = requireScenario(state, input.index);
    for (const key of ["active", "onStart", "sync"]) {
      if (typeof input[key] === "boolean") scenario[key] = input[key];
    }
    // BLOCK name/desc are edited through the scenario options window; the
    // live hub did not apply them through scenario.update.
    if (scenario.type !== "BLOCK") {
      if (typeof input.name === "string") scenario.name = input.name;
      if (typeof input.desc === "string") scenario.desc = input.desc;
    }
    if (Object.hasOwn(input, "data")) {
      if (scenario.type === "BLOCK") {
        scenario.data = normalizeBlockData(input.data);
        scenario.rooms = blockRooms(state, scenario.data);
      } else {
        if (typeof input.data !== "string") {
          throw invalidParams("LOGIC scenario requires source text");
        }
        scenario.data = input.data;
        scenario.desc = logicSourceDescription(input.data) ?? scenario.desc;
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

  "window.get": (state, { windowKey }) => state.windows[windowKey] ?? null,
  "window.update": (state, { windowKey, options }) => {
    const window = state.windows[windowKey];
    if (!window) throw notFound(`Window ${windowKey}`);
    applyOptions(window.options, options);
    const scenario = state.scenarios.find(
      (candidate) => candidate.optionsWindow === windowKey,
    );
    if (scenario) {
      for (const option of window.options) {
        if (option.key === "Name") scenario.name = option.value.stringValue;
        if (option.key === "Desc") scenario.desc = option.value.stringValue;
      }
    }
    return {};
  },

  "extension.list": (state) => ({
    extensions: state.extensions.map(({ spaces: _spaces, ...summary }) => ({
      ...summary,
      childCount: extensionChildren(state, summary.extensionKey).length,
    })),
  }),
  "extension.get": (state, { extensionKey }) => {
    const extension = state.extensions.find(
      (candidate) => candidate.extensionKey === extensionKey,
    );
    return extension
      ? {
          ...extension,
          childCount: extensionChildren(state, extensionKey).length,
        }
      : null;
  },
  "extensionChild.list": (state, { extensionKey }) => ({
    children: extensionChildren(state, extensionKey).map(
      ({ description: _d, status: _s, ...summary }) => summary,
    ),
  }),
  "extensionChild.get": (state, { extensionKey, id }) =>
    extensionChildren(state, extensionKey).find((child) => child.id === id) ??
    null,
};

function buildState(fixture) {
  const startedAt = Date.now();
  const utcOffsetMinutes = fixture.log?.utcOffsetMinutes ?? 180;
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
    },
    extensions: structuredClone(fixture.extensions ?? []),
    logicCatalog: structuredClone(fixture.logicTypes ?? {}),
    logics: [],
    logicOptionValues: {},
    scenarios: [],
    links: new Map(),
    runs: [],
    log: seedLog(fixture.log, startedAt),
    logCapacity: fixture.log?.capacity ?? DEFAULT_LOG_CAPACITY,
    nextScenarioIndex: 1,
    nextWindow: 1,
    nextSubscription: 1,
  };
  for (const input of fixture.accessories) {
    state.accessories.push(buildAccessory(state, input));
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
      scenario.optionsWindow = `scenario-options-${state.nextWindow++}`;
      scenario.rooms = blockRooms(state, scenario.data);
    } else {
      scenario.data = Array.isArray(input.data)
        ? input.data.join("\n")
        : input.data;
      scenario.desc =
        input.desc ?? logicSourceDescription(scenario.data) ?? scenario.desc;
    }
    state.scenarios.push(scenario);
    syncScenarioWindow(state, scenario);
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
  if (input.manufacturer || input.model) {
    services.push({
      aId: input.id,
      sId: 1,
      name: "Информация об аксессуаре",
      type: "AccessoryInformation",
      characteristics: [
        ["Identify", false],
        ["Manufacturer", input.manufacturer ?? ""],
        ["Model", input.model ?? ""],
        ["Name", input.name],
        ["SerialNumber", input.deviceId ?? `SN-${input.id}`],
        ["FirmwareRevision", input.firmware ?? "1.0"],
      ].map(([type, value], index) =>
        buildCharacteristic(input.id, 1, { cId: index + 2, type, value }),
      ),
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
    ...(input.extensionKey
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
    ],
  };
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
  const time = Math.max(Date.now(), (state.log.at(-1)?.time ?? 0) + 1);
  state.log.push({ time, ...entry });
  if (state.log.length > state.logCapacity) {
    state.log.splice(0, state.log.length - state.logCapacity);
  }
}

function syncScenarioWindow(state, scenario) {
  if (scenario.type !== "BLOCK") return;
  const text = (key, name, inputType, value) => ({
    key,
    name,
    type: "GenericString",
    inputType,
    read: true,
    write: true,
    disabled: false,
    value: { stringValue: value },
  });
  state.windows[scenario.optionsWindow] = {
    windowKey: scenario.optionsWindow,
    label: { text: "Настройки сценария" },
    options: [
      text("Name", "Имя", "TEXT", scenario.name),
      text("Desc", "Описание", "TEXT_MULTILINE", scenario.desc),
    ],
  };
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
      const [field] = Object.keys(characteristic.control.value);
      characteristic.control.value = {
        [field]:
          field === "boolValue"
            ? action.value === "true"
            : field === "stringValue"
              ? action.value
              : Number(action.value),
      };
      run.executed.push({ aId: target.aId, sId: target.sId, cId: action.cId });
    }
  }
  return run;
}

function logicTypeForScenario(index) {
  return `UserLogic_${index}`;
}

function logicSourceDescription(source) {
  return /description\s*:\s*"([^"]*)"/.exec(source)?.[1];
}

function logicSourceServices(source) {
  const list = /sourceServices\s*:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "";
  return [...list.matchAll(/HS\.(\w+)/g)].map(([, type]) => type);
}

function availableLogicTypes(state, service) {
  const builtIn = state.logicCatalog[service.type] ?? [];
  const user = state.scenarios
    .filter(
      (scenario) =>
        scenario.type === "LOGIC" &&
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

function extensionChildren(state, extensionKey) {
  return state.accessories
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
}

function projectAccessory(accessory, expand) {
  const { services, ...summary } = accessory;
  if (!expandIncludes(expand, "services")) return summary;
  return {
    ...summary,
    services: services.map(({ characteristics, ...service }) =>
      expandIncludes(expand, "characteristics")
        ? { ...service, characteristics }
        : service,
    ),
  };
}

function expandIncludes(expand, part) {
  return (
    typeof expand === "string" &&
    expand.split(",").some((item) => item.trim() === part)
  );
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

function propagateVirtualLinks(state, source, value) {
  for (const link of state.links.get(characteristicKey(source)) ?? []) {
    if (link.type !== "IN") continue;
    for (const target of link.characteristics) {
      const characteristic = findCharacteristic(state, target);
      if (characteristic) characteristic.control.value = structuredClone(value);
    }
  }
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
const CHARACTERISTIC_SETTINGS = ["hasLinks", "linkProcessing"];

// Flat, comparable view of the configurable home: room, accessory and service
// identity and visibility, every characteristic value (the information
// service's Name mirrors accessory/<id>/name and is left out), link settings,
// options, logic assignments, scenario settings (BLOCK data without
// editor/runtime fields) and virtual links. Graders diff two snapshots
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
