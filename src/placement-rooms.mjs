import { isDeepStrictEqual } from "node:util";
import { configuredHomeRef } from "./change-refs.mjs";

export function accessoryPlacementSnapshot(accessory, room) {
  return {
    name: accessory.name,
    room_id: accessory.roomId,
    room_name: room?.name ?? null,
    binding: {
      id: accessory.id,
      endpoint: accessory.endpoint ?? null,
      extension_key: accessory.extensionKey ?? null,
      controller_index: accessory.controllerIndex ?? null,
      device_id: accessory.deviceId ?? null,
      device_window: accessory.deviceWindow ?? null,
      services: (accessory.services ?? [])
        .map(({ sId, type }) => ({ id: sId, type }))
        .sort((left, right) => left.id - right.id),
    },
  };
}

export function accessoryPlacementMatches(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.name === right.name &&
    left.room_id === right.room_id &&
    isDeepStrictEqual(left.binding, right.binding)
  );
}

export function roomSnapshot(room) {
  return {
    id: room.id,
    name: room.name,
    order: room.order ?? null,
    visible: room.visible ?? null,
  };
}

export function publicRoom(room, serial) {
  return {
    ref: `${configuredHomeRef(serial)}/room/${room.id}`,
    name: room.name,
  };
}

export function publicAccessoryPlacement(snapshot, serial) {
  return {
    name: snapshot.name,
    room_ref: `${configuredHomeRef(serial)}/room/${snapshot.room_id}`,
    room_name: snapshot.room_name,
  };
}

export function placementOwnedSinceApply(change) {
  return (
    change.status === "applied" ||
    (change.status === "conflict" &&
      change.conflict_reason === "later_owned_change")
  );
}

// A sent create is unknown until the room is identified, unless the hub
// refused the request (or it was never delivered): then no room was created.
export function roomCreationOutcomeUnknown(change) {
  return change.native_write_sent === true && change.status !== "not_applied";
}
