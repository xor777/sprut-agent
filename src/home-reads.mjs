// Household reads of one SprutHub home. The answer size follows the
// question, not the home: an overview lists rooms and counts instead of
// every scenario and device.
import {
  accessoryRef,
  homeRef,
  parseEntityRef,
  roomRef,
  SprutHubError,
} from "./spruthub-client.mjs";

const PROBLEM_LIMIT = 10;
const MATCH_LIMIT = 10;

export class HomeReads {
  #client;

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

    const [rooms, accessories, scenarios, extensions] = await Promise.all([
      client.nativeRooms(serial, deadline),
      client.nativeAccessories(serial, deadline),
      client.nativeScenarios(serial, deadline),
      client.nativeExtensions(serial, deadline),
    ]);
    const observedAt = [
      account.freshness.hubResponseReceivedAt,
      rooms.observedAt,
      accessories.observedAt,
      scenarios.observedAt,
      extensions.observedAt,
    ].reduce((latest, value) => (value > latest ? value : latest));
    const roomList = roomsWithDeviceCounts(
      serial,
      rooms.rooms,
      accessories.accessories,
    );
    const several =
      account.homes.length > 1 || account.selection.required === true;
    const selection = several ? listed : {};

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
      return {
        status: "ok",
        home: { ref: home.ref, name: home.name },
        ...selection,
        query,
        matches: matches.slice(0, MATCH_LIMIT),
        total: matches.length,
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
}

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
// word must occur in the name. Longer endings are tried first; a stem keeps
// at least three letters.
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
    .filter(Boolean)
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
