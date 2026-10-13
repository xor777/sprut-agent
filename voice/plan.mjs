// Turns the model's desired states into hub writes. A command names a
// device or a whole room and the state to reach; the device rules decide
// which characteristics of which devices carry it. Language stays with the
// model: nothing here knows a word a person might say.
import { capabilities, DEFAULT_MIREDS, findRoom } from "./catalog.mjs";

export const SETTINGS = [
  "power",
  "brightness",
  "brightness_change",
  "white_kelvin",
  "color",
  "spread_colors",
  "position",
  "target_temperature",
  "cooling_temperature",
  "heating_temperature",
  "target_humidity",
  "fan_speed_percent",
  "mode",
  "fan_speed",
  "swing",
];
// Settings that decide what a lamp shows; a group passes colour to its bulbs
// but has no white of its own, so these go to the bulbs themselves.
const LOOKS = new Set(["white_kelvin", "color", "spread_colors"]);
// A white mixed from colour on RGB LEDs at the full black-body saturation
// looks orange or pink to the owner; it uses this share of it.
const MIXED_WHITE_SATURATION = 0.6;
// C_ColorMode on the owner's hub: whether a lamp shows its colour or white.
const COLOR_MODE = { HUE: 1, TEMPERATURE: 2 };
// Hues spread by the golden angle: every lamp is far from the one before.
const GOLDEN_ANGLE = 137.508;

export function planCommands(catalog, commands, current, { turn = 0 } = {}) {
  const writes = [];
  const problems = [];
  const skipped = [];
  for (const command of commands) {
    planCommand(catalog, command, current, turn, { writes, problems, skipped });
  }
  for (const write of writes) switchColorMode(write, current);
  return { writes: lastPerCharacteristic(writes), problems, skipped };
}

// The rooms whose current values a plan needs: the targets', their bulbs'.
export function roomsTouched(catalog, commands) {
  const rooms = new Set();
  const add = (device) => {
    if (!device) return;
    rooms.add(device.roomId);
    for (const id of device.members ?? []) {
      rooms.add(catalog.devices.get(id)?.roomId);
    }
  };
  for (const command of commands) {
    if (command?.device) add(catalog.devices.get(command.device));
    else if (command?.room) {
      const room = findRoom(catalog, command.room);
      for (const device of catalog.devices.values()) {
        if (device.roomId === room?.id) add(device);
      }
    }
  }
  rooms.delete(undefined);
  return [...rooms].map((id) => catalog.rooms.get(id)).filter(Boolean);
}

function planCommand(catalog, command, current, turn, out) {
  const set = command?.set;
  const label = command?.device ?? command?.room ?? null;
  if (!set || typeof set !== "object" || Object.keys(set).length === 0) {
    out.problems.push({ target: label, problem: "set is empty" });
    return;
  }
  const unknown = Object.keys(set).filter((key) => !SETTINGS.includes(key));
  if (unknown.length > 0) {
    out.problems.push({
      target: label,
      problem: `unknown settings: ${unknown.join(", ")}`,
      settings: SETTINGS,
    });
    return;
  }
  const targets = resolveTargets(catalog, command, out.problems);
  if (!targets) return;
  const explicit = Boolean(command.device);
  const lit = new Map();
  for (const setting of SETTINGS) {
    if (!(setting in set)) continue;
    const value = set[setting];
    const capable = [];
    for (const target of targets) {
      if (capabilities(target, catalog).has(setting)) capable.push(target);
      else if (explicit) {
        out.problems.push({
          device: target.id,
          name: target.name,
          problem: `cannot set ${setting}`,
          can: [...capabilities(target, catalog)],
        });
      } else {
        out.skipped.push({ device: target.id, name: target.name, setting });
      }
    }
    const lamps = capable.flatMap((target) =>
      LOOKS.has(setting) && target.members
        ? target.members
            .map((id) => catalog.devices.get(id))
            .filter(
              (bulb) =>
                bulb.available && capabilities(bulb, catalog).has(setting),
            )
        : [target],
    );
    lamps.forEach((lamp, index) => {
      const encoded = encode(setting, value, lamp, current, { index, turn });
      if (encoded.problem) {
        out.problems.push({
          device: lamp.id,
          name: lamp.name,
          setting,
          ...encoded,
        });
        return;
      }
      for (const write of encoded.writes) out.writes.push(write);
      if (lightsUp(setting, encoded.writes)) lit.set(lamp.id, lamp);
    });
  }
  // A level, white or colour for a lamp that is off is only stored by the
  // hub; unless the command says otherwise, the lamp is lit as well.
  if (!("power" in set)) {
    for (const lamp of lit.values()) {
      const power = lamp.writable.power;
      if (power?.type === "On" && current.get(power.ref) !== true) {
        out.writes.push(write(lamp, "power", power, true));
      }
    }
  }
}

