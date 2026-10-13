// Narrow household tools for the voice prototype. They use only the public
// sprut-agent MCP contract: src/server.mjs runs as an MCP child over stdio,
// and every read and write goes through its tools. The voice model gets a
// catalog of controllable devices with short ids, fresh readings and one-shot
// device commands; scenarios, settings and new devices are out of reach.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CATALOG_MAX_AGE_MS = 5 * 60_000;
const ROOM_PAGE = { limit: 100, max_bytes: 32_768 };

// Writable characteristic types the voice model may set, under its own names.
const CONTROLS = {
  On: { control: "power", kind: "bool" },
  Active: { control: "power", kind: "active" },
  Brightness: { control: "brightness", kind: "number", min: 0, max: 100 },
  TargetPosition: { control: "position", kind: "number", min: 0, max: 100 },
  TargetTemperature: {
    control: "target_temperature",
    kind: "number",
    details: true,
  },
  CoolingThresholdTemperature: {
    control: "cooling_temperature",
    kind: "number",
    details: true,
  },
  HeatingThresholdTemperature: {
    control: "heating_temperature",
    kind: "number",
    details: true,
  },
  TargetRelativeHumidity: {
    control: "target_humidity",
    kind: "number",
    details: true,
  },
  RotationSpeed: {
    control: "fan_speed_percent",
    kind: "number",
    details: true,
  },
  TargetHeatingCoolingState: { control: "mode", kind: "enum", details: true },
  TargetHeaterCoolerState: { control: "mode", kind: "enum", details: true },
  TargetAirPurifierState: { control: "mode", kind: "enum", details: true },
  C_FanSpeed: { control: "fan_speed", kind: "enum", details: true },
  SwingMode: { control: "swing", kind: "enum", details: true },
  Hue: { control: "color", kind: "color" },
  ColorTemperature: {
    control: "color_temperature",
    kind: "kelvin",
    details: true,
  },
};
export const CONTROL_NAMES = [
  ...new Set(Object.values(CONTROLS).map(({ control }) => control)),
];

// Colours a person names: hue in degrees and saturation in percent.
const COLORS = [
  ["красный", 0, 100],
  ["оранжевый", 30, 100],
  ["жёлтый", 55, 100],
  ["салатовый", 90, 100],
  ["зелёный", 120, 100],
  ["бирюзовый", 170, 100],
  ["голубой", 195, 100],
  ["синий", 235, 100],
  ["фиолетовый", 275, 100],
  ["розовый", 320, 60],
  ["белый", 0, 0],
];
const ENGLISH_COLORS = {
  red: "красный",
  orange: "оранжевый",
  yellow: "жёлтый",
  green: "зелёный",
  cyan: "голубой",
  blue: "синий",
  purple: "фиолетовый",
  violet: "фиолетовый",
  pink: "розовый",
  white: "белый",
};
const WHITE_KELVIN = { теплый: 2700, нейтральный: 4000, холодный: 6000 };
// HomeKit's usual ColorTemperature range in mireds when a lamp reports none.
const DEFAULT_MIREDS = { min: 140, max: 500 };
// A lamp lights up when a person sets how it looks.
const LIGHTING_CONTROLS = new Set(["brightness", "color", "color_temperature"]);

const KIND_LABELS = {
  light: "свет",
  switch: "выключатель или розетка",
  climate: "климат",
  air: "воздух",
  cover: "шторы",
  sensor: "датчик",
};

