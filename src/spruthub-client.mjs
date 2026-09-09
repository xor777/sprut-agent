import { WebSocket } from "ws";

const VALUE_FIELDS = [
  "boolValue",
  "intValue",
  "longValue",
  "doubleValue",
  "stringValue",
];

export class SprutHubError extends Error {
  constructor(code, message, action, { requestSent = false, ...details } = {}) {
    super(message);
    this.name = "SprutHubError";
    this.code = code;
    this.action = action;
    this.requestSent = requestSent;
    if (Object.keys(details).length > 0) this.details = details;
  }
}

export class SprutHubClient {
  #connectPromise;
  #connectingSocket;
  #nextRequestId = 1;
  #pending = new Map();
  #socket;

  constructor({ url, token, serial, cid, timeoutMs = 10_000 }) {
    if (!url || !token || !serial || !cid) {
      throw new SprutHubError(
        "configuration",
        "SprutHub connection settings are incomplete.",
      );
    }

    this.url = url;
    this.token = token;
    this.serial = serial;
    this.cid = cid;
    this.timeoutMs = timeoutMs;
  }

  async listHomes() {
    const deadline = Date.now() + this.timeoutMs;
    const { homes, observedAt } = await this.#listHomes(deadline);
    return {
      status: "ok",
      homes: homes.map((home) => normalizeHome(home, observedAt)),
      selection: {
        required: homes.length !== 1,
        ...(homes.length === 1
          ? { default_home_ref: homeRef(homes[0].serial) }
          : {}),
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
        extensions: extensions.map((extension) =>
          normalizeExtension(serial, extension),
        ),
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
        "events and logs",
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

  async listRooms() {
    const deadline = Date.now() + this.timeoutMs;
    const roomsResponse = await this.#request({ room: { list: {} } }, deadline);
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

  async readRoom(roomReference) {
    let parsedRef;
    try {
      parsedRef = parseEntityRef(roomReference);
    } catch {
      throw invalidRoomRef();
    }
    if (parsedRef.kind !== "room" || parsedRef.serial !== this.serial) {
      throw invalidRoomRef();
    }
    const roomId = parsedRef.roomId;
    const deadline = Date.now() + this.timeoutMs;
    const roomResponse = await this.#request(
      { room: { get: { id: roomId } } },
      deadline,
    );
    const roomContainer = roomResponse.result?.room;
    if (!roomContainer || !("get" in roomContainer)) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible room response.",
      );
    }
    const room = roomContainer.get;
    if (room === null) {
      throw new SprutHubError(
        "room_not_found",
        "The selected SprutHub room was not found.",
        "list_rooms",
      );
    }
    validateRoom(room, roomId);

    const accessoriesResponse = await this.#request(
      {
        accessory: {
          list: { roomId, expand: "services,characteristics" },
        },
      },
      deadline,
    );
    const accessories =
      accessoriesResponse.result?.accessory?.list?.accessories;
    if (!Array.isArray(accessories)) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible accessory list.",
      );
    }

    return {
      status: "ok",
      room: {
        ref: roomRef(this.serial, room.id),
        name: room.name,
      },
      devices: accessories
        .map(validateAccessory)
        .filter(({ roomId }) => roomId === room.id)
        .map((accessory) => normalizeAccessory(this.serial, accessory)),
      freshness: {
        hubResponseReceivedAt: new Date().toISOString(),
        measurementAt: null,
      },
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

  async listScenarioDetails() {
    const deadline = Date.now() + this.timeoutMs;
    const scenarios = extractArray(
      await this.#request({ scenario: { list: {} } }, deadline),
      ["scenario", "list", "scenarios"],
    );
    const details = [];
    for (const scenario of scenarios) {
      if (typeof scenario?.index !== "string") {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub returned a scenario without a stable index.",
        );
      }
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
        "inspect_hub",
        { requestSent: true },
      );
    }
    return scenario;
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
    if (parsed.kind === "home") {
      return { kind: "home", ref: homeRef(parsed.serial) };
    }
    if (parsed.kind === "room") {
      return this.#readRoomEntity(parsed, deadline);
    }
    if (
      ["accessory", "service", "characteristic", "logic"].includes(parsed.kind)
    ) {
      return this.#readAccessoryEntity(parsed, requested, deadline);
    }
    if (parsed.kind === "scenario") {
      return this.#readScenarioEntity(parsed, requested, deadline);
    }
    if (parsed.kind === "extension") {
      return this.#readExtensionEntity(parsed, deadline);
    }
    if (parsed.kind === "window") {
      return this.#readWindowEntity(parsed, requested, deadline);
    }
    throw invalidEntityRef();
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
      return entity;
    }
    const service = accessory.services?.find(
      ({ sId }) => sId === parsed.serviceId,
    );
    if (!service) throw entityNotFound("service");
    if (parsed.kind === "service") {
      return normalizeServiceDetail(
        parsed.serial,
        accessory,
        service,
        observedAt,
      );
    }
    if (parsed.kind === "logic") {
      const logics = await this.#readLogics(
        parsed.serial,
        accessory.id,
        service.sId,
        deadline,
      );
      const logic = logics.find(({ type }) => type === parsed.logicType);
      if (!logic) throw entityNotFound("logic");
      return normalizeLogic(parsed.serial, accessory.id, service.sId, logic);
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
      entity.options = extractEntityArray(
        optionsResponse,
        ["characteristic", "getOptions", "options"],
        true,
      ).map(normalizeOption);
    }
    if (requested.has("relations")) {
      const [logics, linksResponse, scenariosResponse] = await Promise.all([
        this.#readLogics(parsed.serial, accessory.id, service.sId, deadline),
        this.#request(
          {
            link: {
              list: {
                aId: accessory.id,
                sId: service.sId,
                cId: characteristic.cId,
              },
            },
          },
          deadline,
          { serial: parsed.serial },
        ),
        this.#request({ scenario: { list: { aId: accessory.id } } }, deadline, {
          serial: parsed.serial,
        }),
      ]);
      entity.relations = {
        assigned_logics: logics.map((logic) =>
          normalizeLogic(parsed.serial, accessory.id, service.sId, logic),
        ),
        links: extractEntityArray(
          linksResponse,
          ["link", "list", "links"],
          true,
        ).map((link) => sanitizeNativeData(link)),
        direct_scenarios: extractEntityArray(
          scenariosResponse,
          ["scenario", "list", "scenarios"],
          true,
        ).map((scenario) => normalizeScenarioSummary(parsed.serial, scenario)),
        limitations: [
          "An empty direct scenario list does not prove that no BLOCK or code scenario refers to this characteristic.",
        ],
      };
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
    return entity;
  }

  async #readAccessoryRelations(serial, accessory, deadline) {
    const directScenariosResponse = await this.#request(
      { scenario: { list: { aId: accessory.id } } },
      deadline,
      { serial },
    );
    const assignedLogics = [];
    for (const service of accessory.services ?? []) {
      assignedLogics.push(
        ...(
          await this.#readLogics(serial, accessory.id, service.sId, deadline)
        ).map((logic) =>
          normalizeLogic(serial, accessory.id, service.sId, logic),
        ),
      );
    }
    return {
      direct_scenarios: extractEntityArray(
        directScenariosResponse,
        ["scenario", "list", "scenarios"],
        true,
      ).map((scenario) => normalizeScenarioSummary(serial, scenario)),
      assigned_logics: assignedLogics,
    };
  }

  async #readLogics(serial, accessoryId, serviceId, deadline) {
    const response = await this.#request(
      { logic: { list: { aId: accessoryId, sId: serviceId } } },
      deadline,
      { serial },
    );
    return extractEntityArray(response, ["logic", "list", "logics"], true);
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
    const extension = extractEntityArray(response, [
      "extension",
      "list",
      "extensions",
    ]).find((candidate) => extensionKey(candidate) === parsed.extensionKey);
    if (!extension) throw entityNotFound("extension");
    return {
      kind: "extension",
      ...normalizeExtension(parsed.serial, extension),
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
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

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

function extractEntityArray(response, path, missingMeansEmpty = false) {
  let value = response.result;
  for (const key of path) value = value?.[key];
  if (Array.isArray(value)) return value;
  if (missingMeansEmpty && value === undefined) return [];
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

function invalidRoomRef() {
  return new SprutHubError(
    "invalid_room_ref",
    "Use a configured-home room reference returned by list_rooms.",
    "list_rooms",
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

function extensionKey(extension) {
  return extension?.extensionKey ?? extension?.key ?? extension?.type;
}

function normalizeExtension(serial, extension) {
  const key = extensionKey(extension);
  if (
    typeof key !== "string" ||
    typeof extension?.name !== "string" ||
    typeof extension.type !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete extension data.",
    );
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
  const value = extractTypedValue(control.value);
  return {
    kind: "characteristic",
    ref: characteristicRef(
      serial,
      accessory.id,
      service.sId,
      characteristic.cId,
    ),
    name: control.name,
    type: control.type ?? control.key,
    current_value: {
      value: value.value,
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
      valid_values: (control.validValues ?? []).map((validValue) => ({
        key: validValue.key,
        name: validValue.name,
        value: extractTypedValue(validValue.value).value,
      })),
    },
    freshness: {
      observed_at: observedAt,
      source_timestamp: null,
    },
  };
}

function normalizeOption(option) {
  if (!option || typeof option.key !== "string") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an option without a native key.",
    );
  }
  const configured = extractTypedValue(option.value);
  const sensitive = isSensitiveNativeOption(option);
  return {
    key: redactSensitiveText(option.key),
    name:
      typeof option.name === "string" ? redactSensitiveText(option.name) : "",
    type:
      typeof option.type === "string" ? redactSensitiveText(option.type) : null,
    configured_value: sensitive
      ? "[REDACTED]"
      : sanitizeNativeData(configured.value, option.key),
    unit:
      typeof option.unit === "string" ? redactSensitiveText(option.unit) : null,
    read: option.read === true,
    write: option.write === true,
    events: option.events === true,
    ...(option.inputType ? { input_type: option.inputType } : {}),
    ...(sensitive ? { sensitive: true } : {}),
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
            value: sensitive
              ? "[REDACTED]"
              : sanitizeNativeData(
                  extractTypedValue(validValue.value).value,
                  option.key,
                ),
          })),
        }
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
  const reports = extractWindowReports(diagnosticOptions);
  const options = window.options
    .filter(
      (option) =>
        !diagnosticOptions.includes(option) &&
        !layoutOptions.includes(option) &&
        !commandOptions.includes(option),
    )
    .map((option) => {
      const normalized = normalizeOption(option);
      const property = propertyFromNativeOptionKey(option.key);
      const report = property ? reports.get(property) : undefined;
      return {
        ...normalized,
        ...(property
          ? {
              property,
              reported_value: report
                ? parseScalarLike(report.value, normalized.configured_value)
                : null,
              reported_source: report ? "window_info_report" : null,
              reported_observed_at: report ? observedAt : null,
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
      layout: layoutOptions.map(normalizeWindowControl),
      commands: commandOptions.map((option) => ({
        ...normalizeWindowControl(option),
        requires_confirmation: option.validValues?.some(
          ({ confirm }) => typeof confirm === "string" && confirm.length > 0,
        ),
      })),
      freshness: {
        observed_at: observedAt,
        source_timestamp: null,
      },
    },
    ...(includeDiagnostics
      ? {
          diagnostics: diagnosticOptions.map((option) => ({
            key: redactSensitiveText(option.key),
            text: redactSensitiveText(
              String(extractTypedValue(option.value).value ?? ""),
            ).slice(0, 16_384),
            content_origin: "spruthub_device_data",
          })),
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

function extractWindowReports(options) {
  const reports = new Map();
  const pattern =
    /(?:^|>)[0-9A-Fa-f]+_([A-Za-z][A-Za-z0-9_]*)\s+\([0-9A-Fa-f]+\):\s*([^<]+?)\s*\[([A-Z0-9_]+)\]/g;
  for (const option of options) {
    const text = extractTypedValue(option.value).value;
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(pattern)) {
      reports.set(match[1], { value: match[2].trim() });
    }
  }
  return reports;
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

function isSensitiveNativeOption(option) {
  return (
    option?.inputType === "PASSWORD" ||
    isSensitiveKey(option?.key ?? "") ||
    isSensitiveKey(option?.name ?? "")
  );
}

function parseScalarLike(value, example) {
  if (typeof example === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof example === "boolean" && ["true", "false"].includes(value)) {
    return value === "true";
  }
  return value;
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
    name: logic.name ?? logic.type,
    active: logic.active === true,
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
        text: redactSensitiveText(scenario.data),
      };
    }
  }
  return {
    format: "code",
    text: redactSensitiveText(scenario.data),
    content_origin: "spruthub_scenario_data",
  };
}

export function sanitizeNativeData(value, key = "", forceSensitive = false) {
  const sensitive = forceSensitive || isSensitiveKey(key);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNativeData(item, "", sensitive));
  }
  if (value && typeof value === "object") {
    const sensitiveContainer =
      sensitive ||
      value.inputType === "PASSWORD" ||
      isSensitiveKey(value.key ?? "") ||
      isSensitiveKey(value.name ?? "") ||
      isSensitiveKey(value.type ?? "");
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeNativeData(
          childValue,
          childKey,
          sensitiveContainer && isSecretValueField(childKey),
        ),
      ]),
    );
  }
  if (sensitive) return value == null ? value : "[REDACTED]";
  return typeof value === "string" ? redactSensitiveText(value) : value;
}

