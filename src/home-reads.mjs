// Household reads of one SprutHub home: home_overview and find_devices. The
// answer size follows the question, not the home: the overview counts
// instead of listing every scenario and device, and find_devices matches
// names, rooms and types in the client's session catalog and reads values
// only for the matched devices.
import { randomBytes } from "node:crypto";
import {
  accessoryIdentity,
  accessoryRef,
  characteristicRef,
  extractTypedValue,
  homeRef,
  isSensitiveNativeNode,
  matchEnumValue,
  parseEntityRef,
  roomRef,
  SprutHubError,
  sanitizeNativeData,
  serviceRef,
} from "./spruthub-client.mjs";

const PROBLEM_LIMIT = 10;
const MATCH_LIMIT = 10;
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_BYTES = 16_000;
// Value reads by accessory or by room while they stay this few; above that
// one whole-home read is fewer native requests.
const TARGETED_ACCESSORY_READS = 4;
const TARGETED_ROOM_READS = 2;
const NOT_EVALUATED_LIMIT = 10;
const REMAINING_ROOM_LIMIT = 10;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const SNAPSHOT_LIMIT = 20;

export class HomeReads {
  #client;
  #snapshots = new Map();

  constructor(client) {
    this.#client = client;
  }

  async overview({ homeRef: requestedHomeRef, query } = {}) {
    const client = this.#client;
    const deadline = Date.now() + client.timeoutMs;
    const requestedSerial =
      requestedHomeRef === undefined
        ? null
        : parseHomeArgument(requestedHomeRef);
    const account = await client.listHomes(deadline);
    const listed = {
      homes: account.homes.map(({ ref, name, online }) => ({
        ref,
        name,
        online,
      })),
      selection: account.selection,
    };
    const serial =
      requestedSerial ??
      client.serial ??
      (account.selection.default_home_ref
        ? parseEntityRef(account.selection.default_home_ref).serial
        : null);
    if (serial === null) return { status: "ok", ...listed };
    const home = account.homes.find(({ ref }) => ref === homeRef(serial));
    if (!home) throw homeNotFound();

    const generation = client.writeGeneration;
    const [rooms, accessories, scenarios, extensions] = await Promise.all([
      client.nativeRooms(serial, deadline),
      client.nativeAccessories(serial, deadline),
      client.nativeScenarios(serial, deadline),
      client.nativeExtensions(serial, deadline),
    ]);
    const observedAt = latest([
      account.freshness.hubResponseReceivedAt,
      rooms.observedAt,
      accessories.observedAt,
      scenarios.observedAt,
      extensions.observedAt,
    ]);
    client.rememberHomeCatalog(serial, {
      rooms: rooms.rooms,
      accessories: accessories.accessories,
      observedAt: latest([rooms.observedAt, accessories.observedAt]),
      generation,
    });
    const roomList = roomsWithDeviceCounts(
      serial,
      rooms.rooms,
      accessories.accessories,
    );
    const selection =
      account.homes.length > 1 || account.selection.required === true
        ? listed
        : {};

    if (query !== undefined) {
      const matches = rankMatches(query, [
        ...roomList.map((room) => ({ kind: "room", ...room })),
        ...scenarios.scenarios.map(({ summary }) => ({
          kind: "scenario",
          ref: summary.ref,
          name: summary.name,
          type: summary.type,
          active: summary.active,
        })),
        ...extensions.extensions.map((extension) => ({
          kind: "extension",
          ...extensionSummary(extension),
        })),
      ]);
      const stems = queryStems(query);
      const deviceMatches = accessories.accessories.reduce(
        (count, accessory) =>
          count +
          (accessory.services ?? []).filter(
            (service) =>
              serviceKind(service, accessory).kind !== "technical" &&
              matchesStems(stems, deviceText(service, accessory, rooms.rooms)),
          ).length,
        0,
      );
      return {
        status: "ok",
        home: { ref: home.ref, name: home.name },
        ...selection,
        query,
        matches: matches.slice(0, MATCH_LIMIT),
        total: matches.length,
        ...(deviceMatches > 0
          ? {
              devices: {
                matches: deviceMatches,
                next: {
                  tool: "find_devices",
                  arguments: { home_ref: home.ref, query },
                },
              },
            }
          : {}),
        observed_at: observedAt,
      };
    }

    const problems = [
      ...extensions.extensions
        .filter(isExtensionProblem)
        .map(({ ref, name, state, enabled }) => ({
          kind: "extension",
          ref,
          name,
          state,
          enabled,
        })),
      ...scenarios.scenarios
        .filter(({ native }) => native.error === true)
        .map(({ summary }) => ({
          kind: "scenario_error",
          ref: summary.ref,
          name: summary.name,
        })),
      ...accessories.accessories
        .filter(({ online }) => online === false)
        .map((accessory) => ({
          kind: "device_unavailable",
          ref: accessoryRef(serial, accessory.id),
          name: accessory.name,
          room:
            rooms.rooms.find(({ id }) => id === accessory.roomId)?.name ?? null,
        })),
    ];
    return {
      status: "ok",
      home: {
        ref: home.ref,
        name: home.name,
        online: home.online,
        model: home.model,
        firmware: home.firmware,
        ...(Object.hasOwn(home, "options_window_ref")
          ? { options_window_ref: home.options_window_ref }
          : {}),
      },
      ...selection,
      rooms: roomList,
      scenarios: scenarioCounts(scenarios.scenarios),
      extensions: extensions.extensions.map(extensionSummary),
      problems: problems.slice(0, PROBLEM_LIMIT),
      problems_total: problems.length,
      observed_at: observedAt,
    };
  }