// Values worth saying aloud, by characteristic type.
const READINGS = {
  On: "включено",
  Active: "работает",
  Brightness: "яркость",
  CurrentPosition: "открыто на",
  CurrentTemperature: "температура",
  TargetTemperature: "целевая температура",
  CurrentRelativeHumidity: "влажность",
  TargetRelativeHumidity: "целевая влажность",
  TargetHeatingCoolingState: "режим",
  TargetHeaterCoolerState: "режим",
  TargetAirPurifierState: "режим",
  CurrentHeatingCoolingState: "сейчас",
  C_FanSpeed: "вентилятор",
  RotationSpeed: "скорость вентилятора",
  SwingMode: "качание",
  ContactSensorState: "контакт",
  MotionDetected: "движение",
  OccupancyDetected: "присутствие",
  LeakDetected: "протечка",
  SmokeDetected: "дым",
  CarbonDioxideLevel: "CO2",
  AirQuality: "качество воздуха",
  PM2_5Density: "PM2.5",
  CurrentAmbientLightLevel: "освещённость",
};
const SENSOR_READINGS = new Set([
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

const COMMAND_MEANINGS = {
  applied: "выполнено",
  already_desired: "уже было так, ничего не менялось",
  uncertain: "команда ушла, но нет подтверждения: не говори, что получилось",
  conflict: "значение тем временем изменил кто-то другой",
  rejected: "устройство или хаб отказали",
  not_sent: "не отправлено",
};

export class HomeToolError extends Error {
  constructor(body) {
    super(body?.error?.message ?? "sprut-agent returned an error");
    this.body = body;
  }
}

export class HomeTools {
  #env;
  #stderr;
  #client = null;
  #connecting = null;
  #catalog = null;
  #loading = null;

  constructor({ env = process.env, stderr = "inherit" } = {}) {
    this.#env = env;
    this.#stderr = stderr;
  }

  async close() {
    await this.#client?.close();
    this.#client = null;
  }

  async catalog({ refresh = false } = {}) {
    const fresh =
      this.#catalog && Date.now() - this.#catalog.loadedAt < CATALOG_MAX_AGE_MS;
    if (fresh && !refresh) return this.#catalog;
    this.#loading ??= this.#loadCatalog()
      .then((catalog) => {
        this.#catalog = catalog;
        return catalog;
      })
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }

  // Sends one-shot commands through send_device_commands. Every command is
  // resolved against the catalog first: if any is not understood, nothing is
  // sent, the same all-or-nothing rule the MCP applies to invalid values.
  async control({ commands, reason } = {}) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return notSent([{ problem: "Нет ни одной команды." }]);
    }
    let catalog = await this.catalog();
    if (commands.some((command) => !catalog.devices.has(command?.device))) {
      catalog = await this.catalog({ refresh: true });
    }
    const planned = [];
    const problems = [];
    for (const command of commands) {
      const device = catalog.devices.get(command?.device);
      if (!device) {
        problems.push({
          device: command?.device ?? null,
          problem: "Такого устройства нет в списке.",
        });
        continue;
      }
      const resolved = resolveCommand(device, command.control, command.value);
      if (resolved.problem) {
        problems.push({
          device: device.id,
          name: device.name,
          control: command.control,
          ...resolved,
        });
      } else {
        planned.push(...resolved.items.map((item) => ({ ...item, device })));
      }
    }
    if (problems.length > 0) return notSent(problems);
    const current = await this.#currentValues(catalog, planned);
    const ordered = withImpliedPower(planned, current);
    // From the VM every command costs about a second of hub round trips, and
    // the MCP always sends On even when the lamp already has it. A command
    // whose characteristic already holds the value is answered here instead.
    const toSend = ordered.filter(
      (item) => !sameValue(current.get(item.ref), item.value),
    );
    let sent = [];
    if (toSend.length > 0) {
      try {
        sent = (
          await this.#call("send_device_commands", {
            home_ref: catalog.homeRef,
            commands: toSend.map(({ ref, value }) => ({
              target_ref: ref,
              value,
            })),
            reason: `Голосовой помощник: ${String(reason || "просьба человека")}`,
          })
        ).results;
      } catch (error) {
        const invalid = error.body?.invalid_commands;
        if (!Array.isArray(invalid)) throw error;
        return notSent(
          invalid.map((item) => ({
            device: toSend[item.index]?.device.id ?? null,
            name: toSend[item.index]?.device.name ?? null,
            control: toSend[item.index]?.control ?? null,
            problem: item.message,
            ...rangeOf(item.contract),
          })),
        );
      }
    }
    const results = ordered.map((item) => {
      const index = toSend.indexOf(item);
      const result =
        index >= 0
          ? sent[index]
          : {
              status: "already_desired",
              observed_value: current.get(item.ref),
            };
      return {
        device: item.device.id,
        name: item.device.name,
        room: catalog.rooms.get(item.device.roomId)?.name ?? null,
        control: item.control,
        status: result.status,
        meaning: COMMAND_MEANINGS[result.status] ?? result.status,
        ...(result.rejection ? { reason: rejectionText(result) } : {}),
        ...(result.error && !result.rejection
          ? { reason: result.error.message }
          : {}),
        ...(result.warning ? { warning: result.warning.message } : {}),
        ...(result.previous_value !== undefined
          ? { before: result.previous_value }
          : {}),
        ...(result.observed_value !== undefined
          ? { now: result.observed_value }
          : {}),
      };
    });
    return {
      status: results.every(({ status }) =>
        ["applied", "already_desired"].includes(status),
      )
        ? "done"
        : "partly_done",
      results,
    };
  }

  // Reads current values fresh from the hub, room by room. Only devices of
  // the catalog are returned, so the voice model never sees technical
  // services it cannot name.
  async read({ devices, room, kind, only_on: onlyOn } = {}) {
    const catalog = await this.catalog();
    const roomRefs = new Set();
    let wanted = null;
    if (Array.isArray(devices) && devices.length > 0) {
      wanted = new Set(devices.filter((id) => catalog.devices.has(id)));
      if (wanted.size === 0) {
        return { status: "error", problem: "Таких устройств нет в списке." };
      }
      for (const id of wanted) {
        roomRefs.add(catalog.rooms.get(catalog.devices.get(id).roomId).ref);
      }
    } else if (room) {
      const found = findRoom(catalog, room);
      if (!found) {
        return {
          status: "error",
          problem: "Такой комнаты нет.",
          rooms: [...catalog.rooms.values()].map(({ id, name }) => ({
            id,
            name,
          })),
        };
      }
      roomRefs.add(found.ref);
    } else {
      for (const device of catalog.devices.values()) {
        if (kind && device.kind !== kind) continue;
        roomRefs.add(catalog.rooms.get(device.roomId).ref);
      }
    }
    const pages = await mapLimit([...roomRefs], 4, (ref) =>
      this.#readRoom(catalog.homeRef, ref),
    );
    const found = [];
    for (const page of pages) {
      for (const { room: hubRoom, device, service } of page.services) {
        const id = serviceId(service.ref);
        const listed = catalog.devices.get(id);
        if (!listed || (wanted && !wanted.has(id))) continue;
        // Bulbs hidden in the app behind a group answer only when named.
        if (!wanted && listed.hidden) continue;
        if (kind && listed.kind !== kind) continue;
        if (onlyOn && service.on !== true) continue;
        found.push({
          device: id,
          name: service.name,
          room: hubRoom.name,
          available: device.available !== false,
          ...(Number.isFinite(device.battery_percent)
            ? { battery: `${device.battery_percent} %` }
            : {}),
          values: readingsOf(service),
        });
      }
    }
    return {
      status: "ok",
      observed_at: pages[0]?.observedAt ?? null,
      devices: found,
    };
  }

  // Current values of every characteristic in the rooms of the planned
  // commands, one fresh room read each. Without them every command is sent.
  async #currentValues(catalog, planned) {
    const roomRefs = new Set(
      planned.map(({ device }) => catalog.rooms.get(device.roomId).ref),
    );
    const values = new Map();
    try {
      const pages = await mapLimit([...roomRefs], 4, (ref) =>
        this.#readRoom(catalog.homeRef, ref),
      );
      for (const page of pages) {
        for (const { service } of page.services) {
          for (const value of service.values ?? []) {
            if (value.ref) values.set(value.ref, value.value);
          }
        }
      }
    } catch {
      values.clear();
    }
    return values;
  }

  async #mcp() {
    if (this.#client) return this.#client;
    this.#connecting ??= (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "src", "server.mjs")],
        cwd: projectRoot,
        env: this.#env,
        stderr: this.#stderr,
      });
      const client = new Client({ name: "sprut-voice", version: "0.1.0" });
      client.onclose = () => {
        if (this.#client === client) this.#client = null;
      };
      await client.connect(transport);
      this.#client = client;
      return client;
    })().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #call(name, args) {
    const client = await this.#mcp();
    const result = await client.callTool({ name, arguments: args });
    const body =
      result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
    if (result.isError) throw new HomeToolError(body);
    return body;
  }

  async #loadCatalog() {
    const overview = await this.#call("home_overview", {});
    if (!overview.home?.ref) throw new HomeToolError(overview);
    const homeRef = overview.home.ref;
    const pages = await mapLimit(
      overview.rooms.filter((room) => room.device_count > 0),
      4,
      (room) => this.#readRoom(homeRef, room.ref),
    );
    const rooms = new Map();
    const devices = new Map();
    for (const page of pages) {
      for (const entry of page.services) {
        const device = catalogEntry(entry);
        if (!device || devices.has(device.id)) continue;
        devices.set(device.id, device);
        if (!rooms.has(device.roomId)) {
          rooms.set(device.roomId, {
            id: device.roomId,
            ref: entry.room.ref,
            name: entry.room.name,
          });
        }
      }
    }
    // Modes, fan speeds and temperature ranges differ per device; only a
    // characteristic read reports them.
    const detailed = [...devices.values()].flatMap((device) =>
      Object.values(device.controls).filter((control) => control.details),
    );
    await mapLimit(detailed, 6, async (control) => {
      const body = await this.#call("get_entity", {
        entity_ref: control.ref,
      }).catch(() => null);
      const capabilities = body?.entity?.capabilities;
      if (!capabilities) return;
      if (Array.isArray(capabilities.valid_values)) {
        control.values = capabilities.valid_values.map(
          ({ key, name, value }) => ({ key, name, value }),
        );
      } else {
        control.min = capabilities.min;
        control.max = capabilities.max;
        control.step = capabilities.step;
        control.unit = capabilities.unit;
      }
    });
    return {
      homeRef,
      homeName: overview.home.name,
      loadedAt: Date.now(),
      rooms,
      devices,
    };
  }

  async #readRoom(homeRef, roomRef) {
    const services = [];
    let observedAt = null;
    let args = { home_ref: homeRef, room_ref: roomRef, ...ROOM_PAGE };
    while (args) {
      const page = await this.#call("find_devices", args);
      observedAt ??= page.observed_at ?? null;
      for (const room of page.rooms ?? []) {
        for (const device of room.devices ?? []) {
          for (const service of device.services ?? []) {
            services.push({ room, device, service });
          }
        }
      }
      args = page.next?.arguments ?? null;
    }
    return { observedAt, services };
  }
}

