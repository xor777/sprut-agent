import { randomUUID } from "node:crypto";
import { parse } from "@babel/parser";
import jsTokens from "js-tokens";
import { WebSocket } from "ws";
import {
  blockBindings,
  blockSummary,
  decodeBlock,
  relationRole,
} from "./block-summary.mjs";
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
// A room above this many services returns its size and a paged
// read_services call instead of listing every accessory and service.
const ROOM_LISTING_SERVICE_LIMIT = 20;
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
  #nextRequestId = 1;
  #observation;
  #observationClient;
  #pending = new Map();
  #socket;
  #startingObservationClient;

  constructor({
    url,
    token,
    serial,
    configuredSerial = serial,
    availableHomeCount = null,
    cid,
    timeoutMs = 10_000,
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
  }

  async listHomes() {
    const deadline = Date.now() + this.timeoutMs;
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

  async inspectHome(homeReference) {
    const serial = parseHomeRef(homeReference);
    const deadline = Date.now() + this.timeoutMs;
    const { home, observedAt: homeObservedAt } = await this.#requireHome(
      serial,
      deadline,
    );
    const [roomsResponse, scenariosResponse, extensionsResponse] =
      await Promise.all([
        this.#request({ room: { list: {} } }, deadline, { serial }),
        this.#request({ scenario: { list: {} } }, deadline, { serial }),
        this.#request({ extension: { list: {} } }, deadline, { serial }),
      ]);
    const rooms = extractNativeList(roomsResponse, ["room", "list", "rooms"]);
    const scenarios = extractNativeList(scenariosResponse, [
      "scenario",
      "list",
      "scenarios",
    ]);
    const extensions = extractNativeList(extensionsResponse, [
      "extension",
      "list",
      "extensions",
    ]);
    const normalizedExtensions = normalizeExtensions(serial, extensions);
    rooms.forEach((room) => {
      validateRoom(room);
    });
    const observedAt = latestObservedAt([
      homeObservedAt,
      roomsResponse.responseReceivedAt,
      scenariosResponse.responseReceivedAt,
      extensionsResponse.responseReceivedAt,
    ]);
    return {
      status: "ok",
      home: normalizeHome(home, homeObservedAt),
      entities: {
        rooms: rooms.map((room) => ({
          ref: roomRef(serial, room.id),
          name: room.name,
        })),
        scenarios: scenarios.map((scenario) =>
          normalizeScenarioSummary(serial, scenario),
        ),
        extensions: normalizedExtensions,
      },
      coverage: [
        capability(
          "account_homes",
          "hub.list",
          "live_confirmed",
          homeObservedAt,
        ),
        capability(
          "rooms",
          "room.list",
          "live_confirmed",
          roomsResponse.responseReceivedAt,
        ),
        capability(
          "scenarios",
          "scenario.list",
          "live_confirmed",
          scenariosResponse.responseReceivedAt,
        ),
        capability(
          "extensions",
          "extension.list",
          "live_confirmed",
          extensionsResponse.responseReceivedAt,
        ),
      ],
      unsupported_in_this_slice: [
        "pairing and controller actions",
        "history of characteristic values and events, and unbounded monitoring",
        "dashboards",
        "backups",
      ],
      freshness: freshness(observedAt),
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
        "get_native_observation",
        { observation_ref: activeClient.#observation?.ref },
      );
    }

    const candidate = new SprutHubClient({
      url: this.url,
      token: this.token,
      serial: this.serial,
      cid: this.cid,
      timeoutMs: this.timeoutMs,
    });
    this.#startingObservationClient = candidate;
    try {
      const result = await candidate.#startNativeObservation(input);
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

  async #startNativeObservation({
    homeRef: selectedHomeRef,
    characteristicRefs,
    scenarioRef: selectedScenarioRef,
    durationSeconds,
    maxEvents,
  }) {
    if (this.#observation && !isTerminalObservation(this.#observation.status)) {
      throw new SprutHubError(
        "observation_in_progress",
        "Another native observation is already running in this MCP process.",
        "get_native_observation",
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
        "start_native_observation",
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
      observation.startedAt = new Date().toISOString();
      observation.endsAt = new Date(
        Date.now() + durationSeconds * 1_000,
      ).toISOString();
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

  async readServices(input) {
    const selection = normalizeServiceSelection(input);
    const deadline = Date.now() + this.timeoutMs;
    if (this.serial === null || selection.serial !== this.serial) {
      await this.#requireHome(selection.serial, deadline);
    }

    const snapshots = selection.room
      ? [await this.#readServiceRoom(selection.room, deadline)]
      : await this.#readServiceHome(selection.serial, deadline);
    const allServices = snapshots
      .flatMap(({ room, accessories, observedAt }) =>
        accessories.flatMap((accessory) =>
          (accessory.services ?? []).map((service) => {
            const identity = normalizeServiceIdentity(
              selection.serial,
              room,
              accessory,
              service,
              observedAt,
            );
            return selection.representation === "catalog"
              ? { ...identity, readings_status: "not_requested" }
              : {
                  ...identity,
                  readings: normalizeReadableCharacteristics(
                    selection.serial,
                    accessory,
                    service,
                  ),
                };
          }),
        ),
      )
      .sort(compareServiceRefs);
    const observedServiceTypes = [
      ...new Set(allServices.map(({ type }) => type)),
    ];
    const services = selection.serviceTypes
      ? allServices.filter(({ type }) => selection.serviceTypes.includes(type))
      : allServices;
    const observedAt = latestObservedAt(
      snapshots.map(({ observedAt: value }) => value),
    );
    const base = {
      status: "ok",
      representation: selection.representation,
      scope: {
        home_ref: selection.homeRef,
        ...(selection.room
          ? {
              room: {
                ref: roomRef(selection.serial, selection.room.roomId),
                name: snapshots[0].room.name,
              },
            }
          : {}),
      },
      scope_status: allServices.length === 0 ? "empty" : "non_empty",
      match_status: selection.serviceTypes
        ? services.length === 0
          ? "no_matches"
          : "matched"
        : "not_filtered",
      observed_service_types: observedServiceTypes,
      freshness: freshness(observedAt),
    };
    return paginateServices(base, services, selection);
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
        "The hub log is read only from the configured SprutHub home. Use its home_ref from list_homes.",
        "list_homes",
        { next: { tool: "list_homes", arguments: {} } },
      );
    }
    let response;
    try {
      response = await this.#request(
        { log: { list: { count } } },
        Date.now() + this.timeoutMs,
        { serial },
      );
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
    return {
      status: "ok",
      home_ref: homeRef(serial),
      entries: nativeEntries
        .map(normalizeHubLogEntry)
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

  async #readServiceHome(serial, deadline) {
    const [roomsResponse, accessoriesResponse] = await Promise.all([
      this.#request({ room: { list: {} } }, deadline, { serial }),
      // A narrower native expand has not been observed on the target hub. The
      // catalog representation is therefore a safe MCP projection of this
      // confirmed response rather than a guessed transport contract.
      this.#request(
        {
          accessory: {
            list: { expand: "services,characteristics" },
          },
        },
        deadline,
        { serial },
      ),
    ]);
    const rooms = extractNativeList(roomsResponse, ["room", "list", "rooms"]);
    rooms.forEach((room) => {
      validateRoom(room);
    });
    const accessories = extractNativeList(accessoriesResponse, [
      "accessory",
      "list",
      "accessories",
    ]);
    accessories.forEach(validateAccessory);
    const observedAt = latestObservedAt([
      roomsResponse.responseReceivedAt,
      accessoriesResponse.responseReceivedAt,
    ]);
    if (accessories.length === 0) {
      return [
        {
          room: null,
          accessories: [],
          observedAt,
        },
      ];
    }
    const roomsById = new Map(rooms.map((room) => [room.id, room]));
    return accessories.map((accessory) => ({
      room: roomsById.get(accessory.roomId) ?? null,
      accessories: [accessory],
      observedAt,
    }));
  }

  async #readServiceRoom(parsedRoom, deadline) {
    const roomResponse = await this.#request(
      { room: { get: { id: parsedRoom.roomId } } },
      deadline,
      { serial: parsedRoom.serial },
    );
    const roomContainer = roomResponse.result?.room;
    if (!roomContainer || !Object.hasOwn(roomContainer, "get")) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible room response.",
      );
    }
    if (roomContainer.get === null) {
      throw new SprutHubError(
        "room_not_found",
        "The selected SprutHub room was not found.",
        "inspect_home",
      );
    }
    validateRoom(roomContainer.get, parsedRoom.roomId);
    const snapshot = await this.#readServiceRoomForKnownRoom(
      parsedRoom.serial,
      roomContainer.get,
      deadline,
    );
    snapshot.observedAt = latestObservedAt([
      roomResponse.responseReceivedAt,
      snapshot.observedAt,
    ]);
    return snapshot;
  }

  async #readServiceRoomForKnownRoom(serial, room, deadline) {
    const accessoriesResponse = await this.#request(
      {
        accessory: {
          list: {
            roomId: room.id,
            expand: "services,characteristics",
          },
        },
      },
      deadline,
      { serial },
    );
    const accessories = extractNativeList(accessoriesResponse, [
      "accessory",
      "list",
      "accessories",
    ]);
    accessories.forEach(validateAccessory);
    return {
      room,
      accessories: accessories.filter(({ roomId }) => roomId === room.id),
      observedAt: accessoriesResponse.responseReceivedAt,
    };
  }

  async inspectAutomation({ source, target }) {
    const deadline = Date.now() + this.timeoutMs;
    const selections = {};
    for (const [role, selected] of Object.entries({ source, target })) {
      const roomResponse = await this.#request(
        { room: { get: { id: selected.roomId } } },
        deadline,
      );
      const room = roomResponse.result?.room?.get;
      validateRoom(room, selected.roomId);
      const accessoriesResponse = await this.#request(
        {
          accessory: {
            list: {
              roomId: selected.roomId,
              expand: "services,characteristics",
            },
          },
        },
        deadline,
      );
      const accessories = extractNativeList(accessoriesResponse, [
        "accessory",
        "list",
        "accessories",
      ]);
      accessories.forEach(validateAccessory);

      const directScenarios = extractNativeList(
        await this.#request(
          { scenario: { list: { aId: selected.aId } } },
          deadline,
        ),
        ["scenario", "list", "scenarios"],
      );
      const assignedLogics = extractNativeList(
        await this.#request(
          { logic: { list: { aId: selected.aId, sId: selected.sId } } },
          deadline,
        ),
        ["logic", "list", "logics"],
      );
      const links = extractNativeList(
        await this.#request(
          {
            link: {
              list: {
                aId: selected.aId,
                sId: selected.sId,
                cId: selected.cId,
              },
            },
          },
          deadline,
        ),
        ["link", "list", "links"],
      );
      selections[role] = {
        room,
        accessories,
        directScenarios,
        assignedLogics,
        links,
      };
    }
    return selections;
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

  async getScenarioSdk() {
    const response = await this.#request(
      { scenario: { sdk: {} } },
      Date.now() + this.timeoutMs,
    );
    const sdk = response.result?.scenario?.sdk?.sdk;
    if (typeof sdk !== "string" || sdk.length === 0) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incomplete scenario SDK.",
      );
    }
    return { sdk, responseReceivedAt: response.responseReceivedAt };
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
        "list_homes",
      );
    }
    return { home, observedAt };
  }

  async #readEntity(parsed, requested, deadline) {
    let entity;
    let ownerContext = {};
    if (parsed.kind === "home") {
      entity = { kind: "home", ref: homeRef(parsed.serial) };
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
          tool: "read_services",
          arguments: {
            home_ref: homeRef(parsed.serial),
            room_ref: identity.ref,
            representation: "catalog",
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
    for (const association of associations) {
      if (association.type === "BLOCK") continue;
      unchecked.push({
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
          tool: "inspect_home",
          arguments: { home_ref: homeRef(parsed.serial) },
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
      scenario.type === "BLOCK" &&
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
            .filter(
              (option) => option?.key === "Name" || option?.key === "Desc",
            )
            .map((option) =>
              normalizeOption(option, {
                operation: "window_option",
                targetRef: entity.ref,
                allowText: true,
              }),
            );
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
      data = sanitizeNativeData(JSON.parse(scenario.data));
    } catch {
      return { format: "block", status: "invalid_json" };
    }
    const context = await this.#blockNameContext(
      serial,
      blockBindings(data),
      deadline,
    );
    return blockSummary(decodeBlock(data, context), context);
  }

  // Names for a decoded BLOCK: one accessory catalog read (the hub has no
  // read by a list of ids), room names, and the scenario catalog only when
  // the BLOCK runs another scenario. A failed read leaves refs unnamed
  // instead of failing the entity read.
  async #blockNameContext(
    serial,
    { accessoryIds, scenarioIndexes },
    deadline,
    { rooms: readRooms = true } = {},
  ) {
    const needAccessories = accessoryIds.size > 0;
    const needScenarios = scenarioIndexes.size > 0;
    const [accessoriesRead, roomsRead, scenariosRead] = await Promise.all([
      needAccessories
        ? this.#readRelationSource(
            { accessory: { list: { expand: "services,characteristics" } } },
            deadline,
            serial,
            (response) =>
              extractNativeList(response, [
                "accessory",
                "list",
                "accessories",
              ]),
          )
        : null,
      needAccessories && readRooms
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
    const accessories = accessoriesRead?.ok
      ? new Map(
          accessoriesRead.value
            .filter((accessory) => accessoryIds.has(accessory?.id))
            .map((accessory) => [accessory.id, accessory]),
        )
      : null;
    const rooms = roomsRead?.ok
      ? new Map(
          roomsRead.value
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
      isSensitiveControl: (control) => isSensitiveNativeNode(control),
      namesResolved:
        (!needAccessories || accessoriesRead.ok) &&
        (!needScenarios || scenariosRead.ok),
    };
  }

  async #readExtensionEntity(parsed, requested, deadline) {
    const response = await this.#request(
      { extension: { get: { extensionKey: parsed.extensionKey } } },
      deadline,
      { serial: parsed.serial },
    );
    const extension = extractEntity(
      response,
      ["extension", "get"],
      "extension",
    );
    if (extensionKey(extension) !== parsed.extensionKey) {
      throw incompatibleExtensionIdentity();
    }
    const entity = {
      kind: "extension",
      ...normalizeExtensionDetail(parsed.serial, extension),
    };
    if (requested.has("children")) {
      try {
        entity.children = await this.#readExtensionChildren(
          parsed.serial,
          parsed.extensionKey,
          deadline,
        );
      } catch (error) {
        if (!(error instanceof SprutHubError)) throw error;
        // Optional children must not discard a successful extension.get.
        Object.defineProperty(entity, INCLUDE_READ_ERROR, {
          value: {
            ...(entity[INCLUDE_READ_ERROR] ?? {}),
            children: { code: error.code, message: error.message },
          },
          enumerable: false,
        });
      }
    }
    return entity;
  }

  async #readExtensionChildren(serial, selectedExtensionKey, deadline) {
    const response = await this.#request(
      { extensionChild: { list: { extensionKey: selectedExtensionKey } } },
      deadline,
      { serial },
    );
    const children = extractNativeList(response, [
      "extensionChild",
      "list",
      "children",
    ]);
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
    return {
      kind: "window",
      ...normalized.physical_configuration,
      ...(normalized.diagnostics
        ? { diagnostics: normalized.diagnostics }
        : { diagnostics_available: normalized.diagnostics_available }),
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

  async #request(params, deadline, { serial = this.serial } = {}) {
    const socket = await this.#connect(deadline);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();
    const id = this.#nextRequestId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(timeoutError());
        this.#handleConnectionLoss(socket);
        socket.terminate();
      }, remainingMs);
      this.#pending.set(id, { resolve, reject, timer });
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

  async #connect(deadline) {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    if (this.#connectPromise) return this.#connectPromise;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError();

    const connection = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, "json-rpc");
      this.#connectingSocket = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(timeoutError());
        socket.terminate();
      }, remainingMs);
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
        socket.on("error", () => {
          this.#handleConnectionLoss(socket);
          socket.terminate();
        });
        resolve(socket);
      });
      socket.on("message", (data) => this.#handleMessage(data));
      socket.on("close", () => {
        if (!settled) failBeforeOpen();
        this.#handleConnectionLoss(socket);
      });
    });
    this.#connectPromise = connection;

    try {
      return await connection;
    } finally {
      if (this.#connectPromise === connection) {
        this.#connectPromise = undefined;
        this.#connectingSocket = undefined;
      }
    }
  }

  #handleMessage(data) {
    let message;
    try {
      message = parseSprutHubMessage(data);
    } catch (error) {
      if (this.#observation?.status === "observing") {
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
        this.#socket?.terminate();
      }
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.#pending.clear();
      return;
    }

    this.#handleNativeEvent(message);
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);

    if (message.error) {
      let error;
      if (message.error.code === 401) {
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
          "inspect_home",
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
    pending.resolve(message);
  }

  #handleConnectionLoss(socket) {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    if (this.#observation?.status === "observing") {
      this.#observation.connection = {
        status: "lost",
        lost_at: new Date().toISOString(),
      };
      void this.#finishObservation(
        this.#observation,
        "connection_lost",
        "connection_closed",
        false,
      );
    }
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(
        new SprutHubError(
          "connection_closed",
          "The SprutHub connection closed before the response arrived.",
          "retry",
          { capability_status: "unknown" },
        ),
      );
    }
    this.#pending.clear();
  }

  #handleNativeEvent(message) {
    const observation = this.#observation;
    if (observation?.status !== "observing") return;
    const receivedAt = new Date().toISOString();
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
      const normalized = normalizeScenarioLog(log, observation.scenarioIndex);
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
    observation.endedAt = new Date().toISOString();
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
      "start_native_observation",
    );
  }

  #requireObservation(observationRef) {
    if (!this.#observation || this.#observation.ref !== observationRef) {
      throw new SprutHubError(
        "observation_not_found",
        "The native observation is not available in this MCP process.",
        "start_native_observation",
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
        "received_at is local receipt time; source_timestamp is available only for selected native log messages and comes from their SprutHub time field.",
        "Characteristic frames are partial events, not complete saved characteristic state.",
        "Event frames did not identify a home; scope comes from keeping this connection selected to the requested home.",
        "Temporal proximity between scenario and characteristic events does not prove causality or physical effect.",
        "Native log message text is untrusted data; only exact observed scenario formats and paths are included, without deriving causality from the text.",
      ],
      ...(publicStatus === "observing"
        ? {
            next: {
              tool: "get_native_observation",
              arguments: { observation_ref: observation.ref },
            },
            stop: {
              tool: "stop_native_observation",
              arguments: { observation_ref: observation.ref },
            },
          }
        : {}),
    };
  }
}