  // Devices of one home by name, room, kind or state. Names, rooms and types
  // come from the session catalog; values are read fresh for the matched
  // devices only, by accessory, by room or for the whole home, whichever
  // needs the fewest native requests.
  async findDevices(input) {
    const client = this.#client;
    const serial =
      input.homeRef === undefined
        ? client.selectedSerial()
        : parseHomeArgument(input.homeRef);
    const selection = findSelection(input, serial);
    if (input.cursor !== undefined) {
      return this.#continuePage(selection, input.cursor);
    }
    const deadline = Date.now() + client.timeoutMs;
    if (serial !== client.serial) {
      const account = await client.listHomes(deadline);
      if (!account.homes.some(({ ref }) => ref === homeRef(serial))) {
        throw homeNotFound();
      }
    }

    let read = await client.homeCatalog(serial, deadline);
    let refreshed = read.fresh;
    let candidates = selectCandidates(read.catalog, selection);
    // A room or a name that a cached catalog does not know may be new: an
    // edit in the SprutHub app since the catalog was read.
    if (
      !refreshed &&
      ((selection.roomId !== null && !hasRoom(read.catalog, selection)) ||
        (candidates.length === 0 && selection.query !== null))
    ) {
      read = await client.homeCatalog(serial, deadline, { refresh: true });
      refreshed = true;
      candidates = selectCandidates(read.catalog, selection);
    }
    let catalog = read.catalog;
    if (selection.roomId !== null && !hasRoom(catalog, selection)) {
      throw roomNotFound(selection);
    }

    const summary = !selection.filtered;
    const needValues = summary || selection.state !== null || selection.values;
    let values = null;
    let observedAt = catalog.observedAt;
    if (needValues && read.fresh) {
      values = byId(catalog.accessories);
      observedAt = read.valuesObservedAt;
    } else if (needValues) {
      const fresh = await readValues(
        client,
        serial,
        catalog,
        candidates,
        deadline,
      );
      if (fresh.stale && !refreshed) {
        read = await client.homeCatalog(serial, deadline, { refresh: true });
        catalog = read.catalog;
        candidates = selectCandidates(catalog, selection);
        values = byId(catalog.accessories);
        observedAt = read.valuesObservedAt;
      } else {
        if (fresh.wholeHome) {
          catalog = client.rememberHomeCatalog(serial, {
            rooms: catalog.rooms,
            accessories: fresh.accessories,
            observedAt: fresh.observedAt,
            generation: fresh.generation,
          });
          candidates = selectCandidates(catalog, selection);
        }
        values = byId(fresh.accessories);
        observedAt = fresh.observedAt;
      }
    }

    const base = {
      status: "ok",
      home_ref: homeRef(serial),
      observed_at: observedAt,
      catalog_observed_at: catalog.observedAt,
    };
    const evaluated = candidates.map((candidate) =>
      evaluateCandidate(candidate, values),
    );
    if (summary) return { ...base, ...roomSummary(serial, catalog, evaluated) };
    return this.#firstPage(base, serial, catalog, evaluated, selection);
  }

