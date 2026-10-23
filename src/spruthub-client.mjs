import { createHash, randomUUID } from "node:crypto";
import { parse } from "@babel/parser";
import jsTokens from "js-tokens";
import { WebSocket } from "ws";
import { withHiddenHttpUrls } from "./block-model.mjs";
import {
  blockBindings,
  blockSummary,
  decodeBlock,
  relationRole,
  withShownHttpUrls,
} from "./block-summary.mjs";
import { HomeState } from "./home-state.mjs";
import {
  inspectNativeOption,
  isSelectableNativeValidValue,
  nativeScalarContract,
} from "./native-option-contract.mjs";

const VALUE_FIELDS = [
  "boolValue",
  "intValue",
  "longValue",
  "doubleValue",
  "stringValue",
];

const INCLUDE_READ_ERROR = Symbol("includeReadError");
// A room above this many services returns its size and a find_devices call
// instead of listing every accessory and service.
const ROOM_LISTING_SERVICE_LIMIT = 20;
// How long the hub's time zone serves without a new read of the home
// settings window, so that a change there shows up.
const HUB_TIME_ZONE_TTL_MS = 5 * 60_000;
// Reads an answer from the warm home makes before it gives up: the whole
// home or its changed accessories, the room list an accessory read asks
// for, and two more for reads the state did not take.
const HOME_READ_PASSES = 4;
// How long a read waits for the home settings window when the hub's time
// zone is not cached. The owner's hub answered in 133 ms for its 99 KB
// window; a hub that answers later leaves that read's times in UTC rather
// than hold back what was read. The window read itself has a full request
// timeout of its own, whatever time the read that started it has left, so
// that a late answer still serves the reads after it.
const HUB_TIME_ZONE_WAIT_MS = 2_000;
// A BLOCK names its devices from the home catalog; the ones the catalog
// lacks are read one by one up to this many, past that the catalog is read.
const REFERENCED_ACCESSORY_READS = 16;
// A BLOCK summary reads the devices of its characteristic conditions now,
// one accessory.get each, up to this many; the rest show status not_read.
const CONDITION_VALUE_READS = 16;
// Relations search the sources of the owner's code scenarios, one
// scenario.get each, up to this many (one LOGIC and one GLOBAL besides 7
// built-in LOGIC on the owner's hub, 2026-09-24-live-conformance-3).
const CODE_SOURCE_READS = 24;
// Native methods that only read. Any other method may change the home: a
// device value write waits for its event in the warm home state, the
// writes below leave the state to the hub's events, any other has the home
// read again (home-state.mjs).
const READ_ONLY_METHODS = new Set([
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
// Writes that change nothing the warm home state holds besides values,
// which the hub's events carry: scenarios and a device search.
const HOME_STATE_NEUTRAL_WRITES = new Set([
  "scenario.create",
  "scenario.update",
  "scenario.delete",
  "scenario.run",
  "extension.action",
]);
const LOG_LEVEL_NAMES = new Map(
  ["off", "error", "warn", "info", "debug", "trace", "all"].map((name) => [
    `LOG_LEVEL_${name.toUpperCase()}`,
    name,
  ]),
);
const LOG_LEVELS = new Set(LOG_LEVEL_NAMES.keys());
const SCENARIO_LOG_PREFIX_BY_PATH = new Map([
  ["Scenario.ScenarioBlock.Target.jBlock", ": "],
  ["Notifiers.Notifier", " - "],
]);

export class SprutHubError extends Error {
  constructor(
    code,
    message,
    action,
    { requestSent = false, protocolErrorCode, ...details } = {},
  ) {
    super(message);
    this.name = "SprutHubError";
    this.code = code;
    this.action = action;
    this.requestSent = requestSent;
    if (protocolErrorCode !== undefined)
      this.protocolErrorCode = protocolErrorCode;
    if (Object.keys(details).length > 0) this.details = details;
  }
}

// Errors that describe the hub connection rather than the command itself.
export const HUB_TRANSPORT_ERROR_CODES = new Set([
  "authentication_delayed",
  "authentication_failed",
  "connection_closed",
  "connection_failed",
  "invalid_message",
  "timeout",
]);

// A read the hub refused with an error reply, or that the connection did
// not complete: what the hub holds is not known. Other errors, such as a
// reply the client cannot understand, are not read failures.
export function isHubReadFailure(error) {
  return (
    error instanceof SprutHubError &&
    (error.hubError !== undefined || HUB_TRANSPORT_ERROR_CODES.has(error.code))
  );
}

export function parseSprutHubMessage(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    throw invalidMessage();
  }
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    throw invalidMessage();
  }
  return message;
}

export class SprutHubClient {
  #availableHomeCount;
  #connectPromise;
  #configuredSerial;
  #connectingSocket;
  // Each open connection's record: the home serials its requests carried,
  // whose events it then receives.
  #connections = new WeakMap();
  #replyConnections = new WeakMap();
  // The warm state of each home read (home-state.mjs) and its whole read
  // in flight.
  #homeStates = new Map();
  #wholeReads = new Map();
  #hubTimeZones = new Map();
  #hubTimeZoneReads = new Map();
  #nextRequestId = 1;
  #observation;
  #observationClient;
  // Listeners of the events the hub pushes (onNativeEvent).
  #nativeEventListeners = new Set();
  #pending = new Map();
  #renewSession;
  #socket;
  #startingObservationClient;
  #writeGeneration = 0;

  constructor({
    url,
    token,
    serial,
    configuredSerial = serial,
    availableHomeCount = null,
    cid,
    timeoutMs = 10_000,
    // (rejectedToken) => Promise<{token, cid}>: a new session from the
    // account's login, for a client whose session the hub may stop
    // accepting. Without it a refused session stays an error.
    renewSession,
  }) {
    if (!url || !token || !cid) {
      throw new SprutHubError(
        "configuration",
        "SprutHub connection settings are incomplete.",
      );
    }

    this.url = url;
    this.token = token;
    this.serial = serial ?? null;
    this.#configuredSerial =
      typeof configuredSerial === "string" && configuredSerial.length > 0
        ? configuredSerial
        : null;
    this.#availableHomeCount = availableHomeCount;
    this.cid = cid;
    this.timeoutMs = timeoutMs;
    this.#renewSession = renewSession;
  }

  async listHomes(deadline = Date.now() + this.timeoutMs) {
    const { homes, observedAt } = await this.#listHomes(deadline);
    this.#availableHomeCount = homes.length;
    const selectedHome = homes.find((home) => home.serial === this.serial);
    const configuredHomeUnavailable =
      this.#configuredSerial !== null &&
      !homes.some((home) => home.serial === this.#configuredSerial);
    const options = homes.map((home) => ({
      home_ref: homeRef(home.serial),
      pin_value: home.serial,
    }));
    return {
      status: "ok",
      homes: homes.map((home) => normalizeHome(home, observedAt)),
      selection:
        homes.length === 0
          ? { required: false, reason: "no_available_homes" }
          : selectedHome
            ? {
                required: false,
                default_home_ref: homeRef(selectedHome.serial),
                ...(homes.length > 1 ? { options } : {}),
              }
            : homes.length === 1 && !configuredHomeUnavailable
              ? {
                  required: false,
                  default_home_ref: homeRef(homes[0].serial),
                }
              : {
                  required: true,
                  ...(configuredHomeUnavailable
                    ? { reason: "configured_home_unavailable" }
                    : {}),
                  options,
                },
      freshness: freshness(observedAt),
    };
  }

  // The selected home's serial, or the error that tells the agent to choose
  // one.
  selectedSerial() {
    if (this.serial !== null) return this.serial;
    if (this.#availableHomeCount === 0) throw noHomesAvailable();
    throw homeSelectionRequired();
  }

  // The home as the warm state holds it (home-state.mjs): names, rooms,
  // types and current values. null while something must be read before it
  // answers.
  cachedHomeCatalog(serial) {
    const state = this.#homeStates.get(serial);
    return state && state.needs() === null ? state.catalog() : null;
  }

  // The home from the warm state, read first where the state cannot
  // answer: whole when it was never read, may have missed something or
  // refresh is set, else the rooms and the accessories its events changed.
  // A read the state does not take, because something it cannot follow
  // happened while the read was in flight, is made again; an accessory read
  // in a room the state does not know has the room list read after it.
  async homeCatalog(serial, deadline, { refresh = false } = {}) {
    const state = this.#homeState(serial);
    const since = state.readMark();
    for (let pass = 0; pass <= HOME_READ_PASSES; pass += 1) {
      const needs = state.needs(Date.now(), since, refresh);
      if (needs === null) return { catalog: state.catalog() };
      if (pass === HOME_READ_PASSES) break;
      if (needs.whole) {
        // A refresh takes no whole read begun before it.
        await this.#readWholeHome(state, deadline, refresh ? since : 0);
      } else {
        await Promise.all([
          needs.rooms ? this.#readRoomsInto(state, deadline) : null,
          ...needs.accessories.map((id) =>
            this.#readAccessoryInto(state, id, deadline),
          ),
        ]);
      }
    }
    throw new SprutHubError(
      "home_changing",
      "The home kept changing in ways that need a new read while it was being read, so no answer could be given from a read that may have missed a change. Retry the call.",
      "retry",
    );
  }

  #homeState(serial) {
    let state = this.#homeStates.get(serial);
    if (!state) {
      state = new HomeState(serial);
      this.#homeStates.set(serial, state);
    }
    return state;
  }

  // A whole read already running answers too (it started earlier, with an
  // earlier deadline), unless the state has since learnt of something it
  // cannot follow (the state would not take that read) or it is not newer
  // than the read mark after.
  #readWholeHome(state, deadline, after) {
    const running = this.#wholeReads.get(state.serial);
    if (running?.generation === state.generation && running.number > after) {
      return running.read;
    }
    const token = state.beginRead();
    const read = this.#readWhole(state, token, deadline);
    const entry = { read, generation: token.generation, number: token.number };
    this.#wholeReads.set(state.serial, entry);
    const forget = () => {
      if (this.#wholeReads.get(state.serial) === entry) {
        this.#wholeReads.delete(state.serial);
      }
    };
    read.then(forget, forget);
    return read;
  }