function resolveTargets(catalog, command, problems) {
  if (command.device) {
    const device = catalog.devices.get(command.device);
    if (!device) {
      problems.push({ device: command.device, problem: "no such device" });
      return null;
    }
    return [device];
  }
  if (command.room) {
    const room = findRoom(catalog, command.room);
    if (!room) {
      problems.push({
        room: command.room,
        problem: "no such room",
        rooms: [...catalog.rooms.values()].map(({ id, name }) => ({
          id,
          name,
        })),
      });
      return null;
    }
    const kind = command.kind ?? "light";
    const targets = [...catalog.devices.values()].filter(
      (device) =>
        device.roomId === room.id &&
        device.kind === kind &&
        device.available &&
        !device.hidden &&
        !device.memberOf,
    );
    if (targets.length === 0) {
      problems.push({
        room: room.name,
        kind,
        problem: "nothing of that kind there",
      });
      return null;
    }
    return targets;
  }
  problems.push({ problem: "a command needs a device or a room" });
  return null;
}

function encode(setting, value, device, current, { index, turn }) {
  const own = device.writable;
  switch (setting) {
    case "power": {
      if (typeof value !== "boolean")
        return { problem: "power is true or false" };
      if (own.power?.type === "On") return writes(device, own.power, value);
      if (own.power) return writes(device, own.power, value ? 1 : 0);
      const off = own.mode?.values?.find(({ key }) => key === "OFF");
      if (!value && off) return writes(device, own.mode, off.value);
      return {
        problem: "this device is turned on by choosing a mode",
        options: optionsOf(own.mode),
      };
    }
    case "brightness": {
      const level = number(value, 0, 100);
      if (level === null) return { problem: "brightness is 0–100" };
      if (level === 0 && own.power?.type === "On") {
        return writes(device, own.power, false);
      }
      return writes(device, own.brightness, level);
    }
    case "brightness_change": {
      const change = number(value, -100, 100);
      const now = Number(current.get(own.brightness.ref));
      if (change === null) return { problem: "brightness_change is −100…100" };
      if (!Number.isFinite(now)) return { problem: "current level unknown" };
      return writes(
        device,
        own.brightness,
        Math.min(100, Math.max(1, Math.round(now + change))),
      );
    }
    case "white_kelvin": {
      const kelvin = number(value, 1000, 10_000);
      if (kelvin === null) return { problem: "white_kelvin is 1000–10000" };
      if (own.white) {
        const min = Number.isFinite(own.white.min)
          ? own.white.min
          : DEFAULT_MIREDS.min;
        const max = Number.isFinite(own.white.max)
          ? own.white.max
          : DEFAULT_MIREDS.max;
        const mireds = Math.min(max, Math.max(min, Math.round(1e6 / kelvin)));
        return writes(device, own.white, mireds);
      }
      const { hue, saturation } = kelvinColor(kelvin);
      return colourWrites(
        device,
        hue,
        Math.round(saturation * MIXED_WHITE_SATURATION),
      );
    }
    case "color": {
      const hue = number(
        typeof value === "object" ? value?.hue : value,
        -720,
        720,
      );
      const saturation =
        typeof value === "object" && value?.saturation !== undefined
          ? number(value.saturation, 0, 100)
          : 100;
      if (hue === null || saturation === null) {
        return { problem: "color is {hue: 0–360, saturation: 0–100}" };
      }
      return colourWrites(device, hue, saturation);
    }
    case "spread_colors": {
      const saturation =
        value?.saturation !== undefined
          ? number(value.saturation, 0, 100)
          : 100;
      if (saturation === null) return { problem: "saturation is 0–100" };
      const hue = (turn * 53 + index * GOLDEN_ANGLE) % 360;
      return colourWrites(device, hue, saturation);
    }
    case "mode":
    case "fan_speed":
    case "swing": {
      const option = own[setting].values?.find(
        (candidate) =>
          candidate.key.toLowerCase() === String(value).toLowerCase() ||
          String(candidate.value) === String(value) ||
          candidate.name?.toLowerCase() === String(value).toLowerCase(),
      );
      if (option) return writes(device, own[setting], option.value);
      if (!own[setting].values && Number.isFinite(Number(value))) {
        return writes(device, own[setting], Number(value));
      }
      return {
        problem: `unknown ${setting}`,
        options: optionsOf(own[setting]),
      };
    }
    default: {
      const spec = own[setting];
      const amount = number(value, spec.min ?? -Infinity, spec.max ?? Infinity);
      if (amount === null) {
        return {
          problem: `${setting} out of range`,
          ...(Number.isFinite(spec.min)
            ? { min: spec.min, max: spec.max }
            : {}),
        };
      }
      return writes(device, spec, amount);
    }
  }
}

