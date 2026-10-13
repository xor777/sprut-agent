// The home as the voice model sees it: devices with short ids, what each
// one can be set to, and what each one shows now. Everything here comes
// from the hub's own types, ranges, links and names; the model, not this
// file, turns a person's words into these settings.

// Writable characteristic types and the setting each one carries.
const WRITABLE = {
  On: "power",
  Active: "power",
  Brightness: "brightness",
  ColorTemperature: "white",
  Hue: "hue",
  Saturation: "saturation",
  TargetPosition: "position",
  TargetTemperature: "target_temperature",
  CoolingThresholdTemperature: "cooling_temperature",
  HeatingThresholdTemperature: "heating_temperature",
  TargetRelativeHumidity: "target_humidity",
  RotationSpeed: "fan_speed_percent",
  TargetHeatingCoolingState: "mode",
  TargetHeaterCoolerState: "mode",
  TargetAirPurifierState: "mode",
  C_FanSpeed: "fan_speed",
  SwingMode: "swing",
};
// Settings whose range or options only a characteristic read reports.
export const DETAILED = new Set([
  "white",
  "target_temperature",
  "cooling_temperature",
  "heating_temperature",
  "target_humidity",
  "fan_speed_percent",
  "mode",
  "fan_speed",
  "swing",
]);

// Values worth reading out, under the names the model gets them by.
const READABLE = {
  On: "power",
  Active: "active",
  Brightness: "brightness",
  CurrentPosition: "position",
  CurrentTemperature: "current_temperature",
  TargetTemperature: "target_temperature",
  CurrentRelativeHumidity: "humidity",
  TargetRelativeHumidity: "target_humidity",
  TargetHeatingCoolingState: "mode",
  TargetHeaterCoolerState: "mode",
  TargetAirPurifierState: "mode",
  CurrentHeatingCoolingState: "running",
  C_FanSpeed: "fan_speed",
  RotationSpeed: "fan_speed_percent",
  SwingMode: "swing",
  ContactSensorState: "contact",
  MotionDetected: "motion",
  OccupancyDetected: "occupancy",
  LeakDetected: "leak",
  SmokeDetected: "smoke",
  CarbonDioxideLevel: "co2",
  AirQuality: "air_quality",
  PM2_5Density: "pm2_5",
  CurrentAmbientLightLevel: "light_level",
};
const SENSOR_TYPES = new Set([
  "CurrentTemperature",
  "CurrentRelativeHumidity",
  "ContactSensorState",
  "MotionDetected",
  "OccupancyDetected",
  "LeakDetected",
  "SmokeDetected",
  "CarbonDioxideLevel",
  "AirQuality",
  "PM2_5Density",
  "CurrentAmbientLightLevel",
]);
const KINDS = new Set(["light", "switch", "climate", "air", "cover", "sensor"]);
// HomeKit's usual ColorTemperature range in mireds when a lamp reports none.
export const DEFAULT_MIREDS = { min: 140, max: 500 };
// Whites a person asks for lie well inside this, whatever a lamp reports.
const WHITE_KELVIN_SHOWN = { min: 2000, max: 6500 };

export function deviceEntry({ room, device, service }) {
  const id = serviceId(service.ref);
  const roomId = roomIdOf(room.ref);
  if (!id || !roomId || !KINDS.has(service.kind)) return null;
  if (service.hidden && service.kind !== "light") return null;
  const values = service.values ?? service.characteristics ?? [];
  const writable = {};
  for (const value of values) {
    const setting = WRITABLE[value.type];
    if (!setting || value.writable !== true || writable[setting]) continue;
    writable[setting] = {
      setting,
      type: value.type,
      ref: value.ref,
      ...(setting === "brightness" || setting === "position"
        ? { min: 0, max: 100, unit: "%" }
        : {}),
    };
  }
  const sensors = [
    ...new Set(
      values
        .filter(({ type }) => SENSOR_TYPES.has(type))
        .map(({ type }) => READABLE[type]),
    ),
  ];
  if (Object.keys(writable).length === 0 && sensors.length === 0) return null;
  const mode = values.find(({ type }) => type === "C_ColorMode");
  return {
    id,
    ref: service.ref,
    name: service.name,
    deviceName: device.name,
    functionOf: service.function_of?.name ?? null,
    roomId,
    kind: service.kind,
    hidden: service.hidden === true,
    available: device.available !== false,
    modeRef: mode?.ref ?? null,
    writable,
    sensors,
  };
}

// What the model may set on a device, under the tool's setting names. A
// group takes white and colour for its bulbs, which do the showing.
export function capabilities(device, catalog) {
  const own = device.writable;
  const bulbs = (device.members ?? []).map((id) => catalog.devices.get(id));
  const anyBulb = (test) => bulbs.some((bulb) => bulb && test(bulb));
  const can = new Set();
  if (own.power || own.mode?.values?.some(({ key }) => key === "OFF")) {
    can.add("power");
  }
  if (own.brightness) can.add("brightness").add("brightness_change");
  const colour = (d) => Boolean(d.writable.hue);
  const white = (d) => Boolean(d.writable.white || d.writable.hue);
  if (device.members ? anyBulb(white) : white(device)) can.add("white_kelvin");
  if (device.members ? anyBulb(colour) : colour(device)) {
    can.add("color").add("spread_colors");
  }
  for (const setting of [
    "position",
    "target_temperature",
    "cooling_temperature",
    "heating_temperature",
    "target_humidity",
    "fan_speed_percent",
    "mode",
    "fan_speed",
    "swing",
  ]) {
    if (own[setting]) can.add(setting);
  }
  return can;
}