  async #readWhole(state, token, deadline) {
    try {
      const [rooms, accessories] = await Promise.all([
        this.#readRooms(state.serial, deadline),
        this.#readAccessories(state.serial, deadline),
      ]);
      const feed =
        rooms.connection === accessories.connection
          ? accessories.connection
          : null;
      state.replaceWhole(
        {
          rooms: rooms.rooms,
          accessories: accessories.accessories,
          observedAt: latestObservedAt([
            rooms.observedAt,
            accessories.observedAt,
          ]),
          feed,
        },
        token,
      );
    } finally {
      state.endRead(token);
    }
  }

  async #readRoomsInto(state, deadline) {
    const token = state.beginRead();
    try {
      const { rooms } = await this.#readRooms(state.serial, deadline);
      state.replaceRooms(rooms, token);
    } finally {
      state.endRead(token);
    }
  }

  async #readAccessoryInto(state, id, deadline) {
    const token = state.beginRead();
    try {
      const { accessory, observedAt } = await this.nativeAccessory(
        state.serial,
        id,
        deadline,
      );
      state.replaceAccessory(id, accessory, observedAt, token);
    } finally {
      state.endRead(token);
    }
  }

  // One accessory with its services and values; null when the hub says it
  // is not there (a live -32603 or get:null).
  async nativeAccessory(serial, id, deadline) {
    let response;
    try {
      response = await this.#request({ accessory: { get: { id } } }, deadline, {
        serial,
      });
    } catch (error) {
      if (!isNativeNotFoundCandidate(error)) throw error;
      return { accessory: null, observedAt: new Date().toISOString() };
    }
    const container = response.result?.accessory;
    if (!container || !Object.hasOwn(container, "get")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible accessory response.",
      );
    }
    if (container.get === null) {
      return { accessory: null, observedAt: response.responseReceivedAt };
    }
    validateAccessory(container.get);
    if (container.get.id !== id) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a different accessory than requested.",
      );
    }
    return {
      accessory: container.get,
      observedAt: response.responseReceivedAt,
    };
  }

  // Plain native reads of one home for the household reads in
  // home-reads.mjs; each validates what it returns and one caller deadline
  // covers them all.
  async nativeRooms(serial, deadline) {
    const { rooms, observedAt } = await this.#readRooms(serial, deadline);
    return { rooms, observedAt };
  }

  async nativeAccessories(serial, deadline, { roomId } = {}) {
    const { accessories, observedAt } = await this.#readAccessories(
      serial,
      deadline,
      { roomId },
    );
    return { accessories, observedAt };
  }

  // These two also name the connection the list came over.
  async #readRooms(serial, deadline) {
    const response = await this.#request({ room: { list: {} } }, deadline, {
      serial,
    });
    const rooms = extractNativeList(
      response,
      ["room", "list", "rooms"],
      () =>
        new SprutHubError(
          "incompatible_response",
          "SprutHub returned an incompatible room list.",
        ),
    );
    rooms.forEach((room) => {
      validateRoom(room);
    });
    return {
      rooms,
      observedAt: response.responseReceivedAt,
      connection: this.#replyConnections.get(response),
    };
  }

  async #readAccessories(serial, deadline, { roomId } = {}) {
    const response = await this.#request(
      {
        accessory: {
          list: {
            ...(roomId === undefined ? {} : { roomId }),
            expand: "services,characteristics",
          },
        },
      },
      deadline,
      { serial },
    );
    const accessories = extractNativeList(response, [
      "accessory",
      "list",
      "accessories",
    ]);
    accessories.forEach(validateAccessory);
    return {
      accessories,
      observedAt: response.responseReceivedAt,
      connection: this.#replyConnections.get(response),
    };
  }

  async nativeScenarios(serial, deadline) {
    const response = await this.#request({ scenario: { list: {} } }, deadline, {
      serial,
    });
    const scenarios = extractNativeList(response, [
      "scenario",
      "list",
      "scenarios",
    ]).map((native) => ({
      native,
      summary: normalizeScenarioSummary(serial, native),
    }));
    return { scenarios, observedAt: response.responseReceivedAt };
  }

  async nativeExtensions(serial, deadline) {
    const response = await this.#request(
      { extension: { list: {} } },
      deadline,
      { serial },
    );
    const extensions = extractNativeList(response, [
      "extension",
      "list",
      "extensions",
    ]);
    // ends_at of a running search is on the hub's clock; the zone is read
    // only while a search runs.
    const timeZone = extensions.some(hasRunningAction)
      ? await this.#hubTimeZone(serial, deadline)
      : null;
    return {
      extensions: normalizeExtensions(serial, extensions, timeZone),
      observedAt: response.responseReceivedAt,
    };
  }

  // One extension as extension.get returns it, its spaces with their
  // actions included: a search's state is read here (state and
  // endTimestamp, 2026-10-12-device-pairing P1, P2).
  async nativeExtension(serial, key, deadline) {
    const response = await this.#request(
      { extension: { get: { extensionKey: key } } },
      deadline,
      { serial },
    );
    const extension = extractEntity(
      response,
      ["extension", "get"],
      "extension",
    );
    if (extensionKey(extension) !== key) throw incompatibleExtensionIdentity();
    normalizeExtensionDetail(serial, extension, null);
    return { extension, observedAt: response.responseReceivedAt };
  }

  // The controller's devices as extensionChild.list returns them, each
  // checked to belong to this controller.
  async nativeExtensionChildren(serial, key, deadline) {
    const response = await this.#request(
      { extensionChild: { list: { extensionKey: key } } },
      deadline,
      { serial },
    );
    const children = extractNativeList(response, [
      "extensionChild",
      "list",
      "children",
    ]);
    normalizeExtensionChildren(serial, children, key);
    return { children, observedAt: response.responseReceivedAt };
  }

  // Sends an action of an extension space: state true starts a search,
  // false stops it. The hub answers with an empty result; what it did shows
  // only in a later extension.get (2026-10-12-device-pairing P1).
  async extensionAction(
    serial,
    { extensionKey: key, spaceKey, actionId, state },
    deadline,
  ) {
    const response = await this.#request(
      {
        extension: {
          action: { extensionKey: key, spaceKey, actionId, state },
        },
      },
      deadline,
      { serial },
    );
    const container = response.result?.extension;
    if (!container || !Object.hasOwn(container, "action")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the extension action.",
        undefined,
        { requestSent: true },
      );
    }
    return { observedAt: response.responseReceivedAt };
  }

  // A window as window.get returns it; null when the hub has none.
  async nativeWindow(serial, windowKey, deadline) {
    const response = await this.#request(
      { window: { get: { windowKey } } },
      deadline,
      { serial },
    );
    const window = response.result?.window?.get;
    if (window === null) return null;
    if (
      !window ||
      window.windowKey !== windowKey ||
      !Array.isArray(window.options)
    ) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible device-window response.",
      );
    }
    return window;
  }

  // The hub's time zone for times shown on its clock; null keeps UTC.
  hubTimeZone(serial, deadline) {
    return this.#hubTimeZone(serial, deadline);
  }

  // Calls listener with the event part of each frame the hub pushes on this
  // client's connection, until the returned function is called. The hub
  // sends events to every connection without a subscription
  // (2026-10-12-device-pairing H12, P5); they are hub data, a reason to
  // read again, never the state itself.
  onNativeEvent(listener) {
    this.#nativeEventListeners.add(listener);
    return () => {
      this.#nativeEventListeners.delete(listener);
    };
  }

  async getEntity(entityReference, include = []) {
    const parsed = parseEntityRef(entityReference);
    const deadline = Date.now() + this.timeoutMs;
    await this.#requireHome(parsed.serial, deadline);
    const requested = new Set(include);
    const entity = await this.#readEntity(parsed, requested, deadline);
    const observedAt = new Date().toISOString();
    return {
      status: "ok",
      home_ref: homeRef(parsed.serial),
      entity,
      freshness: freshness(observedAt),
    };
  }

  async startNativeObservation(input) {
    const activeClient =
      this.#startingObservationClient ??
      (this.#observationClient &&
      !isTerminalObservation(this.#observationClient.#observation?.status)
        ? this.#observationClient
        : null);
    if (activeClient) {
      throw new SprutHubError(
        "observation_in_progress",
        "Another native observation is already running in this MCP process.",
        "read_hub_log",
        { observation_ref: activeClient.#observation?.ref },
      );
    }

    const candidate = new SprutHubClient({
      url: this.url,
      token: this.token,
      serial: this.serial,
      cid: this.cid,
      timeoutMs: this.timeoutMs,
      renewSession: this.#renewSession,
    });
    this.#startingObservationClient = candidate;
    try {
      // The zone is read on this client, not on the observation's
      // connection.
      const result = await candidate.#startNativeObservation(
        input,
        (serial, deadline) => this.#hubTimeZone(serial, deadline),
      );
      const previous = this.#observationClient;
      this.#observationClient = candidate;
      this.#startingObservationClient = undefined;
      await previous?.close();
      return result;
    } catch (error) {
      if (this.#startingObservationClient === candidate) {
        this.#startingObservationClient = undefined;
      }
      await candidate.close();
      throw error;
    }
  }

  async #startNativeObservation(
    {
      homeRef: selectedHomeRef,
      characteristicRefs,
      scenarioRef: selectedScenarioRef,
      durationSeconds,
      maxEvents,
    },
    readTimeZone,
  ) {
    if (this.#observation && !isTerminalObservation(this.#observation.status)) {
      throw new SprutHubError(
        "observation_in_progress",
        "Another native observation is already running in this MCP process.",
        "read_hub_log",
        { observation_ref: this.#observation.ref },
      );
    }

    const serial = parseHomeRef(selectedHomeRef);
    const parsedCharacteristics = characteristicRefs.map((ref) => {
      const parsed = parseEntityRef(ref);
      if (parsed.kind !== "characteristic" || parsed.serial !== serial) {
        throw invalidObservationScope();
      }
      return { ref, parsed };
    });
    const parsedScenario = parseEntityRef(selectedScenarioRef);
    if (
      parsedScenario.kind !== "scenario" ||
      parsedScenario.serial !== serial
    ) {
      throw invalidObservationScope();
    }
    if (
      new Set(parsedCharacteristics.map(({ ref }) => ref)).size !==
      parsedCharacteristics.length
    ) {
      throw new SprutHubError(
        "invalid_observation_scope",
        "Characteristic references in one observation must be unique.",
        "read_hub_log",
      );
    }

    const observation = {
      ref: `native-observation:${randomUUID()}`,
      status: "starting",
      serial,
      homeRef: selectedHomeRef,
      characteristicRefs: parsedCharacteristics.map(({ ref }) => ref),
      characteristicByNativeId: new Map(
        parsedCharacteristics.map(({ ref, parsed }) => [
          nativeCharacteristicKey({
            aId: parsed.accessoryId,
            sId: parsed.serviceId,
            cId: parsed.characteristicId,
          }),
          ref,
        ]),
      ),
      scenarioRef: selectedScenarioRef,
      scenarioIndex: parsedScenario.scenarioIndex,
      durationSeconds,
      maxEvents,
      // Times are given on this zone's clock, read once at the start; null
      // keeps UTC.
      timeZone: null,
      events: [],
      sequence: 0,
      startedAt: null,
      endsAt: null,
      endedAt: null,
      completionReason: null,
      truncated: false,
      connection: { status: "connected" },
      subscriptionUuids: { scenario: null, log: null },
      cleanup: { status: "not_needed" },
      timer: null,
      pingTimer: null,
      cancelRequested: null,
      waiters: new Set(),
    };
    this.#observation = observation;

    const deadline = Date.now() + this.timeoutMs;
    try {
      await this.#requireHome(serial, deadline);
      for (const { parsed } of parsedCharacteristics) {
        const characteristic = await this.#readEntity(
          parsed,
          new Set(),
          deadline,
        );
        if (characteristic.capabilities?.events !== true) {
          throw new SprutHubError(
            "events_unavailable",
            "A selected characteristic is not marked as event-capable by SprutHub.",
            "get_entity",
            { characteristic_ref: characteristic.ref },
          );
        }
      }
      await this.#readEntity(parsedScenario, new Set(), deadline);
      observation.timeZone = await readTimeZone(serial, deadline);
      const response = await this.#request(
        { scenario: { subscribe: { index: parsedScenario.scenarioIndex } } },
        deadline,
        { serial },
      );
      const uuid = response.result?.scenario?.subscribe?.uuid;
      if (typeof uuid !== "string" || uuid.length === 0) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub did not identify the native scenario subscription.",
        );
      }
      observation.subscriptionUuids.scenario = uuid;
      observation.cleanup = { status: "pending" };
      if (observation.cancelRequested) {
        await this.#finishObservation(
          observation,
          observation.cancelRequested.status,
          observation.cancelRequested.completionReason,
        );
        return this.#observationResult(observation);
      }
      const logResponse = await this.#request(
        { log: { subscribe: {} } },
        deadline,
        { serial },
      );
      const logUuid = logResponse.result?.log?.subscribe?.uuid;
      if (typeof logUuid !== "string" || logUuid.length === 0) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub did not identify the native log subscription.",
        );
      }
      observation.subscriptionUuids.log = logUuid;
      if (observation.cancelRequested) {
        await this.#finishObservation(
          observation,
          observation.cancelRequested.status,
          observation.cancelRequested.completionReason,
        );
        return this.#observationResult(observation);
      }
      observation.status = "observing";
      const startedAt = Date.now();
      observation.startedAt = zonedTimestamp(startedAt, observation.timeZone);
      observation.endsAt = zonedTimestamp(
        startedAt + durationSeconds * 1_000,
        observation.timeZone,
      );
      observation.timer = setTimeout(() => {
        void this.#finishObservation(
          observation,
          "completed",
          "duration_elapsed",
        );
      }, durationSeconds * 1_000);
      observation.pingTimer = setInterval(() => {
        void this.#pingObservation(observation);
      }, 30_000);
      return this.#observationResult(observation);
    } catch (error) {
      if (observation.cancelRequested) {
        await this.#finishObservation(
          observation,
          observation.cancelRequested.status,
          observation.cancelRequested.completionReason,
        );
        return this.#observationResult(observation);
      }
      if (Object.values(observation.subscriptionUuids).some(Boolean)) {
        await this.#cleanupObservationSubscriptions(observation);
      }
      if (this.#observation === observation) this.#observation = undefined;
      throw error;
    }
  }

  async getNativeObservation(observationRef, waitSeconds = 0) {
    return this.#observationClientFor(observationRef).#getNativeObservation(
      observationRef,
      waitSeconds,
    );
  }

  async #getNativeObservation(observationRef, waitSeconds = 0) {
    const observation = this.#requireObservation(observationRef);
    if (
      ["observing", "finishing"].includes(observation.status) &&
      waitSeconds > 0
    ) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          observation.waiters.delete(done);
          resolve();
        }, waitSeconds * 1_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        observation.waiters.add(done);
      });
    }
    return this.#observationResult(observation);
  }

  async stopNativeObservation(observationRef) {
    return this.#observationClientFor(observationRef).#stopNativeObservation(
      observationRef,
    );
  }

  async #stopNativeObservation(
    observationRef,
    completionReason = "requested_stop",
  ) {
    const observation = this.#requireObservation(observationRef);
    if (observation.status === "starting") {
      observation.cancelRequested = {
        status: "canceled",
        completionReason,
      };
      await new Promise((resolve) => observation.waiters.add(resolve));
    } else if (observation.status === "finishing") {
      await new Promise((resolve) => observation.waiters.add(resolve));
    } else if (!isTerminalObservation(observation.status)) {
      await this.#finishObservation(observation, "canceled", completionReason);
    }
    return this.#observationResult(observation);
  }

  async listRooms() {
    if (this.serial === null) {
      if (this.#availableHomeCount === 0) throw noHomesAvailable();
      throw homeSelectionRequired();
    }
    const deadline = Date.now() + this.timeoutMs;
    const roomsResponse = await this.#request(
      { room: { list: {} } },
      deadline,
      { serial: this.serial },
    );
    const rooms = extractNativeList(
      roomsResponse,
      ["room", "list", "rooms"],
      () =>
        new SprutHubError(
          "incompatible_response",
          "SprutHub returned an incompatible room list.",
        ),
    );

    return {
      status: "ok",
      rooms: rooms.map((room) => {
        validateRoom(room);
        return {
          ref: roomRef(this.serial, room.id),
          name: room.name,
        };
      }),
      freshness: {
        hubResponseReceivedAt: new Date().toISOString(),
        measurementAt: null,
      },
    };
  }

  async readHubLog({ homeRef: selectedHomeRef, count }) {
    const serial = parseHomeRef(selectedHomeRef);
    if (this.serial === null) {
      if (this.#availableHomeCount === 0) throw noHomesAvailable();
      throw homeSelectionRequired();
    }
    if (serial !== this.serial) {
      throw new SprutHubError(
        "wrong_home",
        "The hub log is read only from the configured SprutHub home. Use its home_ref from home_overview.",
        "home_overview",
        { next: { tool: "home_overview", arguments: {} } },
      );
    }
    const deadline = Date.now() + this.timeoutMs;
    let response;
    try {
      response = await this.#request({ log: { list: { count } } }, deadline, {
        serial,
      });
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        ["unsupported", "request_rejected"].includes(error.code)
      ) {
        throw new SprutHubError(
          "hub_log_unavailable",
          "SprutHub did not provide its execution log for this request; this is not an empty log.",
          undefined,
          {
            capability_status:
              error.code === "unsupported" ? "unsupported" : "unknown",
            native_error_code:
              error.protocolErrorCode ??
              (error.code === "unsupported" ? -32601 : null),
          },
        );
      }
      throw error;
    }
    const nativeEntries = extractNativeList(
      response,
      ["log", "list", "log"],
      incompatibleHubLog,
    );
    // Read after the log, which a hub slow to give its settings window
    // then does not hold back.
    const timeZone = await this.#hubTimeZone(serial, deadline);
    return {
      status: "ok",
      home_ref: homeRef(serial),
      time_zone: timeZone,
      entries: nativeEntries
        .map((entry) => normalizeHubLogEntry(entry, timeZone))
        .sort((a, b) => b.native_time - a.native_time),
      native: {
        operation: "log.list",
        requested_count: count,
        returned_count: nativeEntries.length,
        time_unit: "unix_ms",
      },
      freshness: freshness(response.responseReceivedAt),
    };
  }

  // The hub's time zone, kept per home for HUB_TIME_ZONE_TTL_MS and until a
  // write of this client. A caller waits for
  // it at most HUB_TIME_ZONE_WAIT_MS within its own deadline and then keeps
  // UTC (null); the read goes on with its own request timeout, later callers
  // share it, and its answer is kept when it comes. A zone that is not read
  // is not kept, so the next read asks again.
  async #hubTimeZone(serial, deadline) {
    const cached = this.#hubTimeZones.get(serial);
    if (
      cached &&
      cached.generation === this.#writeGeneration &&
      Date.now() - cached.readAt < HUB_TIME_ZONE_TTL_MS
    ) {
      return cached.zone;
    }
    const generation = this.#writeGeneration;
    let reading = this.#hubTimeZoneReads.get(serial);
    if (reading?.generation !== generation) {
      reading = {
        generation,
        zone: this.#readHubTimeZone(serial, Date.now() + this.timeoutMs).then(
          (zone) => {
            if (zone !== null && generation === this.#writeGeneration) {
              this.#hubTimeZones.set(serial, {
                zone,
                generation,
                readAt: Date.now(),
              });
            }
            return zone;
          },
        ),
      };
      this.#hubTimeZoneReads.set(serial, reading);
      const forget = () => {
        if (this.#hubTimeZoneReads.get(serial) === reading) {
          this.#hubTimeZoneReads.delete(serial);
        }
      };
      reading.zone.then(forget, forget);
    }
    let timer;
    const gaveUp = new Promise((resolve) => {
      timer = setTimeout(
        resolve,
        Math.max(0, Math.min(HUB_TIME_ZONE_WAIT_MS, deadline - Date.now())),
        null,
      );
    });
    try {
      return await Promise.race([reading.zone, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
  }

  // TimeZone in the home settings window, which window.get returns for the
  // root key "" (hub optionsWindow was "" on the live hub,
  // research/protocol/2026-09-16-home-settings-window.md). null when the hub
  // gives no single zone this process can apply; the caller then keeps UTC
  // rather than guess an offset.
  async #readHubTimeZone(serial, deadline) {
    let response;
    try {
      response = await this.#request(
        { window: { get: { windowKey: "" } } },
        deadline,
        { serial },
      );
    } catch (error) {
      if (error instanceof SprutHubError) return null;
      throw error;
    }
    const options = response.result?.window?.get?.options;
    const zones = Array.isArray(options)
      ? options.filter((option) => option?.key === "TimeZone")
      : [];
    const zone = zones.length === 1 ? zones[0].value?.stringValue : undefined;
    return typeof zone === "string" &&
      zoneOffsetMinutes(Date.now(), zone) !== null
      ? zone
      : null;
  }

  // The scenarios the hub's index lists for one accessory, as relations
  // read them (scenario.list {aId}); a summary without data.
  async listAccessoryScenarios(aId) {
    const response = await this.#request(
      { scenario: { list: { aId } } },
      Date.now() + this.timeoutMs,
    );
    return extractNativeList(response, ["scenario", "list", "scenarios"]);
  }

  async listScenarioDetails({ descriptionIncludes } = {}) {
    const deadline = Date.now() + this.timeoutMs;
    const scenarios = extractScenarioCatalog(
      await this.#request({ scenario: { list: {} } }, deadline),
    );
    const details = [];
    for (const scenario of scenarios) {
      if (
        descriptionIncludes !== undefined &&
        typeof scenario.desc === "string" &&
        !scenario.desc.includes(descriptionIncludes)
      )
        continue;
      const response = await this.#request(
        { scenario: { get: { index: scenario.index, expand: "data" } } },
        deadline,
      );
      const container = response.result?.scenario;
      if (!container || !("get" in container)) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub returned an incompatible scenario response.",
        );
      }
      if (container.get !== null) details.push(container.get);
    }
    return details;
  }

  async createScenario(request) {
    const response = await this.#request(
      { scenario: { create: request } },
      Date.now() + this.timeoutMs,
    );
    const scenario = response.result?.scenario?.create;
    if (!scenario || typeof scenario.index !== "string") {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not identify the created scenario.",
        "get_native_change",
        { requestSent: true },
      );
    }
    return scenario;
  }

  // The scenario SDK declarations of a home, as get_entity include sdk on
  // its ref. bytes and sha256 describe the text as read; the server
  // compares them with the text it returns (sdk_complete).
  async #readScenarioSdk(serial, deadline) {
    const response = await this.#request({ scenario: { sdk: {} } }, deadline, {
      serial,
    });
    const sdk = response.result?.scenario?.sdk?.sdk;
    if (typeof sdk !== "string" || sdk.length === 0) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incomplete scenario SDK.",
      );
    }
    return {
      sdk,
      bytes: Buffer.byteLength(sdk),
      sha256: createHash("sha256").update(sdk).digest("hex"),
      sdk_origin: "spruthub_scenario_sdk",
      sdk_limitations: [
        "The declarations describe code executed by SprutHub; they are not a Node.js or browser API.",
        "The SDK does not prove callback ordering, repeated-value delivery, or runtime behavior on a particular service.",
      ],
    };
  }

  async getAccessory(id) {
    const response = await this.#request(
      { accessory: { get: { id } } },
      Date.now() + this.timeoutMs,
    );
    const accessory = response.result?.accessory?.get;
    validateAccessory(accessory);
    if (accessory.id !== id) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a different accessory than requested.",
      );
    }
    return accessory;
  }

  async getAccessoryOrNull(id) {
    const deadline = Date.now() + this.timeoutMs;
    let response;
    try {
      response = await this.#request({ accessory: { get: { id } } }, deadline);
    } catch (error) {
      if (!isNativeNotFoundCandidate(error)) throw error;
      const accessories = await this.listAccessories(deadline);
      if (accessories.some((accessory) => accessory.id === id)) throw error;
      return null;
    }
    const container = response.result?.accessory;
    if (!container || !Object.hasOwn(container, "get")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible accessory response.",
      );
    }
    if (container.get === null) return null;
    validateAccessory(container.get);
    if (container.get.id !== id) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a different accessory than requested.",
      );
    }
    return container.get;
  }

  async listAccessories(deadline = Date.now() + this.timeoutMs) {
    const response = await this.#request(
      { accessory: { list: { expand: "services,characteristics" } } },
      deadline,
    );
    const accessories = extractNativeList(response, [
      "accessory",
      "list",
      "accessories",
    ]);
    accessories.forEach(validateAccessory);
    return accessories;
  }

  async listServiceTypes() {
    const response = await this.#request(
      { service: { types: {} } },
      Date.now() + this.timeoutMs,
    );
    const types = extractNativeList(response, ["service", "types", "types"]);
    return types.map((type) => {
      if (
        !type ||
        typeof type.type !== "string" ||
        (type.required !== undefined && !Array.isArray(type.required)) ||
        (type.optional !== undefined && !Array.isArray(type.optional))
      ) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub returned an incompatible service type catalog.",
        );
      }
      return {
        ...type,
        required: type.required ?? [],
        optional: type.optional ?? [],
      };
    });
  }

  async createAccessory({ name, roomId, services }) {
    const response = await this.#request(
      { accessory: { create: { name, roomId, services } } },
      Date.now() + this.timeoutMs,
    );
    const accessory = response.result?.accessory?.create;
    try {
      validateAccessory(accessory);
      if (accessory.virtual === false) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub identified the created accessory as non-virtual.",
        );
      }
    } catch (error) {
      if (error instanceof SprutHubError) {
        error.requestSent = true;
        error.action = "get_native_change";
      }
      throw error;
    }
    return accessory;
  }

  async deleteAccessory(id) {
    const response = await this.#request(
      { accessory: { delete: { id } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.accessory;
    if (!container || !Object.hasOwn(container, "delete")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the accessory deletion.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async listLinks({ aId, sId, cId }) {
    const response = await this.#request(
      { link: { list: { aId, sId, cId } } },
      Date.now() + this.timeoutMs,
    );
    const links = extractNativeList(response, ["link", "list", "links"]);
    return links.map(normalizeLink);
  }

  async addVirtualLink({ aId, sId, cId, tAId, tSId, tCId }) {
    const response = await this.#request(
      { link: { addVirtual: { aId, sId, cId, tAId, tSId, tCId } } },
      Date.now() + this.timeoutMs,
    );
    const link = response.result?.link?.addVirtual;
    try {
      return normalizeLink(link);
    } catch (error) {
      if (error instanceof SprutHubError) {
        error.requestSent = true;
        error.action = "get_native_change";
      }
      throw error;
    }
  }

  async removeLink({ aId, sId, cId, linkId }) {
    const response = await this.#request(
      { link: { remove: { aId, sId, cId, linkId } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.link;
    if (!container || !Object.hasOwn(container, "remove")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the link removal.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async updateCharacteristicLinks({ aId, sId, cId, hasLinks }) {
    const response = await this.#request(
      {
        characteristic: {
          update: { aId, sId, cId, hasLinks },
        },
      },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.characteristic;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the characteristic link settings.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async updateAccessory({ id, name, roomId }) {
    const response = await this.#request(
      { accessory: { update: { id, name, roomId } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.accessory;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the accessory update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async getRoom(id) {
    const deadline = Date.now() + this.timeoutMs;
    let response;
    try {
      response = await this.#request({ room: { get: { id } } }, deadline);
    } catch (error) {
      if (!isNativeNotFoundCandidate(error)) throw error;
      const rooms = extractNativeList(
        await this.#request({ room: { list: {} } }, deadline),
        ["room", "list", "rooms"],
      );
      for (const room of rooms) validateRoom(room);
      if (rooms.some((room) => room.id === id)) throw error;
      return null;
    }
    const container = response.result?.room;
    if (!container || !Object.hasOwn(container, "get")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible room response.",
      );
    }
    if (container.get === null) return null;
    validateRoom(container.get, id);
    return container.get;
  }

  async createRoom(name) {
    const response = await this.#request(
      { room: { create: { name } } },
      Date.now() + this.timeoutMs,
    );
    const room = response.result?.room?.create;
    try {
      validateRoom(room);
    } catch (error) {
      if (error instanceof SprutHubError) {
        error.requestSent = true;
        error.action = "get_native_change";
      }
      throw error;
    }
    return room;
  }

  // RoomUpdateRequest also carries visible; only the name is sent here.
  async renameRoom(id, name) {
    const response = await this.#request(
      { room: { update: { id, name } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.room;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the room update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  // Sends only the named fields, never order or grid.
  async updateService({ aId, sId }, fields) {
    const update = { aId, sId };
    if (Object.hasOwn(fields, "name")) update.name = fields.name;
    if (Object.hasOwn(fields, "visible")) update.visible = fields.visible;
    const response = await this.#request(
      { service: { update } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.service;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the service update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async deleteRoom(id) {
    const response = await this.#request(
      { room: { delete: { id } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.room;
    if (!container || !Object.hasOwn(container, "delete")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the room deletion.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async listAccessoriesInRoom(roomId) {
    const response = await this.#request(
      { accessory: { list: { roomId } } },
      Date.now() + this.timeoutMs,
    );
    const accessories = extractNativeList(response, [
      "accessory",
      "list",
      "accessories",
    ]);
    for (const accessory of accessories) {
      validateAccessory(accessory);
      if (accessory.roomId !== roomId) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub returned an accessory from a different room.",
        );
      }
    }
    return accessories;
  }

  async getScenario(index) {
    const deadline = Date.now() + this.timeoutMs;
    return this.#getScenarioRecord(index, deadline, { expand: "data" });
  }

  // Live hubs reject a deleted scenario with -32603, not get:null. Confirm
  // absence only with an unfiltered list of the home from the ref.
  async #getScenarioRecord(index, deadline, { serial, expand } = {}) {
    const requestOptions = serial === undefined ? {} : { serial };
    let response;
    try {
      response = await this.#request(
        {
          scenario: {
            get: {
              index,
              ...(expand === undefined ? {} : { expand }),
            },
          },
        },
        deadline,
        requestOptions,
      );
    } catch (error) {
      if (!isScenarioNotFoundCandidate(error)) throw error;
      const scenarios = extractScenarioCatalog(
        await this.#request(
          { scenario: { list: {} } },
          deadline,
          requestOptions,
        ),
      );
      if (scenarios.some((scenario) => scenario.index === index)) throw error;
      return null;
    }
    const container = response.result?.scenario;
    if (!container || !Object.hasOwn(container, "get")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible scenario response.",
      );
    }
    if (container.get === null) return null;
    if (container.get.index !== index) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a different scenario than requested.",
      );
    }
    return container.get;
  }

  async listScenarios() {
    return extractScenarioCatalog(
      await this.#request(
        { scenario: { list: {} } },
        Date.now() + this.timeoutMs,
      ),
    );
  }

  async updateScenario(index, fields) {
    const update = { index };
    if (Object.hasOwn(fields, "name")) update.name = fields.name;
    if (Object.hasOwn(fields, "desc")) update.desc = fields.desc;
    if (Object.hasOwn(fields, "active")) update.active = fields.active;
    if (Object.hasOwn(fields, "data")) update.data = fields.data;
    const response = await this.#request(
      { scenario: { update } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.scenario;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the scenario update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async updateScenarioData(index, data) {
    await this.updateScenario(index, { data });
  }

  async runScenario(index) {
    const response = await this.#request(
      { scenario: { run: { index } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.scenario;
    if (!container || !Object.hasOwn(container, "run")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the scenario run.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async getCharacteristic({ aId, sId, cId }) {
    const response = await this.#request(
      { characteristic: { get: { aId, sId, cId } } },
      Date.now() + this.timeoutMs,
    );
    const characteristic = response.result?.characteristic?.get;
    if (
      !characteristic ||
      characteristic.aId !== aId ||
      characteristic.sId !== sId ||
      characteristic.cId !== cId ||
      !characteristic.control ||
      typeof characteristic.control !== "object"
    ) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible characteristic response.",
      );
    }
    return {
      ...characteristic,
      responseReceivedAt: response.responseReceivedAt,
    };
  }

  async getCharacteristicOptions({ aId, sId, cId }) {
    const response = await this.#request(
      { characteristic: { getOptions: { aId, sId, cId } } },
      Date.now() + this.timeoutMs,
    );
    return extractNativeList(response, [
      "characteristic",
      "getOptions",
      "options",
    ]);
  }

  async setCharacteristicOption({ aId, sId, cId, key, value }) {
    const response = await this.#request(
      {
        characteristic: {
          setOptions: { aId, sId, cId, options: [{ key, value }] },
        },
      },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.characteristic;
    if (!container || !Object.hasOwn(container, "setOptions")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the characteristic option update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async updateCharacteristic({ aId, sId, cId, value }) {
    const response = await this.#request(
      {
        characteristic: {
          update: { aId, sId, cId, control: { value } },
        },
      },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.characteristic;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the characteristic update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  // The notification setting of one characteristic, as the web client's
  // Notifications screen writes it; nothing else of the characteristic is
  // sent.
  async updateCharacteristicNotify({ aId, sId, cId, notify }) {
    const response = await this.#request(
      { characteristic: { update: { aId, sId, cId, notify } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.characteristic;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the notification setting.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async getWindow(windowKey) {
    const response = await this.#request(
      { window: { get: { windowKey } } },
      Date.now() + this.timeoutMs,
    );
    const window = response.result?.window?.get;
    if (
      !window ||
      window.windowKey !== windowKey ||
      !Array.isArray(window.options)
    ) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible device-window response.",
      );
    }
    return {
      ...window,
      responseReceivedAt: response.responseReceivedAt,
    };
  }

  async updateWindowOption({ windowKey, key, value }) {
    const response = await this.#request(
      { window: { update: { windowKey, options: [{ key, value }] } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.window;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the device-window update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async listLogicTypes({ aId, sId }) {
    const response = await this.#request(
      { logic: { types: { aId, sId } } },
      Date.now() + this.timeoutMs,
    );
    return extractNativeList(response, ["logic", "types", "logicTypes"]);
  }

  async listLogics({ aId, sId }) {
    const response = await this.#request(
      { logic: { list: { aId, sId } } },
      Date.now() + this.timeoutMs,
    );
    return extractNativeList(response, ["logic", "list", "logics"]);
  }

  async getLogic({ aId, sId, type }) {
    const deadline = Date.now() + this.timeoutMs;
    let response;
    try {
      response = await this.#request(
        { logic: { get: { aId, sId, type } } },
        deadline,
      );
    } catch (error) {
      if (!isNativeNotFoundCandidate(error)) throw error;
      const logics = extractNativeList(
        await this.#request({ logic: { list: { aId, sId } } }, deadline),
        ["logic", "list", "logics"],
      );
      if (logics.some((logic) => logic?.type === type)) throw error;
      return null;
    }
    const container = response.result?.logic;
    if (!container || !Object.hasOwn(container, "get")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible logic response.",
      );
    }
    if (container.get === null) return null;
    if (container.get.type !== type) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a different logic assignment than requested.",
      );
    }
    return container.get;
  }

  async getLogicOptions({ aId, sId, type }) {
    const response = await this.#request(
      { logic: { getOptions: { aId, sId, type } } },
      Date.now() + this.timeoutMs,
    );
    return extractNativeList(response, ["logic", "getOptions", "options"]);
  }

  async createLogic({ aId, sId, type }) {
    const response = await this.#request(
      { logic: { create: { aId, sId, type } } },
      Date.now() + this.timeoutMs,
    );
    const logic = response.result?.logic?.create;
    if (!logic || logic.type !== type) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not identify the created logic assignment.",
        "get_native_change",
        { requestSent: true },
      );
    }
    return logic;
  }

  async updateLogicActive({ aId, sId, type, active }) {
    const response = await this.#request(
      { logic: { update: { aId, sId, type, active } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.logic;
    if (!container || !Object.hasOwn(container, "update")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the logic update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async setLogicOption({ aId, sId, type, key, value }) {
    const response = await this.#request(
      { logic: { setOptions: { aId, sId, type, options: [{ key, value }] } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.logic;
    if (!container || !Object.hasOwn(container, "setOptions")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not acknowledge the logic option update.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async deleteLogic({ aId, sId, type }) {
    const response = await this.#request(
      { logic: { delete: { aId, sId, type } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.logic;
    if (!container || !Object.hasOwn(container, "delete")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not confirm logic deletion.",
        "get_native_change",
        { requestSent: true },
      );
    }
  }

  async findLogicAssignments(type) {
    const accessories = await this.listAccessories();
    const assignments = [];
    for (const accessory of accessories) {
      const services = accessory.services ?? [];
      if (!Array.isArray(services)) {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub did not return services needed to check LOGIC assignments.",
        );
      }
      for (const service of services) {
        if (!Number.isInteger(service?.sId)) {
          throw new SprutHubError(
            "incompatible_response",
            "SprutHub returned a service without its native ID.",
          );
        }
        const logics = await this.listLogics({
          aId: accessory.id,
          sId: service.sId,
        });
        for (const logic of logics) {
          if (logic?.type === type) {
            assignments.push({
              aId: accessory.id,
              sId: service.sId,
              type,
              active: logic.active === true,
            });
          }
        }
      }
    }
    return assignments;
  }

  async deleteScenario(index) {
    const response = await this.#request(
      { scenario: { delete: { index } } },
      Date.now() + this.timeoutMs,
    );
    const container = response.result?.scenario;
    if (!container || !("delete" in container)) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub did not confirm scenario deletion.",
        "inspect_hub",
        { requestSent: true },
      );
    }
  }

  async #listHomes(deadline) {
    const response = await this.#request({ hub: { list: {} } }, deadline, {
      serial: null,
    });
    const homes = extractNativeList(
      response,
      ["hub", "list", "hubs"],
      () =>
        new SprutHubError(
          "incompatible_response",
          "SprutHub returned an incompatible home list.",
        ),
    );
    homes.forEach(validateHome);
    return { homes, observedAt: response.responseReceivedAt };
  }

  async #requireHome(serial, deadline) {
    const { homes, observedAt } = await this.#listHomes(deadline);
    const home = homes.find((candidate) => candidate.serial === serial);
    if (!home) {
      throw new SprutHubError(
        "home_not_found",
        "The selected SprutHub home is not available to this account.",
        "home_overview",
      );
    }
    return { home, observedAt };
  }

  async #readEntity(parsed, requested, deadline) {
    let entity;
    let ownerContext = {};
    if (parsed.kind === "home") {
      entity = { kind: "home", ref: homeRef(parsed.serial) };
      if (requested.has("sdk")) {
        try {
          Object.assign(
            entity,
            await this.#readScenarioSdk(parsed.serial, deadline),
          );
        } catch (error) {
          if (!(error instanceof SprutHubError)) throw error;
          markIncludeUnread(entity, "sdk", error);
        }
      }
    } else if (parsed.kind === "room") {
      entity = await this.#readRoomEntity(parsed, deadline);
    } else if (
      ["accessory", "service", "characteristic", "logic"].includes(parsed.kind)
    ) {
      ({ entity, ownerContext } = await this.#readAccessoryEntity(
        parsed,
        requested,
        deadline,
      ));
    } else if (parsed.kind === "scenario") {
      entity = await this.#readScenarioEntity(parsed, requested, deadline);
    } else if (parsed.kind === "extension") {
      entity = await this.#readExtensionEntity(parsed, requested, deadline);
    } else if (parsed.kind === "extension_child") {
      entity = await this.#readExtensionChildEntity(parsed, deadline);
    } else if (parsed.kind === "window") {
      entity = await this.#readWindowEntity(parsed, requested, deadline);
    } else {
      throw invalidEntityRef();
    }
    return addIncludeResolution(entity, requested, ownerContext);
  }

  async #readRoomEntity(parsed, deadline) {
    const [roomResponse, accessoriesResponse] = await Promise.all([
      this.#request({ room: { get: { id: parsed.roomId } } }, deadline, {
        serial: parsed.serial,
      }),
      this.#request(
        {
          accessory: {
            list: {
              roomId: parsed.roomId,
              expand: "services,characteristics",
            },
          },
        },
        deadline,
        { serial: parsed.serial },
      ),
    ]);
    const room = extractEntity(roomResponse, ["room", "get"], "room");
    validateRoom(room, parsed.roomId);
    const accessories = extractNativeList(accessoriesResponse, [
      "accessory",
      "list",
      "accessories",
    ]);
    accessories.forEach(validateAccessory);
    const inRoom = accessories.filter(({ roomId }) => roomId === room.id);
    const serviceCount = inRoom.reduce(
      (count, accessory) => count + (accessory.services ?? []).length,
      0,
    );
    const identity = {
      kind: "room",
      ref: roomRef(parsed.serial, room.id),
      name: room.name,
    };
    if (serviceCount > ROOM_LISTING_SERVICE_LIMIT) {
      return {
        ...identity,
        accessory_count: inRoom.length,
        service_count: serviceCount,
        next: {
          tool: "find_devices",
          arguments: {
            home_ref: homeRef(parsed.serial),
            room_ref: identity.ref,
          },
        },
      };
    }
    return {
      ...identity,
      accessories: inRoom.map((accessory) => ({
        ref: accessoryRef(parsed.serial, accessory.id),
        name: accessory.name,
        available: accessory.online,
        services: (accessory.services ?? []).map((service) => ({
          ref: serviceRef(parsed.serial, accessory.id, service.sId),
          name: service.name,
          type: service.type,
        })),
      })),
    };
  }

  async #readAccessoryEntity(parsed, requested, deadline) {
    const response = await this.#request(
      { accessory: { get: { id: parsed.accessoryId } } },
      deadline,
      { serial: parsed.serial },
    );
    const accessory = extractEntity(
      response,
      ["accessory", "get"],
      "accessory",
    );
    const observedAt = response.responseReceivedAt;
    validateAccessory(accessory);
    const ownerContext = {
      device_window_ref: ownerWindowRef(parsed.serial, accessory.deviceWindow),
      accessory_ref: accessoryRef(parsed.serial, accessory.id),
    };
    if (parsed.kind === "accessory") {
      const entity = normalizeAccessoryDetail(
        parsed.serial,
        accessory,
        observedAt,
      );
      Object.assign(
        entity,
        optionsNext(
          entity.services.flatMap(({ characteristics }) => characteristics),
        ),
      );
      if (requested.has("relations")) {
        entity.relations = await this.#readAccessoryRelations(
          parsed.serial,
          accessory,
          deadline,
        );
      }
      if (requested.has("bridges")) {
        try {
          entity.bridges = await this.#readAccessoryBridges(
            parsed.serial,
            accessory,
            deadline,
          );
        } catch (error) {
          if (!(error instanceof SprutHubError)) throw error;
          markIncludeUnread(entity, "bridges", error);
        }
      }
      if (
        requested.has("physical_configuration") ||
        requested.has("diagnostics")
      ) {
        Object.assign(
          entity,
          await this.#readPhysicalConfiguration(
            parsed.serial,
            accessory,
            requested,
            deadline,
          ),
        );
      }
      return { entity, ownerContext };
    }
    const service = accessory.services?.find(
      ({ sId }) => sId === parsed.serviceId,
    );
    if (!service) throw entityNotFound("service");
    if (parsed.kind === "service") {
      const [logics, logicTypes] = await Promise.all([
        this.#readLogics(parsed.serial, accessory.id, service.sId, deadline),
        this.#readLogicTypes(
          parsed.serial,
          accessory.id,
          service.sId,
          deadline,
        ),
      ]);
      const detail = normalizeServiceDetail(
        parsed.serial,
        accessory,
        service,
        observedAt,
      );
      return {
        entity: {
          ...detail,
          ...optionsNext(detail.characteristics),
          assigned_logics: logics.map((logic) =>
            normalizeLogic(parsed.serial, accessory.id, service.sId, logic),
          ),
          available_logic_types: normalizeLogicTypes(
            parsed.serial,
            accessory.id,
            service.sId,
            logicTypes,
            logics,
          ),
        },
        ownerContext,
      };
    }
    if (parsed.kind === "logic") {
      const logic = await this.getLogic({
        aId: accessory.id,
        sId: service.sId,
        type: parsed.logicType,
      });
      if (!logic) throw entityNotFound("logic");
      const entity = {
        kind: "logic",
        ...normalizeLogic(parsed.serial, accessory.id, service.sId, logic),
        options_window:
          typeof logic.optionsWindow === "string"
            ? redactSensitiveText(logic.optionsWindow)
            : null,
      };
      if (requested.has("options")) {
        entity.options = (
          await this.getLogicOptions({
            aId: accessory.id,
            sId: service.sId,
            type: parsed.logicType,
          })
        ).map((option) =>
          normalizeLogicOption(option, {
            operation: "logic_option",
            targetRef: entity.ref,
          }),
        );
      }
      return {
        entity,
        ownerContext,
      };
    }
    const characteristic = service.characteristics?.find(
      ({ cId }) => cId === parsed.characteristicId,
    );
    if (!characteristic) throw entityNotFound("characteristic");
    const entity = normalizeCharacteristicDetail(
      parsed.serial,
      accessory,
      service,
      characteristic,
      observedAt,
    );
    if (isRedactedNode(entity)) return { entity, ownerContext };
    if (requested.has("options")) {
      const optionsResponse = await this.#request(
        {
          characteristic: {
            getOptions: {
              aId: accessory.id,
              sId: service.sId,
              cId: characteristic.cId,
            },
          },
        },
        deadline,
        { serial: parsed.serial },
      );
      entity.options = extractNativeList(optionsResponse, [
        "characteristic",
        "getOptions",
        "options",
      ]).map((option) =>
        normalizeOption(option, {
          operation: "characteristic_option",
          targetRef: entity.ref,
        }),
      );
    } else if (entity.options_available !== false) {
      entity.options_next = {
        tool: "get_entity",
        arguments: { entity_ref: entity.ref, include: ["options"] },
      };
    }
    if (requested.has("relations")) {
      entity.relations = await this.#readRelations(
        parsed.serial,
        accessory,
        [service],
        characteristic,
        deadline,
      );
    }
    if (
      requested.has("physical_configuration") ||
      requested.has("diagnostics")
    ) {
      Object.assign(
        entity,
        await this.#readPhysicalConfiguration(
          parsed.serial,
          accessory,
          requested,
          deadline,
        ),
      );
    }
    return { entity, ownerContext };
  }

  async #readAccessoryRelations(serial, accessory, deadline) {
    return this.#readRelations(
      serial,
      accessory,
      accessory.services ?? [],
      null,
      deadline,
    );
  }

  // The accessory's export to each bridge (HomeKit, Yandex, Google): a
  // bridge lists one child per accessory it can export, with the accessory
  // id as its id, in main when exported and in notConnected when not; the
  // child's window has a CHECKBOX s:<sId> per exportable service, true when
  // exported. Both read on a bridge that does not run too
  // (2026-10-13-wave4-contracts 3.2, 3.3). A bridge's list is read whole
  // (16-18 KB on the owner's hub): the hub's answer for one child of a
  // bridge that cannot export it was not observed. The window is read only
  // where the accessory is exported: a notConnected child's services were
  // all false.
  async #readAccessoryBridges(serial, accessory, deadline) {
    const { extensions } = await this.nativeExtensions(serial, deadline);
    const childId = String(accessory.id);
    return Promise.all(
      extensions
        .filter(({ bundle_type: bundleType }) => bundleType === "BRIDGE")
        .map(async (extension) => {
          const running = bridgeRunning(extension);
          const entry = {
            ref: extension.ref,
            name: extension.name,
            type: extension.type,
            state: extension.state,
            enabled: extension.enabled,
            running,
            ...(running ? {} : { limitation: BRIDGE_NOT_RUNNING }),
          };
          let children;
          try {
            ({ children } = await this.nativeExtensionChildren(
              serial,
              extension.key,
              deadline,
            ));
          } catch (error) {
            if (!(error instanceof SprutHubError)) throw error;
            return { ...entry, exported: null, error_code: error.code };
          }
          // A list with no children shows nothing about this accessory.
          if (children.length === 0) {
            return {
              ...entry,
              exported: null,
              exportable: null,
              reason: BRIDGE_LISTS_NOTHING,
            };
          }
          const child = children.find(({ id }) => id === childId);
          if (!child) return { ...entry, exported: false, exportable: false };
          const exported = bridgeChildExported(child);
          if (exported !== true) return { ...entry, exported };
          try {
            return {
              ...entry,
              exported,
              services: await this.#readBridgeServices(
                serial,
                accessory,
                child,
                deadline,
              ),
            };
          } catch (error) {
            if (!(error instanceof SprutHubError)) throw error;
            return { ...entry, exported, services_error_code: error.code };
          }
        }),
    );
  }

  // Which of these options of one window set what a bridge exports, and
  // the read of that export; null when none. A bridge's child is an
  // accessory, its id the accessory id, and its window
  // <extensionKey with / for :>/Child/<aId>/ holds that accessory's export,
  // all of its options; the bridge's own window decides with
  // AutoAddNewAccessory whether a new accessory is exported
  // (2026-10-13-wave4-contracts 3.1-3.4). Only a window of that form or
  // that option costs the list of extensions: a device's window, under its
  // controller's /Child/, is keyed by the device's own id.
  async bridgeExportOptions(serial, windowKey, optionKeys, deadline) {
    const child = /^(.+)\/Child\/([1-9]\d{0,15})\/?$/.exec(windowKey);
    const autoAdd = optionKeys.includes(BRIDGE_AUTO_ADD_OPTION);
    if (!child && !autoAdd) return null;
    const { extensions } = await this.nativeExtensions(serial, deadline);
    for (const extension of extensions) {
      if (extension.bundle_type !== "BRIDGE") continue;
      if (child?.[1] === extension.key.replaceAll(":", "/")) {
        return {
          keys: new Set(optionKeys),
          next: {
            tool: "get_entity",
            arguments: {
              entity_ref: accessoryRef(serial, Number(child[2])),
              include: ["bridges"],
            },
          },
        };
      }
      if (
        autoAdd &&
        extension.options_window_ref === windowRef(serial, windowKey)
      ) {
        return {
          keys: new Set([BRIDGE_AUTO_ADD_OPTION]),
          next: {
            tool: "get_entity",
            arguments: { entity_ref: extension.ref, include: ["children"] },
          },
        };
      }
    }
    return null;
  }

  async #readBridgeServices(serial, accessory, child, deadline) {
    if (typeof child.optionsWindow !== "string" || !child.optionsWindow) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a bridge child without its window.",
      );
    }
    const response = await this.#request(
      { window: { get: { windowKey: child.optionsWindow } } },
      deadline,
      { serial },
    );
    const window = extractEntity(response, ["window", "get"], "window");
    if (
      window.windowKey !== child.optionsWindow ||
      !Array.isArray(window.options)
    ) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned incomplete bridge window data.",
      );
    }
    return window.options.flatMap((option) => {
      const match = /^s:(\d+)$/.exec(option?.key ?? "");
      if (!match || option.inputType !== "CHECKBOX") return [];
      const sId = Number(match[1]);
      const service = accessory.services?.find(
        (candidate) => candidate.sId === sId,
      );
      const value = option.value?.boolValue;
      return [
        {
          ref: serviceRef(serial, accessory.id, sId),
          name:
            service?.name ??
            (typeof option.name === "string"
              ? redactSensitiveText(option.name)
              : null),
          // A value the hub did not give is unknown, not false.
          exported: typeof value === "boolean" ? value : null,
        },
      ];
    });
  }

  async #readRelations(serial, accessory, services, characteristic, deadline) {
    const selectedRef = characteristic
      ? characteristicRef(
          serial,
          accessory.id,
          services[0].sId,
          characteristic.cId,
        )
      : null;
    const associationPromise = this.#readRelationSource(
      { scenario: { list: { aId: accessory.id } } },
      deadline,
      serial,
      (response) =>
        uniqueByRef(
          extractNativeList(response, ["scenario", "list", "scenarios"]).map(
            (scenario) => normalizeScenarioSummary(serial, scenario),
          ),
        ),
    );
    const logicPromises = services.map((service) =>
      this.#readRelationSource(
        { logic: { list: { aId: accessory.id, sId: service.sId } } },
        deadline,
        serial,
        (response) =>
          extractNativeList(response, ["logic", "list", "logics"]).map(
            (logic) => normalizeLogic(serial, accessory.id, service.sId, logic),
          ),
      ),
    );
    const linkPromise = characteristic
      ? this.#readRelationSource(
          {
            link: {
              list: {
                aId: accessory.id,
                sId: services[0].sId,
                cId: characteristic.cId,
              },
            },
          },
          deadline,
          serial,
          (response) =>
            extractNativeList(response, ["link", "list", "links"]).map(
              normalizeLink,
            ),
        )
      : null;
    // Awaited after the BLOCK roles; a failure surfaces there, not as an
    // unhandled rejection meanwhile.
    const codePromise = this.#readCodeMentions(serial, accessory, deadline);
    codePromise.catch(() => {});
    const [associationRead, logicReads, linkRead] = await Promise.all([
      associationPromise,
      Promise.all(logicPromises),
      linkPromise,
    ]);

    const checked = {};
    const unchecked = [];
    const associations = associationRead.ok ? associationRead.value : [];
    if (associationRead.ok) {
      checked.scenario_accessory_index =
        associations.length === 0 ? "checked_empty" : "found";
    } else {
      unchecked.push(
        relationFailure("scenario_accessory_index", associationRead),
      );
    }
    // Code scenarios the hub's index lists for this accessory; the ones
    // the source search found a mention in are listed there instead.
    const indexedCode = [];
    for (const association of associations) {
      if (association.type === "BLOCK") continue;
      indexedCode.push({
        area: "scenario_code",
        outcome: "not_analyzed",
        scenario_ref: association.ref,
        scenario_name: association.name,
        scenario_type: association.type,
        next: {
          tool: "get_entity",
          arguments: {
            entity_ref: association.ref,
            include: ["configuration"],
          },
        },
      });
    }

    const blockReads = await Promise.all(
      associations
        .filter(({ type }) => type === "BLOCK")
        .map((summary) => this.#readRelationBlock(serial, summary, deadline)),
    );
    const readBlocks = blockReads.filter(({ data }) => data !== undefined);
    if (associationRead.ok) checked.block_scenarios_read = readBlocks.length;
    unchecked.push(...blockReads.flatMap(({ failure }) => failure ?? []));

    const { roles, others } = await this.#relationRoles(
      serial,
      accessory,
      selectedRef,
      readBlocks,
      unchecked,
      deadline,
    );

    const code = await codePromise;
    if (code.searched !== null) {
      checked.code_scenarios_searched = code.searched;
    }
    const mentioned = new Set(
      code.mentions.map(({ scenario_ref: ref }) => ref),
    );
    unchecked.push(
      ...indexedCode.filter(({ scenario_ref: ref }) => !mentioned.has(ref)),
      ...code.unchecked,
    );

    const assignedLogics = logicReads.flatMap((read) =>
      read.ok ? read.value : [],
    );
    if (logicReads.some(({ ok }) => ok)) {
      checked.logic_assignments =
        assignedLogics.length === 0 ? "checked_empty" : "found";
    }
    logicReads.forEach((read, index) => {
      if (read.ok) return;
      unchecked.push({
        ...relationFailure("logic_assignments", read),
        source_ref: serviceRef(serial, accessory.id, services[index].sId),
      });
    });

    const characteristicLinks = [];
    const systemLinks = [];
    if (!characteristic) {
      unchecked.push({
        area: "characteristic_links",
        outcome: "not_read",
        limitation:
          "Accessory relations do not read every characteristic's links.",
        next: {
          tool: "get_entity",
          candidates: services
            .flatMap(
              (service) =>
                normalizeServiceDetail(serial, accessory, service, null)
                  .characteristics,
            )
            .filter((candidate) => !isRedactedNode(candidate))
            .map(({ ref }) => ({ entity_ref: ref, include: ["relations"] })),
        },
      });
    } else if (linkRead.ok) {
      for (const link of linkRead.value) {
        const { characteristics, ...identity } = link;
        if (link.type === "SYSTEM") {
          systemLinks.push(sanitizeNativeData(identity));
          continue;
        }
        characteristicLinks.push({
          type: link.type,
          index: sanitizeNativeData(link.index),
          related_characteristic_refs: characteristics.map(
            ({ aId, sId, cId }) => characteristicRef(serial, aId, sId, cId),
          ),
        });
      }
      checked.characteristic_links =
        linkRead.value.length === 0 ? "checked_empty" : "found";
    } else {
      unchecked.push({
        ...relationFailure("characteristic_links", linkRead),
        source_ref: selectedRef,
      });
    }

    return {
      scenario_roles: roles,
      other_roles_count: others,
      assigned_logics: assignedLogics,
      code_mentions: code.mentions,
      characteristic_links: characteristicLinks,
      system_links: systemLinks,
      checked,
      unchecked,
      limitation: RELATIONS_LIMITATION,
    };
  }

  // Roles of the selected characteristic (or of any characteristic of the
  // selected accessory) in the read BLOCKs; roles about other entities are
  // only counted.
  async #relationRoles(
    serial,
    accessory,
    selectedRef,
    readBlocks,
    unchecked,
    deadline,
  ) {
    if (readBlocks.length === 0) return { roles: [], others: 0 };
    const accessoryIds = new Set(
      readBlocks.flatMap(({ data }) => [...blockBindings(data).accessoryIds]),
    );
    const context = await this.#blockNameContext(
      serial,
      { accessoryIds, scenarioIndexes: new Set() },
      deadline,
      { rooms: false },
    );
    if (!context.namesResolved) {
      unchecked.push({ area: "names", outcome: "failed" });
      // The selected accessory was already read; its own values still decode.
      context.accessories = new Map([[accessory.id, accessory]]);
    }
    // The selected accessory was read just now, so its own conditions carry
    // current values without another read.
    context.values = new Map([[accessory.id, { accessory }]]);
    const matches = selectedRef
      ? (record) => record.ref === selectedRef
      : (record) => record.accessoryId === accessory.id;
    const roles = [];
    let others = 0;
    for (const { summary, data } of readBlocks) {
      const decoded = decodeBlock(data, context);
      for (const record of decoded.records) {
        if (!matches(record)) {
          others += 1;
          continue;
        }
        roles.push({
          scenario_ref: summary.ref,
          scenario_name: summary.name,
          active: summary.active,
          ...(selectedRef
            ? {}
            : {
                entity_ref: record.ref,
                characteristic: record.characteristic,
              }),
          ...relationRole(record),
        });
      }
      for (const pointer of decoded.codeConditions) {
        unchecked.push({
          area: "block_code_condition",
          outcome: "not_analyzed",
          scenario_ref: summary.ref,
          pointer,
        });
      }
      for (const entry of decoded.unrecognized) {
        unchecked.push({
          area: "block_node",
          outcome: "unrecognized",
          scenario_ref: summary.ref,
          ...entry,
        });
      }
    }
    return { roles, others };
  }

  async #readRelationBlock(serial, summary, deadline) {
    const read = await this.#readRelationSource(
      {
        scenario: {
          get: {
            index: parseEntityRef(summary.ref).scenarioIndex,
            expand: "data",
          },
        },
      },
      deadline,
      serial,
      (response) => {
        const scenario = extractEntity(
          response,
          ["scenario", "get"],
          "scenario",
        );
        const normalized = normalizeScenarioSummary(serial, scenario);
        if (scenario.type !== "BLOCK" || typeof scenario.data !== "string") {
          throw new SprutHubError(
            "incompatible_response",
            "SprutHub returned an incomplete BLOCK scenario configuration.",
          );
        }
        return { scenario, normalized };
      },
    );
    if (!read.ok) {
      return {
        summary,
        failure: {
          ...relationFailure("block_configuration", read),
          scenario_ref: summary.ref,
        },
      };
    }
    try {
      return {
        summary: read.value.normalized,
        data: sanitizeNativeData(JSON.parse(read.value.scenario.data)),
      };
    } catch {
      return {
        summary,
        failure: {
          area: "block_configuration",
          outcome: "invalid_json",
          scenario_ref: summary.ref,
        },
      };
    }
  }

  // The owner's code scenarios (built-in ones are assigned to services and
  // listed as assigned logic) whose source names this accessory, each
  // source read once in this call, at most CODE_SOURCE_READS of them.
  // searched is null when the scenario list could not be read.
  async #readCodeMentions(serial, accessory, deadline) {
    const catalogRead = await this.#readRelationSource(
      { scenario: { list: {} } },
      deadline,
      serial,
      (response) =>
        extractScenarioCatalog(response).flatMap((scenario) =>
          scenario.type === "BLOCK" || scenario.predefined === true
            ? []
            : [
                {
                  index: scenario.index,
                  ...normalizeScenarioSummary(serial, scenario),
                },
              ],
        ),
    );
    if (!catalogRead.ok) {
      return {
        mentions: [],
        searched: null,
        unchecked: [relationFailure("scenario_code", catalogRead)],
      };
    }
    const code = catalogRead.value;
    const searched = code.slice(0, CODE_SOURCE_READS);
    const reads = await Promise.all(
      searched.map(({ index }) =>
        this.#readRelationSource(
          { scenario: { get: { index, expand: "data" } } },
          deadline,
          serial,
          (response) => {
            const { data } = extractEntity(
              response,
              ["scenario", "get"],
              "scenario",
            );
            if (typeof data !== "string") {
              throw new SprutHubError(
                "incompatible_response",
                "SprutHub returned a code scenario without its source.",
              );
            }
            return data;
          },
        ),
      ),
    );
    const mentions = [];
    const unchecked = [];
    reads.forEach((read, position) => {
      const scenario = searched[position];
      if (!read.ok) {
        unchecked.push({
          ...relationFailure("scenario_code", read),
          scenario_ref: scenario.ref,
        });
        return;
      }
      const found = accessoryMentions(read.value, accessory);
      if (!found) return;
      mentions.push({
        scenario_ref: scenario.ref,
        scenario_name: scenario.name,
        scenario_type: scenario.type,
        active: scenario.active,
        ...found,
        next: {
          tool: "get_entity",
          arguments: { entity_ref: scenario.ref, include: ["configuration"] },
        },
      });
    });
    // The rest are counted, not listed, so the answer does not grow with
    // the home. home_overview lists every scenario of their types, the
    // searched and built-in LOGIC too, so it does not show which were not
    // searched: accepted while the owner's hub has far fewer than the limit.
    const rest = code.slice(searched.length);
    if (rest.length > 0) {
      unchecked.push({
        area: "scenario_code",
        outcome: "not_read",
        limit: CODE_SOURCE_READS,
        scenarios_not_read: rest.length,
        next: {
          tool: "home_overview",
          candidates: [...new Set(rest.map(({ type }) => type))].map(
            (type) => ({ home_ref: homeRef(serial), list: "scenarios", type }),
          ),
        },
      });
    }
    return {
      mentions,
      searched: reads.filter(({ ok }) => ok).length,
      unchecked,
    };
  }

  async #readRelationSource(params, deadline, serial, extract) {
    let observedAt = null;
    try {
      const response = await this.#request(params, deadline, { serial });
      observedAt = response.responseReceivedAt;
      return { ok: true, value: extract(response), observedAt };
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      return {
        ok: false,
        outcome: relationFailureOutcome(error),
        errorCode: error.code,
        observedAt,
      };
    }
  }

  async #readLogics(serial, accessoryId, serviceId, deadline) {
    const response = await this.#request(
      { logic: { list: { aId: accessoryId, sId: serviceId } } },
      deadline,
      { serial },
    );
    return extractNativeList(response, ["logic", "list", "logics"]);
  }

  async #readLogicTypes(serial, accessoryId, serviceId, deadline) {
    const response = await this.#request(
      { logic: { types: { aId: accessoryId, sId: serviceId } } },
      deadline,
      { serial },
    );
    return extractNativeList(response, ["logic", "types", "logicTypes"]);
  }

  async #readPhysicalConfiguration(serial, accessory, requested, deadline) {
    if (ownerWindowRef(serial, accessory.deviceWindow) == null) {
      return { physical_configuration: null };
    }
    const response = await this.#request(
      { window: { get: { windowKey: accessory.deviceWindow } } },
      deadline,
      { serial },
    );
    const window = extractEntity(response, ["window", "get"], "window");
    return normalizeWindow(
      serial,
      window,
      requested.has("diagnostics"),
      response.responseReceivedAt,
    );
  }

  async #readScenarioEntity(parsed, requested, deadline) {
    // The summary needs the stored data even when configuration is not
    // requested; the raw data reaches the agent only through that include.
    const scenario = await this.#getScenarioRecord(
      parsed.scenarioIndex,
      deadline,
      { serial: parsed.serial, expand: "data" },
    );
    if (!scenario) {
      throw entityNotFound("scenario", {
        next: {
          tool: "home_overview",
          arguments: { home_ref: homeRef(parsed.serial), list: "scenarios" },
        },
      });
    }
    const entity = normalizeScenarioSummary(parsed.serial, scenario);
    entity.description =
      typeof scenario.desc === "string" ? scenario.desc : null;
    // Runtime execution error is not editable configuration and must not be
    // folded into configuration.value or treated as a failed save.
    entity.execution_error = scenario.error === true;
    entity.summary = await this.#scenarioSummary(
      parsed.serial,
      scenario,
      deadline,
    );
    if (requested.has("configuration")) {
      entity.configuration = normalizeScenarioConfiguration(scenario);
    }
    if (
      ["BLOCK", "LOGIC", "GLOBAL"].includes(scenario.type) &&
      typeof scenario.optionsWindow === "string" &&
      scenario.optionsWindow.length > 0
    ) {
      try {
        const windowResponse = await this.#request(
          { window: { get: { windowKey: scenario.optionsWindow } } },
          deadline,
          { serial: parsed.serial },
        );
        const window = extractEntity(
          windowResponse,
          ["window", "get"],
          "window",
        );
        if (
          window?.windowKey === scenario.optionsWindow &&
          Array.isArray(window.options)
        ) {
          entity.metadata_options = window.options
            .filter((option) =>
              Object.hasOwn(SCENARIO_METADATA_FIELDS, option?.key),
            )
            .map((option) => scenarioMetadataOption(scenario, option, entity));
        }
      } catch (error) {
        if (!(error instanceof SprutHubError)) throw error;
      }
    }
    return { kind: "scenario", ...entity };
  }

  async #scenarioSummary(serial, scenario, deadline) {
    if (scenario.type !== "BLOCK") return codeScenarioSummary(scenario);
    if (typeof scenario.data !== "string") {
      return { format: "block", status: "data_not_returned" };
    }
    let data;
    try {
      data = sanitizeNativeData(withShownHttpUrls(JSON.parse(scenario.data)));
    } catch {
      return { format: "block", status: "invalid_json" };
    }
    const bindings = blockBindings(data);
    // What each condition holds now: its device's value read at this
    // moment, never the catalog's, and for an interval the hub's clock.
    const conditionIds = [...bindings.conditionAccessoryIds].filter(
      (id) => id >= 0,
    );
    const valueIds = new Set(conditionIds.slice(0, CONDITION_VALUE_READS));
    const [context, timeZone] = await Promise.all([
      this.#blockNameContext(serial, bindings, deadline, { valueIds }),
      bindings.hasInterval ? this.#hubTimeZone(serial, deadline) : null,
    ]);
    const now = Date.now();
    if (bindings.hasInterval) context.clock = hubClock(now, timeZone);
    const summary = blockSummary(decodeBlock(data, context), context);
    if (conditionIds.length === 0 && !bindings.hasInterval) return summary;
    const notRead = conditionIds.length - valueIds.size;
    // Devices that gave a value; a failed or not found read says so on
    // its conditions.
    const read = [...(context.values?.values() ?? [])].filter(
      ({ accessory }) => accessory,
    );
    summary.current_values = {
      observed_at: context.valuesObservedAt ?? null,
      devices_read: read.length,
      ...(notRead > 0
        ? { devices_not_read: notRead, read_limit: CONDITION_VALUE_READS }
        : {}),
      ...(bindings.hasInterval
        ? { hub_time: timeZone === null ? null : zonedTimestamp(now, timeZone) }
        : {}),
    };
    return summary;
  }

  // Names for a decoded BLOCK. Accessories and rooms come from the home
  // catalog of this session; an accessory it lacks, or every one without a
  // catalog, is read by accessory.get (the hub has no read by a list of
  // ids). The scenario catalog is read only when the BLOCK runs another
  // scenario. A failed read leaves refs unnamed instead of failing the
  // entity read. The accessories in valueIds are read by accessory.get
  // whatever the catalog holds, for their current values (context.values).
  async #blockNameContext(
    serial,
    { accessoryIds, scenarioIndexes },
    deadline,
    { rooms: readRooms = true, valueIds = new Set() } = {},
  ) {
    const needAccessories = accessoryIds.size > 0;
    const needScenarios = scenarioIndexes.size > 0;
    const nameIds = new Set(
      [...accessoryIds].filter((id) => !valueIds.has(id)),
    );
    const catalog = needAccessories ? this.cachedHomeCatalog(serial) : null;
    const [accessoriesRead, valueReads, roomsRead, scenariosRead] =
      await Promise.all([
        needAccessories
          ? nameIds.size > 0
            ? this.#referencedAccessories(serial, nameIds, catalog, deadline)
            : { ok: true, value: [] }
          : null,
        Promise.all(
          [...valueIds].map((id) =>
            this.#readConditionAccessory(serial, id, deadline),
          ),
        ),
        needAccessories && readRooms && !catalog
          ? this.#readRelationSource(
              { room: { list: {} } },
              deadline,
              serial,
              (response) =>
                extractNativeList(response, ["room", "list", "rooms"]),
            )
          : null,
        needScenarios
          ? this.#readRelationSource(
              { scenario: { list: {} } },
              deadline,
              serial,
              extractScenarioCatalog,
            )
          : null,
      ]);
    const values = new Map(
      valueReads.map(({ id, accessory, status }) => [
        id,
        accessory ? { accessory } : { status },
      ]),
    );
    // A device whose value read failed keeps the catalog's name.
    const accessories = accessoriesRead?.ok
      ? new Map([
          ...accessoriesRead.value.map((accessory) => [
            accessory.id,
            accessory,
          ]),
          ...valueReads.flatMap(({ id, accessory, status }) => {
            const named =
              accessory ??
              (status === "read_failed" ? catalog?.byId.get(id) : undefined);
            return named ? [[id, named]] : [];
          }),
        ])
      : null;
    const observedAt = valueReads.flatMap(({ observedAt: at }) => at ?? []);
    const roomList = catalog
      ? catalog.rooms
      : roomsRead?.ok
        ? roomsRead.value
        : null;
    const rooms =
      needAccessories && readRooms && roomList
        ? new Map(
            roomList
              .filter((room) => typeof room?.name === "string")
              .map((room) => [room.id, room.name]),
          )
        : null;
    const scenarios = scenariosRead?.ok
      ? new Map(
          scenariosRead.value
            .filter((item) => scenarioIndexes.has(item?.index))
            .map((item) => [item.index, item]),
        )
      : null;
    return {
      homeRef: homeRef(serial),
      accessories,
      rooms,
      scenarios,
      ...(valueIds.size > 0
        ? {
            values,
            valuesObservedAt:
              observedAt.length > 0 ? latestObservedAt(observedAt) : null,
          }
        : {}),
      isSensitiveControl: (control) => isSensitiveNativeNode(control),
      namesResolved:
        (!needAccessories || accessoriesRead.ok) &&
        (!needScenarios || scenariosRead.ok),
    };
  }

  // One condition device read now for its value. A failed read marks its
  // conditions (read_failed) instead of failing the entity read.
  async #readConditionAccessory(serial, id, deadline) {
    try {
      const { accessory, observedAt } = await this.nativeAccessory(
        serial,
        id,
        deadline,
      );
      return accessory
        ? { id, accessory, observedAt }
        : { id, status: "not_found", observedAt };
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      return { id, status: "read_failed" };
    }
  }

  async #referencedAccessories(serial, accessoryIds, catalog, deadline) {
    const ids = [...accessoryIds];
    const known = catalog
      ? ids.flatMap((id) => catalog.byId.get(id) ?? [])
      : [];
    const missing = ids.filter((id) => !catalog?.byId.has(id));
    try {
      if (missing.length > REFERENCED_ACCESSORY_READS) {
        const { catalog: read } = await this.homeCatalog(serial, deadline, {
          refresh: true,
        });
        return {
          ok: true,
          value: ids.flatMap((id) => read.byId.get(id) ?? []),
        };
      }
      const reads = await Promise.all(
        missing.map((id) => this.nativeAccessory(serial, id, deadline)),
      );
      return {
        ok: true,
        value: [...known, ...reads.flatMap(({ accessory }) => accessory ?? [])],
      };
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      return {
        ok: false,
        outcome: relationFailureOutcome(error),
        errorCode: error.code,
      };
    }
  }

  async #readExtensionEntity(parsed, requested, deadline) {
    const { extension } = await this.nativeExtension(
      parsed.serial,
      parsed.extensionKey,
      deadline,
    );
    const timeZone = hasRunningAction(extension)
      ? await this.#hubTimeZone(parsed.serial, deadline)
      : null;
    const entity = {
      kind: "extension",
      ...normalizeExtensionDetail(parsed.serial, extension, timeZone),
    };
    // A running extension's spaces show how many devices each holds, from
    // one read of its children; an unread list leaves the counts out.
    const countSpaces =
      entity.spaces?.length > 0 &&
      extension.state === "LOADED" &&
      extension.enabled === true;
    let children;
    let childrenError;
    if (countSpaces || requested.has("children")) {
      try {
        children = await this.#readExtensionChildren(
          parsed.serial,
          parsed.extensionKey,
          deadline,
        );
      } catch (error) {
        if (!(error instanceof SprutHubError)) throw error;
        childrenError = error;
      }
    }
    if (children && entity.spaces) {
      for (const space of entity.spaces) {
        space.child_count = children.filter(
          ({ space_key: key }) => key === space.key,
        ).length;
      }
    }
    const bridge = extension.bundleType === "BRIDGE";
    if (children && bridge) {
      entity.exported_count = children.filter(
        ({ space_key: key }) => key === BRIDGE_EXPORTED_SPACE,
      ).length;
      if (!bridgeRunning(entity)) entity.limitation = BRIDGE_NOT_RUNNING;
    }
    if (requested.has("children")) {
      if (children && bridge) {
        Object.assign(
          entity,
          await this.#bridgeChildren(parsed.serial, children, deadline),
        );
      } else if (children) {
        entity.children = children;
      } else {
        // Optional children must not discard a successful extension.get.
        markIncludeUnread(entity, "children", childrenError);
      }
    }
    return entity;
  }

  // A bridge's children are the home's accessories: the exported ones
  // first, each with its accessory ref and room from the home catalog. A
  // catalog that cannot be read leaves the rooms out and says why.
  async #bridgeChildren(serial, children, deadline) {
    let catalog = null;
    let catalogError = null;
    try {
      ({ catalog } = await this.homeCatalog(serial, deadline));
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      catalogError = error;
    }
    const rooms = new Map(
      (catalog?.rooms ?? []).map(({ id, name }) => [id, name]),
    );
    const listed = children.map((child) => {
      const id = /^[1-9]\d{0,15}$/.test(child.id) ? Number(child.id) : null;
      if (id === null) return child;
      const accessory = catalog?.byId.get(id);
      return {
        ...child,
        accessory_ref: accessoryRef(serial, id),
        ...(catalog
          ? { room: accessory ? (rooms.get(accessory.roomId) ?? null) : null }
          : {}),
      };
    });
    const exported = ({ space_key: key }) => key === BRIDGE_EXPORTED_SPACE;
    return {
      ...(catalogError ? { rooms_error_code: catalogError.code } : {}),
      children: [
        ...listed.filter(exported),
        ...listed.filter((child) => !exported(child)),
      ],
    };
  }

  async #readExtensionChildren(serial, selectedExtensionKey, deadline) {
    const { children } = await this.nativeExtensionChildren(
      serial,
      selectedExtensionKey,
      deadline,
    );
    return normalizeExtensionChildren(serial, children, selectedExtensionKey);
  }

  async #readExtensionChildEntity(parsed, deadline) {
    const response = await this.#request(
      {
        extensionChild: {
          get: { extensionKey: parsed.extensionKey, id: parsed.childId },
        },
      },
      deadline,
      { serial: parsed.serial },
    );
    const child = extractEntity(
      response,
      ["extensionChild", "get"],
      "extension child",
    );
    if (
      extensionKey(child) !== parsed.extensionKey ||
      child?.id !== parsed.childId
    ) {
      throw incompatibleExtensionChildIdentity();
    }
    return {
      kind: "extension_child",
      ...normalizeExtensionChildDetail(
        parsed.serial,
        child,
        parsed.extensionKey,
      ),
    };
  }

  async #readWindowEntity(parsed, requested, deadline) {
    const response = await this.#request(
      { window: { get: { windowKey: parsed.windowKey } } },
      deadline,
      { serial: parsed.serial },
    );
    const window = extractEntity(response, ["window", "get"], "window");
    if (window.windowKey !== parsed.windowKey) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned incomplete device-window data.",
      );
    }
    const normalized = normalizeWindow(
      parsed.serial,
      window,
      requested.has("diagnostics"),
      response.responseReceivedAt,
    );
    await this.#offerScenarioActive(parsed, normalized, deadline);
    await this.#withholdBridgeExportWrites(parsed, normalized, deadline);
    return {
      kind: "window",
      ...normalized.physical_configuration,
      ...(normalized.diagnostics
        ? { diagnostics: normalized.diagnostics }
        : { diagnostics_available: normalized.diagnostics_available }),
    };
  }

  // A bridge's export is read but not offered for writing, as window_option
  // refuses it. When the extensions cannot be read the offer stays: the
  // contract reads them again and refuses without them.
  async #withholdBridgeExportWrites(parsed, normalized, deadline) {
    const writable = normalized.physical_configuration.options.filter(
      (option) => option.native_change?.supported === true,
    );
    if (writable.length === 0) return;
    let bridgeExport;
    try {
      bridgeExport = await this.bridgeExportOptions(
        parsed.serial,
        parsed.windowKey,
        writable.map(({ key }) => key),
        deadline,
      );
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      return;
    }
    for (const option of writable) {
      if (!bridgeExport?.keys.has(option.key)) continue;
      option.native_change = {
        native_write: option.native_change.native_write,
        supported: false,
        reason: BRIDGE_EXPORT_UNVERIFIED,
      };
    }
  }

  // Active in a scenario's options window is that scenario's on/off flag;
  // window_option refuses it, and scenario_active also checks scenario.get.
  async #offerScenarioActive(parsed, normalized, deadline) {
    const option = normalized.physical_configuration.options.find(
      ({ key, redacted }) => key === "Active" && redacted !== true,
    );
    if (!option) return;
    const owners = extractScenarioCatalog(
      await this.#request({ scenario: { list: {} } }, deadline, {
        serial: parsed.serial,
      }),
    ).filter(({ optionsWindow }) => optionsWindow === parsed.windowKey);
    if (owners.length === 0) return;
    option.native_change = {
      native_write: option.native_change.native_write,
      supported: false,
      reason: "scenario_owner_required",
      ...(owners.length === 1
        ? {
            next: {
              tool: "get_native_change_contract",
              arguments: {
                operation: "scenario_active",
                target_ref: scenarioRef(parsed.serial, owners[0].index),
              },
            },
          }
        : {}),
    };
  }

  async close() {
    const startingObservationClient = this.#startingObservationClient;
    await startingObservationClient?.close();
    if (
      this.#observationClient &&
      this.#observationClient !== startingObservationClient
    ) {
      await this.#observationClient.close();
    }
    if (this.#observation?.status === "starting") {
      await this.#stopNativeObservation(
        this.#observation.ref,
        "server_shutdown",
      );
    } else if (this.#observation?.status === "finishing") {
      await new Promise((resolve) => this.#observation.waiters.add(resolve));
    } else if (
      this.#observation &&
      !isTerminalObservation(this.#observation.status)
    ) {
      await this.#finishObservation(
        this.#observation,
        "canceled",
        "server_shutdown",
      );
    }
    this.#connectingSocket?.terminate();
    if (!this.#socket) return;
    await new Promise((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.close();
    });
  }

  // A write of a device value waits for its event in the warm home state;
  // another write that may change what the state holds has the home read
  // again after it, and no read in flight across it is taken. A failed
  // value write leaves the value to what comes next: a refusal or a write
  // never sent changed nothing, and a write without a reply had its
  // connection retired or lost, which has the whole home read again.
  async #request(params, deadline, { serial = this.serial } = {}) {
    const method = nativeMethod(params);
    if (READ_ONLY_METHODS.has(method)) {
      return this.#send(params, deadline, serial);
    }
    const target = valueWriteTarget(params);
    const homeWrite =
      target === null &&
      !HOME_STATE_NEUTRAL_WRITES.has(method) &&
      !isNotifyWrite(params);
    const states =
      serial === null
        ? [...this.#homeStates.values()]
        : [this.#homeStates.get(serial)].filter(Boolean);
    this.#writeGeneration += 1;
    const writes = target
      ? states.map((state) => [
          state,
          state.writeSent(target, params.characteristic.update.control.value),
        ])
      : [];
    // The reply is counted as its frame is handled: the write's event may
    // come in the next frame of the same read from the socket, before this
    // call resumes.
    const onReply = target
      ? () => {
          for (const [state, write] of writes) state.writeAnswered(write);
        }
      : undefined;
    try {
      return await this.#send(params, deadline, serial, onReply);
    } catch (error) {
      for (const [state, write] of writes) state.writeFailed(write);
      throw error;
    } finally {
      this.#writeGeneration += 1;
      if (homeWrite) for (const state of states) state.invalidate("own_write");
    }
  }

  // A session the hub refuses is renewed by one login, and the request goes
  // again once: the hub refused it before carrying it out. The requests the
  // old session lost share that login; a failed login is the answer.
  async #send(params, deadline, serial, onReply) {
    const token = this.token;
    try {
      return await this.#sendOnce(params, deadline, serial, onReply);
    } catch (error) {
      if (!this.#renewSession || error.code !== "authentication_failed") {
        throw error;
      }
      if (this.token === token) {
        const renewed = await this.#renewSession(token);
        if (this.token === token) {
          this.token = renewed.token;
          this.cid = renewed.cid;
          // The new session goes over a new connection, as after a login
          // at start.
          if (this.#socket) this.#retire(this.#socket);
        }
      }
      return this.#sendOnce(params, deadline, serial, onReply);
    }
  }

  async #sendOnce(params, deadline, serial, onReply) {
    const socket = await this.#connect(deadline);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    this.#noteSerial(socket, serial);
    const id = this.#nextRequestId++;
    const response = new Promise((resolve, reject) => {
      // Only this request runs out of time: the others on the connection
      // keep theirs, and a reply that comes later finds no request under its
      // id and is dropped.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(timeoutError());
        this.#retire(socket);
      }, remainingMs);
      this.#pending.set(id, { resolve, reject, timer, socket, onReply });
    });

    socket.send(
      JSON.stringify({
        id,
        token: this.token,
        ...(serial === null ? {} : { serial }),
        cid: this.cid,
        params,
      }),
    );

    try {
      return await response;
    } catch (error) {
      if (error instanceof SprutHubError) error.requestSent = true;
      throw error;
    }
  }

  // Calls that need a connection while one is opening share the attempt.
  // It has the request timeout of its own: a call whose time runs out
  // first stops waiting without giving the attempt up for the others.
  async #connect(deadline) {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    if (deadline - Date.now() <= 0) throw timeoutError();
    this.#connectPromise ??= this.#openConnection();
    let timer;
    try {
      return await Promise.race([
        this.#connectPromise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(timeoutError()),
            deadline - Date.now(),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #openConnection() {
    const connection = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, "json-rpc");
      this.#connectingSocket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(timeoutError());
        socket.terminate();
      }, this.timeoutMs);
      const failBeforeOpen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new SprutHubError(
            "connection_failed",
            "Could not connect to SprutHub.",
            "retry",
            { capability_status: "unknown" },
          ),
        );
      };

      socket.once("error", failBeforeOpen);
      socket.once("open", () => {
        if (settled) {
          socket.terminate();
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off("error", failBeforeOpen);
        this.#connectingSocket = undefined;
        this.#socket = socket;
        this.#connections.set(socket, {
          serials: new Set(),
          lastEventAt: null,
        });
        socket.on("error", () => {
          this.#handleConnectionLoss(socket);
          socket.terminate();
        });
        resolve(socket);
      });
      socket.on("message", (data) => this.#handleMessage(data, socket));
      socket.on("close", () => {
        if (!settled) failBeforeOpen();
        this.#handleConnectionLoss(socket);
      });
    });
    const forget = () => {
      if (this.#connectPromise === connection) {
        this.#connectPromise = undefined;
        this.#connectingSocket = undefined;
      }
    };
    connection.then(forget, forget);
    return connection;
  }

  #handleMessage(data, socket) {
    let message;
    try {
      message = parseSprutHubMessage(data);
    } catch (error) {
      if (
        this.#socket === socket &&
        this.#observation?.status === "observing"
      ) {
        this.#observation.connection = {
          status: "unknown",
          error_code: "invalid_message",
        };
        void this.#finishObservation(
          this.#observation,
          "truncated",
          "invalid_message",
          false,
        );
        socket.terminate();
      }
      // Nor to an event: the warm home may have missed one.
      this.#connectionGone(socket, "invalid_frame");
      // The frame cannot be matched to a request, so each one on this
      // connection may have lost its reply.
      for (const [id, pending] of this.#pending) {
        if (pending.socket !== socket) continue;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#closeIfRetired(socket);
      return;
    }

    const record = this.#connections.get(socket);
    this.#handleNativeEvent(message, socket);
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    this.#closeIfRetired(pending.socket);

    if (message.error) {
      let error;
      // The owner's hub refused an expired session with -666003 "Incorrect
      // token" (2026-10-23).
      if (message.error.code === 401 || message.error.code === -666003) {
        error = new SprutHubError(
          "authentication_failed",
          "SprutHub rejected the configured credentials.",
          "check_credentials",
          { capability_status: "insufficient_access" },
        );
      } else if (message.error.code === -32601) {
        error = new SprutHubError(
          "unsupported",
          "SprutHub does not support this operation on the selected home.",
          "home_overview",
          { capability_status: "unsupported" },
        );
      } else {
        error = new SprutHubError(
          "request_rejected",
          "SprutHub rejected the request.",
          undefined,
          { protocolErrorCode: message.error.code },
        );
      }
      // An error reply to this request id is the hub's own answer: it received
      // the request and refused it. Keep its code and bounded text as data.
      error.hubError = hubErrorReply(message.error, this.token);
      pending.reject(error);
      return;
    }
    message.responseReceivedAt = new Date().toISOString();
    if (record) this.#replyConnections.set(message, record);
    pending.onReply?.();
    pending.resolve(message);
  }

  // A request with a home's serial has the hub push that home's events to
  // the connection (2026-10-13-voice-latency-baseline, section 5).
  #noteSerial(socket, serial) {
    const record = this.#connections.get(socket);
    if (!record || serial === null) return;
    record.serials.add(serial);
  }

  // The events of a connection are applied to the home it carries. Events
  // do not name their home: an event over a connection that carried two
  // homes' serials is applied to neither, and both are read again.
  #routeHomeEvent(event, socket) {
    const record = this.#connections.get(socket);
    if (!record) return;
    // Only a pushed event shows that the hub still pushes them here.
    record.lastEventAt = Date.now();
    const receivedAt = new Date().toISOString();
    for (const serial of record.serials) {
      const state = this.#homeStates.get(serial);
      if (!state) continue;
      if (record.serials.size > 1) state.invalidate("mixed_homes");
      else state.receive(event, record, receivedAt);
    }
  }

  // A connection retired, lost or carrying an unreadable frame: a home
  // state that follows its events may have missed some.
  #connectionGone(socket, reason) {
    const record = this.#connections.get(socket);
    if (!record) return;
    for (const state of this.#homeStates.values()) {
      state.connectionGone(record, reason);
    }
  }

  #handleConnectionLoss(socket) {
    this.#connectionGone(socket, "connection_lost");
    if (this.#socket === socket) {
      this.#socket = undefined;
      if (this.#observation?.status === "observing") {
        this.#observation.connection = {
          status: "lost",
          lost_at: zonedTimestamp(Date.now(), this.#observation.timeZone),
        };
        void this.#finishObservation(
          this.#observation,
          "connection_lost",
          "connection_closed",
          false,
        );
      }
    }
    for (const [id, pending] of this.#pending) {
      if (pending.socket !== socket) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(
        new SprutHubError(
          "connection_closed",
          "The SprutHub connection closed before the response arrived.",
          "retry",
          { capability_status: "unknown" },
        ),
      );
    }
  }

  // A connection on which a request ran out of time may be gone without a
  // close, as when the network drops, or may no longer answer; frames on it
  // prove nothing, since the hub sends events to every socket. It takes no
  // new requests: the next one opens a new connection, so a retry gets
  // through at once without waiting on a probe. The requests already on it
  // keep their own time, so a write sent there still gets its answer from a
  // hub that is only slow, and it closes once they have settled. The
  // subscriptions of an observation stay on their connection, so for an
  // observation the connection is lost.
  #retire(socket) {
    this.#connectionGone(socket, "connection_retired");
    if (this.#socket === socket) {
      if (this.#observation?.status === "observing") {
        this.#handleConnectionLoss(socket);
        socket.terminate();
        return;
      }
      this.#socket = undefined;
    }
    this.#closeIfRetired(socket);
  }

  #closeIfRetired(socket) {
    if (socket === this.#socket) return;
    for (const pending of this.#pending.values()) {
      if (pending.socket === socket) return;
    }
    socket.terminate();
  }

  #handleNativeEvent(message, socket) {
    if (isPlainObject(message.event)) {
      this.#routeHomeEvent(message.event, socket);
      for (const listener of this.#nativeEventListeners) {
        listener(message.event);
      }
    }
    const observation = this.#observation;
    if (observation?.status !== "observing") return;
    const receivedAt = zonedTimestamp(Date.now(), observation.timeZone);
    const characteristicEvent = message.event?.characteristic;
    if (characteristicEvent && typeof characteristicEvent === "object") {
      for (const characteristic of characteristicEvent.characteristics ?? []) {
        const ref = observation.characteristicByNativeId.get(
          nativeCharacteristicKey(characteristic),
        );
        if (!ref) continue;
        const typed = extractTypedValue(characteristic.control?.value);
        this.#recordObservationEvent(observation, {
          kind: "characteristic",
          ref,
          received_at: receivedAt,
          source_timestamp: null,
          value: normalizeEventValue(typed),
          native: {
            event_type:
              typeof characteristicEvent.event === "string"
                ? characteristicEvent.event
                : null,
            value_field: typed.field,
            control_type:
              typeof characteristic.control?.type === "string"
                ? characteristic.control.type
                : null,
            partial: true,
          },
        });
      }
    }

    const scenarioEvent = message.event?.scenario;
    if (
      scenarioEvent?.index === observation.scenarioIndex &&
      observation.status === "observing"
    ) {
      this.#recordObservationEvent(observation, {
        kind: "scenario",
        ref: observation.scenarioRef,
        received_at: receivedAt,
        source_timestamp: null,
        native: {
          type:
            typeof scenarioEvent.type === "string" ? scenarioEvent.type : null,
          block_id: Number.isSafeInteger(scenarioEvent.blockId)
            ? scenarioEvent.blockId
            : null,
        },
      });
    }

    const logMessages = message.event?.log?.log;
    for (const log of Array.isArray(logMessages) ? logMessages : []) {
      const normalized = normalizeScenarioLog(
        log,
        observation.scenarioIndex,
        observation.timeZone,
      );
      if (!normalized || observation.status !== "observing") continue;
      this.#recordObservationEvent(observation, {
        kind: "scenario_log",
        ref: observation.scenarioRef,
        received_at: receivedAt,
        source_timestamp: normalized.sourceTimestamp,
        message: normalized.message,
        content_origin: "spruthub_native_log",
        native: {
          time_ms: normalized.timeMs,
          level: normalized.level,
          path: normalized.path,
        },
      });
    }
  }

  #recordObservationEvent(observation, event) {
    if (observation.status !== "observing") return;
    observation.sequence += 1;
    observation.events.push({ sequence: observation.sequence, ...event });
    if (observation.events.length >= observation.maxEvents) {
      void this.#finishObservation(
        observation,
        "truncated",
        "event_limit_reached",
      );
    }
  }

  async #pingObservation(observation) {
    if (observation.status !== "observing") return;
    try {
      await this.#request(
        { server: { ping: {} } },
        Date.now() + this.timeoutMs,
        { serial: observation.serial },
      );
    } catch (error) {
      if (observation.status !== "observing") return;
      observation.connection = {
        status: "unknown",
        error_code:
          error instanceof SprutHubError ? error.code : "internal_error",
      };
      await this.#finishObservation(
        observation,
        "truncated",
        "keepalive_failed",
      );
    }
  }

  async #finishObservation(
    observation,
    status,
    completionReason,
    unsubscribe = true,
  ) {
    if (!["starting", "observing"].includes(observation.status)) return;
    observation.status = "finishing";
    clearTimeout(observation.timer);
    clearInterval(observation.pingTimer);
    observation.timer = null;
    observation.pingTimer = null;

    if (
      unsubscribe &&
      Object.values(observation.subscriptionUuids).some(Boolean)
    ) {
      await this.#cleanupObservationSubscriptions(observation);
    } else if (Object.values(observation.subscriptionUuids).some(Boolean)) {
      observation.cleanup = { status: "connection_closed" };
    }

    observation.status = status;
    observation.completionReason = completionReason;
    observation.truncated = [
      "connection_lost",
      "truncated",
      "canceled",
    ].includes(status);
    observation.endedAt = zonedTimestamp(Date.now(), observation.timeZone);
    for (const resolve of observation.waiters) resolve();
    observation.waiters.clear();
    this.#socket?.close();
  }

  async #cleanupObservationSubscriptions(observation) {
    const errors = [];
    for (const [domain, uuid] of Object.entries(
      observation.subscriptionUuids,
    )) {
      if (!uuid) continue;
      try {
        await this.#request(
          { [domain]: { unsubscribe: { uuid } } },
          Date.now() + this.timeoutMs,
          { serial: observation.serial },
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      observation.cleanup = { status: "unsubscribed" };
      return;
    }
    observation.cleanup = {
      status: "connection_closed",
      error_code:
        errors[0] instanceof SprutHubError ? errors[0].code : "internal_error",
    };
    this.#socket?.terminate();
  }

  #observationClientFor(observationRef) {
    for (const client of [
      this.#startingObservationClient,
      this.#observationClient,
    ]) {
      if (client?.#observation?.ref === observationRef) return client;
    }
    throw new SprutHubError(
      "observation_not_found",
      "The native observation is not available in this MCP process.",
      "read_hub_log",
    );
  }

  #requireObservation(observationRef) {
    if (!this.#observation || this.#observation.ref !== observationRef) {
      throw new SprutHubError(
        "observation_not_found",
        "The native observation is not available in this MCP process.",
        "read_hub_log",
      );
    }
    return this.#observation;
  }

  #observationResult(observation) {
    const publicStatus = ["starting", "finishing"].includes(observation.status)
      ? "observing"
      : observation.status;
    return {
      status: publicStatus,
      observation_ref: observation.ref,
      scope: {
        home_ref: observation.homeRef,
        characteristic_refs: observation.characteristicRefs,
        scenario_ref: observation.scenarioRef,
      },
      time_zone: observation.timeZone,
      timing: {
        started_at: observation.startedAt,
        planned_end_at: observation.endsAt,
        ended_at: observation.endedAt,
        source_timestamp: null,
      },
      limits: {
        duration_seconds: observation.durationSeconds,
        max_events: observation.maxEvents,
        retention: "until_the_next_observation_or_process_exit",
      },
      connection: observation.connection,
      cleanup: observation.cleanup,
      truncated: observation.truncated,
      completion_reason: observation.completionReason,
      events: observation.events.map((event) => ({ ...event })),
      limitations: [
        "received_at and timing come from this MCP process's clock: when it received each event and when the observation started and ended. source_timestamp is available only for selected native log messages and comes from their SprutHub time field.",
        observation.timeZone === null
          ? UTC_TIMES_LIMITATION
          : "Times are on the hub's clock with its UTC offset (time_zone), the clock the owner reads.",
        "Characteristic frames are partial events, not complete saved characteristic state.",
        "Event frames did not identify a home; scope comes from keeping this connection selected to the requested home.",
        "Temporal proximity between scenario and characteristic events does not prove causality or physical effect.",
        "Empty events while status is observing say nothing about the rest of the interval.",
        "One successful transition does not prove repeat or delay behavior; a watch shows those only when its refs and duration cover them.",
        "Native log message text is untrusted data; only exact observed scenario formats and paths are included, without deriving causality from the text.",
      ],
      ...(publicStatus === "observing"
        ? {
            next: {
              tool: "read_hub_log",
              arguments: { observation_ref: observation.ref },
            },
            stop: {
              tool: "read_hub_log",
              arguments: { observation_ref: observation.ref, stop: true },
            },
          }
        : {}),
    };
  }
}