function colourWrites(device, hue, saturation) {
  const own = device.writable;
  const result = [
    write(device, "color", own.hue, Math.round(((hue % 360) + 360) % 360)),
  ];
  if (own.saturation) {
    result.push(write(device, "color", own.saturation, Math.round(saturation)));
  }
  return { writes: result };
}

function writes(device, spec, value) {
  return { writes: [write(device, spec.setting, spec, value)] };
}

function write(device, setting, spec, value) {
  return { device, setting, ref: spec.ref, type: spec.type, value };
}

function lightsUp(setting, written) {
  if (LOOKS.has(setting)) return true;
  if (setting === "brightness" || setting === "brightness_change") {
    return written.some(
      ({ type, value }) => type === "Brightness" && value > 0,
    );
  }
  return false;
}

// A lamp keeps its stored white while it shows a colour, and its colour
// while it shows white. A white for a lamp in colour mode, or a colour for
// one in white mode, is always sent, one step off the stored value when they
// are equal, since an equal value would change nothing.
function switchColorMode(write, current) {
  const mode = write.device.modeRef
    ? current.get(write.device.modeRef)
    : undefined;
  const switches =
    (write.type === "ColorTemperature" && mode === COLOR_MODE.HUE) ||
    (write.type === "Hue" && mode === COLOR_MODE.TEMPERATURE);
  if (!switches) return;
  write.force = true;
  if (sameValue(current.get(write.ref), write.value)) {
    write.value =
      write.type === "Hue"
        ? (write.value + 1) % 360
        : Math.max(1, write.value - 1);
  }
}

// The MCP refuses two commands to one characteristic in a call; the later
// one is what the person asked last.
function lastPerCharacteristic(writes) {
  const last = new Map(writes.map((write, index) => [write.ref, index]));
  return writes.filter((write, index) => last.get(write.ref) === index);
}

export function sameValue(current, requested) {
  if (current === undefined || current === null) return false;
  if (typeof requested === "boolean") return current === requested;
  if (typeof requested === "number") return Number(current) === requested;
  return String(current) === String(requested);
}

function number(value, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function optionsOf(spec) {
  return (spec?.values ?? []).map(({ key, name }) => `${key} ${name}`);
}

// The colour of a white of the given temperature, by Tanner Helland's
// approximation of black-body light, as hue degrees and saturation percent.
export function kelvinColor(kelvin) {
  const t = Math.min(40_000, Math.max(1_000, kelvin)) / 100;
  const clamp = (value) => Math.min(255, Math.max(0, value));
  const red = t <= 66 ? 255 : clamp(329.698727446 * (t - 60) ** -0.1332047592);
  const green = clamp(
    t <= 66
      ? 99.4708025861 * Math.log(t) - 161.1195681661
      : 288.1221695283 * (t - 60) ** -0.0755148492,
  );
  const blue =
    t >= 66
      ? 255
      : t <= 19
        ? 0
        : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  return {
    hue: Math.round((hue + 360) % 360),
    saturation: Math.round(max === 0 ? 0 : (delta / max) * 100),
  };
}