export function describeCatalog(catalog) {
  const lines = [];
  for (const room of catalog.rooms.values()) {
    lines.push(`Room «${room.name}» [${room.id}]:`);
    for (const device of catalog.devices.values()) {
      if (device.roomId !== room.id || device.memberOf) continue;
      const parts = [`- [${device.id}] «${device.name}»`];
      if (device.deviceName && device.deviceName !== device.name) {
        parts.push(` (device «${device.deviceName}»)`);
      }
      if (device.functionOf) parts.push(`, part of «${device.functionOf}»`);
      parts.push(`, ${device.kind}`);
      if (device.hidden) parts.push(", hidden in the app");
      if (device.members) {
        parts.push(`, group of ${device.members.length} bulbs`);
      }
      const can = [...capabilities(device, catalog)].map((setting) =>
        describeSetting(setting, device, catalog),
      );
      if (can.length > 0) parts.push(`; set: ${can.join("; ")}`);
      if (device.sensors.length > 0) {
        parts.push(`; reads: ${device.sensors.join(", ")}`);
      }
      if (!device.available) parts.push("; offline");
      lines.push(parts.join(""));
      if (device.members) {
        const bulbs = device.members.map((id) => {
          const bulb = catalog.devices.get(id);
          return `[${id}] «${bulb.name}»${bulb.available ? "" : " (offline)"}`;
        });
        lines.push(`  bulbs: ${bulbs.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

function describeSetting(setting, device, catalog) {
  const own = device.writable[setting];
  if (setting === "white_kelvin") {
    const lamps = device.members
      ? device.members.map((id) => catalog.devices.get(id)).filter(Boolean)
      : [device];
    const real = lamps.find((lamp) => lamp.writable.white);
    if (!real) return "white_kelvin (mixed from colour)";
    const { min, max } = kelvinRange(real.writable.white);
    return `white_kelvin ${min}–${max} K`;
  }
  if (own?.values?.length) {
    return `${setting} (${own.values.map(({ key, name }) => `${key} ${name}`).join(", ")})`;
  }
  if (own && Number.isFinite(own.min) && Number.isFinite(own.max)) {
    return `${setting} ${own.min}–${own.max}${own.unit ? ` ${own.unit}` : ""}`;
  }
  return setting;
}

export function kelvinRange(white) {
  const min = Number.isFinite(white?.min) ? white.min : DEFAULT_MIREDS.min;
  const max = Number.isFinite(white?.max) ? white.max : DEFAULT_MIREDS.max;
  return {
    min: Math.max(WHITE_KELVIN_SHOWN.min, Math.round(1e6 / max / 100) * 100),
    max: Math.min(WHITE_KELVIN_SHOWN.max, Math.round(1e6 / min / 100) * 100),
  };
}

// What a device shows now, in numbers the model can name for a person.
export function stateOf(service) {
  const byType = new Map();
  const state = {};
  for (const value of service.values ?? []) {
    byType.set(value.type, value);
    const key = READABLE[value.type];
    if (!key || key in state) continue;
    state[key] = shownValue(value);
  }
  const hue = byType.get("Hue")?.value;
  const mireds = byType.get("ColorTemperature")?.value;
  if (Number.isFinite(hue) || Number.isFinite(mireds)) {
    const mode = byType.get("C_ColorMode")?.enum?.key;
    const shows =
      mode === "TEMPERATURE"
        ? "white"
        : mode === "HUE"
          ? "color"
          : Number.isFinite(hue) && !Number.isFinite(mireds)
            ? "color"
            : !Number.isFinite(hue)
              ? "white"
              : "unknown";
    state.shows = shows;
    if (shows !== "color" && Number.isFinite(mireds) && mireds > 0) {
      state.white_kelvin = Math.round(1e6 / mireds / 10) * 10;
    }
    if (shows !== "white" && Number.isFinite(hue)) {
      state.hue = hue;
      const saturation = byType.get("Saturation")?.value;
      if (Number.isFinite(saturation)) state.saturation = saturation;
    }
  }
  return state;
}

function shownValue(value) {
  if (value.enum) return value.enum.name ?? value.enum.key;
  if (value.value === null || value.value === undefined) return null;
  if (typeof value.value === "boolean") return value.value;
  return value.unit && value.unit !== "%"
    ? `${value.value} ${value.unit}`
    : value.value;
}

export function findRoom(catalog, query) {
  const text = String(query).toLowerCase().replaceAll("ё", "е").trim();
  const rooms = [...catalog.rooms.values()];
  const named = (room) => room.name.toLowerCase().replaceAll("ё", "е");
  return (
    rooms.find(({ id }) => id === text) ??
    rooms.find((room) => named(room) === text) ??
    rooms.find((room) => named(room).includes(text))
  );
}

export function serviceId(ref) {
  const match = /\/accessory\/(\d+)\/service\/(\d+)$/.exec(ref ?? "");
  return match ? `a${match[1]}s${match[2]}` : null;
}

export function roomIdOf(ref) {
  const match = /\/room\/(\d+)$/.exec(ref ?? "");
  return match ? `r${match[1]}` : null;
}