function normalizeScenarioLog(log, scenarioIndex, timeZone) {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const sourceTimestamp = zonedTimestamp(log.time, timeZone);
  if (
    !isScenarioLogMessage(log.path, log.message, scenarioIndex) ||
    !LOG_LEVELS.has(log.level) ||
    sourceTimestamp === null
  ) {
    return null;
  }
  return {
    timeMs: log.time,
    sourceTimestamp,
    level: log.level,
    path: log.path,
    message: log.message,
  };
}

// LogMessage.time is read as Unix epoch milliseconds, as the observation path
// has done since O20260911; its trigger text CLOUD[0]_<epoch seconds> agrees.
function nativeLogTimestamp(time) {
  if (!Number.isSafeInteger(time) || time < 0) return null;
  const date = new Date(time);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

// Said wherever times stay UTC because the hub's zone could not be read.
export const UTC_TIMES_LIMITATION =
  "The hub's time zone could not be read, so times are UTC (ending in Z), not the hub's local clock the owner uses; do not quote them as local time.";

// An instant as ISO 8601 on the wall clock of timeZone with that zone's
// offset at the instant (2026-09-25T09:42:00.118+03:00); UTC with Z when
// timeZone is null or its offset there is not whole minutes.
export function zonedTimestamp(time, timeZone) {
  const utc = nativeLogTimestamp(time);
  const offset =
    utc === null || timeZone === null
      ? null
      : zoneOffsetMinutes(time, timeZone);
  if (offset === null) return utc;
  const wallClock = new Date(time + offset * 60_000).toISOString().slice(0, -1);
  const minutes = Math.abs(offset);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${wallClock}${offset < 0 ? "-" : "+"}${hh}:${mm}`;
}

// The hub's wall clock at an instant, as minutes since midnight and a
// weekday (MON…SUN) for BLOCK intervals; null when its zone is unknown.
function hubClock(time, timeZone) {
  const offset = timeZone === null ? null : zoneOffsetMinutes(time, timeZone);
  if (offset === null) return null;
  const wall = new Date(time + offset * 60_000);
  return {
    minutes: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
    weekday: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][
      wall.getUTCDay()
    ],
  };
}

// The UTC offset of timeZone at an instant in minutes, or null for a zone
// this process does not know.
function zoneOffsetMinutes(time, timeZone) {
  let name;
  try {
    name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(time))
      .find(({ type }) => type === "timeZoneName")?.value;
  } catch {
    return null;
  }
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name ?? "");
  if (!match) return null;
  if (match[1] === undefined) return 0;
  return (
    (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  );
}

// A missing level, path or message stays null (protobuf JSON may omit a
// default); a present value of another form is not a readable log entry.
// time is on the hub's clock when its zone is known, else UTC.
function normalizeHubLogEntry(log, timeZone) {
  if (!isPlainObject(log)) throw incompatibleHubLog();
  const time = zonedTimestamp(log.time, timeZone);
  const level = log.level === undefined ? null : LOG_LEVEL_NAMES.get(log.level);
  if (
    time === null ||
    level === undefined ||
    ![log.path, log.message].every(
      (value) => value === undefined || typeof value === "string",
    )
  ) {
    throw incompatibleHubLog();
  }
  return {
    time,
    native_time: log.time,
    level,
    path: log.path ?? null,
    message: log.message ?? null,
  };
}

function incompatibleHubLog() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned an incompatible execution log.",
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Only these observed path/prefix pairs identify one scenario index; the
// separator keeps "Сценарий 230" out of scenario 23.
export function isScenarioLogMessage(path, message, scenarioIndex) {
  const separator = SCENARIO_LOG_PREFIX_BY_PATH.get(path);
  return (
    separator !== undefined &&
    typeof message === "string" &&
    message.startsWith(`Сценарий ${scenarioIndex}${separator}`)
  );
}

function extractScenarioCatalog(response) {
  const scenarios = extractNativeList(response, [
    "scenario",
    "list",
    "scenarios",
  ]);
  for (const scenario of scenarios) {
    if (typeof scenario?.index !== "string") {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned a scenario without a stable index.",
      );
    }
  }
  return scenarios;
}

function isScenarioNotFoundCandidate(error) {
  return isNativeNotFoundCandidate(error);
}

function isNativeNotFoundCandidate(error) {
  return (
    error instanceof SprutHubError &&
    error.code === "request_rejected" &&
    error.protocolErrorCode === -32603
  );
}

const HUB_ERROR_MESSAGE_MAX_LENGTH = 500;

// The hub's error text is untrusted data that may be saved in the journal, so
// it is bounded and never carries the connection token or a credential.
function hubErrorReply(error, token) {
  const code =
    typeof error?.code === "number" || typeof error?.code === "string"
      ? error.code
      : null;
  if (typeof error?.message !== "string") return { code };
  const message = error.message.includes(token)
    ? "[REDACTED]"
    : redactSensitiveText(error.message);
  const characters = [...message];
  return {
    code,
    message:
      characters.length > HUB_ERROR_MESSAGE_MAX_LENGTH
        ? `${characters.slice(0, HUB_ERROR_MESSAGE_MAX_LENGTH).join("")}…`
        : message,
  };
}

// SprutHub replies in proto3 JSON, which leaves out a repeated field that is
// empty: a list object without its array is an empty list. Live hubs did this
// for accessory.list{roomId}, extensionChild.list, logic.getOptions, log.list
// and scenario.list{aId}. A missing envelope or list object, null or any
// other non-array value is not a list and never reads as empty.
export function extractNativeList(
  response,
  path,
  incompatible = incompatibleEntityList,
) {
  let container = response?.result;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(container) || !Object.hasOwn(container, key)) {
      throw incompatible();
    }
    container = container[key];
  }
  if (!isPlainObject(container)) throw incompatible();
  const key = path.at(-1);
  if (!Object.hasOwn(container, key)) return [];
  if (!Array.isArray(container[key])) throw incompatible();
  return container[key];
}

function incompatibleEntityList() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned an incompatible entity list.",
  );
}

function extractEntity(response, path, kind) {
  let container = response.result;
  for (const key of path.slice(0, -1)) container = container?.[key];
  const key = path.at(-1);
  if (!container || !Object.hasOwn(container, key)) {
    throw new SprutHubError(
      "incompatible_response",
      `SprutHub returned an incompatible ${kind} response.`,
    );
  }
  if (container[key] === null) throw entityNotFound(kind);
  return container[key];
}

function entityNotFound(kind, details = {}) {
  return new SprutHubError(
    "entity_not_found",
    `The selected SprutHub ${kind} was not found.`,
    "home_overview",
    details,
  );
}

function validateHome(home) {
  if (
    !home ||
    typeof home.serial !== "string" ||
    home.serial.length === 0 ||
    typeof home.name !== "string" ||
    typeof home.online !== "boolean"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete home data.",
    );
  }
}

function normalizeHome(home, observedAt) {
  return {
    ref: homeRef(home.serial),
    name: redactSensitiveText(home.name),
    online: home.online,
    access: {
      ownership:
        typeof home.owner === "boolean"
          ? home.owner
            ? "owner"
            : "not_owner"
          : "unknown",
      native_owner:
        typeof home.owner === "string" ? redactSensitiveText(home.owner) : null,
      support: home.support === true,
    },
    model:
      typeof home.model === "string" ? redactSensitiveText(home.model) : null,
    firmware: {
      version: home.version?.current?.version ?? null,
      revision: home.version?.current?.revision ?? null,
    },
    ...(typeof home.optionsWindow === "string"
      ? { options_window_ref: windowRef(home.serial, home.optionsWindow) }
      : {}),
    observed_at: observedAt,
  };
}

function freshness(observedAt) {
  return {
    hubResponseReceivedAt: observedAt,
    measurementAt: null,
  };
}

function latestObservedAt(values) {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

// The characteristics the web client's Notifications screen offers a
// notification for: the device's online state (C_Online of its information
// service) and every characteristic but a name of the other services, apart
// from extended information and camera streams (app.16735171810a795a9f2d.js,
// NotificationsScreen with its service and characteristic filters).
const NOTIFY_EXCLUDED_SERVICE_TYPES = new Set([
  "AccessoryInformation",
  "C_AccessoryExtInfo",
  "CameraRTPStreamManagement",
]);

export function characteristicNotifyOffered(service, characteristic) {
  const type = characteristic?.control?.type ?? characteristic?.control?.key;
  if (service?.type === "AccessoryInformation") return type === "C_Online";
  return !NOTIFY_EXCLUDED_SERVICE_TYPES.has(service?.type) && type !== "Name";
}

// The notification setting of a characteristic from accessory.get, the only
// read that reports it (false where it was never set; accessory.list and
// characteristic.get leave it out whatever it is, owner hub 3.0.0,
// research/protocol/2026-10-12-notifications-live.md). A missing one reads
// as off, as the web client shows it; anything but a boolean is unknown
// (null). Never pass a characteristic from another read.
export function characteristicNotifyOn(characteristic) {
  const notify = characteristic?.notify;
  if (notify === undefined || notify === null) return false;
  return typeof notify === "boolean" ? notify : null;
}

export function homeRef(serial) {
  return `spruthub://hub/${encodeURIComponent(serial)}`;
}

export function roomRef(serial, roomId) {
  return `${homeRef(serial)}/room/${roomId}`;
}

export function accessoryRef(serial, accessoryId) {
  return `${homeRef(serial)}/accessory/${accessoryId}`;
}

export function serviceRef(serial, accessoryId, serviceId) {
  return `${accessoryRef(serial, accessoryId)}/service/${serviceId}`;
}

export function characteristicRef(
  serial,
  accessoryId,
  serviceId,
  characteristicId,
) {
  return `${serviceRef(serial, accessoryId, serviceId)}/characteristic/${characteristicId}`;
}

function scenarioRef(serial, index) {
  return `${homeRef(serial)}/scenario/${encodeURIComponent(index)}`;
}

export function extensionRef(serial, key) {
  return `${homeRef(serial)}/extension/${encodeURIComponent(key)}`;
}

export function extensionChildRef(serial, key, id) {
  return `${extensionRef(serial, key)}/child/${encodeURIComponent(id)}`;
}

function windowRef(serial, key) {
  return `${homeRef(serial)}/window/${encodeURIComponent(key)}`;
}

function ownerWindowRef(serial, key) {
  // Hub optionsWindow may be ""; frontend treats empty device/extension
  // windows as absent.
  return typeof key === "string" && key.length > 0
    ? windowRef(serial, key)
    : null;
}

function logicRef(serial, accessoryId, serviceId, type) {
  return `${serviceRef(serial, accessoryId, serviceId)}/logic/${encodeURIComponent(type)}`;
}

function parseHomeRef(ref) {
  const parsed = parseEntityRef(ref);
  if (parsed.kind !== "home") throw invalidEntityRef();
  return parsed.serial;
}

export function parseEntityRef(ref) {
  let url;
  try {
    url = new URL(ref);
  } catch {
    throw invalidEntityRef();
  }
  if (url.protocol !== "spruthub:" || url.hostname !== "hub") {
    throw invalidEntityRef();
  }
  const encoded = entityPathSegments(url.pathname);
  if (encoded.length === 0) throw invalidEntityRef();
  let segments;
  try {
    segments = encoded.map(decodeURIComponent);
  } catch {
    throw invalidEntityRef();
  }
  const serial = segments[0];
  if (!serial) throw invalidEntityRef();
  if (segments.length === 1) return { kind: "home", serial };
  if (segments.length === 3 && segments[1] === "room") {
    return { kind: "room", serial, roomId: parseEntityId(segments[2]) };
  }
  if (segments.length === 3 && segments[1] === "scenario") {
    return { kind: "scenario", serial, scenarioIndex: segments[2] };
  }
  if (segments.length === 3 && segments[1] === "extension") {
    return { kind: "extension", serial, extensionKey: segments[2] };
  }
  if (
    segments.length === 5 &&
    segments[1] === "extension" &&
    segments[3] === "child"
  ) {
    const childExtensionKey = segments[2];
    const childId = segments[4];
    if (!childExtensionKey || !childId) throw invalidEntityRef();
    return {
      kind: "extension_child",
      serial,
      extensionKey: childExtensionKey,
      childId,
    };
  }
  if (segments.length === 3 && segments[1] === "window") {
    return { kind: "window", serial, windowKey: segments[2] };
  }
  if (segments[1] !== "accessory") throw invalidEntityRef();
  const accessoryId = parseEntityId(segments[2]);
  if (segments.length === 3) return { kind: "accessory", serial, accessoryId };
  if (segments[3] !== "service") throw invalidEntityRef();
  const serviceId = parseEntityId(segments[4]);
  if (segments.length === 5) {
    return { kind: "service", serial, accessoryId, serviceId };
  }
  if (segments.length === 7 && segments[5] === "characteristic") {
    return {
      kind: "characteristic",
      serial,
      accessoryId,
      serviceId,
      characteristicId: parseEntityId(segments[6]),
    };
  }
  if (segments.length === 7 && segments[5] === "logic") {
    return {
      kind: "logic",
      serial,
      accessoryId,
      serviceId,
      logicType: segments[6],
    };
  }
  throw invalidEntityRef();
}

function entityPathSegments(pathname) {
  if (!pathname.startsWith("/")) throw invalidEntityRef();
  const raw = pathname.slice(1).split("/");
  return raw.filter((segment, index) => {
    if (segment.length > 0) return true;
    // windowRef(serial, "") ends with /window/; keep that empty key.
    return index === raw.length - 1 && raw.length === 3 && raw[1] === "window";
  });
}

function parseEntityId(value) {
  if (!/^\d+$/.test(value)) throw invalidEntityRef();
  const id = Number(value);
  if (!isStableId(id)) throw invalidEntityRef();
  return id;
}

function invalidEntityRef(action = "home_overview") {
  return new SprutHubError(
    "invalid_entity_ref",
    "Use a home-qualified reference returned by home_overview, find_devices, or get_entity.",
    action,
  );
}

function invalidObservationScope() {
  return new SprutHubError(
    "invalid_observation_scope",
    "Use characteristic and scenario references from the same explicitly selected home.",
    "read_hub_log",
  );
}

function isTerminalObservation(status) {
  return ["completed", "connection_lost", "truncated", "canceled"].includes(
    status,
  );
}

function invalidMessage() {
  return new SprutHubError(
    "invalid_message",
    "SprutHub returned an invalid JSON-RPC message.",
    "retry",
    { capability_status: "unknown" },
  );
}

function homeSelectionRequired() {
  return new SprutHubError(
    "home_selection_required",
    "Call home_overview, choose one exact home, follow selection.pin, restart the same MCP application, and retry this operation.",
    "home_overview",
    { next: { tool: "home_overview", arguments: {} } },
  );
}

function noHomesAvailable() {
  return new SprutHubError(
    "no_homes_available",
    "This SprutHub account has no available homes.",
    "check_home_access",
    { capability_status: "insufficient_access" },
  );
}

function normalizeScenarioSummary(serial, scenario) {
  if (
    !scenario ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.type !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete scenario data.",
    );
  }
  return {
    ref: scenarioRef(serial, scenario.index),
    name: scenario.name,
    type: scenario.type,
    predefined: scenario.predefined === true,
    active: scenario.active === true,
    on_start: scenario.onStart === true,
    sync: scenario.sync === true,
    ...(scenario.type === "BLOCK" &&
    typeof scenario.optionsWindow === "string" &&
    scenario.optionsWindow.length > 0
      ? { options_window_ref: windowRef(serial, scenario.optionsWindow) }
      : {}),
  };
}