  #firstPage(base, serial, catalog, evaluated, selection) {
    const roomsById = new Map(catalog.rooms.map((room) => [room.id, room]));
    const stateFilter = selection.state;
    const listed = [];
    const notEvaluated = [];
    const notApplicable = {};
    for (const item of evaluated) {
      if (stateFilter === "on" || stateFilter === "off") {
        if (!item.onState.applicable) {
          notApplicable[item.kind] = (notApplicable[item.kind] ?? 0) + 1;
          continue;
        }
        if (item.onState.on === null) {
          notEvaluated.push({
            ref: serviceRef(serial, item.accessory.id, item.service.sId),
            name: item.service.name,
            device: item.accessory.name,
            type: item.service.type,
            reason: item.onState.reason,
          });
          continue;
        }
        if (item.onState.on !== (stateFilter === "on")) continue;
      } else if (stateFilter === "unavailable") {
        if (item.available !== false) continue;
      }
      listed.push(item);
    }
    // Grouped by room in the home's room order: the hub may list devices of
    // one room apart. Rooms missing from the room list come last.
    const roomOrder = new Map(
      catalog.rooms.map(({ id }, index) => [id, index]),
    );
    const orderOf = ({ accessory }) =>
      roomOrder.get(accessory.roomId) ?? catalog.rooms.length;
    listed.sort((left, right) => orderOf(left) - orderOf(right));
    const slots = listed.map((item) => {
      const room = roomsById.get(item.accessory.roomId);
      return {
        room: {
          ref: roomRef(serial, item.accessory.roomId),
          name: room?.name ?? null,
          ...(room ? {} : { metadata_status: "missing" }),
        },
        device: deviceEntry(serial, item),
        service: serviceEntry(serial, item, selection),
      };
    });
    const snapshot = {
      id: randomBytes(8).toString("hex"),
      scope: selection.scope,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      base,
      slots,
      roomMatches: countBy(slots, ({ room }) => room.ref),
      extras: {
        ...(stateFilter === "on" || stateFilter === "off"
          ? {
              not_evaluated: notEvaluated.slice(0, NOT_EVALUATED_LIMIT),
              not_evaluated_total: notEvaluated.length,
              not_applicable: notApplicable,
            }
          : {}),
      },
    };
    const page = buildPage(snapshot, 0, selection);
    if (page.next) this.#remember(snapshot);
    return page;
  }

  #continuePage(selection, cursor) {
    const decoded = decodeCursor(cursor, selection);
    const now = Date.now();
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
    const snapshot = this.#snapshots.get(decoded.id);
    if (!snapshot) {
      throw new SprutHubError(
        "stale_cursor",
        "This cursor's snapshot has expired; start the read again.",
        "restart_find_devices",
        { next: { tool: "find_devices", arguments: selection.args } },
      );
    }
    if (snapshot.scope !== selection.scope) throw invalidCursor(selection);
    if (decoded.offset > snapshot.slots.length) throw invalidCursor(selection);
    return buildPage(snapshot, decoded.offset, selection);
  }

  #remember(snapshot) {
    this.#snapshots.set(snapshot.id, snapshot);
    while (this.#snapshots.size > SNAPSHOT_LIMIT) {
      this.#snapshots.delete(this.#snapshots.keys().next().value);
    }
  }
}

// ---- find_devices selection ------------------------------------------------

function findSelection(input, serial) {
  const home = homeRef(serial);
  let roomId = null;
  if (input.roomRef !== undefined) {
    let parsed;
    try {
      parsed = parseEntityRef(input.roomRef);
    } catch {
      parsed = null;
    }
    if (parsed?.kind !== "room" || parsed.serial !== serial) {
      throw new SprutHubError(
        "invalid_room_ref",
        "room_ref must be a room ref of the selected home from home_overview.",
        "home_overview",
        { next: { tool: "home_overview", arguments: { home_ref: home } } },
      );
    }
    roomId = parsed.roomId;
  }
  const query = input.query ?? null;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const args = {
    home_ref: home,
    ...(query === null ? {} : { query }),
    ...(roomId === null ? {} : { room_ref: input.roomRef }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.values === false ? { values: false } : {}),
    ...(input.includeTechnical === true ? { include_technical: true } : {}),
    ...(limit === DEFAULT_LIMIT ? {} : { limit }),
    ...(maxBytes === DEFAULT_MAX_BYTES ? {} : { max_bytes: maxBytes }),
  };
  return {
    args,
    scope: JSON.stringify(args),
    homeRef: home,
    roomId,
    roomRef: input.roomRef ?? null,
    query,
    stems: query === null ? null : queryStems(query),
    kind: input.kind ?? null,
    state: input.state ?? null,
    values: input.values !== false,
    includeTechnical: input.includeTechnical === true,
    limit,
    maxBytes,
    filtered:
      query !== null ||
      roomId !== null ||
      input.kind !== undefined ||
      input.state !== undefined,
  };
}

