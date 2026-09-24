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
const LIST_LIMIT = 50;
const LIST_PAGE_BYTES = 16_000;
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_BYTES = 16_000;
// Value reads by accessory or by room while they stay this few; above that
// one whole-home read is fewer native requests.
const TARGETED_ACCESSORY_READS = 4;
const TARGETED_ROOM_READS = 2;
const NOT_EVALUATED_LIMIT = 10;
const SWITCH_LIMIT = 10;
const REMAINING_ROOM_LIMIT = 10;
const SNAPSHOT_TTL_MS = 5 * 60_000;
const SNAPSHOT_LIMIT = 20;

export class HomeReads {
  #client;
  #snapshots = new Map();

  constructor(client) {
    this.#client = client;
  }

  async overview(input = {}) {
    const client = this.#client;
    checkOverviewInput(input);
    const requestedSerial =
      input.homeRef === undefined ? null : parseHomeArgument(input.homeRef);
    if (input.cursor !== undefined) {
      const serial = requestedSerial ?? client.serial;
      if (serial === null) {
        throw invalidCursor({
          tool: "home_overview",
          args: overviewArgs(input, null),
        });
      }
      return this.#continuePage(
        overviewSelection(input, serial),
        input.cursor,
        buildListPage,
      );
    }
    const deadline = Date.now() + client.timeoutMs;
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

    // A list reads only what it lists; the overview and a query read all.
    const list = input.list ?? null;
    const query = input.query ?? null;
    const needs = (part) => list === null || list === part;
    const generation = client.writeGeneration;
    const [rooms, accessories, scenarios, extensions] = await Promise.all([
      needs("rooms") ? client.nativeRooms(serial, deadline) : null,
      needs("rooms") ? client.nativeAccessories(serial, deadline) : null,
      needs("scenarios") ? client.nativeScenarios(serial, deadline) : null,
      needs("extensions") ? client.nativeExtensions(serial, deadline) : null,
    ]);
    const observedAt = latest([
      account.freshness.hubResponseReceivedAt,
      rooms?.observedAt,
      accessories?.observedAt,
      scenarios?.observedAt,
      extensions?.observedAt,
    ]);
    const roomList =
      rooms &&
      roomsWithDeviceCounts(serial, rooms.rooms, accessories.accessories);
    if (rooms) {
      client.rememberHomeCatalog(serial, {
        rooms: rooms.rooms,
        accessories: accessories.accessories,
        observedAt: latest([rooms.observedAt, accessories.observedAt]),
        generation,
      });
    }
    const selection =
      account.homes.length > 1 || account.selection.required === true
        ? listed
        : {};

