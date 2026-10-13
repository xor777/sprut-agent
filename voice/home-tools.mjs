// Household tools for the voice prototype over the public sprut-agent MCP:
// src/server.mjs runs as an MCP child over stdio, and every read and write
// goes through its tools. The model gets the catalog, fresh states and
// commands that set desired states; scenarios, settings and new devices
// stay out of reach.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DETAILED,
  deviceEntry,
  findRoom,
  roomIdOf,
  serviceId,
  stateOf,
} from "./catalog.mjs";
import { planCommands, roomsTouched, sameValue } from "./plan.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CATALOG_MAX_AGE_MS = 5 * 60_000;
// The hub shows a bulb's new value a moment after the write, later than the
// MCP's immediate readback; an unconfirmed write is read again after this.
const VERIFY_DELAY_MS = 1_500;
// How far a value read back may be from the one written and still be it:
// devices round levels, hues and white temperatures.
const TOLERANCE = {
  Brightness: 2,
  TargetPosition: 3,
  Hue: 5,
  Saturation: 5,
  ColorTemperature: 10,
  TargetTemperature: 0.5,
  CoolingThresholdTemperature: 0.5,
  HeatingThresholdTemperature: 0.5,
  TargetRelativeHumidity: 2,
  RotationSpeed: 3,
};
const ROOM_PAGE = { limit: 100, max_bytes: 32_768 };

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
  #turn = 0;

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
  // rebuild takes seconds and must not stall a spoken command.
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

  // Sets desired states. Every command is planned first; if any is not
  // understood, nothing is sent, as the MCP does with invalid values. A dry
  // run returns the plan without writing, to check it on a live home.
  async control({ commands, reason } = {}, { dryRun = false } = {}) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return notSent([{ problem: "no commands" }]);
    }
    let catalog = await this.catalog();
    if (
      commands.some(
        (command) => command?.device && !catalog.devices.has(command.device),
      )
    ) {
      catalog = await this.catalog({ refresh: true });
    }
    const current = await this.#currentValues(
      catalog,
      roomsTouched(catalog, commands),
    );
    const plan = planCommands(catalog, commands, current, {
      turn: this.#turn++,
    });
    if (plan.problems.length > 0) return notSent(plan.problems);
    const toSend = plan.writes.filter(
      (write) => write.force || !sameValue(current.get(write.ref), write.value),
    );
    if (dryRun) {
      return {
        status: "dry_run",
        writes: plan.writes.map((write) => ({
          ...describeWrite(catalog, write),
          value: write.value,
          send: toSend.includes(write),
        })),
        skipped: plan.skipped,
      };
    }
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
            ...(toSend[item.index]
              ? describeWrite(catalog, toSend[item.index])
              : {}),
            problem: item.message,
          })),
        );
      }
    }
    const outcomes = new Map(
      plan.writes.map((write) => {
        const index = toSend.indexOf(write);
        return [
          write,
          index >= 0
            ? sent[index]
            : {
                status: "already_desired",
                observed_value: current.get(write.ref),
              },
        ];
      }),
    );
    await this.#confirmLate(catalog, outcomes);
    const results = plan.writes.map((write) => {
      const result = outcomes.get(write);
      return {
        ...describeWrite(catalog, write),
        status: result.status,
        ...(result.rejection ? { reason: rejectionText(result) } : {}),
        ...(result.error && !result.rejection
          ? { reason: result.error.message }
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
      ...(plan.skipped.length > 0 ? { skipped: plan.skipped } : {}),
    };
  }

  // Reads current states fresh from the hub, room by room. Only devices of
  // the catalog are returned, and a group answers with its bulbs.
  async read({ devices, room, kind, only_on: onlyOn } = {}) {
    const catalog = await this.catalog();
    let wanted = null;
    let rooms;
    if (Array.isArray(devices) && devices.length > 0) {
      wanted = new Set(devices.filter((id) => catalog.devices.has(id)));
      if (wanted.size === 0) {
        return { status: "error", problem: "no such devices" };
      }
      rooms = roomsTouched(
        catalog,
        [...wanted].map((device) => ({ device })),
      );
    } else if (room) {
      const found = findRoom(catalog, room);
      if (!found) {
        return {
          status: "error",
          problem: "no such room",
          rooms: [...catalog.rooms.values()].map(({ id, name }) => ({
            id,
            name,
          })),
        };
      }
      rooms = [found];
    } else {
      rooms = [
        ...new Set(
          [...catalog.devices.values()]
            .filter((device) => !kind || device.kind === kind)
            .map((device) => catalog.rooms.get(device.roomId)),
        ),
      ];
    }
    const pages = await mapLimit(rooms, 4, (found) =>
      this.#readRoom(catalog.homeRef, found.ref),
    );
    const states = new Map();
    for (const page of pages) {
      for (const { service } of page.services) {
        states.set(serviceId(service.ref), stateOf(service));
      }
    }
    const found = [];
    for (const page of pages) {
      for (const { room: hubRoom, device, service } of page.services) {
        const id = serviceId(service.ref);
        const listed = catalog.devices.get(id);
        if (!listed || (wanted && !wanted.has(id))) continue;
        if (!wanted && (listed.hidden || listed.memberOf)) continue;
        if (kind && listed.kind !== kind) continue;
        if (onlyOn && service.on !== true) continue;
        const state = states.get(id);
        found.push({
          device: id,
          name: service.name,
          room: hubRoom.name,
          available: device.available !== false,
          ...(Number.isFinite(device.battery_percent)
            ? { battery_percent: device.battery_percent }
            : {}),
          state: listed.members ? groupState(state, listed, states) : state,
        });
      }
    }
    return {
      status: "ok",
      observed_at: pages[0]?.observedAt ?? null,
      devices: found,
    };
  }

  // Reads unconfirmed writes again after a pause; a value that has arrived
  // by then, within the device's rounding, makes the write applied.
  async #confirmLate(catalog, outcomes) {
    const unconfirmed = [...outcomes].filter(
      ([, result]) => result.status === "uncertain" && result.sent !== false,
    );
    if (unconfirmed.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, this.#verifyDelayMs));
    const later = await this.#currentValues(
      catalog,
      roomsTouched(
        catalog,
        unconfirmed.map(([write]) => ({ device: write.device.id })),
      ),
    );
    for (const [write, result] of unconfirmed) {
      if (!later.has(write.ref)) continue;
      const now = later.get(write.ref);
      outcomes.set(
        write,
        closeEnough(now, write)
          ? { status: "applied", observed_value: now }
          : { ...result, observed_value: now },
      );
    }
  }

  // Current values of every characteristic in the given rooms, one fresh
  // room read each. Without them every write is sent.
  async #currentValues(catalog, rooms) {
    const values = new Map();
    try {
      const pages = await mapLimit(rooms, 4, (room) =>
        this.#readRoom(catalog.homeRef, room.ref),
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
        const device = deviceEntry(entry);
        if (!device || devices.has(device.id)) continue;
        devices.set(device.id, device);
        if (!rooms.has(device.roomId)) {
          rooms.set(device.roomId, {
            id: roomIdOf(entry.room.ref),
            ref: entry.room.ref,
            name: entry.room.name,
          });
        }
      }
    }
    await this.#readDetails(devices);
    await this.#findGroups(devices);
    return {
      homeRef,
      homeName: overview.home.name,
      loadedAt: Date.now(),
      rooms,
      devices,
    };
  }

  // Modes, fan speeds and ranges differ per device; only a characteristic
  // read reports them.
  async #readDetails(devices) {
    const specs = [...devices.values()].flatMap((device) =>
      Object.values(device.writable).filter(({ setting }) =>
        DETAILED.has(setting),
      ),
    );
    await mapLimit(specs, 6, async (spec) => {
      const body = await this.#call("get_entity", {
        entity_ref: spec.ref,
      }).catch(() => null);
      const capabilities = body?.entity?.capabilities;
      if (!capabilities) return;
      if (Array.isArray(capabilities.valid_values)) {
        spec.values = capabilities.valid_values.map(({ key, name, value }) => ({
          key,
          name,
          value,
        }));
      } else {
        spec.min = capabilities.min;
        spec.max = capabilities.max;
        spec.unit = capabilities.unit;
      }
    });
  }

  // A lamp whose On is fed by other lamps' On through Virtual links is a
  // group, like the owner's chandelier over five hidden bulbs.
  async #findGroups(devices) {
    const lamps = [...devices.values()].filter(
      (device) =>
        device.kind === "light" &&
        !device.hidden &&
        device.writable.power?.type === "On",
    );
    await mapLimit(lamps, 6, async (device) => {
      const body = await this.#call("get_entity", {
        entity_ref: device.writable.power.ref,
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

export { describeCatalog } from "./catalog.mjs";

function describeWrite(catalog, write) {
  const group = write.device.memberOf
    ? catalog.devices.get(write.device.memberOf)?.name
    : undefined;
  return {
    device: write.device.id,
    name: write.device.name,
    ...(group ? { group } : {}),
    room: catalog.rooms.get(write.device.roomId)?.name ?? null,
    setting: write.setting,
    characteristic: write.type,
  };
}

// A group's own colour is not what its bulbs show; the bulbs speak for it.
function groupState(state, group, states) {
  const {
    shows: _shows,
    hue: _hue,
    saturation: _sat,
    white_kelvin: _k,
    ...rest
  } = state;
  const bulbs = group.members
    .map((id) => states.get(id))
    .filter(Boolean)
    .map(({ power, brightness, shows, white_kelvin, hue, saturation }) => ({
      power,
      brightness,
      shows,
      ...(white_kelvin !== undefined ? { white_kelvin } : {}),
      ...(hue !== undefined ? { hue, saturation } : {}),
    }));
  return bulbs.length > 0 ? { ...rest, bulbs } : state;
}

function closeEnough(current, write) {
  if (typeof write.value !== "number" || !Number.isFinite(Number(current))) {
    return sameValue(current, write.value);
  }
  const difference = Math.abs(Number(current) - write.value);
  const distance =
    write.type === "Hue" ? Math.min(difference, 360 - difference) : difference;
  return distance <= (TOLERANCE[write.type] ?? 0);
}

function rejectionText(result) {
  const rejection = result.rejection;
  if (typeof rejection === "string") return rejection;
  return rejection.message ?? rejection.reason ?? JSON.stringify(rejection);
}

function notSent(problems) {
  return {
    status: "not_sent",
    meaning: "Nothing was sent. Fix the commands or ask the person.",
    problems,
  };
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