function selectCandidates(catalog, selection) {
  const candidates = [];
  for (const accessory of catalog.accessories) {
    if (selection.roomId !== null && accessory.roomId !== selection.roomId) {
      continue;
    }
    for (const service of accessory.services ?? []) {
      const { kind, basis } = serviceKind(service, accessory);
      if (kind === "technical" && !selection.includeTechnical) continue;
      if (selection.kind !== null && kind !== selection.kind) continue;
      if (
        selection.stems !== null &&
        !matchesStems(
          selection.stems,
          deviceText(service, accessory, catalog.rooms),
        )
      ) {
        continue;
      }
      candidates.push({ accessory, service, kind, basis });
    }
  }
  return candidates;
}

function hasRoom(catalog, selection) {
  return catalog.rooms.some(({ id }) => id === selection.roomId);
}

function deviceText(service, accessory, rooms) {
  const room = rooms.find(({ id }) => id === accessory.roomId);
  return `${service.name} ${accessory.name} ${room?.name ?? ""}`;
}

// Fresh values of the candidates' accessories with the fewest native
// requests. A targeted read that disagrees with the catalog (an accessory
// gone, renamed, moved or changed) marks the catalog stale.
async function readValues(client, serial, catalog, candidates, deadline) {
  const generation = client.writeGeneration;
  const accessoryIds = [...new Set(candidates.map((c) => c.accessory.id))];
  const roomIds = [...new Set(candidates.map((c) => c.accessory.roomId))];
  if (accessoryIds.length === 0) {
    return { accessories: [], observedAt: catalog.observedAt, stale: false };
  }
  if (accessoryIds.length <= TARGETED_ACCESSORY_READS) {
    const reads = await Promise.all(
      accessoryIds.map((id) => client.nativeAccessory(serial, id, deadline)),
    );
    const accessories = reads.map(({ accessory }) => accessory);
    return {
      accessories: accessories.filter(Boolean),
      observedAt: latest(reads.map(({ observedAt }) => observedAt)),
      stale: accessoryIds.some(
        (id, index) =>
          !accessories[index] ||
          catalog.identities.get(id) !== accessoryIdentity(accessories[index]),
      ),
    };
  }
  if (roomIds.length <= TARGETED_ROOM_READS) {
    const reads = await Promise.all(
      roomIds.map((roomId) =>
        client.nativeAccessories(serial, deadline, { roomId }),
      ),
    );
    const accessories = reads.flatMap((read, index) =>
      read.accessories.filter(({ roomId }) => roomId === roomIds[index]),
    );
    const known = catalog.accessories.filter(({ roomId }) =>
      roomIds.includes(roomId),
    );
    return {
      accessories,
      observedAt: latest(reads.map(({ observedAt }) => observedAt)),
      stale:
        accessories.length !== known.length ||
        accessories.some(
          (accessory) =>
            catalog.identities.get(accessory.id) !==
            accessoryIdentity(accessory),
        ),
    };
  }
  const read = await client.nativeAccessories(serial, deadline);
  const knownRooms = new Set(catalog.rooms.map(({ id }) => id));
  return {
    accessories: read.accessories,
    observedAt: read.observedAt,
    wholeHome: true,
    generation,
    // An accessory in a room the catalog does not know means new rooms.
    stale: read.accessories.some(({ roomId }) => !knownRooms.has(roomId)),
  };
}

// What decides a matched service: its kind, availability and on/off from
// the fresh accessory when values were read, else from the catalog.
function evaluateCandidate(candidate, values) {
  const fresh = values?.get(candidate.accessory.id);
  const service =
    fresh?.services?.find(({ sId }) => sId === candidate.service.sId) ??
    candidate.service;
  const accessory = fresh ?? candidate.accessory;
  return {
    accessory,
    service,
    kind: candidate.kind,
    basis: candidate.basis,
    valuesRead: fresh !== undefined,
    available: fresh === undefined ? null : fresh.online,
    onState:
      fresh === undefined ? null : onState(candidate.kind, fresh, service),
  };
}