function uniqueByRef(values) {
  const seen = new Set();
  return values.filter(({ ref }) => {
    if (seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
}

function relationFailureOutcome(error) {
  if (error.code === "entity_not_found") return "missing";
  if (error.code === "unsupported") return "unsupported";
  return "failed";
}

function relationFailure(area, read) {
  return { area, outcome: read.outcome, error_code: read.errorCode };
}

const RELATIONS_LIMITATION =
  "Roles come from the BLOCK scenarios that the hub's scenario index lists for this accessory; that index is not proven complete. code_mentions are the owner's code scenarios whose source names this accessory by its id in a Hub call (getAccessory, getCharacteristic, get/set/toggleCharacteristicValue) or by its exact name in a string: a mention, not proof of what the code does; code that finds it otherwise is missed. Past the search limit, the home_overview lists named for the rest also show the searched and built-in scenarios, so which were not searched is unknown. Code conditions and code steps of BLOCKs and extensions are not analyzed, and stored configuration does not prove that a command ran.";

function extensionKey(extension) {
  return typeof extension?.extensionKey === "string" &&
    extension.extensionKey.trim().length > 0
    ? extension.extensionKey
    : null;
}

function normalizeExtensions(serial, extensions, timeZone = null) {
  const normalized = extensions.map((extension) =>
    normalizeExtension(serial, extension, timeZone),
  );
  if (new Set(normalized.map(({ key }) => key)).size !== normalized.length) {
    throw incompatibleExtensionIdentity();
  }
  return normalized;
}

function incompatibleExtensionIdentity() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned an extension without a unique native extensionKey.",
    "home_overview",
  );
}

function normalizeExtension(serial, extension, timeZone = null) {
  const key = extensionKey(extension);
  if (
    typeof key !== "string" ||
    typeof extension?.name !== "string" ||
    typeof extension.type !== "string"
  ) {
    throw incompatibleExtensionIdentity();
  }
  if (
    Object.hasOwn(extension, "childCount") &&
    !Number.isSafeInteger(extension.childCount)
  ) {
    throw incompatibleExtensionIdentity();
  }
  const mainWindowRef = ownerWindowRef(serial, extension.mainWindow);
  const deviceSearch = deviceSearchSummary(extension, timeZone);
  return {
    ref: extensionRef(serial, key),
    key,
    name: redactSensitiveText(extension.name),
    type: redactSensitiveText(extension.type),
    index:
      typeof extension.index === "string"
        ? redactSensitiveText(extension.index)
        : null,
    options_window_ref: ownerWindowRef(serial, extension.optionsWindow),
    ...(mainWindowRef ? { main_window_ref: mainWindowRef } : {}),
    ...(Object.hasOwn(extension, "childCount")
      ? { child_count: extension.childCount }
      : {}),
    bundle_type: extension.bundleType ?? null,
    enabled: extension.enabled === true,
    state: extension.state ?? null,
    ...(deviceSearch ? { device_search: deviceSearch } : {}),
  };
}

function normalizeExtensionDetail(serial, extension, timeZone = null) {
  const spaces = normalizeExtensionSpaces(serial, extension.spaces, timeZone);
  return {
    ...normalizeExtension(serial, extension, timeZone),
    ...(spaces ? { spaces } : {}),
  };
}

function normalizeExtensionSpaces(serial, spaces, timeZone) {
  if (spaces === undefined) return undefined;
  if (!Array.isArray(spaces)) {
    throw incompatibleExtensionIdentity();
  }
  const now = Date.now();
  return spaces.map((space) => {
    if (typeof space?.key !== "string" || space.key.length === 0) {
      throw incompatibleExtensionIdentity();
    }
    // An action the client cannot read is left out and its space flagged:
    // the extension and its other actions stay usable.
    const listed = Array.isArray(space.actions) ? space.actions : [];
    const actions = listed
      .filter(isReadableAction)
      .map((action) => normalizeExtensionAction(serial, action, timeZone, now));
    const unreadable =
      (space.actions !== undefined && !Array.isArray(space.actions)) ||
      actions.length < listed.length;
    return {
      key: redactSensitiveText(space.key),
      type:
        typeof space.type === "string" ? redactSensitiveText(space.type) : null,
      label: normalizeFormLabel(space.label),
      ...(actions.length > 0 ? { actions } : {}),
      ...(unreadable ? { actions_unreadable: true } : {}),
    };
  });
}

// The space where a controller lists its connected devices; its
// ACTION_DISCOVERY is the controller's ordinary device search (ZigBee
// «Поиск»). Another space's search, as ZigBee's «ZLL поиск» in
// «Устройства рядом», acts on devices nearby (2026-10-12-device-pairing H2).
export const DEVICE_SEARCH_SPACE = "main";

// The one ACTION_DISCOVERY of a space, or null when it has none or several.
export function extensionSearchAction(
  extension,
  spaceKey = DEVICE_SEARCH_SPACE,
) {
  const space = Array.isArray(extension?.spaces)
    ? extension.spaces.find((candidate) => candidate?.key === spaceKey)
    : undefined;
  const actions = (Array.isArray(space?.actions) ? space.actions : []).filter(
    (action) =>
      action?.type === "ACTION_DISCOVERY" && Number.isSafeInteger(action.id),
  );
  return actions.length === 1 ? actions[0] : null;
}

// The epoch milliseconds a running action ends at, or null. endTimestamp
// shows on every action of the extension while one runs; only state tells
// which (P2).
export function runningActionEnd(action) {
  if (action?.state !== true) return null;
  const end =
    typeof action.endTimestamp === "string" &&
    /^\d{1,16}$/.test(action.endTimestamp)
      ? Number(action.endTimestamp)
      : action.endTimestamp;
  return Number.isSafeInteger(end) && end > 0 ? end : null;
}

function hasRunningAction(extension) {
  return (Array.isArray(extension?.spaces) ? extension.spaces : []).some(
    (space) =>
      Array.isArray(space?.actions) &&
      space.actions.some((action) => runningActionEnd(action) !== null),
  );
}

// An action of an extension space: its button text as label, active from
// its state, and for a running one when it ends on the hub's clock.
function isReadableAction(action) {
  return isPlainObject(action) && Number.isSafeInteger(action.id);
}

function normalizeExtensionAction(serial, action, timeZone, now) {
  const end = runningActionEnd(action);
  const windowRef =
    typeof action.windowKey === "string"
      ? ownerWindowRef(serial, action.windowKey)
      : null;
  return {
    id: action.id,
    label:
      typeof action.button === "string"
        ? redactSensitiveText(action.button)
        : null,
    type: typeof action.type === "string" ? action.type : null,
    active: action.state === true,
    ...(end === null ? {} : searchEnd(end, timeZone, now)),
    ...(windowRef ? { window_ref: windowRef } : {}),
  };
}

// When a running search ends on the hub's clock and how many seconds are
// left on this process's clock.
export function searchEnd(end, timeZone, now = Date.now()) {
  return {
    ends_at: zonedTimestamp(end, timeZone),
    seconds_left: Math.max(0, Math.round((end - now) / 1_000)),
  };
}

// A running controller's ordinary device search for lists of extensions:
// active, and when it ends while it runs.
function deviceSearchSummary(extension, timeZone) {
  if (
    extension.bundleType !== "CONTROLLER" ||
    extension.state !== "LOADED" ||
    extension.enabled !== true
  ) {
    return null;
  }
  const action = extensionSearchAction(extension);
  if (!action) return null;
  const end = runningActionEnd(action);
  return {
    active: action.state === true,
    ...(end === null ? {} : searchEnd(end, timeZone)),
  };
}

function normalizeFormLabel(label) {
  if (!label || typeof label !== "object" || Array.isArray(label)) return null;
  const normalized = {};
  for (const field of ["header", "text", "button"]) {
    if (typeof label[field] === "string") {
      normalized[field] = redactSensitiveText(label[field]);
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function incompatibleExtensionChildIdentity() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned an extension child that does not match the requested identity.",
    "home_overview",
  );
}

// A bridge lists an exported accessory in main and one it does not export
// in notConnected (2026-10-13-wave4-contracts 3.2).
const BRIDGE_EXPORTED_SPACE = "main";

// A bridge serves its export only while it runs; one that is NOT_LOADED or
// off keeps the setting (2026-10-13-wave4-contracts 3.1, 3.3).
function bridgeRunning({ state, enabled }) {
  return state === "LOADED" && enabled === true;
}

const BRIDGE_NOT_RUNNING =
  "The bridge is not running: its export is kept, but nothing from it reaches its assistant until it runs.";
const BRIDGE_LISTS_NOTHING =
  "The bridge lists no accessories, so whether it exports or can export this one is unknown; the owner can check the bridge in the SprutHub app.";

const BRIDGE_AUTO_ADD_OPTION = "AutoAddNewAccessory";
const BRIDGE_EXPORT_UNVERIFIED = "bridge_export_unverified";

// Writing a bridge's export was never checked on a hub
// (2026-10-13-wave4-contracts, limitations): it is read, not written.
export function bridgeExportUnverified(next) {
  return new SprutHubError(
    BRIDGE_EXPORT_UNVERIFIED,
    "This option sets what a bridge (HomeKit, Yandex Alice, Google) exports. Changing a bridge's export has not been verified on a SprutHub hub yet, so nothing was prepared or sent; the owner can change it in the SprutHub app.",
    "get_entity",
    { next },
  );
}

function bridgeChildExported({ spaceKey }) {
  if (spaceKey === BRIDGE_EXPORTED_SPACE) return true;
  return spaceKey === "notConnected" ? false : null;
}

// An optional include that could not be read must not discard the entity
// read before it; include_resolution names the failure.
function markIncludeUnread(entity, include, error) {
  Object.defineProperty(entity, INCLUDE_READ_ERROR, {
    value: {
      ...(entity[INCLUDE_READ_ERROR] ?? {}),
      [include]: { code: error.code, message: error.message },
    },
    enumerable: false,
    configurable: true,
  });
}

function normalizeExtensionChildren(serial, children, expectedExtensionKey) {
  const normalized = children.map((child) =>
    normalizeExtensionChildSummary(serial, child, expectedExtensionKey),
  );
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    throw incompatibleExtensionChildIdentity();
  }
  return normalized;
}

function normalizeExtensionChildSummary(serial, child, expectedExtensionKey) {
  validateExtensionChildIdentity(child, expectedExtensionKey);
  return {
    kind: "extension_child",
    ref: extensionChildRef(serial, child.extensionKey, child.id),
    id: child.id,
    space_key:
      typeof child.spaceKey === "string"
        ? redactSensitiveText(child.spaceKey)
        : null,
    name:
      typeof child.name === "string" ? redactSensitiveText(child.name) : null,
    // Missing online is unknown; native space membership is a separate fact.
    online: typeof child.online === "boolean" ? child.online : null,
    options_window_ref: ownerWindowRef(serial, child.optionsWindow),
  };
}

function normalizeExtensionChildDetail(serial, child, expectedExtensionKey) {
  const features = normalizeFeatureList(child.features);
  const transports = normalizeFeatureList(child.transports);
  return {
    ...normalizeExtensionChildSummary(serial, child, expectedExtensionKey),
    extension_ref: extensionRef(serial, child.extensionKey),
    description:
      typeof child.description === "string"
        ? redactSensitiveText(child.description)
        : null,
    status:
      typeof child.status === "string"
        ? redactSensitiveText(child.status)
        : null,
    ...(Number.isSafeInteger(child.groupId) ? { group_id: child.groupId } : {}),
    ...(features ? { features } : {}),
    ...(transports ? { transports } : {}),
  };
}

function validateExtensionChildIdentity(child, expectedExtensionKey) {
  if (
    typeof child?.id !== "string" ||
    child.id.length === 0 ||
    extensionKey(child) !== expectedExtensionKey
  ) {
    throw incompatibleExtensionChildIdentity();
  }
}

function normalizeFeatureList(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) {
    throw incompatibleExtensionChildIdentity();
  }
  return list.map((item) => ({
    type:
      typeof item?.type === "string" ? redactSensitiveText(item.type) : null,
    ...(typeof item?.count === "number" ? { count: item.count } : {}),
    ...(typeof item?.label === "string"
      ? { label: redactSensitiveText(item.label) }
      : {}),
  }));
}