// The catalog as the voice model reads it: rooms, devices with short ids and
// what each one can do. Ids stay out of speech; the instructions say so.
// Lamps hidden in the SprutHub app are usually the bulbs behind a group such
// as a chandelier; they are listed apart, for requests about single bulbs.
export function describeCatalog(catalog) {
  const lines = [];
  for (const room of catalog.rooms.values()) {
    lines.push(`Комната «${room.name}» [${room.id}]:`);
    const hidden = new Map();
    for (const device of catalog.devices.values()) {
      if (device.roomId !== room.id) continue;
      const controls = Object.entries(device.controls)
        .map(([name, control]) => describeControl(name, control))
        .join("; ");
      if (device.hidden) {
        const names = hidden.get(controls) ?? [];
        names.push(
          `[${device.id}] «${device.name}»${device.available ? "" : " (не на связи)"}`,
        );
        hidden.set(controls, names);
        continue;
      }
      const parts = [`- [${device.id}] «${device.name}»`];
      if (device.deviceName && device.deviceName !== device.name) {
        parts.push(` (прибор «${device.deviceName}»)`);
      }
      if (device.functionOf)
        parts.push(`, функция прибора «${device.functionOf}»`);
      parts.push(`, ${KIND_LABELS[device.kind]}`);
      if (controls) parts.push(`; можно: ${controls}`);
      if (device.readings.length > 0) {
        parts.push(`; показывает: ${device.readings.join(", ")}`);
      }
      if (!device.available) parts.push("; сейчас не на связи");
      lines.push(parts.join(""));
    }
    for (const [controls, names] of hidden) {
      lines.push(
        `- отдельные лампочки, скрытые в приложении: ${names.join(", ")}; у каждой можно: ${controls}`,
      );
    }
  }
  return lines.join("\n");
}