function roomSummary(serial, catalog, evaluated) {
  const rows = new Map(
    catalog.rooms.map((room) => [
      room.id,
      {
        ref: roomRef(serial, room.id),
        name: room.name,
        services: 0,
        on: 0,
        unavailable: 0,
      },
    ]),
  );
  for (const item of evaluated) {
    const roomId = item.accessory.roomId;
    if (!rows.has(roomId)) {
      rows.set(roomId, {
        ref: roomRef(serial, roomId),
        name: null,
        metadata_status: "missing",
        services: 0,
        on: 0,
        unavailable: 0,
      });
    }
    const row = rows.get(roomId);
    row.services += 1;
    if (item.onState?.on === true) row.on += 1;
    if (item.available === false) row.unavailable += 1;
  }
  const rooms = [...rows.values()];
  return {
    services: rooms.reduce((sum, row) => sum + row.services, 0),
    on: rooms.reduce((sum, row) => sum + row.on, 0),
    unavailable: rooms.reduce((sum, row) => sum + row.unavailable, 0),
    rooms,
  };
}

function deviceEntry(serial, item) {
  const battery = item.valuesRead ? batteryPercent(item.accessory) : null;
  return {
    ref: accessoryRef(serial, item.accessory.id),
    name: item.accessory.name,
    ...(item.valuesRead ? { available: item.available } : {}),
    ...(battery === null ? {} : { battery_percent: battery }),
  };
}

function serviceEntry(serial, item, selection) {
  const { accessory, service, onState: on } = item;
  const ref = serviceRef(serial, accessory.id, service.sId);
  return {
    ref,
    name: service.name,
    type: service.type,
    kind: item.kind,
    ...(item.basis ? { kind_basis: item.basis } : {}),
    ...(service.visible === false ? { hidden: true } : {}),
    ...(on?.applicable
      ? {
          on: on.on,
          ...(on.basis ? { on_basis: on.basis } : {}),
          ...(on.on === null ? { on_unknown: on.reason } : {}),
        }
      : {}),
    ...(selection.values && item.valuesRead
      ? { values: characteristicValues(serial, accessory, service) }
      : { characteristics: characteristicRefs(serial, accessory, service) }),
  };
}

function characteristicValues(serial, accessory, service) {
  return (service.characteristics ?? [])
    .filter(({ control }) => control.read === true && !isNameControl(control))
    .map((characteristic) => {
      const control = characteristic.control;
      if (isSensitiveNativeNode(control)) {
        return { redacted: true, reason: "sensitive_native_data" };
      }
      const type = control.type ?? control.key;
      const typed = extractTypedValue(control.value);
      return {
        type,
        // The hub's own C_* types are not self-explanatory without a name.
        ...(type.startsWith("C_") ? { name: control.name } : {}),
        value: typed.found ? sanitizeNativeData(typed.value) : null,
        ...(typed.found ? {} : { value_status: "unknown" }),
        ...(typeof control.unit === "string" ? { unit: control.unit } : {}),
        ...(control.validValues
          ? { enum: matchEnumValue(control.validValues, typed) }
          : {}),
        ...(control.write === true ? { writable: true } : {}),
        ref: characteristicRef(
          serial,
          accessory.id,
          service.sId,
          characteristic.cId,
        ),
      };
    });
}

function characteristicRefs(serial, accessory, service) {
  return (service.characteristics ?? [])
    .filter(
      ({ control }) =>
        (control.read === true || control.write === true) &&
        !isNameControl(control),
    )
    .map((characteristic) =>
      isSensitiveNativeNode(characteristic.control)
        ? { redacted: true, reason: "sensitive_native_data" }
        : {
            type: characteristic.control.type ?? characteristic.control.key,
            ...(characteristic.control.write === true
              ? { writable: true }
              : {}),
            ref: characteristicRef(
              serial,
              accessory.id,
              service.sId,
              characteristic.cId,
            ),
          },
    );
}

function isNameControl(control) {
  return (control.type ?? control.key) === "Name";
}

function batteryPercent(accessory) {
  for (const service of accessory.services ?? []) {
    if (service.type !== "BatteryService") continue;
    const level = service.characteristics?.find(
      ({ control }) => control?.type === "BatteryLevel",
    )?.control;
    const typed = extractTypedValue(level?.value);
    if (typed.found && typeof typed.value === "number") return typed.value;
  }
  return null;
}

// ---- pages -----------------------------------------------------------------

