import { randomUUID } from "node:crypto";
import { parse } from "@babel/parser";
import jsTokens from "js-tokens";
import { WebSocket } from "ws";
import { inspectBlockRelations } from "./block-model.mjs";
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

const LOG_LEVELS = new Set([
  "LOG_LEVEL_OFF",
  "LOG_LEVEL_ERROR",
  "LOG_LEVEL_WARN",
  "LOG_LEVEL_INFO",
  "LOG_LEVEL_DEBUG",
  "LOG_LEVEL_TRACE",
  "LOG_LEVEL_ALL",
]);
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
    const rooms = extractEntityArray(roomsResponse, ["room", "list", "rooms"]);
    const scenarios = extractEntityArray(scenariosResponse, [
      "scenario",
      "list",
      "scenarios",
    ]);
    const extensions = extractEntityArray(extensionsResponse, [
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
        "historical events, logs, and unbounded monitoring",
        "dashboards",
        "backups",
      ],
      freshness: freshness(observedAt),
    };
  }

  async getEntity(entityReference, include = []) {
    const parsed = parseEntityRef(entityReference);
    const deadline = Date.now() + this.timeoutMs;
    const { home, observedAt: homeObservedAt } = await this.#requireHome(
      parsed.serial,
      deadline,
    );
    const requested = new Set(include);
    const entity = await this.#readEntity(parsed, requested, deadline);
    const observedAt = new Date().toISOString();
    return {
      status: "ok",
      home: normalizeHome(home, homeObservedAt),
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
    const rooms = roomsResponse.result?.room?.list?.rooms;
    if (!Array.isArray(rooms)) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible room list.",
      );
    }

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
    const rooms = extractEntityArray(roomsResponse, ["room", "list", "rooms"]);
    rooms.forEach((room) => {
      validateRoom(room);
    });
    const accessories = extractEntityArray(accessoriesResponse, [
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
    const accessories = extractEntityArray(accessoriesResponse, [
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
      const accessories =
        accessoriesResponse.result?.accessory?.list?.accessories;
      if (!Array.isArray(accessories)) throw incompleteAccessoryError();
      accessories.forEach(validateAccessory);

      const directScenarios = extractArray(
        await this.#request(
          { scenario: { list: { aId: selected.aId } } },
          deadline,
        ),
        ["scenario", "list", "scenarios"],
        true,
      );
      const assignedLogics = extractArray(
        await this.#request(
          { logic: { list: { aId: selected.aId, sId: selected.sId } } },
          deadline,
        ),
        ["logic", "list", "logics"],
        true,
      );
      const logicTypes = extractArray(
        await this.#request(
          { logic: { types: { aId: selected.aId, sId: selected.sId } } },
          deadline,
        ),
        ["logic", "types", "logicTypes"],
        true,
      );
      const links = extractArray(
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
        true,
      );
      const options = extractArray(
        await this.#request(
          {
            characteristic: {
              getOptions: {
                aId: selected.aId,
                sId: selected.sId,
                cId: selected.cId,
              },
            },
          },
          deadline,
        ),
        ["characteristic", "getOptions", "options"],
        true,
      );
      selections[role] = {
        room,
        accessories,
        directScenarios,
        assignedLogics,
        logicTypes,
        links,
        options,
      };
    }

    const scenarios = extractArray(
      await this.#request({ scenario: { list: {} } }, deadline),
      ["scenario", "list", "scenarios"],
    );
    const extensions = extractArray(
      await this.#request({ extension: { list: {} } }, deadline),
      ["extension", "list", "extensions"],
    );
    return { ...selections, scenarios, extensions };
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
    const accessories = extractEntityArray(response, [
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
    const types = extractEntityArray(response, ["service", "types", "types"]);
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
    const links = extractEntityArray(response, ["link", "list", "links"], true);
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
      const rooms = extractEntityArray(
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
    const accessories = extractEntityArray(response, [
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
    let response;
    try {
      response = await this.#request(
        { scenario: { get: { index, expand: "data" } } },
        deadline,
      );
    } catch (error) {
      if (!isScenarioNotFoundCandidate(error)) throw error;
      const scenarios = extractScenarioCatalog(
        await this.#request({ scenario: { list: {} } }, deadline),
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

  async updateScenarioData(index, data) {
    const response = await this.#request(
      { scenario: { update: { index, data } } },
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
    return extractEntityArray(
      response,
      ["characteristic", "getOptions", "options"],
      true,
    );
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
    return extractEntityArray(response, ["logic", "types", "logicTypes"], true);
  }

  async listLogics({ aId, sId }) {
    const response = await this.#request(
      { logic: { list: { aId, sId } } },
      Date.now() + this.timeoutMs,
    );
    return extractEntityArray(response, ["logic", "list", "logics"], true);
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
      const logics = extractEntityArray(
        await this.#request({ logic: { list: { aId, sId } } }, deadline),
        ["logic", "list", "logics"],
        true,
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
    return extractEntityArray(
      response,
      ["logic", "getOptions", "options"],
      true,
    );
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
    const homes = response.result?.hub?.list?.hubs;
    if (!Array.isArray(homes)) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible home list.",
      );
    }
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
      entity = await this.#readExtensionEntity(parsed, deadline);
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
    const accessories = extractEntityArray(accessoriesResponse, [
      "accessory",
      "list",
      "accessories",
    ]);
    accessories.forEach(validateAccessory);
    return {
      kind: "room",
      ref: roomRef(parsed.serial, room.id),
      name: room.name,
      accessories: accessories
        .filter(({ roomId }) => roomId === room.id)
        .map((accessory) => ({
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
      device_window_ref:
        typeof accessory.deviceWindow === "string"
          ? windowRef(parsed.serial, accessory.deviceWindow)
          : null,
    };
    if (parsed.kind === "accessory") {
      const entity = normalizeAccessoryDetail(
        parsed.serial,
        accessory,
        observedAt,
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
      return {
        entity: {
          ...normalizeServiceDetail(
            parsed.serial,
            accessory,
            service,
            observedAt,
          ),
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
      entity.options = extractEntityArray(optionsResponse, [
        "characteristic",
        "getOptions",
        "options",
      ]).map((option) =>
        normalizeOption(option, {
          operation: "characteristic_option",
          targetRef: entity.ref,
        }),
      );
      entity.option_scope.status =
        entity.options.length === 0 ? "checked_empty" : "found";
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
    const homeReference = homeRef(serial);
    const accessoryReference = accessoryRef(serial, accessory.id);
    const associationPromise = this.#readRelationSource(
      { scenario: { list: { aId: accessory.id } } },
      deadline,
      serial,
      (response) =>
        uniqueByRef(
          extractEntityArray(
            response,
            ["scenario", "list", "scenarios"],
            true,
          ).map((scenario) => normalizeScenarioSummary(serial, scenario)),
        ),
    );
    const catalogPromise = this.#readRelationSource(
      { scenario: { list: {} } },
      deadline,
      serial,
      (response) =>
        uniqueByRef(
          extractEntityArray(response, ["scenario", "list", "scenarios"]).map(
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
          extractEntityArray(response, ["logic", "list", "logics"], true).map(
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
            extractEntityArray(response, ["link", "list", "links"], true).map(
              normalizeLink,
            ),
        )
      : null;
    const [associationRead, catalogRead, logicReads, linkRead] =
      await Promise.all([
        associationPromise,
        catalogPromise,
        Promise.all(logicPromises),
        linkPromise,
      ]);

    const associations = associationRead.ok ? associationRead.value : [];
    const blockReads = await Promise.all(
      associations
        .filter(({ type }) => type === "BLOCK")
        .map((summary) => this.#readRelationBlock(serial, summary, deadline)),
    );
    const scopes = [
      relationListScope(
        "scenario_accessory_index",
        accessoryReference,
        associationRead,
      ),
      relationListScope("scenario_catalog", homeReference, catalogRead),
      ...blockReads.map(({ scope }) => scope),
      ...logicReads.map((read, index) =>
        relationListScope(
          "logic_assignments",
          serviceRef(serial, accessory.id, services[index].sId),
          read,
        ),
      ),
    ];
    const assignedLogics = logicReads.flatMap((read, index) => {
      if (!read.ok) return [];
      const ownerRef = serviceRef(serial, accessory.id, services[index].sId);
      return read.value.map((logic) => ({
        ...logic,
        role: "service_assignment",
        service_ref: ownerRef,
      }));
    });
    const characteristicLinks = [];
    const systemLinks = [];
    if (characteristic) {
      const sourceRef = characteristicRef(
        serial,
        accessory.id,
        services[0].sId,
        characteristic.cId,
      );
      scopes.push(
        relationListScope("characteristic_links", sourceRef, linkRead),
      );
      if (linkRead.ok) {
        for (const link of linkRead.value) {
          const { characteristics, ...identity } = link;
          if (link.type === "SYSTEM") {
            systemLinks.push(
              sanitizeNativeData({ ...identity, role: "system" }),
            );
            continue;
          }
          characteristicLinks.push({
            type: link.type,
            index: sanitizeNativeData(link.index),
            role: "inter_entity",
            related_characteristic_refs: characteristics.map(
              ({ aId, sId, cId }) => characteristicRef(serial, aId, sId, cId),
            ),
          });
        }
      }
    } else {
      scopes.push({
        area: "characteristic_links",
        outcome: "not_read",
        source_ref: accessoryReference,
        observed_at: null,
      });
    }

    const unresolvedAreas = relationUnresolvedAreas({
      associationRead,
      associations,
      catalogRead,
      blockReads,
      logicReads,
      linkRead,
      characteristic,
      serial,
      accessory,
      services,
      characteristicCandidates: services.flatMap((service) =>
        normalizeServiceDetail(
          serial,
          accessory,
          service,
          null,
        ).characteristics.filter((candidate) => !isRedactedNode(candidate)),
      ),
    });
    return {
      scenario_associations: associations.map((summary) => ({
        ...summary,
        meaning: "accessory_index_association",
        direction: "not_established",
      })),
      scenario_roles: blockReads.flatMap(({ roles }) => roles),
      assigned_logics: assignedLogics,
      characteristic_links: characteristicLinks,
      system_links: systemLinks,
      scopes,
      unresolved_areas: unresolvedAreas,
    };
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
    const sourceRef = summary.ref;
    if (!read.ok) {
      return {
        scope: relationReadScope("block_configuration", sourceRef, read),
        roles: [],
        unresolved: [
          {
            area: "block_configuration",
            outcome: read.outcome,
            scenario_ref: sourceRef,
          },
        ],
      };
    }
    const scope = relationReadScope("block_configuration", sourceRef, read);
    let data;
    try {
      data = JSON.parse(read.value.scenario.data);
    } catch {
      return {
        scope,
        roles: [],
        unresolved: [
          {
            area: "block_configuration",
            outcome: "invalid_json",
            scenario_ref: sourceRef,
          },
        ],
      };
    }
    const inspected = inspectBlockRelations(data, {
      homeRef: homeRef(serial),
      scenarioRef: sourceRef,
      scenarioActive: read.value.normalized.active,
    });
    return { scope, roles: inspected.roles, unresolved: inspected.unresolved };
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
    return extractEntityArray(response, ["logic", "list", "logics"], true);
  }

  async #readLogicTypes(serial, accessoryId, serviceId, deadline) {
    const response = await this.#request(
      { logic: { types: { aId: accessoryId, sId: serviceId } } },
      deadline,
      { serial },
    );
    return extractEntityArray(response, ["logic", "types", "logicTypes"], true);
  }

  async #readPhysicalConfiguration(serial, accessory, requested, deadline) {
    if (typeof accessory.deviceWindow !== "string") {
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
    const response = await this.#request(
      {
        scenario: {
          get: {
            index: parsed.scenarioIndex,
            ...(requested.has("configuration") ? { expand: "data" } : {}),
          },
        },
      },
      deadline,
      { serial: parsed.serial },
    );
    const scenario = extractEntity(response, ["scenario", "get"], "scenario");
    const entity = normalizeScenarioSummary(parsed.serial, scenario);
    if (requested.has("configuration")) {
      entity.configuration = normalizeScenarioConfiguration(scenario);
    }
    return { kind: "scenario", ...entity };
  }

  async #readExtensionEntity(parsed, deadline) {
    const response = await this.#request(
      { extension: { list: {} } },
      deadline,
      { serial: parsed.serial },
    );
    const extensions = extractEntityArray(response, [
      "extension",
      "list",
      "extensions",
    ]).filter((candidate) => extensionKey(candidate) === parsed.extensionKey);
    if (extensions.length === 0) throw entityNotFound("extension");
    if (extensions.length > 1) throw incompatibleExtensionIdentity();
    return {
      kind: "extension",
      ...normalizeExtension(parsed.serial, extensions[0]),
    };
  }

  async #readWindowEntity(parsed, requested, deadline) {
    const response = await this.#request(
      { window: { get: { windowKey: parsed.windowKey } } },
      deadline,
      { serial: parsed.serial },
    );
    const window = extractEntity(response, ["window", "get"], "window");
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
      if (message.error.code === 401) {
        pending.reject(
          new SprutHubError(
            "authentication_failed",
            "SprutHub rejected the configured credentials.",
            "check_credentials",
            { capability_status: "insufficient_access" },
          ),
        );
      } else if (message.error.code === -32601) {
        pending.reject(
          new SprutHubError(
            "unsupported",
            "SprutHub does not support this operation on the selected home.",
            "inspect_home",
            { capability_status: "unsupported" },
          ),
        );
      } else {
        pending.reject(
          new SprutHubError(
            "request_rejected",
            "SprutHub rejected the request.",
            undefined,
            { protocolErrorCode: message.error.code },
          ),
        );
      }
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
  const separator = SCENARIO_LOG_PREFIX_BY_PATH.get(log.path);
  if (
    separator === undefined ||
    !LOG_LEVELS.has(log.level) ||
    typeof log.message !== "string" ||
    !log.message.startsWith(`Сценарий ${scenarioIndex}${separator}`) ||
    !Number.isSafeInteger(log.time) ||
    log.time < 0
  ) {
    return null;
  }
  const sourceDate = new Date(log.time);
  if (Number.isNaN(sourceDate.valueOf())) return null;
  return {
    timeMs: log.time,
    sourceTimestamp: sourceDate.toISOString(),
    level: log.level,
    path: log.path,
    message: log.message,
  };
}

function extractArray(response, path, missingMeansEmpty = false) {
  let value = response.result;
  for (const key of path) value = value?.[key];
  if (Array.isArray(value)) return value;
  if (missingMeansEmpty && value === undefined) return [];
  throw new SprutHubError(
    "incompatible_response",
    "SprutHub returned an incompatible automation response.",
  );
}

function extractScenarioCatalog(response) {
  const scenarios = extractArray(response, ["scenario", "list", "scenarios"]);
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

function extractEntityArray(response, path, missingMeansEmpty = false) {
  let container = response.result;
  for (const key of path.slice(0, -1)) {
    if (
      !container ||
      typeof container !== "object" ||
      Array.isArray(container) ||
      !Object.hasOwn(container, key)
    ) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible entity list.",
      );
    }
    container = container[key];
  }
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incompatible entity list.",
    );
  }
  const key = path.at(-1);
  const value = container[key];
  if (Array.isArray(value)) return value;
  if (missingMeansEmpty && !Object.hasOwn(container, key)) return [];
  throw new SprutHubError(
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

function entityNotFound(kind) {
  return new SprutHubError(
    "entity_not_found",
    `The selected SprutHub ${kind} was not found.`,
    "inspect_home",
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

function windowRef(serial, key) {
  return `${homeRef(serial)}/window/${encodeURIComponent(key)}`;
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

function parseEntityRef(ref) {
  let url;
  try {
    url = new URL(ref);
  } catch {
    throw invalidEntityRef();
  }
  if (url.protocol !== "spruthub:" || url.hostname !== "hub") {
    throw invalidEntityRef();
  }
  const encoded = url.pathname.split("/").filter(Boolean);
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

function relationListScope(area, sourceRef, read) {
  return {
    area,
    outcome: read.ok
      ? read.value.length === 0
        ? "checked_empty"
        : "found"
      : read.outcome,
    source_ref: sourceRef,
    observed_at: read.observedAt,
    ...(!read.ok ? { error_code: read.errorCode } : {}),
  };
}

function relationReadScope(area, sourceRef, read) {
  return {
    area,
    outcome: read.ok ? "read" : read.outcome,
    source_ref: sourceRef,
    observed_at: read.observedAt,
    ...(!read.ok ? { error_code: read.errorCode } : {}),
  };
}

function relationUnresolvedAreas({
  associationRead,
  associations,
  catalogRead,
  blockReads,
  logicReads,
  linkRead,
  characteristic,
  serial,
  accessory,
  services,
  characteristicCandidates,
}) {
  const unresolved = blockReads.flatMap(({ unresolved: items }) => items);
  if (!associationRead.ok) {
    unresolved.push({
      area: "scenario_accessory_index",
      outcome: associationRead.outcome,
      source_ref: accessoryRef(serial, accessory.id),
    });
  }
  if (!catalogRead.ok) {
    unresolved.push({
      area: "scenario_catalog",
      outcome: catalogRead.outcome,
      source_ref: homeRef(serial),
    });
  } else {
    const associatedRefs = new Set(associations.map(({ ref }) => ref));
    const codeScenarios = catalogRead.value.filter(
      ({ type }) => type !== "BLOCK",
    );
    if (codeScenarios.length > 0) {
      unresolved.push({
        area: "scenario_code",
        outcome: "not_read",
        scenario_count: codeScenarios.length,
        scenario_types: [...new Set(codeScenarios.map(({ type }) => type))],
      });
    }
    const unindexedBlocks = catalogRead.value.filter(
      ({ type, ref }) => type === "BLOCK" && !associatedRefs.has(ref),
    );
    if (unindexedBlocks.length > 0) {
      unresolved.push({
        area: "unindexed_block_scenarios",
        outcome: "not_read",
        scenario_count: unindexedBlocks.length,
        scenario_types: ["BLOCK"],
      });
    }
  }
  logicReads.forEach((read, index) => {
    if (read.ok) return;
    unresolved.push({
      area: "logic_assignments",
      outcome: read.outcome,
      source_ref: serviceRef(serial, accessory.id, services[index].sId),
    });
  });
  if (characteristic && !linkRead.ok) {
    unresolved.push({
      area: "characteristic_links",
      outcome: linkRead.outcome,
      source_ref: characteristicRef(
        serial,
        accessory.id,
        services[0].sId,
        characteristic.cId,
      ),
    });
  }
  if (!characteristic) {
    unresolved.push({
      area: "characteristic_links",
      outcome: "not_read",
      source_ref: accessoryRef(serial, accessory.id),
      limitation:
        "Accessory relations do not recursively read every characteristic link.",
      next: {
        tool: "get_entity",
        candidates: characteristicCandidates.map(({ ref }) => ({
          entity_ref: ref,
          include: ["relations"],
        })),
      },
    });
  }
  unresolved.push(
    {
      area: "extensions",
      outcome: "not_read",
      limitation:
        "Extension code and controller behavior are outside this entity-scoped read.",
    },
    {
      area: "runtime_execution",
      outcome: "not_observed",
      limitation:
        "Stored configuration does not prove that a command ran or caused a past event.",
    },
  );
  return unresolved;
}

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
  return {
    ref: extensionRef(serial, key),
    key,
    name: redactSensitiveText(extension.name),
    type: redactSensitiveText(extension.type),
    index:
      typeof extension.index === "string"
        ? redactSensitiveText(extension.index)
        : null,
    options_window_ref:
      typeof extension.optionsWindow === "string"
        ? windowRef(serial, extension.optionsWindow)
        : null,
    bundle_type: extension.bundleType ?? null,
    enabled: extension.enabled === true,
    state: extension.state ?? null,
  };
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
      device_window_ref:
        typeof accessory.deviceWindow === "string"
          ? windowRef(serial, accessory.deviceWindow)
          : null,
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
      source: "characteristic",
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
    option_scope: {
      native_has_options:
        typeof characteristic.hasOptions === "boolean"
          ? characteristic.hasOptions
          : null,
      status: "not_read",
      next: {
        tool: "get_entity",
        arguments: { entity_ref: ref, include: ["options"] },
      },
    },
    freshness: {
      observed_at: observedAt,
      source_timestamp: null,
    },
  };
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
  return false;
}

function explainUnappliedInclude(entity, include, ownerContext) {
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

  const containerRoute = ownerCandidatesFromContainer(entity, include);
  if (containerRoute.length > 0) {
    return { tool: "get_entity", candidates: containerRoute };
  }

  if (
    entity.kind === "extension" &&
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
            ? {
                native_has_options:
                  characteristic.option_scope.native_has_options,
              }
            : {}),
        })),
    );
  }

  return [];
}

function ownerScopeReason(entity, include) {
  if (entity.kind === "home") return "catalog_required";
  if (entity.kind === "extension") return "window_scoped";
  if (include === "configuration") return "scenario_scoped";
  if (include === "options") {
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
    ["GROUP", "LABEL", "DIVIDER"].includes(inputType),
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
      });
      if (normalized.redacted) return normalized;
      const property = propertyFromNativeOptionKey(option.key);
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
                  ).slice(0, 16_384),
                  content_origin: "spruthub_device_data",
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

function normalizeWindowControl(option) {
  return {
    key: redactSensitiveText(option.key ?? ""),
    name:
      typeof option.name === "string" ? redactSensitiveText(option.name) : "",
    type:
      typeof option.type === "string" ? redactSensitiveText(option.type) : null,
    input_type: option.inputType ?? null,
    parent:
      typeof option.parent === "string"
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

function publicNativeOptionChange(option, { operation, targetRef }) {
  const inspected = inspectNativeOption(option);
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

function isRedactedNode(value) {
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
  return sensitiveKeyPattern.test(key);
}

function isSensitiveAssignmentKey(key) {
  // A text match hides the whole source, while a structural match only hides
  // one node, so text requires a complete credential-shaped name.
  const parts = key
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[_\s-]+/)
    .map((part) => part.replace(/^\$+/u, "").toLowerCase())
    .filter(Boolean);
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