function catalogEntry({ room, device, service }) {
  const id = serviceId(service.ref);
  const roomId = roomIdOf(room.ref);
  if (!id || !roomId || !(service.kind in KIND_LABELS)) return null;
  if (service.hidden && service.kind !== "light") return null;
  const values = service.values ?? service.characteristics ?? [];
  const controls = {};
  for (const value of values) {
    const spec = CONTROLS[value.type];
    if (!spec || value.writable !== true || controls[spec.control]) continue;
    controls[spec.control] = { ...spec, type: value.type, ref: value.ref };
  }
  const saturation = values.find(
    ({ type, writable }) => type === "Saturation" && writable === true,
  );
  if (controls.color && saturation)
    controls.color.saturationRef = saturation.ref;
  const readings = [
    ...new Set(
      values
        .filter(({ type }) => SENSOR_READINGS.has(type))
        .map(({ type }) => READINGS[type]),
    ),
  ];
  if (Object.keys(controls).length === 0 && readings.length === 0) return null;
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
    controls,
    readings,
  };
}

function describeControl(name, control) {
  if (control.kind === "color") {
    return `${name} (${COLORS.map(([color]) => color).join(", ")})`;
  }
  if (control.kind === "kelvin") {
    const { min, max } = kelvinRange(control);
    return `${name} (тёплый, нейтральный, холодный или ${min}–${max} K)`;
  }
  if (control.values?.length) {
    return `${name} (${control.values.map(({ key, name: label }) => `${key} — ${label}`).join(", ")})`;
  }
  if (control.kind === "bool" || control.kind === "active")
    return `${name} (on, off)`;
  if (Number.isFinite(control.min) && Number.isFinite(control.max)) {
    const unit = control.unit ?? (control.max === 100 ? "%" : "");
    return `${name} ${control.min}–${control.max}${unit ? ` ${unit}` : ""}`;
  }
  return name;
}

