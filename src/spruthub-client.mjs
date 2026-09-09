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
    const roomsResponse = await this.#request({ room: { list: {} } });
    const rooms = roomsResponse.result?.room?.list?.rooms;
    if (!Array.isArray(rooms)) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned an incompatible room list.",
      );
    }

    return {
      status: "ok",
      rooms: rooms.map((room) => ({
        ref: `spruthub://room/${room.id}`,
        name: room.name,
      })),
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
    const roomResponse = await this.#request({
      room: { get: { id: roomId } },
    });
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

    const accessoriesResponse = await this.#request({
      accessory: {
        list: { roomId, expand: "services,characteristics" },
      },
    });
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
        .filter(({ roomId }) => roomId === room.id)
        .map(normalizeAccessory),
      freshness: {
        hubResponseReceivedAt: new Date().toISOString(),
        measurementAt: null,
      },
    };
  }

  async close() {
    if (!this.#socket) return;
    await new Promise((resolve) => {
      this.#socket.once("close", resolve);
      this.#socket.close();
    });
  }

  async #request(params) {
    const socket = await this.#connect();
    const id = this.#nextRequestId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new SprutHubError(
            "timeout",
            "SprutHub did not respond within the request budget.",
            "retry",
          ),
        );
      }, this.timeoutMs);
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

  async #connect() {
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    if (this.#connectPromise) return this.#connectPromise;

    this.#connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, "json-rpc");
      const failBeforeOpen = () => {
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
        socket.off("error", failBeforeOpen);
        this.#socket = socket;
        this.#connectPromise = undefined;
        resolve(socket);
      });
      socket.on("message", (data) => this.#handleMessage(data));
      socket.on("close", () => this.#handleClose());
    });

    try {
      return await this.#connectPromise;
    } catch (error) {
      this.#connectPromise = undefined;
      throw error;
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

  #handleClose() {
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

function normalizeAccessory(accessory) {
  return {
    ref: `spruthub://accessory/${accessory.id}`,
    name: accessory.name,
    available: accessory.online,
    services: (accessory.services ?? []).map((service) => ({
      ref: `spruthub://accessory/${accessory.id}/service/${service.sId}`,
      name: service.name,
      type: service.type,
      readings: (service.characteristics ?? []).map((characteristic) => {
        const control = characteristic.control ?? {};
        return {
          ref: `spruthub://accessory/${accessory.id}/service/${service.sId}/characteristic/${characteristic.cId}`,
          name: control.name,
          type: control.type ?? control.key,
          value: extractValue(control.value),
          unit: control.unit ?? null,
          measuredAt: null,
        };
      }),
    })),
  };
}

function extractValue(value) {
  if (!value) return null;
  for (const field of VALUE_FIELDS) {
    if (Object.hasOwn(value, field)) return value[field];
  }
  return null;
}
