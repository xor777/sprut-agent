import { WebSocket } from "ws";

const VALUE_FIELDS = [
  "boolValue",
  "intValue",
  "longValue",
  "doubleValue",
  "stringValue",
];

export class SprutHubError extends Error {
  constructor(code, message, action) {
    super(message);
    this.name = "SprutHubError";
    this.code = code;
    this.action = action;
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
          ref: `spruthub://room/${room.id}`,
          name: room.name,
        };
      }),
      freshness: {
        hubResponseReceivedAt: new Date().toISOString(),
        measurementAt: null,
      },
    };
  }

  async readRoom(roomRef) {
    const parsedRef = /^spruthub:\/\/room\/(\d+)$/.exec(roomRef);
    if (!parsedRef) {
      throw new SprutHubError(
        "invalid_room_ref",
        "Use a room reference returned by list_rooms.",
        "list_rooms",
      );
    }
    const roomId = Number(parsedRef[1]);
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
        ref: `spruthub://room/${room.id}`,
        name: room.name,
      },
      devices: accessories
        .map(validateAccessory)
        .filter(({ roomId }) => roomId === room.id)
        .map(normalizeAccessory),
      freshness: {
        hubResponseReceivedAt: new Date().toISOString(),
        measurementAt: null,
      },
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

  async #request(params, deadline) {
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
        serial: this.serial,
        cid: this.cid,
        params,
      }),
    );

    return response;
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
      pending.reject(
        message.error.code === 401
          ? new SprutHubError(
              "authentication_failed",
              "SprutHub rejected the configured credentials.",
              "check_credentials",
            )
          : new SprutHubError(
              "request_rejected",
              "SprutHub rejected the request.",
            ),
      );
      return;
    }
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
        ),
      );
    }
    this.#pending.clear();
  }
}

function timeoutError() {
  return new SprutHubError(
    "timeout",
    "SprutHub did not respond within the request budget.",
    "retry",
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

function normalizeAccessory(accessory) {
  return {
    ref: `spruthub://accessory/${accessory.id}`,
    name: accessory.name,
    available: accessory.online,
    services: (accessory.services ?? []).map((service) => ({
      ref: `spruthub://accessory/${accessory.id}/service/${service.sId}`,
      name: service.name,
      type: service.type,
      readings: (service.characteristics ?? [])
        .filter(({ control }) => control.read === true)
        .map((characteristic) => {
          const control = characteristic.control;
          const value = extractTypedValue(control.value);
          return {
            ref: `spruthub://accessory/${accessory.id}/service/${service.sId}/characteristic/${characteristic.cId}`,
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