function resolveCommand(device, control, raw) {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (control === "power") {
    const on = parseOnOff(value);
    if (on === null) return { problem: "power принимает on или off." };
    const power = device.controls.power;
    if (power?.kind === "bool") return single(power, on);
    if (power?.kind === "active") return single(power, on ? 1 : 0);
    const mode = device.controls.mode;
    const off = mode?.values?.find(({ key }) => key === "OFF");
    if (!on && off) return single(mode, off.value);
    if (mode) {
      return {
        problem:
          "Этот прибор включается выбором режима (mode). Выбери режим по смыслу просьбы или спроси человека.",
        options: optionsOf(mode),
      };
    }
    return { problem: "Это устройство нельзя включить или выключить." };
  }
  const spec = device.controls[control];
  if (!spec) {
    const available = Object.keys(device.controls);
    return {
      problem:
        available.length > 0
          ? `У этого устройства нет ${control}. Можно: ${available.join(", ")}.`
          : "Это устройство только показывает значения.",
    };
  }
  if (spec.kind === "color") {
    const color = parseColor(value);
    if (!color) {
      return {
        problem: "Не знаю такого цвета.",
        options: COLORS.map(([name]) => name),
      };
    }
    const items = [{ ref: spec.ref, value: color.hue, control }];
    if (spec.saturationRef) {
      items.push({ ref: spec.saturationRef, value: color.saturation, control });
    }
    return { items };
  }
  if (spec.kind === "kelvin") {
    const kelvin = WHITE_KELVIN[normalize(value)] ?? parseNumber(value);
    if (!Number.isFinite(kelvin) || kelvin < 1000) {
      return {
        problem:
          "Оттенок белого: тёплый, нейтральный, холодный или число кельвинов.",
        ...kelvinRange(spec),
      };
    }
    const { min, max } = miredRange(spec);
    return single(spec, Math.min(max, Math.max(min, Math.round(1e6 / kelvin))));
  }
  if (spec.kind === "enum") {
    const found = matchOption(spec, value) ?? matchSwitch(spec, value);
    if (!found)
      return { problem: "Нет такого варианта.", options: optionsOf(spec) };
    return single(spec, found.value);
  }
  const number = parseNumber(value);
  if (value === "" || !Number.isFinite(number)) {
    return { problem: `${control} — это число.` };
  }
  if (
    (Number.isFinite(spec.min) && number < spec.min) ||
    (Number.isFinite(spec.max) && number > spec.max)
  ) {
    return { problem: "Значение вне допустимого диапазона.", ...rangeOf(spec) };
  }
  if (control === "brightness" && number === 0 && device.controls.power) {
    return resolveCommand(device, "power", "off");
  }
  return single(spec, number);
}

