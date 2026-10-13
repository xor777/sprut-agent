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
// The hub shows a colour bulb's new value a moment after the write, later
// than the MCP's immediate readback; an unconfirmed command is read again.
const VERIFY_DELAY_MS = 1_500;
// How far a read value may be from the requested one and still be it:
// devices round levels, hues and white temperatures.
const TOLERANCE = {
  brightness: 2,
  position: 3,
  color: 5,
  color_temperature: 10,
  target_temperature: 0.5,
  cooling_temperature: 0.5,
  heating_temperature: 0.5,
  target_humidity: 2,
  fan_speed_percent: 3,
};
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
const NEUTRAL_KELVIN = 4000;
// RGB LEDs mixing a white at the full black-body saturation look orange or
// pink to the owner; a white made from colour uses this share of it.
const MIXED_WHITE_SATURATION = 0.6;
// C_ColorMode values on the owner's hub: which of colour or white a lamp shows.
const COLOR_MODE = { HUE: 1, TEMPERATURE: 2 };
// «Разными цветами» for a whole room: neighbours differ as much as possible.
const CONTRAST_PALETTE = [
  "красный",
  "синий",
  "зелёный",
  "жёлтый",
  "фиолетовый",
  "оранжевый",
  "бирюзовый",
  "розовый",
  "голубой",
  "салатовый",
];
const PALETTE_WORDS = new Set(["разные", "разными", "разный", "different"]);
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
  #verifyDelayMs;
  #client = null;
  #connecting = null;
  #catalog = null;
  #loading = null;

  constructor({
    env = process.env,
    stderr = "inherit",
    verifyDelayMs = VERIFY_DELAY_MS,
  } = {}) {
    this.#env = env;
    this.#stderr = stderr;
    this.#verifyDelayMs = verifyDelayMs;
  }

  async close() {
    await this.#client?.close();
    this.#client = null;
  }

  // An old catalog is answered at once and refreshed in the background: a
  // rebuild takes seconds from the VM and must not stall a spoken command.
  async catalog({ refresh = false } = {}) {
    if (this.#catalog && !refresh) {
      if (Date.now() - this.#catalog.loadedAt >= CATALOG_MAX_AGE_MS) {
        this.#reload().catch(() => {});
      }
      return this.#catalog;
    }
    return this.#reload();
  }

  #reload() {
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
    if (
      commands.some(
        (command) => !command?.room && !catalog.devices.has(command?.device),
      )
    ) {
      catalog = await this.catalog({ refresh: true });
    }
    const planned = [];
    const problems = [];
    for (const command of expandTargets(catalog, commands, problems)) {
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
    for (const item of ordered) switchColorMode(item, current);
    const toSend = ordered.filter(
      (item) => item.force || !sameValue(current.get(item.ref), item.value),
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
    const outcomes = new Map(
      ordered.map((item) => {
        const index = toSend.indexOf(item);
        return [
          item,
          index >= 0
            ? sent[index]
            : {
                status: "already_desired",
                observed_value: current.get(item.ref),
              },
        ];
      }),
    );
    await this.#confirmLate(catalog, outcomes);
    const results = ordered.map((item) => {
      const result = outcomes.get(item);
      return {
        device: item.device.id,
        name: item.device.name,
        ...(item.device.memberOf
          ? { group: catalog.devices.get(item.device.memberOf)?.name }
          : {}),
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
    const shown = new Map();
    for (const page of pages) {
      for (const { service } of page.services) {
        shown.set(serviceId(service.ref), readingsOf(service));
      }
    }
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
          values: listed.members
            ? groupReadings(readingsOf(service), listed.members, shown)
            : readingsOf(service),
        });
      }
    }
    return {
      status: "ok",
      observed_at: pages[0]?.observedAt ?? null,
      devices: found,
    };
  }

  // Reads unconfirmed commands again after a pause; a value that has arrived
  // by then, within the device's rounding, makes the command applied.
  async #confirmLate(catalog, outcomes) {
    const unconfirmed = [...outcomes].filter(
      ([, result]) => result.status === "uncertain" && result.sent !== false,
    );
    if (unconfirmed.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.#verifyDelayMs));
    const later = await this.#currentValues(
      catalog,
      unconfirmed.map(([item]) => item),
    );
    for (const [item, result] of unconfirmed) {
      if (!later.has(item.ref)) continue;
      const now = later.get(item.ref);
      outcomes.set(
        item,
        closeEnough(now, item.value, item.control)
          ? { status: "applied", observed_value: now }
          : { ...result, observed_value: now },
      );
    }
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
    await this.#findGroups(devices);
    return {
      homeRef,
      homeName: overview.home.name,
      loadedAt: Date.now(),
      rooms,
      devices,
    };
  }

  // A lamp whose On is fed by other lamps' On through Virtual links is a
  // group, like the owner's chandelier over five hidden bulbs. The hub links
  // its power, level and colour to the bulbs but not their white, so white
  // and colour go to the bulbs themselves.
  async #findGroups(devices) {
    const lamps = [...devices.values()].filter(
      (device) =>
        device.kind === "light" &&
        !device.hidden &&
        device.controls.power?.kind === "bool",
    );
    await mapLimit(lamps, 6, async (device) => {
      const body = await this.#call("get_entity", {
        entity_ref: device.controls.power.ref,
        include: ["relations"],
      }).catch(() => null);
      const links = body?.entity?.relations?.characteristic_links ?? [];
      const members = links
        .filter(
          ({ type, index }) =>
            type === "IN" && String(index).startsWith("Virtual/"),
        )
        .flatMap(({ related_characteristic_refs: refs = [] }) => refs)
        .map((ref) => serviceId(ref.replace(/\/characteristic\/\d+$/, "")))
        .filter((id) => id && id !== device.id && devices.has(id));
      if (members.length === 0) return;
      device.members = [...new Set(members)];
      for (const id of device.members) devices.get(id).memberOf = device.id;
      device.controls.color_temperature = {
        control: "color_temperature",
        kind: "members",
      };
    });
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
      if (device.memberOf) continue;
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
      if (device.members) {
        const members = device.members.map((id) => {
          const member = catalog.devices.get(id);
          return `[${id}] «${member.name}»${member.available ? "" : " (не на связи)"}`;
        });
        lines.push(
          `  группа: цвет и оттенок белого получат её лампочки ${members.join(", ")}`,
        );
      }
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
  if (controls.color && saturation) {
    controls.color.saturationRef = saturation.ref;
    // A colour-only lamp still gets warm or cold white, mixed from colour.
    controls.color_temperature ??= {
      control: "color_temperature",
      kind: "kelvin-color",
      hueRef: controls.color.ref,
      saturationRef: saturation.ref,
    };
  }
  const mode = values.find(({ type }) => type === "C_ColorMode");
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
    modeRef: mode?.ref ?? null,
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
  if (control.kind === "kelvin-color" || control.kind === "members") {
    return `${name} (тёплый, нейтральный, холодный)`;
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
    // RGB LEDs at zero saturation look bluish; white is a neutral white.
    if (["белый", "white"].includes(normalize(value))) {
      return resolveCommand(device, "color_temperature", NEUTRAL_KELVIN);
    }
    const color = parseColor(value);
    if (!color) {
      return {
        problem: "Не знаю такого цвета.",
        options: COLORS.map(([name]) => name),
      };
    }
    const items = [{ ref: spec.ref, value: color.hue, control, part: "Hue" }];
    if (spec.saturationRef) {
      items.push({
        ref: spec.saturationRef,
        value: color.saturation,
        control,
        part: "Saturation",
      });
    }
    return { items };
  }
  if (spec.kind === "kelvin-color") {
    const kelvin = WHITE_KELVIN[normalize(value)] ?? parseNumber(value);
    if (!Number.isFinite(kelvin) || kelvin < 1000) {
      return { problem: "Оттенок белого: тёплый, нейтральный или холодный." };
    }
    const { hue, saturation } = kelvinColor(kelvin);
    return {
      items: [
        { ref: spec.hueRef, value: hue, control, part: "Hue" },
        {
          ref: spec.saturationRef,
          value: Math.round(saturation * MIXED_WHITE_SATURATION),
          control,
          part: "Saturation",
        },
      ],
    };
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

function closeEnough(current, requested, control) {
  if (typeof requested !== "number" || !Number.isFinite(Number(current))) {
    return sameValue(current, requested);
  }
  const difference = Math.abs(Number(current) - requested);
  const distance =
    control === "color" ? Math.min(difference, 360 - difference) : difference;
  return distance <= (TOLERANCE[control] ?? 0);
}

// A lamp keeps its stored white while it shows a colour, and its colour
// while it shows white. A white for a lamp in colour mode (or a colour for
// one in white mode) is therefore always sent, one step off the stored value
// when they are equal, since an equal value would change nothing.
function switchColorMode(item, current) {
  const mode = item.device.modeRef
    ? current.get(item.device.modeRef)
    : undefined;
  const switches =
    (item.part === "ColorTemperature" && mode === COLOR_MODE.HUE) ||
    (item.part === "Hue" && mode === COLOR_MODE.TEMPERATURE);
  if (!switches) return;
  item.force = true;
  if (sameValue(current.get(item.ref), item.value)) {
    item.value =
      item.part === "Hue"
        ? (item.value + 1) % 360
        : Math.max(1, item.value - 1);
  }
}

function sameValue(current, requested) {
  if (current === undefined || current === null) return false;
  if (typeof requested === "boolean") return current === requested;
  if (typeof requested === "number") return Number(current) === requested;
  return String(current) === String(requested);
}

// A whole-room command names the room and the kind; it becomes one command
// per device of that kind there that can do it and is on the network.
// Colour and white also reach the bulbs hidden behind groups, since a group
// passes on only power and level; power and level go to what the app shows.
function expandTargets(catalog, commands, problems) {
  return expandGroups(catalog, expandRooms(catalog, commands, problems));
}

// White and colour for a group go to its bulbs: the group passes colour on
// but has no white, and a bulb showing colour must be told to switch.
function expandGroups(catalog, commands) {
  const expanded = [];
  for (const command of commands) {
    const group = catalog.devices.get(command?.device);
    if (
      !group?.members ||
      !["color", "color_temperature"].includes(command.control)
    ) {
      expanded.push(command);
      continue;
    }
    const members = group.members
      .map((id) => catalog.devices.get(id))
      .filter(
        (member) => member.available && supports(member, command.control),
      );
    const palette = PALETTE_WORDS.has(normalize(command.value));
    members.forEach((member, index) => {
      expanded.push({
        device: member.id,
        control: command.control,
        value: palette
          ? CONTRAST_PALETTE[index % CONTRAST_PALETTE.length]
          : command.value,
      });
    });
  }
  return expanded;
}

function expandRooms(catalog, commands, problems) {
  const expanded = [];
  for (const command of commands) {
    if (!command?.room) {
      expanded.push(command);
      continue;
    }
    const room = findRoom(catalog, command.room);
    if (!room) {
      problems.push({
        room: command.room,
        problem: "Такой комнаты нет.",
        rooms: [...catalog.rooms.values()].map(({ id, name }) => ({
          id,
          name,
        })),
      });
      continue;
    }
    const kind = command.kind ?? "light";
    const withHidden = ["color", "color_temperature"].includes(command.control);
    // Colour and white go to every bulb and lamp but not to the groups,
    // which would pass a colour on over the bulbs' white; power and level
    // go to what the app shows, groups included.
    const targets = [...catalog.devices.values()].filter(
      (device) =>
        device.roomId === room.id &&
        device.kind === kind &&
        device.available &&
        (withHidden ? !device.members : !device.hidden) &&
        supports(device, command.control),
    );
    if (targets.length === 0) {
      problems.push({
        room: room.name,
        control: command.control,
        problem: "В этой комнате нет доступных устройств, которые это умеют.",
      });
      continue;
    }
    const palette = PALETTE_WORDS.has(normalize(command.value));
    targets.forEach((device, index) => {
      expanded.push({
        device: device.id,
        control: command.control,
        value: palette
          ? CONTRAST_PALETTE[index % CONTRAST_PALETTE.length]
          : command.value,
      });
    });
  }
  return expanded;
}

function supports(device, control) {
  if (control === "power") {
    return Boolean(device.controls.power ?? device.controls.mode);
  }
  return Boolean(device.controls[control]);
}

// The colour of a white of the given temperature, by Tanner Helland's
// approximation of black-body light, as hue degrees and saturation percent.
function kelvinColor(kelvin) {
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
  // A white mixed from colour on a colour-only lamp.
  if (
    hue >= 15 &&
    hue <= 45 &&
    Number.isFinite(saturation) &&
    saturation <= 70
  ) {
    return "тёплый белый";
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
  return {
    items: [{ ref: spec.ref, value, control: spec.control, part: spec.type }],
  };
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

// A group's own colour is not what its bulbs show; the bulbs speak for it.
function groupReadings(readings, members, shown) {
  const counts = new Map();
  for (const id of members) {
    const bulb = shown.get(id);
    if (!bulb) continue;
    const look =
      bulb.включено === "нет"
        ? "выключена"
        : (bulb.цвет ??
          bulb["оттенок белого"]?.replace(/ \(.*\)$/, "") ??
          "неизвестно");
    counts.set(look, (counts.get(look) ?? 0) + 1);
  }
  const { цвет: _colour, "оттенок белого": _white, ...rest } = readings;
  if (counts.size === 0) return readings;
  return {
    ...rest,
    лампочки: [...counts]
      .map(([look, count]) => `${look} — ${count}`)
      .join(", "),
  };
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