function normalizeAccessoryDetail(serial, accessory, observedAt) {
  return {
    kind: "accessory",
    ref: accessoryRef(serial, accessory.id),
    name: accessory.name,
    available: accessory.online,
    room_ref: roomRef(serial, accessory.roomId),
    native: {
      extension_key: accessory.extensionKey ?? null,
      device_id: accessory.deviceId ?? null,
      device_window_ref: ownerWindowRef(serial, accessory.deviceWindow),
    },
    services: (accessory.services ?? []).map((service) =>
      normalizeServiceDetail(serial, accessory, service, observedAt),
    ),
  };
}

function normalizeServiceDetail(serial, accessory, service, observedAt) {
  return {
    kind: "service",
    ref: serviceRef(serial, accessory.id, service.sId),
    name: service.name,
    type: service.type,
    characteristics: (service.characteristics ?? []).map((characteristic) =>
      normalizeCharacteristicDetail(
        serial,
        accessory,
        service,
        characteristic,
        observedAt,
      ),
    ),
  };
}

function normalizeCharacteristicDetail(
  serial,
  accessory,
  service,
  characteristic,
  observedAt,
) {
  const control = characteristic.control;
  if (
    !control ||
    !isStableId(characteristic.cId) ||
    typeof control.name !== "string" ||
    (typeof control.type !== "string" && typeof control.key !== "string")
  ) {
    throw incompleteAccessoryError();
  }
  if (isSensitiveNativeNode(control)) return redactedNode();
  const value = extractTypedValue(control.value);
  const currentEnum = control.validValues
    ? matchEnumValue(control.validValues, value)
    : null;
  const ref = characteristicRef(
    serial,
    accessory.id,
    service.sId,
    characteristic.cId,
  );
  return {
    kind: "characteristic",
    ref,
    name: control.name,
    type: control.type ?? control.key,
    available: accessory.online,
    current_value: {
      value: value.value,
      ...(currentEnum ? { enum: currentEnum } : {}),
      source_timestamp: null,
    },
    capabilities: {
      read: control.read === true,
      write: control.write === true,
      events: control.events === true,
      unit: control.unit ?? null,
      min: control.minValue ?? null,
      max: control.maxValue ?? null,
      step: control.minStep ?? null,
      ...(control.validValues !== undefined
        ? {
            valid_values: selectableCharacteristicValues(control, value),
          }
        : {}),
    },
    // Native hasOptions; null when the hub did not say.
    options_available:
      typeof characteristic.hasOptions === "boolean"
        ? characteristic.hasOptions
        : null,
    // SprutHub's own notification on a change of this characteristic (for
    // C_Online, the device going offline or online); only where the web
    // client offers it.
    ...(characteristicNotifyOffered(service, characteristic)
      ? { notify: characteristicNotifyOn(characteristic) }
      : {}),
    freshness: {
      observed_at: observedAt,
      source_timestamp: null,
    },
  };
}