// «Свет в спальне на тридцать процентов» or «сделай ленту красной» means a
// lit lamp: a level or colour sent to a lamp that is off is only stored by
// the hub. So such a command without its own power command also turns the
// lamp on, after everything else for that lamp is set, unless it is lit.
function withImpliedPower(planned, current = new Map()) {
  const explicit = new Set(
    planned
      .filter(({ control }) => control === "power")
      .map(({ device }) => device),
  );
  const lastLighting = new Map();
  planned.forEach((item, index) => {
    const lightsUp =
      LIGHTING_CONTROLS.has(item.control) &&
      !(item.control === "brightness" && item.value <= 0);
    const power = item.device.controls.power;
    if (
      lightsUp &&
      power?.kind === "bool" &&
      current.get(power.ref) !== true &&
      !explicit.has(item.device)
    ) {
      lastLighting.set(item.device, index);
    }
  });
  return planned.flatMap((item, index) =>
    lastLighting.get(item.device) === index
      ? [
          item,
          {
            ref: item.device.controls.power.ref,
            value: true,
            control: "power",
            device: item.device,
          },
        ]
      : [item],
  );
}

function sameValue(current, requested) {
  if (current === undefined || current === null) return false;
  if (typeof requested === "boolean") return current === requested;
  if (typeof requested === "number") return Number(current) === requested;
  return String(current) === String(requested);
}

function parseColor(value) {
  const text = normalize(value);
  const name = ENGLISH_COLORS[text] ?? text;
  const named = COLORS.find(([color]) => normalize(color) === normalize(name));
  if (named) return { hue: named[1], saturation: named[2] };
  const hue = parseNumber(value);
  if (Number.isFinite(hue) && hue >= 0 && hue <= 360) {
    return { hue: Math.round(hue), saturation: 100 };
  }
  return null;
}

function colorName(hue, saturation) {
  if (
    !Number.isFinite(hue) ||
    (Number.isFinite(saturation) && saturation < 15)
  ) {
    return "белый";
  }
  let best = null;
  for (const [name, colorHue, colorSaturation] of COLORS) {
    if (colorSaturation === 0) continue;
    const distance = Math.min(
      Math.abs(hue - colorHue),
      360 - Math.abs(hue - colorHue),
    );
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best.name;
}

function whiteName(mireds) {
  const kelvin = Math.round(1e6 / mireds / 100) * 100;
  const label =
    kelvin < 3300 ? "тёплый" : kelvin < 5000 ? "нейтральный" : "холодный";
  return `${label} (${kelvin} K)`;
}

function miredRange(spec) {
  return {
    min: Number.isFinite(spec.min) ? spec.min : DEFAULT_MIREDS.min,
    max: Number.isFinite(spec.max) ? spec.max : DEFAULT_MIREDS.max,
  };
}

// Lamps may report a cold end far beyond daylight (20 000 K on the owner's
// bulbs); a person never asks for more than about 6500 K.
function kelvinRange(spec) {
  const { min, max } = miredRange(spec);
  return {
    min: Math.round(1e6 / max / 100) * 100,
    max: Math.min(6500, Math.round(1e6 / min / 100) * 100),
  };
}

// A switch-like setting such as SwingMode takes on and off as well as its keys.
function matchSwitch(spec, value) {
  const on = parseOnOff(value);
  if (on === null) return undefined;
  return spec.values?.find(({ key }) =>
    on ? /(^|_)ENABLED$/.test(key) : /(^|_)DISABLED$/.test(key),
  );
}

function parseNumber(value) {
  if (typeof value === "number") return value;
  const text = String(value)
    .replace(",", ".")
    .replace(/[^\d.+-]/g, "");
  return text === "" ? Number.NaN : Number(text);
}

function normalize(value) {
  return String(value).toLowerCase().replaceAll("ё", "е").trim();
}

function single(spec, value) {
  return { items: [{ ref: spec.ref, value, control: spec.control }] };
}

function parseOnOff(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value).toLowerCase();
  if (["on", "true", "1", "вкл", "включить", "включено"].includes(text))
    return true;
  if (["off", "false", "0", "выкл", "выключить", "выключено"].includes(text)) {
    return false;
  }
  return null;
}