// One page of a snapshot: up to limit services from offset, grouped by room
// and device, within max_bytes. Rooms after the page are listed with a
// drill-down call; optional parts shrink first when a page would not fit.
function buildPage(snapshot, offset, selection) {
  let end = Math.min(offset + 1, snapshot.slots.length);
  let page = assemblePage(snapshot, offset, end, selection, 0);
  for (let level = 1; bytes(page) > selection.maxBytes && level <= 3; level++) {
    page = assemblePage(snapshot, offset, end, selection, level);
  }
  while (end < snapshot.slots.length && end - offset < selection.limit) {
    const candidate = assemblePage(snapshot, offset, end + 1, selection, 0);
    if (bytes(candidate) > selection.maxBytes) break;
    page = candidate;
    end += 1;
  }
  return page;
}

function assemblePage(snapshot, offset, end, selection, compaction) {
  const { slots } = snapshot;
  const rooms = [];
  for (const slot of slots.slice(offset, end)) {
    let room = rooms.at(-1);
    if (room?.ref !== slot.room.ref) {
      room = {
        ...slot.room,
        matches: snapshot.roomMatches.get(slot.room.ref),
        devices: [],
      };
      rooms.push(room);
    }
    let device = room.devices.at(-1);
    if (device?.ref !== slot.device.ref) {
      device = { ...slot.device, services: [] };
      room.devices.push(device);
    }
    device.services.push(
      compaction >= 3 ? withoutValues(slot.service) : slot.service,
    );
  }
  const remaining = countBy(slots.slice(end), ({ room }) => room.ref);
  const remainingRooms = [...remaining]
    .slice(0, compaction >= 2 ? 3 : REMAINING_ROOM_LIMIT)
    .map(([ref, count]) => {
      const room = slots.find((slot) => slot.room.ref === ref).room;
      return {
        ref,
        name: room.name,
        remaining: count,
        ...(compaction >= 1
          ? {}
          : {
              next: {
                tool: "find_devices",
                arguments: { ...selection.args, room_ref: ref },
              },
            }),
      };
    });
  const extras = { ...snapshot.extras };
  if (compaction >= 2 && extras.not_evaluated) {
    extras.not_evaluated = extras.not_evaluated.slice(0, 3);
  }
  return {
    ...snapshot.base,
    total: slots.length,
    returned: end - offset,
    rooms,
    ...extras,
    ...(remainingRooms.length > 0
      ? {
          remaining_rooms: remainingRooms,
          remaining_rooms_total: remaining.size,
        }
      : {}),
    next:
      end < slots.length
        ? {
            tool: "find_devices",
            arguments: {
              ...selection.args,
              cursor: encodeCursor(snapshot.id, end),
            },
          }
        : null,
  };
}

function withoutValues(service) {
  const {
    values: _values,
    characteristics: _characteristics,
    ...rest
  } = service;
  return {
    ...rest,
    values_omitted: "exceeds_max_bytes",
    next: { tool: "get_entity", arguments: { entity_ref: service.ref } },
  };
}

function encodeCursor(id, offset) {
  return Buffer.from(JSON.stringify({ v: 1, id, offset })).toString(
    "base64url",
  );
}

function decodeCursor(cursor, selection) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      parsed?.v === 1 &&
      typeof parsed.id === "string" &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.offset > 0
    ) {
      return parsed;
    }
  } catch {}
  throw invalidCursor(selection);
}

function invalidCursor(selection) {
  return new SprutHubError(
    "invalid_cursor",
    "Use the cursor returned by find_devices with the same filters.",
    "restart_find_devices",
    { next: { tool: "find_devices", arguments: selection.args } },
  );
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  }
  return counts;
}

function byId(accessories) {
  return new Map(accessories.map((accessory) => [accessory.id, accessory]));
}

function latest(values) {
  return values
    .filter(Boolean)
    .reduce((best, value) => (value > best ? value : best));
}

// ---- overview helpers and name matching -----------------------------------

function parseHomeArgument(ref) {
  const parsed = parseEntityRef(ref);
  if (parsed.kind !== "home") {
    throw new SprutHubError(
      "invalid_entity_ref",
      "home_ref must be a home reference returned by home_overview.",
      "home_overview",
      { next: { tool: "home_overview", arguments: {} } },
    );
  }
  return parsed.serial;
}

function homeNotFound() {
  return new SprutHubError(
    "home_not_found",
    "The selected SprutHub home is not available to this account.",
    "home_overview",
    { next: { tool: "home_overview", arguments: {} } },
  );
}

function roomNotFound(selection) {
  return new SprutHubError(
    "room_not_found",
    "The selected SprutHub room was not found.",
    "home_overview",
    {
      next: {
        tool: "home_overview",
        arguments: { home_ref: selection.homeRef },
      },
    },
  );
}