// One options call per container instead of one per characteristic: only
// characteristics that report options (or did not say) are candidates.
function optionsNext(characteristics) {
  const candidates = characteristics
    .filter(
      (characteristic) =>
        !isRedactedNode(characteristic) &&
        characteristic.options_available !== false,
    )
    .map(({ ref }) => ({ entity_ref: ref, include: ["options"] }));
  return candidates.length > 0
    ? { options_next: { tool: "get_entity", candidates } }
    : {};
}

function addIncludeResolution(entity, requested, ownerContext) {
  if (isRedactedNode(entity) || requested.size === 0) return entity;
  const requestedIncludes = [...requested];
  const applied = requestedIncludes.filter((include) =>
    includeWasApplied(entity, include),
  );
  const notApplied = requestedIncludes
    .filter((include) => !includeWasApplied(entity, include))
    .map((include) => explainUnappliedInclude(entity, include, ownerContext));
  return {
    ...entity,
    include_resolution: {
      requested: requestedIncludes,
      applied,
      not_applied: notApplied,
    },
  };
}

function includeWasApplied(entity, include) {
  if (include === "configuration") {
    return entity.kind === "scenario" && Object.hasOwn(entity, "configuration");
  }
  if (include === "options") {
    return (
      ["characteristic", "logic"].includes(entity.kind) &&
      Object.hasOwn(entity, "options")
    );
  }
  if (include === "relations") {
    return (
      ["accessory", "characteristic"].includes(entity.kind) &&
      Object.hasOwn(entity, "relations")
    );
  }
  if (include === "physical_configuration") {
    return (
      (["accessory", "characteristic"].includes(entity.kind) &&
        Object.hasOwn(entity, "physical_configuration")) ||
      (entity.kind === "window" && Object.hasOwn(entity, "options"))
    );
  }
  if (include === "diagnostics") {
    return (
      ["accessory", "characteristic", "window"].includes(entity.kind) &&
      Object.hasOwn(entity, "diagnostics")
    );
  }
  if (include === "children") {
    return entity.kind === "extension" && Array.isArray(entity.children);
  }
  if (include === "bridges") {
    return entity.kind === "accessory" && Array.isArray(entity.bridges);
  }
  if (include === "sdk") {
    return entity.kind === "home" && typeof entity.sdk === "string";
  }
  return false;
}

const DETERMINISTIC_INCLUDE_FAILURES = new Set([
  "unsupported",
  "incompatible_response",
]);

export function includeReadFailedAction(errorCode) {
  if (
    [
      "timeout",
      "connection_closed",
      "connection_failed",
      "invalid_message",
    ].includes(errorCode)
  ) {
    return "retry";
  }
  if (errorCode === "unsupported") return "home_overview";
  return undefined;
}

export function includeReadFailedNext(
  errorCode,
  { entityRef, include, homeRef } = {},
) {
  if (errorCode === "unsupported") {
    return typeof homeRef === "string"
      ? { tool: "home_overview", arguments: { home_ref: homeRef } }
      : undefined;
  }
  if (DETERMINISTIC_INCLUDE_FAILURES.has(errorCode)) return undefined;
  if (typeof entityRef !== "string" || !include) return undefined;
  return {
    tool: "get_entity",
    arguments: { entity_ref: entityRef, include: [include] },
  };
}

function explainUnappliedInclude(entity, include, ownerContext) {
  const includeError = entity[INCLUDE_READ_ERROR]?.[include];
  if (includeError) {
    const next = includeReadFailedNext(includeError.code, {
      entityRef: entity.ref,
      include,
    });
    return {
      include,
      reason: "read_failed",
      error_code: includeError.code,
      limitation: includeError.message,
      ...(next ? { next } : {}),
    };
  }
  const next = nextReadTowardOwner(entity, include, ownerContext);
  if (next) {
    return {
      include,
      reason: ownerScopeReason(entity, include),
      next,
    };
  }
  return {
    include,
    reason: "not_supported_for_entity",
    limitation:
      "No safe owning-entity reference for this include is available in this result.",
  };
}

function nextReadTowardOwner(entity, include, ownerContext) {
  // The scenario SDK belongs to the home.
  const home = /^spruthub:\/\/hub\/[^/]+/.exec(entity.ref ?? "")?.[0];
  if (include === "sdk" && entity.kind !== "home" && home) {
    return {
      tool: "get_entity",
      arguments: { entity_ref: home, include: ["sdk"] },
    };
  }
  if (entity.kind === "home") {
    return {
      tool: "home_overview",
      arguments: { home_ref: entity.ref },
    };
  }

  // A bridge exports an accessory; a service, characteristic or logic of it
  // reads its bridges through the accessory.
  if (
    include === "bridges" &&
    entity.kind !== "accessory" &&
    typeof ownerContext.accessory_ref === "string"
  ) {
    return {
      tool: "get_entity",
      arguments: { entity_ref: ownerContext.accessory_ref, include: [include] },
    };
  }

  if (
    ["physical_configuration", "diagnostics"].includes(include) &&
    Object.hasOwn(ownerContext, "device_window_ref")
  ) {
    if (typeof ownerContext.device_window_ref !== "string") return null;
    return {
      tool: "get_entity",
      arguments: {
        entity_ref: ownerContext.device_window_ref,
        include: [include],
      },
    };
  }

  if (
    entity.kind === "room" &&
    !Array.isArray(entity.accessories) &&
    ["options", "relations", "physical_configuration", "diagnostics"].includes(
      include,
    )
  ) {
    return entity.next;
  }

  const containerRoute = ownerCandidatesFromContainer(entity, include);
  if (containerRoute.length > 0) {
    return { tool: "get_entity", candidates: containerRoute };
  }

  if (
    entity.kind === "scenario" &&
    typeof entity.options_window_ref === "string" &&
    include === "options"
  ) {
    return {
      tool: "get_entity",
      arguments: { entity_ref: entity.options_window_ref },
    };
  }

  if (
    ["extension", "extension_child"].includes(entity.kind) &&
    typeof entity.options_window_ref === "string" &&
    ["options", "physical_configuration", "diagnostics"].includes(include)
  ) {
    return {
      tool: "get_entity",
      arguments: {
        entity_ref: entity.options_window_ref,
        ...(["physical_configuration", "diagnostics"].includes(include)
          ? { include: [include] }
          : {}),
      },
    };
  }

  return null;
}

function ownerCandidatesFromContainer(entity, include) {
  if (
    entity.kind === "room" &&
    ["options", "relations", "physical_configuration", "diagnostics"].includes(
      include,
    )
  ) {
    return entity.accessories.map(({ ref }) => ({
      entity_ref: ref,
      include: [include],
    }));
  }

  if (
    ["accessory", "service"].includes(entity.kind) &&
    ["options", "relations"].includes(include)
  ) {
    const services = entity.kind === "accessory" ? entity.services : [entity];
    return services.flatMap((service) =>
      (service.characteristics ?? [])
        .filter((characteristic) => !isRedactedNode(characteristic))
        .map((characteristic) => ({
          entity_ref: characteristic.ref,
          include: [include],
          ...(include === "options"
            ? { options_available: characteristic.options_available }
            : {}),
        })),
    );
  }

  return [];
}

function ownerScopeReason(entity, include) {
  if (include === "sdk" && entity.kind !== "home") return "home_scoped";
  if (entity.kind === "home") return "catalog_required";
  if (["extension", "extension_child"].includes(entity.kind))
    return "window_scoped";
  if (include === "bridges") return "accessory_scoped";
  if (include === "configuration") return "scenario_scoped";
  if (include === "options") {
    if (entity.kind === "scenario") return "window_scoped";
    return entity.kind === "logic" ? "logic_scoped" : "characteristic_scoped";
  }
  if (["physical_configuration", "diagnostics"].includes(include)) {
    return "device_window_scoped";
  }
  return "related_entity_scoped";
}

function normalizeOption(option, changeContext) {
  if (!option || typeof option.key !== "string") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an option without a native key.",
    );
  }
  if (isSensitiveNativeNode(option)) return redactedNode();
  const configured = extractTypedValue(option.value);
  return {
    key: redactSensitiveText(option.key),
    name:
      typeof option.name === "string" ? redactSensitiveText(option.name) : "",
    type:
      typeof option.type === "string" ? redactSensitiveText(option.type) : null,
    configured_value: sanitizeNativeData(configured.value),
    unit:
      typeof option.unit === "string" ? redactSensitiveText(option.unit) : null,
    read: option.read === true,
    write: option.write === true,
    events: option.events === true,
    ...(option.inputType ? { input_type: option.inputType } : {}),
    ...(typeof option.parent === "string" && option.parent.length > 0
      ? { parent: redactSensitiveText(option.parent) }
      : {}),
    ...(option.minValue !== undefined ? { min: option.minValue } : {}),
    ...(option.maxValue !== undefined ? { max: option.maxValue } : {}),
    ...(option.minStep !== undefined ? { step: option.minStep } : {}),
    ...(option.validValues
      ? {
          valid_values: option.validValues.map((validValue) => ({
            name:
              typeof validValue.name === "string"
                ? redactSensitiveText(validValue.name)
                : "",
            value: sanitizeNativeData(
              extractTypedValue(validValue.value).value,
            ),
          })),
        }
      : {}),
    ...(changeContext
      ? { native_change: publicNativeOptionChange(option, changeContext) }
      : {}),
  };
}

function normalizeWindow(serial, window, includeDiagnostics, observedAt) {
  if (
    !window ||
    typeof window.windowKey !== "string" ||
    !Array.isArray(window.options)
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete device-window data.",
    );
  }
  const diagnosticOptions = window.options.filter((option) =>
    ["HTML", "INFO", "CLIPBOARD"].includes(option.inputType),
  );
  const layoutOptions = window.options.filter(({ inputType }) =>
    ["GROUP", "FOLDER", "LABEL", "DIVIDER"].includes(inputType),
  );
  const commandOptions = window.options.filter(({ inputType }) =>
    inputType?.startsWith("BUTTON"),
  );
  const options = window.options
    .filter(
      (option) =>
        !diagnosticOptions.includes(option) &&
        !layoutOptions.includes(option) &&
        !commandOptions.includes(option),
    )
    .map((option) => {
      const normalized = normalizeOption(option, {
        operation: "window_option",
        targetRef: windowRef(serial, window.windowKey),
        writesSupported: window.windowKey !== "",
      });
      if (normalized.redacted) return normalized;
      const property = propertyFromNativeOptionKey(option.key);
      const linkedAccessories = linkedAccessoriesFromOption(serial, option);
      return {
        ...normalized,
        ...(property
          ? {
              property,
              reported_value: null,
              reported_source: null,
              reported_observed_at: null,
            }
          : {}),
        ...(linkedAccessories ? { linked_accessories: linkedAccessories } : {}),
        pending: "unknown",
        source_timestamp: null,
      };
    });
  return {
    physical_configuration: {
      ref: windowRef(serial, window.windowKey),
      name:
        typeof window.label?.text === "string"
          ? redactSensitiveText(window.label.text)
          : null,
      options,
      layout: layoutOptions.map((option) =>
        isSensitiveNativeNode(option)
          ? redactedNode()
          : normalizeWindowControl(option),
      ),
      commands: commandOptions.map((option) =>
        isSensitiveNativeNode(option)
          ? redactedNode()
          : {
              ...normalizeWindowControl(option),
              requires_confirmation: option.validValues?.some(
                ({ confirm }) =>
                  typeof confirm === "string" && confirm.length > 0,
              ),
            },
      ),
      freshness: {
        observed_at: observedAt,
        source_timestamp: null,
      },
    },
    ...(includeDiagnostics
      ? {
          diagnostics: diagnosticOptions.map((option) =>
            isSensitiveNativeNode(option)
              ? redactedNode()
              : {
                  key: redactSensitiveText(option.key),
                  text: redactSensitiveText(
                    String(extractTypedValue(option.value).value ?? ""),
                  ),
                  content_origin: "spruthub_device_window_diagnostics",
                  semantic_status: "uninterpreted",
                  source_timestamp: null,
                  direct_device_report: "not_established",
                },
          ),
        }
      : {
          diagnostics_available: diagnosticOptions.length > 0,
        }),
  };
}