function matchOption(spec, value) {
  const text = String(value).toLowerCase().replaceAll("ё", "е");
  return spec.values?.find(
    (option) =>
      option.key.toLowerCase() === text ||
      option.name?.toLowerCase().replaceAll("ё", "е") === text ||
      String(option.value) === text,
  );
}

function optionsOf(spec) {
  return (spec.values ?? []).map(({ key, name }) => `${key} — ${name}`);
}

function rangeOf(spec) {
  if (!spec || !Number.isFinite(spec.min) || !Number.isFinite(spec.max))
    return {};
  return {
    min: spec.min,
    max: spec.max,
    ...(spec.unit ? { unit: spec.unit } : {}),
  };
}

function rejectionText(result) {
  const rejection = result.rejection;
  if (typeof rejection === "string") return rejection;
  return rejection.message ?? rejection.reason ?? JSON.stringify(rejection);
}

function notSent(problems) {
  return {
    status: "not_sent",
    meaning:
      "Ничего не отправлено. Исправь команду по подсказке или спроси человека.",
    problems,
  };
}

function readingsOf(service) {
  const readings = {};
  const byType = new Map();
  for (const value of service.values ?? []) {
    byType.set(value.type, value);
    const label = READINGS[value.type];
    if (!label || label in readings) continue;
    readings[label] = formatValue(value);
  }
  // A colour lamp shows either a colour or a white; its colour mode says which.
  const mode = byType.get("C_ColorMode")?.enum?.key;
  const hue = byType.get("Hue")?.value;
  const mireds = byType.get("ColorTemperature")?.value;
  if (Number.isFinite(hue) && mode !== "TEMPERATURE") {
    readings.цвет = colorName(hue, byType.get("Saturation")?.value);
  } else if (Number.isFinite(mireds) && mireds > 0) {
    readings["оттенок белого"] = whiteName(mireds);
  }
  return readings;
}

function formatValue(value) {
  if (value.enum) return value.enum.name ?? value.enum.key;
  if (typeof value.value === "boolean") return value.value ? "да" : "нет";
  if (value.value === null || value.value === undefined) return "неизвестно";
  return value.unit ? `${value.value} ${value.unit}` : value.value;
}

function findRoom(catalog, query) {
  const text = String(query).toLowerCase().replaceAll("ё", "е").trim();
  const rooms = [...catalog.rooms.values()];
  return (
    rooms.find(({ id }) => id === text) ??
    rooms.find(
      ({ name }) => name.toLowerCase().replaceAll("ё", "е") === text,
    ) ??
    rooms.find(({ name }) =>
      name.toLowerCase().replaceAll("ё", "е").includes(text),
    )
  );
}

function serviceId(ref) {
  const match = /\/accessory\/(\d+)\/service\/(\d+)$/.exec(ref ?? "");
  return match ? `a${match[1]}s${match[2]}` : null;
}

function roomIdOf(ref) {
  const match = /\/room\/(\d+)$/.exec(ref ?? "");
  return match ? `r${match[1]}` : null;
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