    if (list !== null || query !== null) {
      const paging = overviewSelection(input, serial);
      return this.#firstListPage(paging, {
        base: {
          status: "ok",
          home: { ref: home.ref, name: home.name },
          ...selection,
          ...(list === null ? {} : { list }),
          ...(query === null ? {} : { query }),
          observed_at: observedAt,
        },
        key: list ?? "matches",
        entries: overviewEntries(paging, {
          roomList,
          scenarios: scenarios?.scenarios,
          extensions: extensions?.extensions,
        }),
        extras:
          list === null
            ? deviceMatchesHint(home.ref, query, rooms, accessories)
            : {},
      });
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
      scenarios: {
        ...scenarioCounts(scenarios.scenarios),
        ...(scenarios.scenarios.length > 0
          ? {
              next: {
                tool: "home_overview",
                arguments: { home_ref: home.ref, list: "scenarios" },
              },
            }
          : {}),
      },
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
      return this.#continuePage(selection, input.cursor, buildPage);
    }
    const deadline = Date.now() + client.timeoutMs;
    if (serial !== client.serial) {
      const account = await client.listHomes(deadline);
      if (!account.homes.some(({ ref }) => ref === homeRef(serial))) {
        throw homeNotFound();
      }
    }

    let read = await client.homeCatalog(serial, deadline, {
      refresh: selection.refresh,
    });
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
    // A room is always read fresh: devices moved or added there in the
    // SprutHub app are not in the catalog yet.
    const needValues =
      summary ||
      selection.state !== null ||
      selection.values ||
      selection.roomId !== null;
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
        [...candidates, ...switchCandidates(catalog, selection, candidates)],
        deadline,
        selection.roomId,
      );
      if (fresh.stale && !refreshed) {
        read = await client.homeCatalog(serial, deadline, { refresh: true });
        catalog = read.catalog;
        // Devices moved out of a room deleted in the SprutHub app.
        if (selection.roomId !== null && !hasRoom(catalog, selection)) {
          throw roomNotFound(selection);
        }
        candidates = selectCandidates(catalog, selection);
        values = byId(catalog.accessories);
        observedAt = read.valuesObservedAt;
      } else {
        // An empty room read agrees with an empty room of the catalog even
        // after the room was deleted in the app; the room list tells.
        if (selection.roomId !== null && fresh.accessories.length === 0) {
          const { rooms } = await client.nativeRooms(serial, deadline);
          if (!rooms.some(({ id }) => id === selection.roomId)) {
            throw roomNotFound(selection);
          }
        }
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
    const switches = switchCandidates(catalog, selection, candidates)
      .map((candidate) => evaluateCandidate(candidate, values))
      .filter((item) => matchesState(item, selection.state));
    return this.#firstPage(
      base,
      serial,
      catalog,
      evaluated,
      selection,
      switches.length > 0
        ? { switches: switchesSection(serial, catalog, switches, selection) }
        : {},
    );
  }

  #firstPage(base, serial, catalog, evaluated, selection, hints) {
    const roomsById = new Map(catalog.rooms.map((room) => [room.id, room]));
    const stateFilter = selection.state;
    const listed = [];
    const notEvaluated = [];
    const notApplicable = {};
    let deviceFunctions = 0;
    for (const item of evaluated) {
      // An appliance's own setting is not a device that is on, off or
      // unavailable of its own.
      if (stateFilter !== null && item.appliance !== null) {
        deviceFunctions += 1;
        continue;
      }
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
      size: slots.length,
      base,
      slots,
      roomMatches: countBy(slots, ({ room }) => room.ref),
      extras: {
        ...hints,
        ...(stateFilter === "on" || stateFilter === "off"
          ? {
              not_evaluated: notEvaluated.slice(0, NOT_EVALUATED_LIMIT),
              not_evaluated_total: notEvaluated.length,
              not_applicable: notApplicable,
            }
          : {}),
        ...(deviceFunctions > 0 ? { device_functions: deviceFunctions } : {}),
        ...(listed.length === 0 && selection.words.length > 1
          ? { query_words: queryWordMatches(catalog, selection, evaluated) }
          : {}),
      },
    };
    const page = buildPage(snapshot, 0, selection);
    if (page.next) this.#remember(snapshot);
    return page;
  }

  // The first page of a home_overview list or query; next pages continue
  // the same snapshot.
  #firstListPage(selection, { base, key, entries, extras }) {
    const snapshot = {
      id: randomBytes(8).toString("hex"),
      scope: selection.scope,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
      size: entries.length,
      base,
      key,
      entries,
      extras,
    };
    const page = buildListPage(snapshot, 0, selection);
    if (page.next) this.#remember(snapshot);
    return page;
  }

  #continuePage(selection, cursor, build) {
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
        `restart_${selection.tool}`,
        { next: { tool: selection.tool, arguments: selection.args } },
      );
    }
    if (snapshot.scope !== selection.scope) throw invalidCursor(selection);
    if (decoded.offset > snapshot.size) throw invalidCursor(selection);
    return build(snapshot, decoded.offset, selection);
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
  const words = query === null ? [] : queryWords(query);
  const otherWords = words.filter(({ word }) => !LIGHT_WORD.test(word));
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
    tool: "find_devices",
    args,
    scope: JSON.stringify(args),
    homeRef: home,
    roomId,
    roomRef: input.roomRef ?? null,
    // Not part of args: once read, the catalog is fresh for next pages.
    refresh: input.refresh === true,
    query,
    words,
    stems: query === null ? null : words.map(({ stem }) => stem),
    // A light question lists beside its answer the standalone relays and
    // sockets that match its filters without its light words.
    lightQuestion:
      input.kind === "light" ||
      (input.kind === undefined && otherWords.length < words.length),
    otherWords,
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
      const kind = serviceKind(service);
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
      candidates.push({
        accessory,
        service,
        kind,
        appliance: applianceOf(service, accessory),
      });
    }
  }
  return candidates;
}