function propertyFromNativeOptionKey(key) {
  const match = /\/[0-9A-Fa-f]+_([A-Za-z][A-Za-z0-9_]*)\/([^/]+)$/.exec(key);
  return match?.[1] ?? null;
}

function linkedAccessoriesFromOption(serial, option) {
  const linked = linkedAccessoryIds(option);
  if (linked?.status !== "confirmed") return linked;
  return {
    status: "confirmed",
    accessories: linked.accessories.map(({ id, name }) => ({
      ref: accessoryRef(serial, id),
      ...(name === undefined ? {} : { name }),
    })),
  };
}

function linkedAccessoryIds(option) {
  if (option?.inputType !== "ACCESSORY_LIST") return undefined;
  // Writable picker validValues are candidates, not existing links.
  if (option.read !== true || option.write === true) return undefined;
  // Current value 0 is a placeholder, not an accessory id. Only a fully
  // parseable validValues.intValue list is a confirmed accessory set.
  if (
    !Object.hasOwn(option, "validValues") ||
    !Array.isArray(option.validValues)
  ) {
    return { status: "unreliable_form" };
  }
  const accessories = [];
  for (const candidate of option.validValues) {
    const typed = extractTypedValue(candidate?.value);
    if (
      !typed.found ||
      typed.field !== "intValue" ||
      !isStableId(typed.value)
    ) {
      return { status: "unreliable_form" };
    }
    accessories.push({
      id: typed.value,
      ...(typeof candidate.name === "string"
        ? { name: redactSensitiveText(candidate.name) }
        : {}),
    });
  }
  return { status: "confirmed", accessories };
}

// The accessories a device window links read-only (a controller child's
// AccessoriesList, 2026-10-12-device-pairing H6): confirmed ids, none when
// the window has no such list, or unreliable_form.
export function windowLinkedAccessoryIds(window) {
  const lists = (window?.options ?? [])
    .map(linkedAccessoryIds)
    .filter((linked) => linked !== undefined);
  if (lists.length === 0) return { status: "none", ids: [] };
  if (lists.some(({ status }) => status !== "confirmed")) {
    return { status: "unreliable_form", ids: [] };
  }
  return {
    status: "confirmed",
    ids: [
      ...new Set(
        lists.flatMap(({ accessories }) => accessories.map(({ id }) => id)),
      ),
    ],
  };
}

function normalizeWindowControl(option) {
  return {
    key: redactSensitiveText(option.key ?? ""),
    name:
      typeof option.name === "string" ? redactSensitiveText(option.name) : "",
    type:
      typeof option.type === "string" ? redactSensitiveText(option.type) : null,
    input_type: option.inputType ?? null,
    parent:
      typeof option.parent === "string" && option.parent.length > 0
        ? redactSensitiveText(option.parent)
        : null,
  };
}

// A PINCODE field shows a pairing code; a QR_CODE field encodes one (the
// HomeKit setup payload), a hub user's login link or the access point's
// Wi-Fi password (owner's hub, 2026-10-12).
const SECRET_INPUT_TYPES = new Set(["PASSWORD", "PINCODE", "QR_CODE"]);

export function isSensitiveNativeNode(value, key = "") {
  if (isSensitiveContainerKey(key)) return true;
  if (!value || typeof value !== "object") return false;
  if (
    SECRET_INPUT_TYPES.has(value.inputType) ||
    SECRET_INPUT_TYPES.has(value.input_type) ||
    value.sensitive === true ||
    Object.entries(value).some(
      ([name, child]) => isSensitiveKey(name) && !isFlagOrSize(name, child),
    )
  ) {
    return true;
  }
  // A key that says flag or size decides for its label, type and ref: a
  // yes/no or a number under InstallCodeEnabled or PinCodeLength holds no
  // code, whatever its label says. A kind (Mode, PasswordType) does not
  // say what its number is: under Mode labelled «Пароль» it may be the
  // password, so the label decides there.
  const configured = value.value ?? value.configured_value;
  if (
    typeof value.key === "string" &&
    isFlagOrSize(value.key, configured, { kinds: false })
  ) {
    return false;
  }
  return (
    [value.key, value.type, value.ref].some(
      (candidate) =>
        typeof candidate === "string" &&
        isSensitiveKey(candidate) &&
        !isFlagOrSize(candidate, configured),
    ) ||
    labelHidesValue(value, configured) ||
    namesOptionSecret(value) ||
    holdsKeyMaterial(value) ||
    holdsConfirmationCode(value)
  );
}

// A field for the one-time code of a cloud login, as the Xiaomi
// controller's Ticket labelled «Код подтверждения»: filled, it holds the
// code sent to the owner; empty, it only shows that a login waits for it.
// The input type says whether the code is typed in (a select of how the
// code is sent holds none); a field without one is a choice when it lists
// values.
const TYPED_INPUT_TYPES = new Set(["TEXT", "TEXT_MULTILINE", "PASSWORD"]);

function holdsConfirmationCode(node) {
  const text = optionStringValue(node);
  if (text === null || text.trim() === "") return false;
  const inputType = node.inputType ?? node.input_type ?? null;
  const typed =
    inputType === null
      ? node.validValues === undefined && node.valid_values === undefined
      : TYPED_INPUT_TYPES.has(inputType);
  return (
    typed &&
    ((typeof node.key === "string" &&
      credentialKeyParts(node.key).includes("ticket")) ||
      (typeof node.name === "string" &&
        /код\s+подтверждения/iu.test(node.name)))
  );
}

// A label that names a secret hides the value under it, whatever its other
// words: no word of a way, a type, a time or a size makes it something
// else, so «Пароль в режиме точки доступа», «Временный пароль» and also
// «Длина PIN-кода» are hidden; a wrongly hidden setting is safer than a
// shown secret. A yes/no shows, and so does a choice among listed words:
// neither can be the secret the label names.
function labelHidesValue(node, configured) {
  return (
    typeof node.name === "string" &&
    !isBooleanValue(configured) &&
    !isChoiceOfWords(node, configured) &&
    labelNamesSecret(node.name)
  );
}

// A select shows the choice it holds among those it lists to anyone who
// opens it. A list of codes is not a choice of words: a choice with four
// digits in a row or key material, or a value not among the choices,
// keeps the label's rule.
function isChoiceOfWords(node, configured) {
  const choices = node.validValues ?? node.valid_values;
  if (
    (node.inputType ?? node.input_type) !== "LIST" ||
    !Array.isArray(choices) ||
    choices.length === 0
  ) {
    return false;
  }
  const plain = (value) =>
    value !== null && typeof value === "object"
      ? extractTypedValue(value).value
      : value;
  const current = plain(configured);
  return (
    choices.some((choice) => plain(choice?.value) === current) &&
    choices.every((choice) =>
      [choice?.name, plain(choice?.value)].every((part) => {
        const text = String(part ?? "").trim();
        return !/\d{4}/.test(text) && !looksLikeKeyMaterial(text);
      }),
    )
  );
}

// The hub labels its settings in Russian, which isSensitiveKey does not
// read. A label names a secret when a word of it says password, token or
// secret, PIN (also «PIN-код»), a code with whose it is or what it opens
// (доступа, пользователя, гостя, снятия с охраны, мастер-, одноразовый)
// or a key with what it locks (сети, устройства, закрытый, API, WPA2), in
// Russian or English. Words are whole: «Выключатель», «Код ошибки»,
// «Ключ продукта» and «Пин светодиода» name no secret.
const SECRET_WORD = /^(?:парол|токен|секрет|пинкод)/u;
const CODE_WORD = /^(?:код(?:а|у|ом|е|ы|ов|ами|ах)?|codes?)$/u;
const CODE_OF = new Set([
  "доступа",
  "пользователя",
  "гостя",
  "снятия",
  "охраны",
  "сопряжения",
  "привязки",
  "безопасности",
  "разблокировки",
  "активации",
  "входа",
  "авторизации",
  "аутентификации",
  "администратора",
  "установки",
]);
const CODE_KIND = /^(?:пин|pin|disarm)$|^(?:секретн|мастер|гостев|одноразов)/u;
const KEY_WORD = /^(?:ключ(?:а|у|ом|е|и|ей|ами|ах)?|keys?)$/u;
const KEY_OF = new Set([
  "сети",
  "устройства",
  "привязки",
  "шифрования",
  "безопасности",
  "доступа",
  "связи",
  "api",
  "подписи",
  "авторизации",
  "аутентификации",
  "сопряжения",
  "wifi",
  "wi",
  "wpa",
  "wpa2",
  "wpa3",
  "wep",
]);
const KEY_KIND =
  /^(?:api|wpa\d?|wep|wifi|fi|device|access|cloud)$|^(?:сетев|секретн|закрыт|приватн|локальн|мастер|облачн)/u;

function labelNamesSecret(label) {
  if (
    isSensitiveKey(label) ||
    /(?<![\p{L}\d])(?:PIN|ПИН)(?![\p{L}\d])/u.test(label)
  ) {
    return true;
  }
  const words = label
    .toLowerCase()
    .split(/[^\p{L}\d]+/u)
    .filter(Boolean);
  return words.some((word, index) => {
    const before = words[index - 1] ?? "";
    const after = words[index + 1] ?? "";
    return (
      SECRET_WORD.test(word) ||
      (CODE_WORD.test(word) &&
        (CODE_OF.has(after) ||
          CODE_KIND.test(before) ||
          (before === "time" && words[index - 2] === "one"))) ||
      (KEY_WORD.test(word) && (KEY_OF.has(after) || KEY_KIND.test(before)))
    );
  });
}

// A name after key material with a part that makes it a flag, a size or a
// kind holds no key when its value is a boolean or a number:
// InstallCodeEnabled, UseInstallCode, PinCodeLength, MaxPINCodeLength,
// PasswordType. A key or code in a string, such as InstallCode or a
// NUMBER Passcode without such a part, stays a secret. With kinds: false
// only a flag or a size counts.
const FLAG_OR_SIZE_PARTS = new Set([
  "count",
  "disabled",
  "enable",
  "enabled",
  "len",
  "length",
  "max",
  "min",
  "size",
  "use",
]);
const KIND_PARTS = new Set(["mode", "type"]);

function isFlagOrSize(name, value, { kinds = true } = {}) {
  return (
    (isBooleanValue(value) || isNumberValue(value)) &&
    credentialKeyParts(name).some(
      (part) => FLAG_OR_SIZE_PARTS.has(part) || (kinds && KIND_PARTS.has(part)),
    )
  );
}

function isNumberValue(value) {
  return (
    typeof value === "number" ||
    (value !== null &&
      typeof value === "object" &&
      ["intValue", "longValue", "doubleValue"].some((kind) =>
        Object.hasOwn(value, kind),
      ))
  );
}

function isBooleanValue(value) {
  return (
    typeof value === "boolean" ||
    (value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "boolValue"))
  );
}

// Option keys that are a secret on their own but name ordinary things as
// parts of other names or in text: Pin, Pass and Key as the whole key, and
// a session held in a string (SessionId, not SessionTimeout). A hardware
// GpioPin, a KeyRepeatDelay or a JavaScript variable pass stay visible.
function namesOptionSecret(node) {
  if (typeof node.key !== "string") return false;
  const parts = credentialKeyParts(node.key);
  if (parts.length === 1 && ["key", "pass", "pin"].includes(parts[0])) {
    return true;
  }
  return parts.includes("session") && optionStringValue(node) !== null;
}

// An option named or labelled after a key or code whose string value looks
// like key material, for names no rule knows (a device, bind or cloud
// key), also under an opaque key labelled «Ключ» or «Device key». A key
// that says key or code decides with its own exceptions (a product or
// scene identifier, an IR code); otherwise its label does.
function holdsKeyMaterial(node) {
  const text = optionStringValue(node);
  const name =
    typeof node.key === "string" && /key|code/i.test(node.key)
      ? node.key
      : node.name;
  return (
    typeof name === "string" && text !== null && isKeyMaterialUnder(name, text)
  );
}

// Whether a name says key or code and the text under it looks like key
// material. The same rule decides for an option and for a label in hub
// text (containsLabelledKeyMaterial).
function isKeyMaterialUnder(name, text) {
  const value = text.trim();
  if (!/key|code|ключ|код/iu.test(name) || !looksLikeKeyMaterial(value)) {
    return false;
  }
  const parts = credentialKeyParts(name);
  return (
    !namesPublicIdentifier(parts) &&
    !isProntoCode(value) &&
    !isBroadlinkIrCode(parts, value)
  );
}

// A Tuya productKey names a device model and is the same on every device
// of it, a product code is a model or GTIN number, a scene code numbers a
// scene or a button: none of them opens anything.
function namesPublicIdentifier(parts) {
  const [qualifier, last] = parts.slice(-2);
  return (
    (qualifier === "product" && (last === "key" || last === "code")) ||
    (qualifier === "scene" && last === "code")
  );
}

// A learned Pronto IR code: groups of four hex digits, 0000 first, then
// the carrier and the burst pair counts of its two sequences, which give
// the number of groups. A remote sends it to anyone in the room; a key
// written in groups of four does not fit these counts.
function isProntoCode(text) {
  const words = text.split(/\s+/);
  if (!words.every((word) => /^[\dA-Fa-f]{4}$/.test(word))) return false;
  const [format, carrier, once, repeat] = words.map((word) =>
    Number.parseInt(word, 16),
  );
  return (
    format === 0 &&
    carrier > 0 &&
    once + repeat > 0 &&
    words.length === 4 + 2 * (once + repeat)
  );
}

// A Broadlink IR code under a name for an IR, learned or remote code:
// base64 of a packet that starts with 0x26 (infrared), a repeat count and
// the length of its pulse data. An RF packet (0xb2, 0xd7) can open a gate
// or a garage and stays hidden.
const IR_CODE_PARTS = new Set(["ir", "learn", "learned", "learning", "remote"]);

function isBroadlinkIrCode(parts, text) {
  if (
    !parts.some((part) => IR_CODE_PARTS.has(part)) ||
    !/^[A-Za-z\d+/]+={0,2}$/.test(text)
  ) {
    return false;
  }
  const packet = Buffer.from(text, "base64");
  return (
    packet.length >= 4 &&
    packet[0] === 0x26 &&
    4 + packet.readUInt16LE(2) <= packet.length
  );
}

function optionStringValue(node) {
  for (const candidate of [node.value, node.configured_value]) {
    if (typeof candidate === "string") return candidate;
    if (typeof candidate?.stringValue === "string") {
      return candidate.stringValue;
    }
  }
  return null;
}

// 16 to 128 hex digits with both digits and letters, byte separators and
// 0x allowed; base64 of 16 to 64 bytes with upper case, lower case and
// digits; or 16 to 64 decimal bytes, as a zigbee2mqtt network_key
// [1, 3, 5, …]. Ordinary values under key or code names stay visible: a
// layout "us", a manufacturer code "115F", a 16-digit product code, a
// short channel list. Identifiers in hex, such as an IEEE address or an
// extended PAN ID, are not named key or code.
function looksLikeKeyMaterial(text) {
  const bytes = /^\[?\s*(\d{1,3}(?:\s*,\s*\d{1,3}){15,63})\s*\]?$/.exec(text);
  if (bytes) return bytes[1].split(",").every((byte) => Number(byte) <= 255);
  const hex = text.replace(/0x/gi, "").replace(/[\s:,-]/g, "");
  if (/^[\da-f]{16,128}$/i.test(hex)) {
    return /\d/.test(hex) && /[a-f]/i.test(hex);
  }
  return (
    /^(?:[A-Za-z\d+/]{22,88}={0,2}|[A-Za-z\d_-]{22,88})$/.test(text) &&
    /[A-Z]/.test(text) &&
    /[a-z]/.test(text) &&
    /\d/.test(text)
  );
}

function redactedNode() {
  return { redacted: true, reason: "sensitive_native_data" };
}

function normalizeLogic(serial, accessoryId, serviceId, logic) {
  if (!logic || typeof logic.type !== "string") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic data.",
    );
  }
  return {
    ref: logicRef(serial, accessoryId, serviceId, logic.type),
    type: logic.type,
    name:
      typeof logic.name === "string"
        ? redactSensitiveText(logic.name)
        : logic.type,
    active: logic.active === true,
  };
}

function normalizeLogicTypes(
  serial,
  accessoryId,
  serviceId,
  logicTypes,
  assignedLogics,
) {
  const assigned = new Set(assignedLogics.map(({ type }) => type));
  return logicTypes.map((logicType) => {
    if (!logicType || typeof logicType.type !== "string") {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned incomplete logic type data.",
      );
    }
    return {
      ref: logicRef(serial, accessoryId, serviceId, logicType.type),
      type: logicType.type,
      name:
        typeof logicType.name === "string"
          ? redactSensitiveText(logicType.name)
          : logicType.type,
      description:
        typeof logicType.desc === "string"
          ? redactSensitiveText(logicType.desc)
          : "",
      assigned: assigned.has(logicType.type),
    };
  });
}

function normalizeLogicOption(option, changeContext) {
  if (!option || typeof option.key !== "string") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned a logic option without a native key.",
    );
  }
  if (isSensitiveNativeNode(option)) return redactedNode();
  const configured = extractTypedValue(option.value);
  return {
    key: redactSensitiveText(option.key),
    name:
      typeof option.name === "string" ? redactSensitiveText(option.name) : "",
    type:
      typeof option.type === "string" ? redactSensitiveText(option.type) : null,
    input_type: option.inputType ?? null,
    value: configured.found ? sanitizeNativeData(configured.value) : null,
    value_kind: configured.found ? configured.field : null,
    capabilities: {
      read: option.read === true,
      write: option.write === true,
      disabled: typeof option.disabled === "boolean" ? option.disabled : null,
    },
    ...(option.minValue !== undefined ? { min: option.minValue } : {}),
    ...(option.maxValue !== undefined ? { max: option.maxValue } : {}),
    ...(option.minStep !== undefined ? { step: option.minStep } : {}),
    native_change: publicNativeOptionChange(option, changeContext),
  };
}

function publicNativeOptionChange(
  option,
  { operation, targetRef, allowText = false, writesSupported = true },
) {
  if (!writesSupported) {
    return {
      native_write: option.write === true,
      supported: false,
      reason: "unsupported_home_settings_write",
    };
  }
  const inspected = inspectNativeOption(option, { allowText });
  if (!inspected.supported) {
    return {
      native_write: option?.write === true,
      supported: false,
      reason: inspected.reason,
    };
  }
  return {
    native_write: option.write === true,
    supported: true,
    operation,
    next: {
      tool: "get_native_change_contract",
      arguments: {
        operation,
        target_ref: targetRef,
        option_key: option.key,
      },
    },
  };
}

// The options of a scenario's options window that window_option changes on
// the scenario ref, and the scenario field each one sets.
const SCENARIO_METADATA_FIELDS = {
  Name: "name",
  Desc: "desc",
  OnStart: "onStart",
  Sync: "sync",
};

// The value shown is the scenario's own: a LOGIC's window keeps the values
// last written to it, and a built-in's shows placeholders
// (research/protocol/2026-10-13-wave4-contracts.md 1.7, 1.11).
function scenarioMetadataOption(scenario, option, entity) {
  const normalized = normalizeOption(option, {
    operation: "window_option",
    targetRef: entity.ref,
    allowText: true,
  });
  if (normalized.redacted) return normalized;
  const current = scenario[SCENARIO_METADATA_FIELDS[option.key]];
  return {
    ...normalized,
    configured_value:
      current === undefined ? null : sanitizeNativeData(current),
    ...(scenario.predefined === true
      ? {
          native_change: {
            native_write: option.write === true,
            supported: false,
            reason: "predefined_scenario_read_only",
          },
        }
      : scenario.type === "LOGIC" &&
          option.key !== "Sync" &&
          normalized.native_change?.supported === true
        ? {
            // A LOGIC's code sets its name, description and onStart from
            // info on every code write (1.5): they are changed there, with
            // logic_source_update, unless the agent cannot read that code.
            native_change: {
              native_write: option.write === true,
              supported: false,
              reason: "logic_info_in_code",
              ...(hiddenLogicCode(scenario.data)
                ? { message: hiddenLogicInfo(option.key) }
                : {
                    next: {
                      tool: "get_entity",
                      arguments: {
                        entity_ref: entity.ref,
                        include: ["configuration"],
                      },
                    },
                  }),
            },
          }
        : {}),
  };
}

// Code with credential-shaped text reads back as [REDACTED] in every answer
// (redactSensitiveText, as get_entity shows the configuration), and writing
// the mark back is refused: the agent can neither read nor rewrite info in
// it.
export function hiddenLogicCode(source) {
  return (
    typeof source === "string" &&
    redactSensitiveText(source, "javascript_source") === "[REDACTED]"
  );
}

// What the agent tells the owner about a LOGIC's Name, Desc or OnStart in
// such code.
export function hiddenLogicInfo(optionKey) {
  const field = { Name: "name", Desc: "description", OnStart: "onStart" }[
    optionKey
  ];
  return `This LOGIC's ${optionKey} is info.${field} in its code, and its code holds credential-shaped text that sprut-agent shows only as [REDACTED]: the agent cannot read or rewrite that code, so it cannot change this. Tell the owner to change info.${field} in the code in the SprutHub app; a change in the scenario's options would last only until the next code write.`;
}

function codeScenarioSummary(scenario) {
  return {
    format: "code",
    type: scenario.type,
    targets_known: false,
    ...(scenario.type === "LOGIC" ? { assigned_to: "not_read" } : {}),
    limitation:
      scenario.type === "LOGIC"
        ? "Code is not analyzed: its triggers, conditions and targets are unknown. A LOGIC runs for the services it is assigned to; get_entity on a service lists its assigned_logics."
        : "Code is not analyzed: its triggers, conditions and targets are unknown.",
  };
}

// Where a code source names an accessory, by the Hub methods of the
// hub's scenario.sdk that take its id first (ACCESSORY_ID_METHODS) with the
// id written as a number, or by a string that is exactly its name.
// Comments do not count; an id held in a variable is not found. Returns
// found_by and the first lines, or null.
function accessoryMentions(source, { id, name }) {
  const tokens = [];
  let line = 1;
  for (const token of jsTokens(source)) {
    if (!JAVASCRIPT_TRIVIA.has(token.type)) tokens.push({ ...token, line });
    line += token.value.match(/\r\n|[\n\r\u2028\u2029]/g)?.length ?? 0;
  }
  const foundBy = new Set();
  const lines = new Set();
  tokens.forEach((token, index) => {
    const after = (offset) => tokens[index + offset];
    const byId =
      token.type === "IdentifierName" &&
      token.value === "Hub" &&
      after(1)?.value === "." &&
      ACCESSORY_ID_METHODS.has(after(2)?.value) &&
      after(3)?.value === "(" &&
      after(4)?.type === "NumericLiteral" &&
      Number(after(4).value) === id &&
      [")", ","].includes(after(5)?.value);
    const byName =
      ["StringLiteral", "NoSubstitutionTemplate"].includes(token.type) &&
      token.closed !== false &&
      typeof name === "string" &&
      name !== "" &&
      token.value.length >= 2 &&
      !token.value.includes("\\") &&
      token.value.slice(1, -1) === name;
    if (byId) foundBy.add("accessory_id");
    if (byName) foundBy.add("accessory_name");
    if (byId || byName) lines.add(token.line);
  });
  if (foundBy.size === 0) return null;
  return {
    found_by: ["accessory_id", "accessory_name"].filter((kind) =>
      foundBy.has(kind),
    ),
    lines: [...lines].sort((a, b) => a - b).slice(0, 10),
  };
}

// Hub methods whose first argument is an accessory id, as the owner hub's
// scenario.sdk declares them: read on 2026-09-09
// (research/protocol/2026-09-09-automations.md) and again, the same
// SHA-256, on 2026-10-13.
const ACCESSORY_ID_METHODS = new Set([
  "getAccessory",
  "getCharacteristic",
  "getCharacteristicValue",
  "setCharacteristicValue",
  "toggleCharacteristicValue",
]);