// Rooms in the hub's order with their accessory counts. Accessories whose
// room is not in the room list keep their room ref without a name.
function roomsWithDeviceCounts(serial, rooms, accessories) {
  const counts = new Map();
  for (const { roomId } of accessories) {
    counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
  }
  const known = new Set(rooms.map(({ id }) => id));
  return [
    ...rooms.map((room) => ({
      ref: roomRef(serial, room.id),
      name: room.name,
      device_count: counts.get(room.id) ?? 0,
    })),
    ...[...counts]
      .filter(([roomId]) => !known.has(roomId))
      .map(([roomId, count]) => ({
        ref: roomRef(serial, roomId),
        name: null,
        metadata_status: "missing",
        device_count: count,
      })),
  ];
}

function scenarioCounts(scenarios) {
  const byType = {};
  for (const { summary } of scenarios) {
    byType[summary.type] ??= { active: 0, inactive: 0 };
    byType[summary.type][summary.active ? "active" : "inactive"] += 1;
  }
  return { total: scenarios.length, by_type: byType };
}

function extensionSummary({ ref, name, type, state, enabled }) {
  return { ref, name, type, state, enabled };
}

// FAILED is always a problem; any other state than LOADED of an enabled
// extension is shown too. A disabled, stopped extension is the owner's
// choice. Other native states have not been observed.
function isExtensionProblem({ state, enabled }) {
  return (
    state === "FAILED" ||
    (enabled === true && typeof state === "string" && state !== "LOADED")
  );
}

// Russian names are matched by word stems: the query "в спальне" finds
// "Спальня" and "Детская спальня", "гостиной" finds "Гостиная". Every query
// word of two or more letters must occur in the name; one-letter words are
// prepositions. Longer endings are tried first; a stem keeps at least three
// letters.
const ENDINGS = [
  "ями",
  "ами",
  "ого",
  "его",
  "ому",
  "ему",
  "ыми",
  "ими",
  "ой",
  "ей",
  "ий",
  "ый",
  "ая",
  "яя",
  "ое",
  "ее",
  "ые",
  "ие",
  "ую",
  "юю",
  "ом",
  "ем",
  "ам",
  "ям",
  "ах",
  "ях",
  "ов",
  "ев",
  "ью",
  "а",
  "я",
  "о",
  "е",
  "ы",
  "и",
  "у",
  "ю",
  "ь",
  "й",
];