function isSensitiveKey(key) {
  return /(?:password|passwd|secret|credential|authorization|(?:api|access|refresh|client|private|wifi)[_-]?(?:key|token|secret|password)|token)/i.test(
    key,
  );
}

function isSecretValueField(key) {
  return /^(?:value|configured_value|default_value|defaultValue|boolValue|intValue|longValue|doubleValue|stringValue|bytesValue|validValues)$/i.test(
    key,
  );
}

function redactSensitiveText(text) {
  const credentialName =
    "api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|wifi[_-]?password|api[_-]?key|private[_-]?key|password|passwd|secret|credential|authorization|token";
  return text
    .replace(/\bBearer\s+[^\s;"'<>]+/gi, "Bearer [REDACTED]")
    .replace(
      new RegExp(
        `\\b(${credentialName})(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3).)*\\3`,
        "gi",
      ),
      "$1$2$3[REDACTED]$3",
    )
    .replace(
      new RegExp(
        `\\b(${credentialName})(\\s*[:=]\\s*)(?!\\[REDACTED\\])[^\\s;"'<>]+`,
        "gi",
      ),
      "$1$2[REDACTED]",
    );
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

function incompleteAccessoryError() {
  return new SprutHubError(
    "incompatible_response",
    "SprutHub returned incomplete accessory data.",
  );
}

function isStableId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeAccessory(serial, accessory) {
  return {
    ref: accessoryRef(serial, accessory.id),
    name: accessory.name,
    available: accessory.online,
    services: (accessory.services ?? []).map((service) => ({
      ref: serviceRef(serial, accessory.id, service.sId),
      name: service.name,
      type: service.type,
      readings: (service.characteristics ?? [])
        .filter(({ control }) => control.read === true)
        .map((characteristic) => {
          const control = characteristic.control;
          const value = extractTypedValue(control.value);
          return {
            ref: characteristicRef(
              serial,
              accessory.id,
              service.sId,
              characteristic.cId,
            ),
            name: control.name,
            type: control.type ?? control.key,
            value: value.value,
            ...(control.validValues
              ? { enum: matchEnumValue(control.validValues, value) }
              : {}),
            unit: control.unit ?? null,
            measuredAt: null,
          };
        }),
    })),
  };
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
