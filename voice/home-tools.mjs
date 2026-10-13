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
};
export const CONTROL_NAMES = [
  ...new Set(Object.values(CONTROLS).map(({ control }) => control)),
];

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
  uncertain:
    "команда ушла, но подтверждения нет: не говори, что получилось, скажи, что не уверена",
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
    const ordered = withImpliedPower(planned);
    let body;
    try {
      body = await this.#call("send_device_commands", {
        home_ref: catalog.homeRef,
        commands: ordered.map(({ ref, value }) => ({ target_ref: ref, value })),
        reason: `Голосовой помощник: ${String(reason || "просьба человека")}`,
      });
    } catch (error) {
      const invalid = error.body?.invalid_commands;
      if (!Array.isArray(invalid)) throw error;
      return notSent(
        invalid.map((item) => ({
          device: ordered[item.index]?.device.id ?? null,
          name: ordered[item.index]?.device.name ?? null,
          control: ordered[item.index]?.control ?? null,
          problem: item.message,
          ...rangeOf(item.contract),
        })),
      );
    }
    return {
      status: body.status === "ok" ? "done" : "partly_done",
      results: body.results.map((result, index) => {
        const { device, control } = ordered[index];
        return {
          device: device.id,
          name: device.name,
          room: catalog.rooms.get(device.roomId)?.name ?? null,
          control,
          status: result.status,
          meaning: COMMAND_MEANINGS[result.status] ?? result.status,
          ...(result.rejection ? { reason: rejectionText(result) } : {}),
          ...(result.error && !result.rejection
            ? { reason: result.error.message }
            : {}),
          ...(result.warning ? { warning: result.warning.message } : {}),
        };
      }),
    };
  }

  // Reads current values fresh from the hub, room by room. Only devices of
  // the catalog are returned, so the voice model never sees technical
  // services it cannot name.
  async read({ devices, room, only_on: onlyOn } = {}) {
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
      for (const { ref } of catalog.rooms.values()) roomRefs.add(ref);
    }
    const pages = await mapLimit([...roomRefs], 4, (ref) =>
      this.#readRoom(catalog.homeRef, ref),
    );
    const found = [];
    for (const page of pages) {
      for (const { room: hubRoom, device, service } of page.services) {
        const id = serviceId(service.ref);
        if (!catalog.devices.has(id) || (wanted && !wanted.has(id))) continue;
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
export function describeCatalog(catalog) {
  const lines = [];
  for (const room of catalog.rooms.values()) {
    lines.push(`Комната «${room.name}» [${room.id}]:`);
    for (const device of catalog.devices.values()) {
      if (device.roomId !== room.id) continue;
      const parts = [`- [${device.id}] «${device.name}»`];
      if (device.deviceName && device.deviceName !== device.name) {
        parts.push(` (прибор «${device.deviceName}»)`);
      }
      if (device.functionOf)
        parts.push(`, функция прибора «${device.functionOf}»`);
      parts.push(`, ${KIND_LABELS[device.kind]}`);
      const controls = Object.entries(device.controls).map(([name, control]) =>
        describeControl(name, control),
      );
      if (controls.length > 0) parts.push(`; можно: ${controls.join("; ")}`);
      if (device.readings.length > 0) {
        parts.push(`; показывает: ${device.readings.join(", ")}`);
      }
      if (!device.available) parts.push("; сейчас не на связи");
      lines.push(parts.join(""));
    }
  }
  return lines.join("\n");
}

function catalogEntry({ room, device, service }) {
  const id = serviceId(service.ref);
  const roomId = roomIdOf(room.ref);
  if (!id || !roomId || service.hidden || !(service.kind in KIND_LABELS)) {
    return null;
  }
  const values = service.values ?? service.characteristics ?? [];
  const controls = {};
  for (const value of values) {
    const spec = CONTROLS[value.type];
    if (!spec || value.writable !== true || controls[spec.control]) continue;
    controls[spec.control] = { ...spec, type: value.type, ref: value.ref };
  }
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
    available: device.available !== false,
    controls,
    readings,
  };
}

function describeControl(name, control) {
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
  if (spec.kind === "enum") {
    const found = matchOption(spec, value);
    if (!found)
      return { problem: "Нет такого варианта.", options: optionsOf(spec) };
    return single(spec, found.value);
  }
  const number = Number(
    String(value)
      .replace(",", ".")
      .replace(/[^\d.+-]/g, ""),
  );
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

// «Свет в спальне на тридцать процентов» means a lit lamp: a level sent to a
// lamp that is off is only stored by the hub. So a level above zero without
// its own power command also turns the lamp on, after the level is set.
function withImpliedPower(planned) {
  const ordered = [];
  for (const item of planned) {
    ordered.push(item);
    const power = item.device.controls.power;
    if (
      item.control === "brightness" &&
      item.value > 0 &&
      power?.kind === "bool" &&
      !planned.some(
        (other) => other.device === item.device && other.control === "power",
      )
    ) {
      ordered.push({
        ref: power.ref,
        value: true,
        control: "power",
        device: item.device,
      });
    }
  }
  return ordered;
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
  for (const value of service.values ?? []) {
    const label = READINGS[value.type];
    if (!label || label in readings) continue;
    readings[label] = formatValue(value);
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