export function normalizeName(text) {
  return String(text ?? "")
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function queryStems(query) {
  return normalizeName(query)
    .split(" ")
    .filter((word) => word.length > 1)
    .map((word) => {
      if (word.length < 4 || !/[а-я]$/.test(word)) return word;
      const ending = ENDINGS.find(
        (candidate) =>
          word.endsWith(candidate) && word.length - candidate.length >= 3,
      );
      return ending ? word.slice(0, -ending.length) : word;
    });
}

export function matchesStems(stems, text) {
  const normalized = normalizeName(text);
  return stems.length > 0 && stems.every((stem) => normalized.includes(stem));
}

// Best first: the whole name, then a name that starts with the query, then
// more words matched at a word start; ties keep the hub's order.
function rankMatches(query, candidates) {
  const stems = queryStems(query);
  const whole = normalizeName(query);
  return candidates
    .map((candidate, order) => {
      const name = normalizeName(candidate.name);
      if (!matchesStems(stems, name)) return null;
      const words = name.split(" ");
      const score =
        (name === whole ? 100 : 0) +
        (name.startsWith(stems[0]) ? 10 : 0) +
        stems.filter((stem) => words.some((word) => word.startsWith(stem)))
          .length;
      return { candidate, order, score };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(({ candidate }) => candidate);
}

// ---- kinds and on/off ------------------------------------------------------

// Household kind of a native service type, in one place. SprutHub service
// types are the HomeKit Accessory Protocol ones (service.types answers with
// Apple HAP UUIDs, research/protocol/2026-09-09-type-catalog.json) plus the
// hub's own C_* types. The owner's home on 2026-09-24 had
// AccessoryInformation 80, Lightbulb 53, Switch 39 and
// StatelessProgrammableSwitch 22 of 254 services. A type not listed is
// "other"; AccessoryInformation and BatteryService are technical and hidden
// unless asked for, the battery level shows on its device instead.
const KIND_BY_TYPE = new Map(
  Object.entries({
    light: ["Lightbulb"],
    climate: ["Thermostat", "HeaterCooler"],
    air: [
      "Fan",
      "Fanv2",
      "AirPurifier",
      "HumidifierDehumidifier",
      "FilterMaintenance",
    ],
    sensor: [
      "TemperatureSensor",
      "HumiditySensor",
      "MotionSensor",
      "OccupancySensor",
      "ContactSensor",
      "LeakSensor",
      "SmokeSensor",
      "CarbonMonoxideSensor",
      "CarbonDioxideSensor",
      "AirQualitySensor",
      "LightSensor",
      "C_WattMeter",
    ],
    cover: ["WindowCovering", "Window", "Door", "Slat", "GarageDoorOpener"],
    outlet: ["Outlet", "Switch"],
    security: ["SecuritySystem", "LockMechanism", "LockManagement"],
    button: ["StatelessProgrammableSwitch", "Doorbell"],
    technical: ["AccessoryInformation", "BatteryService"],
  }).flatMap(([kind, types]) => types.map((type) => [type, kind])),
);
export const DEVICE_KINDS = [
  "light",
  "climate",
  "sensor",
  "cover",
  "outlet",
  "air",
  "security",
  "button",
  "other",
];
// Kinds without an on/off: they are counted, not listed, for state filters.
const NO_ON_OFF_KINDS = new Set(["sensor", "cover", "button", "technical"]);

// A relay or outlet drives whatever is wired to it, and owners name such
// channels after their lamps. Its own name decides first; a generic channel
// name ("Канал 1") takes the device's name unless it names another load.
const LIGHT_NAME =
  /свет|ламп|люстр|спот|лент|торшер|ночник|фонар|гирлянд|прожектор|софит|(?:^| )бра(?: |$)|(?:^| )led(?: |$)|light|lamp/;
const OTHER_LOAD_NAME =
  /вентил|вытяжк|насос|полив|нагрев|бойлер|обогрев|тепл|чайник|кондиц|увлажн|бризер|очистит|клапан|розетк/;

export function serviceKind(service, accessory) {
  const kind = KIND_BY_TYPE.get(service.type) ?? "other";
  if (service.type === "Switch" || service.type === "Outlet") {
    const own = normalizeName(service.name);
    if (
      LIGHT_NAME.test(own) ||
      (!OTHER_LOAD_NAME.test(own) &&
        LIGHT_NAME.test(normalizeName(accessory.name)))
    ) {
      return { kind: "light", basis: "name" };
    }
  }
  return { kind };
}

// On/off of one service, first match wins:
// - On (bool): Lightbulb, Switch, Outlet, Fan;
// - Active (INACTIVE 0 / ACTIVE 1): AirPurifier, HeaterCooler, Fanv2, Valve;
// - a target mode that is not OFF: TargetHeatingCoolingState (HAP 0 = OFF)
//   or TargetHeaterCoolerState, for a thermostat heating or cooling.
// OutletInUse only says that a load draws power and never decides; an open
// cover is not "on". An unavailable device keeps its last values, which do
// not say whether it is on.
const ON_CHARACTERISTICS = [
  "On",
  "Active",
  "TargetHeatingCoolingState",
  "TargetHeaterCoolerState",
];

function onState(kind, accessory, service) {
  if (NO_ON_OFF_KINDS.has(kind)) return { applicable: false };
  const characteristics = service.characteristics ?? [];
  const byType = (type) =>
    characteristics.find(
      ({ control }) => (control?.type ?? control?.key) === type,
    )?.control;
  const basis = ON_CHARACTERISTICS.find((type) => byType(type));
  if (!basis) {
    return characteristics.some(({ control }) => control?.write === true)
      ? { applicable: true, on: null, reason: "no_on_off_characteristic" }
      : { applicable: false };
  }
  if (accessory.online === false) {
    return { applicable: true, on: null, basis, reason: "unavailable" };
  }
  const control = byType(basis);
  const typed = extractTypedValue(control.value);
  let on = null;
  if (typed.found) {
    if (basis === "On" && typeof typed.value === "boolean") on = typed.value;
    else if (basis === "Active" && (typed.value === 0 || typed.value === 1)) {
      on = typed.value === 1;
    } else if (basis !== "On" && basis !== "Active") {
      const named = Array.isArray(control.validValues)
        ? matchEnumValue(control.validValues, typed)
        : null;
      if (named) on = named.key !== "OFF";
      else if (basis === "TargetHeatingCoolingState") on = typed.value !== 0;
    }
  }
  return on === null
    ? { applicable: true, on: null, basis, reason: "value_unknown" }
    : { applicable: true, on, basis };
}