// For a light question: the relays and sockets that are not an appliance's
// settings and match its filters without the light words, apart from those
// the answer lists. A relay's name need not say that it drives a lamp; the
// agent reads the names.
function switchCandidates(catalog, selection, candidates) {
  if (!selection.lightQuestion) return [];
  const listed = new Set(
    candidates.map(
      ({ accessory, service }) => `${accessory.id}/${service.sId}`,
    ),
  );
  const stems = selection.otherWords.map(({ stem }) => stem);
  return selectCandidates(catalog, {
    ...selection,
    kind: "switch",
    stems: stems.length > 0 ? stems : null,
  }).filter(
    ({ accessory, service, appliance }) =>
      appliance === null && !listed.has(`${accessory.id}/${service.sId}`),
  );
}

// The switches section of a light answer: how many, the first few with
// their On ref, and the call that lists them all.
function switchesSection(serial, catalog, items, selection) {
  const roomsById = new Map(catalog.rooms.map((room) => [room.id, room]));
  const roomOrder = new Map(catalog.rooms.map(({ id }, index) => [id, index]));
  const orderOf = ({ accessory }) =>
    roomOrder.get(accessory.roomId) ?? catalog.rooms.length;
  const { query: _query, ...args } = selection.args;
  return {
    total: items.length,
    entries: [...items]
      .sort((left, right) => orderOf(left) - orderOf(right))
      .slice(0, SWITCH_LIMIT)
      .map((item) => switchEntry(serial, roomsById, item)),
    note: "Relays and sockets matching the other filters, not settings of an appliance; some may drive lamps: decide by name.",
    next: {
      tool: "find_devices",
      arguments: {
        ...args,
        ...(selection.otherWords.length > 0
          ? {
              query: selection.otherWords.map(({ word }) => word).join(" "),
            }
          : {}),
        kind: "switch",
      },
    },
  };
}

function switchEntry(serial, roomsById, item) {
  const { accessory, service, onState: on } = item;
  const onControl = (service.characteristics ?? []).find(
    ({ control }) => (control?.type ?? control?.key) === "On",
  );
  return {
    ref: serviceRef(serial, accessory.id, service.sId),
    name: service.name,
    device: accessory.name,
    room: roomsById.get(accessory.roomId)?.name ?? null,
    ...(on?.applicable ? { on: on.on } : {}),
    ...(onControl?.control.write === true
      ? {
          on_ref: characteristicRef(
            serial,
            accessory.id,
            service.sId,
            onControl.cId,
          ),
        }
      : {}),
  };
}

// The section as a page shows it: at most limit entries, and the call for
// the rest only when some are left out.
function switchesOnPage({ next, ...section }, limit) {
  const entries = section.entries.slice(0, limit);
  return {
    ...section,
    entries,
    ...(entries.length < section.total ? { next } : {}),
  };
}

// Why a query of several words found nothing: how many services match all
// its words before a state filter, and how many each word matches alone,
// with the other filters.
function queryWordMatches(catalog, selection, evaluated) {
  return {
    matching_all: evaluated.length,
    matching_each: Object.fromEntries(
      selection.words.map(({ word, stem }) => [
        word,
        selectCandidates(catalog, { ...selection, stems: [stem] }).length,
      ]),
    ),
  };
}

// Whether an evaluated service passes a state filter; unknown on/off does
// not.
function matchesState(item, state) {
  if (state === "on" || state === "off") {
    return (
      item.onState?.applicable === true && item.onState.on === (state === "on")
    );
  }
  if (state === "unavailable") return item.available === false;
  return true;
}