function normalizeScenarioLog(log, scenarioIndex) {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const sourceTimestamp = nativeLogTimestamp(log.time);
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

// A missing level, path or message stays null (protobuf JSON may omit a
// default); a present value of another form is not a readable log entry.
function normalizeHubLogEntry(log) {
  if (!isPlainObject(log)) throw incompatibleHubLog();
  const time = nativeLogTimestamp(log.time);
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
    "inspect_home",
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

function capability(family, operation, status, observedAt) {
  return {
    family,
    operation,
    status,
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

function homeRef(serial) {
  return `spruthub://hub/${encodeURIComponent(serial)}`;
}

function roomRef(serial, roomId) {
  return `${homeRef(serial)}/room/${roomId}`;
}

function accessoryRef(serial, accessoryId) {
  return `${homeRef(serial)}/accessory/${accessoryId}`;
}

function serviceRef(serial, accessoryId, serviceId) {
  return `${accessoryRef(serial, accessoryId)}/service/${serviceId}`;
}

function characteristicRef(serial, accessoryId, serviceId, characteristicId) {
  return `${serviceRef(serial, accessoryId, serviceId)}/characteristic/${characteristicId}`;
}

function scenarioRef(serial, index) {
  return `${homeRef(serial)}/scenario/${encodeURIComponent(index)}`;
}

function extensionRef(serial, key) {
  return `${homeRef(serial)}/extension/${encodeURIComponent(key)}`;
}

function extensionChildRef(serial, key, id) {
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
  if (parsed.kind !== "home") throw invalidEntityRef("list_homes");
  return parsed.serial;
}

function normalizeServiceSelection({
  homeRef: selectedHomeRef,
  roomRef: selectedRoomRef,
  serviceTypes,
  representation,
  maxBytes,
  cursor,
}) {
  const serial = parseHomeRef(selectedHomeRef);
  let room = null;
  if (selectedRoomRef !== undefined) {
    try {
      room = parseEntityRef(selectedRoomRef);
    } catch {
      throw invalidServiceScope();
    }
    if (room.kind !== "room" || room.serial !== serial) {
      throw invalidServiceScope();
    }
  }
  const normalizedServiceTypes = serviceTypes
    ? [...new Set(serviceTypes)]
    : null;
  const selectedRepresentation = representation ?? "readings";
  const cursorScope = JSON.stringify({
    home_ref: selectedHomeRef,
    room_ref: selectedRoomRef ?? null,
    service_types: normalizedServiceTypes,
    ...(selectedRepresentation === "catalog"
      ? { representation: selectedRepresentation }
      : {}),
  });
  const selection = {
    homeRef: selectedHomeRef,
    roomRef: selectedRoomRef ?? null,
    serial,
    room,
    serviceTypes: normalizedServiceTypes,
    representation: selectedRepresentation,
    representationArgument: representation,
    maxBytes,
    cursorScope,
  };
  return {
    ...selection,
    afterRef: decodeServiceCursor(cursor, cursorScope, selection),
  };
}

function decodeServiceCursor(cursor, expectedScope, selection) {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed?.v !== 2 ||
      typeof parsed.after_ref !== "string" ||
      parsed.after_ref.length === 0 ||
      parsed.scope !== expectedScope
    ) {
      throw new Error("invalid cursor");
    }
    return parsed.after_ref;
  } catch {
    throw invalidServiceCursor(selection);
  }
}

function encodeServiceCursor(afterRef, scope) {
  return Buffer.from(
    JSON.stringify({ v: 2, after_ref: afterRef, scope }),
  ).toString("base64url");
}

function paginateServices(base, services, selection) {
  const start =
    selection.afterRef === null
      ? 0
      : services.findIndex(({ ref }) => ref === selection.afterRef) + 1;
  if (start === 0 && selection.afterRef !== null) {
    throw new SprutHubError(
      "stale_cursor",
      "The selected service set changed before this cursor could be read.",
      "restart_read_services",
      { next: serviceReadNext(selection, null) },
    );
  }
  let end = start;
  while (end < services.length) {
    const candidate = servicePageResult(
      base,
      services.slice(start, end + 1),
      services.length,
      end + 1,
      selection,
    );
    if (serializedResultBytes(candidate) > selection.maxBytes) break;
    end += 1;
  }

  let selected = services.slice(start, end);
  if (selected.length === 0 && start < services.length) {
    selected = [oversizedServiceSummary(services[start])];
    end = start + 1;
  }
  const result = servicePageResult(
    base,
    selected,
    services.length,
    end,
    selection,
  );
  if (serializedResultBytes(result) > selection.maxBytes) {
    throw new SprutHubError(
      "result_too_large",
      "The selected service cannot be represented inside max_bytes without truncation.",
      "narrow_read_services_scope",
      {
        service_ref: services[start]?.ref,
        required_bytes: serializedResultBytes(result),
      },
    );
  }
  return result;
}

function servicePageResult(base, selected, total, end, selection) {
  const nextCursor =
    end < total
      ? encodeServiceCursor(selected.at(-1).ref, selection.cursorScope)
      : null;
  return {
    ...base,
    services: selected,
    page: {
      max_bytes: selection.maxBytes,
      serialized_bytes: 0,
      returned_services: selected.length,
      remaining_services: total - end,
      snapshot: false,
      next_cursor: nextCursor,
    },
    next: nextCursor ? serviceReadNext(selection, nextCursor) : null,
  };
}

function serviceReadNext(selection, cursor) {
  return {
    tool: "read_services",
    arguments: {
      home_ref: selection.homeRef,
      ...(selection.roomRef ? { room_ref: selection.roomRef } : {}),
      ...(selection.serviceTypes
        ? { service_types: selection.serviceTypes }
        : {}),
      ...(selection.representationArgument
        ? { representation: selection.representationArgument }
        : {}),
      max_bytes: selection.maxBytes,
      ...(cursor ? { cursor } : {}),
    },
  };
}

function serializedResultBytes(result) {
  let previous = -1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === previous) return bytes;
    result.page.serialized_bytes = bytes;
    previous = bytes;
  }
  return Buffer.byteLength(JSON.stringify(result));
}