const JAVASCRIPT_TRIVIA = new Set([
  "HashbangComment",
  "LineTerminatorSequence",
  "MultiLineComment",
  "SingleLineComment",
  "WhiteSpace",
]);

function normalizeScenarioConfiguration(scenario) {
  if (typeof scenario.data !== "string") {
    return { format: "not_returned", value: null };
  }
  if (scenario.type === "BLOCK") {
    try {
      return {
        format: "json",
        // A request URL other than scheme and host may carry a key.
        value: sanitizeNativeData(
          withHiddenHttpUrls(JSON.parse(scenario.data)),
        ),
      };
    } catch {
      return {
        format: "invalid_json",
        value: redactSensitiveText(scenario.data),
      };
    }
  }
  return {
    format: "code",
    value: redactSensitiveText(scenario.data, "javascript_source"),
    content_origin: "spruthub_scenario_data",
  };
}

export function sanitizeNativeData(value, key = "") {
  if (isSensitiveNativeNode(value, key)) return redactedNode();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNativeData(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeNativeData(childValue, childKey),
      ]),
    );
  }
  return typeof value === "string" ? redactSensitiveText(value) : value;
}

export function sanitizeAgentOutput(
  value,
  sensitiveValues = [],
  { stringRoles = {} } = {},
) {
  const codeConfiguration = scenarioCodeConfiguration(value);
  return sanitizeAgentValue(
    value,
    sensitiveValues,
    codeConfiguration,
    stringRoles,
    "",
  );
}

function sanitizeAgentValue(
  value,
  sensitiveValues,
  codeConfiguration,
  stringRoles,
  path,
) {
  if (isRedactedNode(value)) return redactedNode();
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeAgentValue(
        item,
        sensitiveValues,
        codeConfiguration,
        stringRoles,
        `${path}/${index}`,
      ),
    );
  }
  if (value && typeof value === "object") {
    if (
      Object.keys(value).some((key) =>
        sensitiveValues.some((secret) => key.includes(secret)),
      )
    ) {
      return redactedNode();
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [
        key,
        sanitizeAgentValue(
          childValue,
          sensitiveValues,
          codeConfiguration,
          stringRoles,
          `${path}/${escapeJsonPointerToken(key)}`,
        ),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const role =
    path === "/entity/configuration/value" && codeConfiguration !== null
      ? "javascript_source"
      : (stringRoles[path] ?? "data");
  return redactAgentString(value, sensitiveValues, role);
}

function redactAgentString(value, sensitiveValues, role) {
  if (sensitiveValues.some((secret) => value.includes(secret))) {
    return "[REDACTED]";
  }
  return redactSensitiveText(value, role);
}

function escapeJsonPointerToken(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function scenarioCodeConfiguration(result) {
  const entity = result?.entity;
  const configuration = entity?.configuration;
  return entity?.kind === "scenario" && configuration?.format === "code"
    ? configuration
    : null;
}

export function isRedactedNode(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.redacted === true &&
    value.reason === "sensitive_native_data"
  );
}

const sensitiveKeyPattern =
  /(?:password|passwd|secret|credential|authorization|(?:api|access|refresh|client|private|wifi)[_-]?(?:key|token|secret|password)|token)/i;
function isSensitiveKey(key) {
  return (
    sensitiveKeyPattern.test(key) ||
    isPairingCodeKey(key) ||
    namesKeyMaterial(key)
  );
}

// Names of key material and of codes that grant access, by whole name parts
// so TimeZone, KeyboardLayout, KeyCode or testManufacturerCode stay visible:
// the ZigBee controller's NetworkKey, LinkKey and InstallCode, the HomeKit
// PinCodeVisible (owner's hub, 2026-10-12), a keypad passcode, a Wi-Fi PSK
// or WPA key, a Tuya LocalKey, a lock's UserCode or AdminPin, an MQTT or
// access point password named MqttPass or ApPass, a Cookie.
const KEY_MATERIAL_PARTS = new Set([
  "installcode",
  "linkkey",
  "networkkey",
  "nwkkey",
  "otp",
  "passcode",
  "passphrase",
  "pincode",
  "psk",
  "setupcode",
  "totp",
]);
const KEY_QUALIFIERS = new Set([
  "aes",
  "auth",
  "beacon",
  "bind",
  "crypto",
  "encryption",
  "link",
  "local",
  "master",
  "network",
  "nwk",
  "private",
  "secret",
  "security",
  "shared",
  "signing",
  "wep",
  "wpa",
]);
const CODE_QUALIFIERS = new Set([
  "access",
  "activation",
  "admin",
  "auth",
  "confirmation",
  "guest",
  "install",
  "installation",
  "login",
  "master",
  "pair",
  "pairing",
  "pass",
  "pin",
  "security",
  "secret",
  "setup",
  "unlock",
  "user",
  "verification",
]);
// A pin is a PIN code when it says whose or what it opens; a hardware
// GpioPin, LedPin or ResetPin says none of these.
const PIN_QUALIFIERS = new Set([
  "access",
  "admin",
  "alarm",
  "auth",
  "device",
  "door",
  "guest",
  "keypad",
  "lock",
  "login",
  "master",
  "owner",
  "pair",
  "pairing",
  "security",
  "service",
  "setup",
  "sim",
  "unlock",
  "user",
]);

function namesKeyMaterial(key) {
  const parts = credentialKeyParts(key);
  const last = parts.at(-1);
  return (
    parts.some(
      (part, index) =>
        KEY_MATERIAL_PARTS.has(part) ||
        (parts[index + 1] === "key" && KEY_QUALIFIERS.has(part)) ||
        (parts[index + 1] === "code" && CODE_QUALIFIERS.has(part)) ||
        (parts[index + 1] === "pin" && PIN_QUALIFIERS.has(part)),
    ) ||
    // A password under a short name: MqttPass, wifiPass, ApPass; not
    // PassThrough. A bare Pass is an option rule (namesOptionSecret).
    (last === "pass" && parts.length > 1) ||
    last === "cookie" ||
    last === "cookies"
  );
}

// Name parts split at case changes and at _ - / . and spaces, so that a
// cluster attribute path /1/0101_DoorLock/0005_PinCode/255 or a dotted
// zigbee.networkKey has the same parts as PinCode or NetworkKey.
function credentialKeyParts(key) {
  return key
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s\-/.]+/)
    .map((part) => part.replace(/^\$+/u, "").toLowerCase())
    .filter(Boolean);
}

function isPairingCodeKey(key) {
  // Pairing PIN/code adds a client. The hub may expose it as STATUS, so
  // PASSWORD inputType is not enough. Hardware pin numbers stay visible.
  const parts = credentialKeyParts(key);
  const last = parts.at(-1);
  if (last == null) return false;
  if (["pincode", "paircode", "pairingcode"].includes(last)) return true;
  if (last === "code") {
    return parts.some((part) => ["pin", "pair", "pairing"].includes(part));
  }
  return (
    last === "pin" && parts.some((part) => ["pair", "pairing"].includes(part))
  );
}

function isSensitiveAssignmentKey(key) {
  // A text match hides the whole source, while a structural match only hides
  // one node, so text requires a complete credential-shaped name.
  const parts = credentialKeyParts(key);
  const last = parts.at(-1);
  if (
    [
      "authorization",
      "credential",
      "passwd",
      "password",
      "secret",
      "token",
    ].includes(last)
  ) {
    return true;
  }
  if (
    /^(?:apikey|apitoken|accesstoken|refreshtoken|clientsecret|wifipassword|privatekey)$/.test(
      last,
    )
  ) {
    return true;
  }
  if (isPairingCodeKey(key) || namesKeyMaterial(key)) return true;
  return (
    last === "key" &&
    parts.some((part) => ["access", "api", "private", "secret"].includes(part))
  );
}

function isSensitiveContainerKey(key) {
  return /^(?:auth|authentication|authorization|connection|credentials?)$/i.test(
    key,
  );
}

function redactSensitiveText(text, role = "data") {
  const containsCredential =
    /\bBearer\s+[^\s;"'<>]+/i.test(text) ||
    // A URL with a user name and password, as in a BLOCK request.
    /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@:]+:[^\s/?#@]+@/i.test(text) ||
    // A link whose query carries a login code, token or key, as the hub
    // user's login link …/user/login?code=… (owner's hub, 2026-10-12).
    /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]*[?&;](?:code|token|access_token|auth|key|api_?key|secret|password|passwd|pass|pin)=[^&\s"'<>#]/i.test(
      text,
    ) ||
    // The same link without its host, as the web client also gives it:
    // /user/login?code=…
    /\/[^\s"'<>?#]{0,512}\?(?:[^\s"'<>#]{0,512}?[&;])?(?:code|token|access_token|auth|key|api_?key|secret|password|passwd|pass|pin)=[^&;\s"'<>#]/i.test(
      text,
    ) ||
    // A HomeKit setup payload, which pairs a controller with the bridge.
    /\bX-HM:\/\/[\dA-Z]{9}/i.test(text) ||
    // A Wi-Fi QR payload with a password: WIFI:T:WPA;S:<ssid>;P:<password>;;
    // A payload ends where the next payload could begin, a WIFI: after no
    // letter, digit or _, so a text of many WIFI: and no P: is read once,
    // not once from each WIFI:. A name such as Home_WIFI: stays inside it.
    /\bWIFI:(?:(?:(?!\bWIFI:)[^;])*;)*?P:[^;]/.test(text) ||
    containsLabelledKeyMaterial(text) ||
    containsSensitiveAssignment(text, role);
  return containsCredential ? "[REDACTED]" : text;
}

// A key under a label that names a key or code: the label, : or =, then
// the key itself (isKeyMaterialUnder), optionally quoted. «<b>Install
// code</b>: 83FE…» in device HTML, «Ключ сети: [1, 3, …]», "deviceKey":
// "9c2e…". Tags between the label and the key are skipped. Prose under
// such a label («Network key: изменён») and hex under other labels (an
// IEEE address) stay. Each value shape takes at most one byte or character
// more than key material has, so a longer value fails looksLikeKeyMaterial
// and a long run of hex pairs and colons is not rescanned in full at every
// colon.
const KEY_VALUE_SHAPES = [
  // Decimal bytes, in brackets or not.
  /[ \t]?["']?\[?[ \t]?(\d{1,3}(?:[ \t]?,[ \t]?\d{1,3}){0,64})/y,
  // Hex, with or without byte separators and 0x.
  /[ \t]?["']?((?:0x)?[\dA-Fa-f]{2}(?:[ \t]?[:,-]?[ \t]?(?:0x)?[\dA-Fa-f]{2}){0,64})(?![\dA-Za-z])/y,
  // Base64, standard or URL-safe.
  /[ \t]?["']?([A-Za-z\d+/_-]{1,89}={0,2})(?![\w+/=-])/y,
];
const KEY_LABEL = /([\p{L}\d]+(?:[ _-][\p{L}\d]+){0,3})["']?[ \t]*$/u;

function containsLabelledKeyMaterial(text) {
  const plain = text.includes("<")
    ? text.replace(/<\/?[A-Za-z][^<>]*>/g, " ")
    : text;
  for (const separator of plain.matchAll(/[:=]/g)) {
    const values = KEY_VALUE_SHAPES.map((shape) => {
      shape.lastIndex = separator.index + 1;
      return shape.exec(plain)?.[1];
    }).filter((value) => value !== undefined && looksLikeKeyMaterial(value));
    if (values.length === 0) continue;
    const label = KEY_LABEL.exec(
      plain.slice(Math.max(0, separator.index - 64), separator.index),
    )?.[1];
    if (
      label !== undefined &&
      values.some((value) => isKeyMaterialUnder(label, value))
    ) {
      return true;
    }
  }
  return false;
}

function containsSensitiveAssignment(text, role) {
  // Every source range is data for redaction. TypeScript syntax is parsed once
  // so parameter types cannot be confused with credential assignments, while
  // the existing policy still decides which names are sensitive.
  let typeScriptDeclarations;
  if (role === "typescript_declarations") {
    typeScriptDeclarations = inspectTypeScriptDeclarations(text);
    if (
      typeScriptDeclarations === null ||
      typeScriptDeclarations.hasSensitiveParameterInitializer
    ) {
      return true;
    }
  }
  let javascriptTokens;
  const separators = /[:=]/g;
  for (const separator of text.matchAll(separators)) {
    const separatorIndex = separator.index;
    if (
      separator[0] === "=" &&
      !isPlainAssignmentEquals(text, separatorIndex)
    ) {
      continue;
    }
    const candidate = assignmentCandidateBefore(text, separatorIndex);
    const hasSensitiveCandidate =
      candidate && isSensitiveAssignmentKey(candidate.value);
    if (!hasSensitiveCandidate) continue;
    if (separator[0] === ":" && role !== "data") {
      javascriptTokens ??= indexedJavaScriptTokens(text);
      if (isKnownJavaScriptValueOrLabel(javascriptTokens, separatorIndex)) {
        continue;
      }
      if (
        role === "typescript_declarations" &&
        typeScriptDeclarations.parameterTypeColons.has(separatorIndex)
      ) {
        continue;
      }
    }
    return true;
  }
  return false;
}

function inspectTypeScriptDeclarations(text) {
  let program;
  try {
    program = parse(text, {
      sourceType: "unambiguous",
      plugins: ["typescript"],
      errorRecovery: true,
    }).program;
  } catch {
    return null;
  }

  const inspection = {
    hasSensitiveParameterInitializer: false,
    parameterTypeColons: new Set(),
  };
  visitTypeScriptNodes(program, (node) => {
    if (!Array.isArray(node.params)) return;
    for (const parameter of node.params) {
      inspectTypeScriptParameter(parameter, inspection);
    }
  });
  return inspection;
}

function visitTypeScriptNodes(node, visitor) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") {
    return;
  }
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (["comments", "errors", "loc", "tokens"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) visitTypeScriptNodes(item, visitor);
    } else {
      visitTypeScriptNodes(value, visitor);
    }
  }
}

function inspectTypeScriptParameter(parameter, inspection) {
  const unwrapped =
    parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const binding =
    unwrapped.type === "AssignmentPattern" ? unwrapped.left : unwrapped;
  const typeAnnotation = binding.typeAnnotation;
  if (Number.isInteger(typeAnnotation?.start)) {
    inspection.parameterTypeColons.add(typeAnnotation.start);
  }
  if (
    unwrapped.type === "AssignmentPattern" &&
    isSensitiveAssignmentKey(typeScriptParameterName(binding) ?? "")
  ) {
    inspection.hasSensitiveParameterInitializer = true;
  }
}

function typeScriptParameterName(parameter) {
  if (parameter.type === "Identifier") return parameter.name;
  if (parameter.type === "RestElement") {
    return typeScriptParameterName(parameter.argument);
  }
  return null;
}

function assignmentCandidateBefore(text, separatorIndex) {
  let end = skipWhitespaceBackward(text, separatorIndex);
  let bracketed = false;
  if (text[end - 1] === "]") {
    bracketed = true;
    end = skipWhitespaceBackward(text, end - 1);
  }
  const candidate =
    quotedAssignmentCandidate(text, end) ?? bareAssignmentCandidate(text, end);
  if (!candidate || !bracketed) return candidate;
  const beforeCandidate = skipWhitespaceBackward(text, candidate.start);
  return text[beforeCandidate - 1] === "[" ? candidate : null;
}

function quotedAssignmentCandidate(text, end) {
  const quote = text[end - 1];
  if (quote !== '"' && quote !== "'") return null;
  const escapedDelimiter = countBackslashesBefore(text, end - 1) % 2 === 1;
  const closeStart = escapedDelimiter ? end - 2 : end - 1;
  for (let index = closeStart - 1; index >= 0; index -= 1) {
    if (text[index] !== quote) continue;
    const escaped = countBackslashesBefore(text, index) % 2 === 1;
    if (escaped !== escapedDelimiter) continue;
    const start = escapedDelimiter ? index - 1 : index;
    if (start < 0) return null;
    return {
      start,
      value: text
        .slice(index + 1, closeStart)
        .replace(/\\(?:\r\n|[\s\S])/g, (value) => value.slice(1)),
    };
  }
  return null;
}

function bareAssignmentCandidate(text, end) {
  let start = end;
  while (start > 0 && /[\w$-]/u.test(text[start - 1])) {
    start -= 1;
  }
  return start === end ? null : { start, value: text.slice(start, end) };
}

function skipWhitespaceBackward(text, end) {
  while (end > 0 && /\s/u.test(text[end - 1])) end -= 1;
  return end;
}

function countBackslashesBefore(text, index) {
  let count = 0;
  while (index - count - 1 >= 0 && text[index - count - 1] === "\\") {
    count += 1;
  }
  return count;
}

function isPlainAssignmentEquals(text, index) {
  return (
    !/[=!<>+\-*/%&|^?]/u.test(text[index - 1] ?? "") &&
    !/[=>]/u.test(text[index + 1] ?? "")
  );
}

function indexedJavaScriptTokens(text) {
  let offset = 0;
  const tokens = Array.from(jsTokens(text), (token) => {
    const indexed = {
      ...token,
      start: offset,
      end: offset + token.value.length,
    };
    offset = indexed.end;
    return indexed;
  }).filter(
    ({ type }) =>
      ![
        "HashbangComment",
        "LineTerminatorSequence",
        "MultiLineComment",
        "SingleLineComment",
        "WhiteSpace",
      ].includes(type),
  );
  return {
    tokens,
    tokenIndexByStart: new Map(
      tokens.map((token, index) => [token.start, index]),
    ),
  };
}

function isKnownJavaScriptValueOrLabel(context, separatorIndex) {
  const separatorTokenIndex = context.tokenIndexByStart.get(separatorIndex);
  const separator = context.tokens[separatorTokenIndex];
  if (separator?.type !== "Punctuator" || separator.value !== ":") return false;
  return (
    isJavaScriptTernaryColon(context.tokens, separatorTokenIndex) ||
    isJavaScriptCaseLabel(context.tokens, separatorTokenIndex)
  );
}

const javascriptContextLookbehindTokenLimit = 256;

function isJavaScriptTernaryColon(tokens, separatorTokenIndex) {
  let delimiterDepth = 0;
  let nestedTernaries = 0;
  let remaining = javascriptContextLookbehindTokenLimit;
  for (
    let index = separatorTokenIndex - 1;
    index >= 0 && remaining > 0;
    index -= 1, remaining -= 1
  ) {
    const value = tokens[index].value;
    if ([")", "]", "}"].includes(value)) {
      delimiterDepth += 1;
      continue;
    }
    if (["(", "[", "{"].includes(value)) {
      if (delimiterDepth === 0) return false;
      delimiterDepth -= 1;
      continue;
    }
    if (delimiterDepth > 0) continue;
    if (value === ":") {
      nestedTernaries += 1;
    } else if (value === "?") {
      if (nestedTernaries === 0) return true;
      nestedTernaries -= 1;
    } else if (value === ";" || value === "case") {
      return false;
    }
  }
  return false;
}

function isJavaScriptCaseLabel(tokens, separatorTokenIndex) {
  let delimiterDepth = 0;
  let remaining = javascriptContextLookbehindTokenLimit;
  for (
    let index = separatorTokenIndex - 1;
    index >= 0 && remaining > 0;
    index -= 1, remaining -= 1
  ) {
    const value = tokens[index].value;
    if ([")", "]", "}"].includes(value)) {
      delimiterDepth += 1;
      continue;
    }
    if (["(", "[", "{"].includes(value)) {
      if (delimiterDepth === 0) return false;
      delimiterDepth -= 1;
      continue;
    }
    if (delimiterDepth > 0) continue;
    if (value === "case") return true;
    if ([":", ";", "?"].includes(value)) return false;
  }
  return false;
}

function timeoutError() {
  return new SprutHubError(
    "timeout",
    "SprutHub did not respond within the request budget.",
    "retry",
    { capability_status: "unknown" },
  );
}

function validateRoom(room, expectedId) {
  if (
    !room ||
    !isStableId(room.id) ||
    typeof room.name !== "string" ||
    (expectedId !== undefined && room.id !== expectedId)
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete room data.",
    );
  }
}

function validateAccessory(accessory) {
  if (
    !accessory ||
    !isStableId(accessory.id) ||
    !isStableId(accessory.roomId) ||
    typeof accessory.name !== "string" ||
    typeof accessory.online !== "boolean" ||
    (accessory.services !== undefined && !Array.isArray(accessory.services))
  ) {
    throw incompleteAccessoryError();
  }

  for (const service of accessory.services ?? []) {
    if (
      !service ||
      !isStableId(service.sId) ||
      typeof service.name !== "string" ||
      typeof service.type !== "string" ||
      (service.characteristics !== undefined &&
        !Array.isArray(service.characteristics))
    ) {
      throw incompleteAccessoryError();
    }

    for (const characteristic of service.characteristics ?? []) {
      const control = characteristic?.control;
      if (
        !isStableId(characteristic?.cId) ||
        !control ||
        typeof control.name !== "string" ||
        (typeof control.type !== "string" && typeof control.key !== "string") ||
        (control.unit != null && typeof control.unit !== "string") ||
        (control.read === true &&
          control.validValues !== undefined &&
          !Array.isArray(control.validValues))
      ) {
        throw incompleteAccessoryError();
      }

      for (const validValue of control.read === true
        ? (control.validValues ?? [])
        : []) {
        if (
          !validValue ||
          typeof validValue.key !== "string" ||
          typeof validValue.name !== "string" ||
          !extractTypedValue(validValue.value).found
        ) {
          throw incompleteAccessoryError();
        }
      }
    }
  }
  return accessory;
}

function normalizeLink(link) {
  if (
    !link ||
    typeof link.index !== "string" ||
    link.index.length === 0 ||
    !["SYSTEM", "IN", "OUT"].includes(link.type) ||
    (link.characteristics !== undefined && !Array.isArray(link.characteristics))
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete link data.",
    );
  }
  const characteristics = link.characteristics ?? [];
  for (const characteristic of characteristics) {
    if (
      !isStableId(characteristic?.aId) ||
      !isStableId(characteristic?.sId) ||
      !isStableId(characteristic?.cId)
    ) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned incomplete link data.",
      );
    }
  }
  return { ...link, characteristics };
}

function incompleteAccessoryError() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned incomplete accessory data.",
  );
}

function isStableId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function extractTypedValue(value) {
  if (!value) return { found: false, field: null, value: null };
  for (const field of VALUE_FIELDS) {
    if (Object.hasOwn(value, field)) {
      return { found: true, field, value: value[field] };
    }
  }
  return { found: false, field: null, value: null };
}

function nativeMethod(params) {
  const [domain] = Object.keys(params ?? {});
  const [operation] = Object.keys(params?.[domain] ?? {});
  return `${domain}.${operation}`;
}

// The characteristic of a write of its value alone (a device command), or
// null.
function valueWriteTarget(params) {
  const update = params?.characteristic?.update;
  if (
    !isPlainObject(update) ||
    Object.keys(update).sort().join() !== "aId,cId,control,sId" ||
    !isPlainObject(update.control) ||
    Object.keys(update.control).join() !== "value"
  ) {
    return null;
  }
  return { aId: update.aId, sId: update.sId, cId: update.cId };
}

// A characteristic's notification setting, which accessory lists do not
// carry (2026-10-12-notifications-live).
function isNotifyWrite(params) {
  const update = params?.characteristic?.update;
  return (
    isPlainObject(update) &&
    Object.keys(update).sort().join() === "aId,cId,notify,sId"
  );
}

function nativeCharacteristicKey({ aId, sId, cId } = {}) {
  return [aId, sId, cId].every(isStableId) ? `${aId}:${sId}:${cId}` : null;
}

function normalizeEventValue(typed) {
  const type = {
    boolValue: "boolean",
    intValue: "integer",
    longValue: "integer",
    doubleValue: "number",
    stringValue: "string",
  }[typed.field];
  return {
    type: type ?? "unknown",
    value: typed.found ? typed.value : null,
  };
}

export function matchEnumValue(validValues, currentValue) {
  if (!currentValue.found) return null;
  const match = validValues.find((validValue) => {
    const candidate = extractTypedValue(validValue.value);
    return (
      candidate.found &&
      candidate.field === currentValue.field &&
      Object.is(candidate.value, currentValue.value)
    );
  });
  return match ? { key: match.key, name: match.name } : null;
}

function selectableCharacteristicValues(control, currentValue) {
  if (!currentValue.found) return [];
  const scalarContract = nativeScalarContract(control, currentValue.field);
  return control.validValues.flatMap((validValue) => {
    const candidate = extractTypedValue(validValue.value);
    const typed = candidate.found
      ? { value: candidate.value, kind: candidate.field }
      : null;
    return isSelectableNativeValidValue(validValue, typed, scalarContract)
      ? [
          {
            key: validValue.key,
            name: validValue.name,
            value: candidate.value,
          },
        ]
      : [];
  });
}