function hasRoom(catalog, selection) {
  return catalog.rooms.some(({ id }) => id === selection.roomId);
}

function deviceText(service, accessory, rooms) {
  const room = rooms.find(({ id }) => id === accessory.roomId);
  return `${service.name} ${accessory.name} ${room?.name ?? ""}`;
}

// Fresh values of the candidates' accessories with the fewest native
// requests; a selected room is read whole with accessory.list {roomId}, so
// a device moved or added there shows. A targeted read that disagrees with
// the catalog (an accessory gone, added, renamed, moved or changed) marks
// the catalog stale.
async function readValues(
  client,
  serial,
  catalog,
  candidates,
  deadline,
  roomId,
) {
  const generation = client.writeGeneration;
  const accessoryIds = [...new Set(candidates.map((c) => c.accessory.id))];
  const roomIds =
    roomId === null
      ? [...new Set(candidates.map((c) => c.accessory.roomId))]
      : [roomId];
  if (roomId === null && accessoryIds.length === 0) {
    return { accessories: [], observedAt: catalog.observedAt, stale: false };
  }
  if (roomId === null && accessoryIds.length <= TARGETED_ACCESSORY_READS) {
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
    appliance: candidate.appliance,
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
    if (item.appliance !== null) continue;
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
    ...(item.appliance === null
      ? {}
      : {
          function_of: {
            kind: serviceKind(item.appliance),
            service_ref: serviceRef(serial, accessory.id, item.appliance.sId),
          },
        }),
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
  // Even the most compact page of one service is over max_bytes: return it,
  // since the continuation must advance, and say so.
  if (bytes(page) > selection.maxBytes) {
    return { ...page, max_bytes_exceeded: true };
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
  if (extras.switches) {
    extras.switches = switchesOnPage(
      extras.switches,
      compaction >= 2 ? 3 : SWITCH_LIMIT,
    );
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
    `Use the cursor returned by ${selection.tool} with the same filters.`,
    `restart_${selection.tool}`,
    { next: { tool: selection.tool, arguments: selection.args } },
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

function scenarioEntry({ summary, native }) {
  return {
    ref: summary.ref,
    name: summary.name,
    type: summary.type,
    active: summary.active,
    on_start: summary.on_start,
    sync: summary.sync,
    execution_error: native.error === true,
  };
}

// ---- home_overview lists ---------------------------------------------------

// type filters scenarios and extensions; active and error only scenarios.
// limit and cursor page a list or a query, never the overview itself.
function checkOverviewInput(input) {
  const allowed =
    input.list === "scenarios"
      ? ["type", "active", "error"]
      : input.list === "extensions"
        ? ["type"]
        : [];
  const refused = ["type", "active", "error"].filter(
    (filter) => input[filter] !== undefined && !allowed.includes(filter),
  );
  if (refused.length > 0) {
    throw new SprutHubError(
      "invalid_filter",
      `${refused.join(", ")} filter a list: type, active and error the scenarios (list=scenarios), type also the extensions (list=extensions).`,
      "home_overview",
      {
        next: {
          tool: "home_overview",
          arguments: overviewArgs(
            { ...input, list: "scenarios" },
            input.homeRef ?? null,
          ),
        },
      },
    );
  }
  if (
    input.list === undefined &&
    input.query === undefined &&
    (input.limit !== undefined || input.cursor !== undefined)
  ) {
    throw new SprutHubError(
      "invalid_filter",
      "limit and cursor page a list (list=scenarios, rooms or extensions) or a query.",
      "home_overview",
    );
  }
}

function overviewArgs(input, home) {
  return {
    ...(home === null ? {} : { home_ref: home }),
    ...(input.list === undefined ? {} : { list: input.list }),
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.active === undefined ? {} : { active: input.active }),
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function overviewSelection(input, serial) {
  const args = overviewArgs(input, homeRef(serial));
  const list = input.list ?? null;
  return {
    tool: "home_overview",
    args,
    scope: JSON.stringify(["home_overview", args]),
    list,
    query: input.query ?? null,
    type: input.type ?? null,
    active: input.active ?? null,
    error: input.error ?? null,
    limit: input.limit ?? (list === null ? MATCH_LIMIT : LIST_LIMIT),
  };
}

// The entries a list or a query pages through: a list in the hub's order,
// or ranked by the query; a query without list mixes rooms, scenarios and
// extensions with their kind.
function overviewEntries(selection, { roomList, scenarios, extensions }) {
  const sameType = (type) =>
    selection.type === null ||
    type.toLocaleLowerCase("en") === selection.type.toLocaleLowerCase("en");
  const lists = {
    rooms: () => roomList,
    scenarios: () =>
      scenarios
        .filter(
          ({ summary, native }) =>
            sameType(summary.type) &&
            (selection.active === null ||
              summary.active === selection.active) &&
            (selection.error === null ||
              (native.error === true) === selection.error),
        )
        .map(scenarioEntry),
    extensions: () =>
      extensions.filter(({ type }) => sameType(type)).map(extensionSummary),
  };
  if (selection.list !== null) {
    const entries = lists[selection.list]();
    return selection.query === null
      ? entries
      : rankMatches(selection.query, entries);
  }
  return rankMatches(selection.query, [
    ...roomList.map((room) => ({ kind: "room", ...room })),
    ...scenarios.map((scenario) => ({
      kind: "scenario",
      ...scenarioEntry(scenario),
    })),
    ...extensions.map((extension) => ({
      kind: "extension",
      ...extensionSummary(extension),
    })),
  ]);
}

// How many services a name query matches, with the find_devices call that
// lists them.
function deviceMatchesHint(home, query, rooms, accessories) {
  const stems = queryStems(query);
  const matches = accessories.accessories.reduce(
    (count, accessory) =>
      count +
      (accessory.services ?? []).filter(
        (service) =>
          serviceKind(service) !== "technical" &&
          matchesStems(stems, deviceText(service, accessory, rooms.rooms)),
      ).length,
    0,
  );
  return matches > 0
    ? {
        devices: {
          matches,
          next: {
            tool: "find_devices",
            arguments: { home_ref: home, query },
          },
        },
      }
    : {};
}

// One page of a list snapshot: up to limit entries from offset within
// LIST_PAGE_BYTES, at least one.
function buildListPage(snapshot, offset, selection) {
  const { entries } = snapshot;
  const page = (end) => ({
    ...snapshot.base,
    total: entries.length,
    returned: end - offset,
    [snapshot.key]: entries.slice(offset, end),
    ...snapshot.extras,
    next:
      end < entries.length
        ? {
            tool: selection.tool,
            arguments: {
              ...selection.args,
              cursor: encodeCursor(snapshot.id, end),
            },
          }
        : null,
  });
  let end = Math.min(offset + 1, entries.length);
  while (
    end < entries.length &&
    end - offset < selection.limit &&
    bytes(page(end + 1)) <= LIST_PAGE_BYTES
  ) {
    end += 1;
  }
  return page(end);
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
// "Спальня" and "Детская спальня", "гостиной" finds "Гостиная". The stem of
// every query word must start a word of the name, except one-letter words
// and the function words below: prepositions, conjunctions, particles and
// "весь/все", which name no device ("все розетки на кухне" asks for the
// kitchen outlets). "не" stays: a name filter cannot negate, and dropping it
// would answer the opposite. Longer endings are tried first; a stem keeps at
// least three letters.
const IGNORED_WORDS = new Set([
  "во",
  "на",
  "по",
  "из",
  "изо",
  "от",
  "ото",
  "до",
  "за",
  "со",
  "ко",
  "об",
  "обо",
  "над",
  "надо",
  "под",
  "подо",
  "при",
  "про",
  "для",
  "без",
  "через",
  "возле",
  "около",
  "между",
  "или",
  "либо",
  "но",
  "ли",
  "же",
  "бы",
  "весь",
  "вся",
  "все",
  "всю",
  "всех",
  "всем",
  "всеми",
]);

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

// The query's words that count, each with its stem.
function queryWords(query) {
  return normalizeName(query)
    .split(" ")
    .filter((word) => word.length > 1 && !IGNORED_WORDS.has(word))
    .map((word) => {
      if (word.length < 4 || !/[а-я]$/.test(word)) return { word, stem: word };
      const ending = ENDINGS.find(
        (candidate) =>
          word.endsWith(candidate) && word.length - candidate.length >= 3,
      );
      return { word, stem: ending ? word.slice(0, -ending.length) : word };
    });
}

export function queryStems(query) {
  return queryWords(query).map(({ stem }) => stem);
}

// A query word that asks about light in general ("свет", "освещение",
// "лампы", "подсветка"): then the answer lists the relays beside it. It
// classifies the question, never a device. A lamp's own name ("торшер")
// asks for that device and brings no relay list.
const LIGHT_WORD = /^(?:свет|подсвет|освещ|ламп|light|lamp)/;

// Every stem must start a word of the text: "не" does not match inside
// "кухне", while "кухн" matches "Кухня".
export function matchesStems(stems, text) {
  const words = normalizeName(text).split(" ");
  return (
    stems.length > 0 &&
    stems.every((stem) => words.some((word) => word.startsWith(stem)))
  );
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

// Household kind of a native service type, in one place, from the type
// only: a name never changes it. SprutHub service types are the HomeKit
// Accessory Protocol ones (service.types answers with Apple HAP UUIDs,
// research/protocol/2026-09-09-type-catalog.json) plus the hub's own C_*
// types. The owner's home on 2026-09-24 had AccessoryInformation 80,
// Lightbulb 53, Switch 39 and StatelessProgrammableSwitch 22 of 254
// services. Switch and Outlet share the kind switch: neither says what it
// drives, and the service's type still tells a socket from a relay. A type
// not listed is "other"; AccessoryInformation and BatteryService are
// technical and hidden unless asked for, the battery level shows on its
// device instead.
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
    switch: ["Switch", "Outlet"],
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
  "switch",
  "air",
  "security",
  "button",
  "other",
];
// Kinds without an on/off: they are counted, not listed, for state filters.
const NO_ON_OFF_KINDS = new Set(["sensor", "cover", "button", "technical"]);

export function serviceKind(service) {
  return KIND_BY_TYPE.get(service.type) ?? "other";
}

// A Switch or Outlet on an accessory with one of these appliances is one of
// the appliance's settings: display, sound, quiet mode (the owner's hub on
// 2026-09-24: 36 of its 41 Switch and Outlet services, on Thermostat and
// AirPurifier accessories). HAP requires of each of these types a measured
// state, a temperature, a humidity or a purifier state, that a relay channel
// cannot present. Fan and Fanv2 require only On or Active, so a relay
// channel set to a fan is one of them, and its other channels stay relays.
const APPLIANCE_TYPES = new Set([
  "Thermostat",
  "HeaterCooler",
  "AirPurifier",
  "HumidifierDehumidifier",
]);

// The appliance service a switch belongs to, or null.
function applianceOf(service, accessory) {
  if (serviceKind(service) !== "switch") return null;
  return (
    (accessory.services ?? []).find(({ type }) => APPLIANCE_TYPES.has(type)) ??
    null
  );
}

// On/off of one service, first match wins:
// - On (bool): Lightbulb, Switch, Outlet, Fan;
// - Active (INACTIVE 0 / ACTIVE 1): AirPurifier, HeaterCooler, Fanv2, Valve;
// - a target mode that is not OFF: TargetHeatingCoolingState (HAP 0 = OFF)
//   or TargetHeaterCoolerState, for a thermostat heating or cooling.
// OutletInUse only says that a load draws power and never decides; an open
// cover is not "on". A service with none of these (an alarm, a lock, a
// filter) has no on/off, even when it has writable characteristics. An
// unavailable device keeps its last values, which do not say whether it is
// on.
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
  if (!basis) return { applicable: false };
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