function oversizedServiceSummary(service) {
  const { readings: _readings, ...summary } = service;
  return {
    ...summary,
    readings_status: "not_included",
    reason: "service_exceeds_page_limit",
    next: {
      tool: "get_entity",
      arguments: { entity_ref: service.ref },
    },
  };
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

function invalidEntityRef(action = "inspect_home") {
  return new SprutHubError(
    "invalid_entity_ref",
    "Use a home-qualified reference returned by list_homes, inspect_home, or get_entity.",
    action,
  );
}

function invalidServiceScope() {
  return new SprutHubError(
    "invalid_service_scope",
    "room_ref must identify a room in the selected home_ref.",
    "inspect_home",
  );
}

function invalidServiceCursor(selection) {
  return new SprutHubError(
    "invalid_cursor",
    "Use the cursor returned by read_services for the same scope and filters.",
    "restart_read_services",
    { next: serviceReadNext(selection, null) },
  );
}

function invalidObservationScope() {
  return new SprutHubError(
    "invalid_observation_scope",
    "Use characteristic and scenario references from the same explicitly selected home.",
    "start_native_observation",
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
    "Call list_homes, choose one exact home, follow selection.pin, restart the same MCP application, and retry this operation.",
    "list_homes",
    { next: { tool: "list_homes", arguments: {} } },
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
  "Roles come from the BLOCK scenarios that the hub's scenario index lists for this accessory; that index is not proven complete. LOGIC and GLOBAL code, code conditions, code-selected targets and extensions are not analyzed, and stored configuration does not prove that a command ran.";

function extensionKey(extension) {
  return typeof extension?.extensionKey === "string" &&
    extension.extensionKey.trim().length > 0
    ? extension.extensionKey
    : null;
}

function normalizeExtensions(serial, extensions) {
  const normalized = extensions.map((extension) =>
    normalizeExtension(serial, extension),
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
    "inspect_home",
  );
}

function normalizeExtension(serial, extension) {
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
  };
}

function normalizeExtensionDetail(serial, extension) {
  const spaces = normalizeExtensionSpaces(extension.spaces);
  return {
    ...normalizeExtension(serial, extension),
    ...(spaces ? { spaces } : {}),
  };
}

function normalizeExtensionSpaces(spaces) {
  if (spaces === undefined) return undefined;
  if (!Array.isArray(spaces)) {
    throw incompatibleExtensionIdentity();
  }
  return spaces.map((space) => {
    if (typeof space?.key !== "string" || space.key.length === 0) {
      throw incompatibleExtensionIdentity();
    }
    return {
      key: redactSensitiveText(space.key),
      type:
        typeof space.type === "string" ? redactSensitiveText(space.type) : null,
      label: normalizeFormLabel(space.label),
    };
  });
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
    "inspect_home",
  );
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
  if (errorCode === "unsupported") return "inspect_home";
  return undefined;
}

export function includeReadFailedNext(
  errorCode,
  { entityRef, include, homeRef } = {},
) {
  if (errorCode === "unsupported") {
    return typeof homeRef === "string"
      ? { tool: "inspect_home", arguments: { home_ref: homeRef } }
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
  if (entity.kind === "home") {
    return {
      tool: "inspect_home",
      arguments: { home_ref: entity.ref },
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
  if (entity.kind === "home") return "catalog_required";
  if (["extension", "extension_child"].includes(entity.kind))
    return "window_scoped";
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
  if (option.inputType !== "ACCESSORY_LIST") return undefined;
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
      ref: accessoryRef(serial, typed.value),
      ...(typeof candidate.name === "string"
        ? { name: redactSensitiveText(candidate.name) }
        : {}),
    });
  }
  return { status: "confirmed", accessories };
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

export function isSensitiveNativeNode(value, key = "") {
  if (isSensitiveContainerKey(key)) return true;
  if (!value || typeof value !== "object") return false;
  return (
    value?.inputType === "PASSWORD" ||
    value?.input_type === "PASSWORD" ||
    value?.sensitive === true ||
    Object.keys(value ?? {}).some(isSensitiveKey) ||
    [value?.key, value?.name, value?.type, value?.ref].some(
      (candidate) => typeof candidate === "string" && isSensitiveKey(candidate),
    )
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

function normalizeScenarioConfiguration(scenario) {
  if (typeof scenario.data !== "string") {
    return { format: "not_returned", value: null };
  }
  if (scenario.type === "BLOCK") {
    try {
      return {
        format: "json",
        value: sanitizeNativeData(JSON.parse(scenario.data)),
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
  return sensitiveKeyPattern.test(key) || isPairingCodeKey(key);
}

function credentialKeyParts(key) {
  return key
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s-]+/)
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
  if (isPairingCodeKey(key)) return true;
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
    containsSensitiveAssignment(text, role);
  return containsCredential ? "[REDACTED]" : text;
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

function normalizeServiceIdentity(
  serial,
  room,
  accessory,
  service,
  observedAt,
) {
  return {
    ref: serviceRef(serial, accessory.id, service.sId),
    name: redactSensitiveText(service.name),
    type: redactSensitiveText(service.type),
    room: room
      ? {
          ref: roomRef(serial, room.id),
          name: redactSensitiveText(room.name),
        }
      : {
          ref: roomRef(serial, accessory.roomId),
          name: null,
          metadata_status: "missing",
        },
    accessory: {
      ref: accessoryRef(serial, accessory.id),
      name: redactSensitiveText(accessory.name),
      available: accessory.online,
    },
    observed_at: observedAt,
  };
}

function compareServiceRefs(left, right) {
  if (left.ref < right.ref) return -1;
  if (left.ref > right.ref) return 1;
  return 0;
}

function normalizeReadableCharacteristics(serial, accessory, service) {
  return (service.characteristics ?? [])
    .filter(({ control }) => control.read === true)
    .map((characteristic) => {
      const control = characteristic.control;
      if (isSensitiveNativeNode(control)) return redactedNode();
      const value = extractTypedValue(control.value);
      const reading = {
        ref: characteristicRef(
          serial,
          accessory.id,
          service.sId,
          characteristic.cId,
        ),
        name: redactSensitiveText(control.name),
        type: redactSensitiveText(control.type ?? control.key),
        value: value.found ? sanitizeNativeData(value.value) : null,
        ...(control.validValues
          ? { enum: matchEnumValue(control.validValues, value) }
          : {}),
        unit:
          typeof control.unit === "string"
            ? redactSensitiveText(control.unit)
            : null,
      };
      return {
        ...reading,
        value_status: value.found ? "known" : "unknown",
        measured_at: null,
      };
    });
}

function extractTypedValue(value) {
  if (!value) return { found: false, field: null, value: null };
  for (const field of VALUE_FIELDS) {
    if (Object.hasOwn(value, field)) {
      return { found: true, field, value: value[field] };
    }
  }
  return { found: false, field: null, value: null };
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

function matchEnumValue(validValues, currentValue) {
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
