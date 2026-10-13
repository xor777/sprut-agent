// The home a SprutHub client keeps warm in memory for household reads:
// rooms and accessories with their services and current values. It is read
// whole once (room.list and accessory.list) and then kept current by the
// events the hub pushes to a connection after its first request with the
// home's serial (2026-10-13-voice-latency-baseline, section 5); the web
// client of SprutHub polls nothing and keeps its screens current from these
// events alone (2026-10-12-device-pairing K11).
//
// An event is applied where its shape is observed: a characteristic
// EVENT_UPDATE sets one value (aId, sId, cId, control.value), a room
// EVENT_UPDATE renames a room. Of the other events only the ids are taken,
// since their content was not observed: an added, changed or moved
// accessory, a service event, a changed value of a device's information
// service (its name or availability) and a value of a characteristic the
// state lacks have that accessory read again by accessory.get before the
// next answer; a removed accessory leaves at once. The whole home is read
// again before the next answer when the state cannot follow the hub: a room
// added or removed, another event type, a frame it cannot read, the
// connection that feeds it retired, lost or quiet for QUIET_MS, events of
// two homes on one connection, more events during a read than it keeps,
// this process's own writes other than device values, and MAX_AGE_MS after
// the last whole read. A value this process writes is unconfirmed until its event comes
// (the hub pushes one for every write, after its reply,
// 2026-10-13-lamp-logic-undo 4.2, 4.5) or a read sent after the reply.
import { extractTypedValue } from "./spruthub-client.mjs";

// The longest the state answers without a whole read: a safety net for an
// edit the hub does not announce or an event this code cannot follow, at
// the cost of one whole read (245 ms on the owner's hub) per 5 minutes of
// use. It is the age the session catalog of names had before.
export const MAX_AGE_MS = 5 * 60_000;
// A connection that carried no frame this long may be gone without a close
// (a network drop, a sleeping laptop), its events lost: the next answer
// reads the whole home, which also tells whether the connection still
// answers. The owner's hub pushes about 25 frames a minute at rest
// (2026-10-13-voice-latency-baseline, section 5); in a home that pushes
// fewer, an answer after a quiet minute costs the whole read it cost before
// this state.
const QUIET_MS = 60_000;
// Accessories read again one by one before an answer; past that one whole
// read is cheaper (accessory.get about 90 ms each on the owner's hub, the
// whole home 245 ms; 81 parallel reads took about 9 s,
// 2026-10-12-notifications-live).
const ACCESSORY_REREADS = 4;
// Events kept while a read is in flight, to apply again over what it read.
// Creating 4 accessories pushed about 360 frames in 2 s on the owner's hub.
const EVENT_LOG_LIMIT = 1_000;

export class HomeState {
  #rooms = null;
  #accessories = null;
  #byId = new Map();
  #catalogObservedAt = null;
  #builtAt = 0;
  // The record of the connection whose events the state follows; the
  // client keeps lastFrameAt on it, the time its last frame came.
  #feed = null;
  // Why the whole home must be read again before the next answer, or null.
  #stale = "not_read";
  #roomsStale = false;
  // Rooms of devices or events the last room list lacked (a device's room
  // may be missing from it), not asked for again; and those the next room
  // list read is asked for.
  #absentRooms = new Set();
  #roomsAskedFor = new Set();
  // Accessory id -> why it must be read again.
  #staleAccessories = new Map();
  // Value writes of this process awaiting their event: key -> {aId, ackAt}.
  #pending = new Map();
  // Accessory id -> when it was read or its latest event came.
  #observedAt = new Map();
  // While reads are in flight: what happened meanwhile, applied again over
  // each read's result.
  #log = null;

  constructor(serial) {
    this.serial = serial;
  }

  // What must be read before the next answer: the whole home, or the rooms
  // and the accessories to read one by one; null when nothing.
  needs(now = Date.now()) {
    if (this.#wholeReason(now) !== null) return { whole: true };
    const ids = new Set(this.#staleAccessories.keys());
    for (const { aId } of this.#pending.values()) ids.add(aId);
    if (ids.size > ACCESSORY_REREADS) return { whole: true };
    if (!this.#roomsStale && ids.size === 0) return null;
    return { whole: false, rooms: this.#roomsStale, accessories: [...ids] };
  }

  // The home as the state holds it now. Its parts are not changed later:
  // an event replaces what it changes.
  catalog() {
    return {
      serial: this.serial,
      rooms: this.#rooms,
      accessories: this.#accessories,
      byId: this.#byId,
      observedAt: this.#catalogObservedAt,
      accessoryObservedAt: new Map(this.#observedAt),
    };
  }

  #wholeReason(now) {
    if (this.#stale !== null) return this.#stale;
    if (now - this.#builtAt >= MAX_AGE_MS) return "max_age";
    if (now - this.#feed.lastFrameAt >= QUIET_MS) return "quiet_connection";
    return null;
  }

  // A read starts: what happens until it ends is applied again over it.
  beginRead() {
    this.#log ??= { entries: [], overflow: false, readers: 0 };
    this.#log.readers += 1;
    return { log: this.#log, start: this.#log.entries.length, at: Date.now() };
  }

  endRead(token) {
    if (token.ended) return;
    token.ended = true;
    token.log.readers -= 1;
    if (token.log.readers === 0 && this.#log === token.log) this.#log = null;
  }

  // The whole home as read. feed is the connection both lists came over,
  // null when they came over two.
  replaceWhole({ rooms, accessories, observedAt, feed }, token) {
    this.#rooms = rooms;
    this.#accessories = accessories;
    this.#byId = new Map(accessories.map((item) => [item.id, item]));
    this.#catalogObservedAt = observedAt;
    this.#builtAt = token.at;
    this.#feed = feed;
    this.#stale = feed === null ? "connection_changed" : null;
    this.#roomsStale = false;
    this.#roomsAskedFor.clear();
    this.#absentRooms = missingRooms(rooms, accessories);
    this.#staleAccessories.clear();
    this.#observedAt = new Map(accessories.map(({ id }) => [id, observedAt]));
    this.#confirmWrites(token, null);
    this.#replay(token, { all: true });
  }

  replaceRooms(rooms, token) {
    if (this.#accessories === null) return;
    this.#rooms = rooms;
    this.#roomsStale = false;
    this.#absentRooms = missingRooms(rooms, this.#accessories);
    for (const id of this.#roomsAskedFor) {
      if (!rooms.some((room) => room.id === id)) this.#absentRooms.add(id);
    }
    this.#roomsAskedFor.clear();
    this.#replay(token, { rooms: true });
  }

  // One accessory as read, or null when the hub no longer has it.
  replaceAccessory(id, accessory, observedAt, token) {
    if (this.#accessories === null) return;
    this.#staleAccessories.delete(id);
    if (accessory) {
      this.#put(accessory);
      this.#observedAt.set(id, observedAt);
      this.#askForRoom(accessory.roomId);
    } else {
      this.#remove(id);
    }
    this.#confirmWrites(token, id);
    this.#replay(token, { accessory: id });
  }

  // An event frame's event part, from the connection record.
  receive(event, record, receivedAt) {
    if (this.#accessories === null && !this.#log) return;
    this.#append({ event, record, receivedAt });
    if (this.#accessories !== null) {
      this.#apply(event, record, receivedAt, { all: true });
    }
  }

  markStale(reason) {
    this.#stale ??= reason;
    this.#append({ stale: reason });
  }

  // The connection record is retired or lost: the state is stale if it
  // follows that connection.
  connectionGone(record, reason) {
    if (record === this.#feed) this.#stale ??= reason;
    this.#append({ gone: record, reason });
  }

  writeSent(target) {
    this.#pending.set(valueKey(target), { aId: target.aId, ackAt: null });
  }

  writeAnswered(target) {
    const write = this.#pending.get(valueKey(target));
    if (write) write.ackAt = Date.now();
  }

  // The client reads again what a failed write may have changed: a write
  // without a reply retires or loses the connection the state follows.
  writeFailed(target) {
    this.#pending.delete(valueKey(target));
  }

  // A read sent after a write's reply shows what the write did.
  #confirmWrites(token, id) {
    for (const [key, write] of this.#pending) {
      if (
        (id === null || write.aId === id) &&
        write.ackAt !== null &&
        write.ackAt <= token.at
      ) {
        this.#pending.delete(key);
      }
    }
  }

  #append(entry) {
    const log = this.#log;
    if (!log || log.overflow) return;
    if (log.entries.length >= EVENT_LOG_LIMIT) {
      log.overflow = true;
      return;
    }
    log.entries.push(entry);
  }

  #replay(token, scope) {
    for (const entry of token.log.entries.slice(token.start)) {
      if (entry.event) {
        this.#apply(entry.event, entry.record, entry.receivedAt, scope);
      } else if (scope.all && entry.stale) {
        this.#stale ??= entry.stale;
      } else if (scope.all && entry.gone) {
        if (entry.gone === this.#feed) this.#stale ??= entry.reason;
      }
    }
    if (token.log.overflow) this.#stale ??= "event_burst";
  }

  // scope: all, the rooms, or one accessory (what a read just replaced).
  #apply(event, record, receivedAt, scope) {
    const fromFeed = record === this.#feed;
    for (const [domain, part] of Object.entries(event)) {
      if (domain === "characteristic") {
        this.#characteristicEvent(part, receivedAt, scope, fromFeed);
      } else if (domain === "accessory") {
        this.#accessoryEvent(part, scope, fromFeed);
      } else if (domain === "service") {
        this.#serviceEvent(part, scope);
      } else if (domain === "room") {
        if (scope.all || scope.rooms) this.#roomEvent(part, fromFeed);
      } else if (domain === "hub") {
        if (scope.all) this.#stale ??= "hub_event";
      }
    }
  }

  #unknownEvent(scope) {
    if (scope.all) this.#stale ??= "unknown_event";
  }

  // Items of a domain's event that concern the scope; an item without a
  // stable id makes the whole state stale.
  #items(items, idKey, scope) {
    return items.filter((item) => {
      if (!isStableId(item?.[idKey])) {
        this.#unknownEvent(scope);
        return false;
      }
      return scope.all || scope.accessory === item[idKey];
    });
  }

  #characteristicEvent(part, receivedAt, scope, fromFeed) {
    if (!Array.isArray(part?.characteristics)) {
      this.#unknownEvent(scope);
      return;
    }
    for (const item of this.#items(part.characteristics, "aId", scope)) {
      if (!fromFeed) {
        this.#staleAccessories.set(item.aId, "other_connection");
      } else if (
        part.event !== "EVENT_UPDATE" ||
        !isStableId(item.sId) ||
        !isStableId(item.cId) ||
        !extractTypedValue(item.control?.value).found
      ) {
        this.#staleAccessories.set(item.aId, "unknown_event");
      } else {
        this.#setValue(item, receivedAt);
      }
    }
  }

  #setValue(item, receivedAt) {
    const key = valueKey(item);
    this.#pending.delete(key);
    const accessory = this.#byId.get(item.aId);
    const located = locate(accessory, item.sId, item.cId);
    if (!located) {
      this.#staleAccessories.set(item.aId, "unknown_characteristic");
      return;
    }
    const { service, characteristic } = located;
    const value = structuredClone(item.control.value);
    const changed =
      JSON.stringify(characteristic.control?.value) !== JSON.stringify(value);
    if (changed) {
      this.#put({
        ...accessory,
        services: accessory.services.map((candidate) =>
          candidate !== service
            ? candidate
            : {
                ...candidate,
                characteristics: candidate.characteristics.map((other) =>
                  other !== characteristic
                    ? other
                    : { ...other, control: { ...other.control, value } },
                ),
              },
        ),
      });
    }
    this.#observedAt.set(item.aId, receivedAt);
    // A device's name and availability are its accessory's fields, which
    // only a read gives.
    if (changed && service.type === "AccessoryInformation") {
      this.#staleAccessories.set(item.aId, "device_information");
    }
  }

  #accessoryEvent(part, scope, fromFeed) {
    if (!Array.isArray(part?.accessories)) {
      // A camera's stream frames come without accessories.
      if (part?.streams === undefined) this.#unknownEvent(scope);
      return;
    }
    if (!ACCESSORY_EVENTS.has(part.event)) {
      this.#unknownEvent(scope);
      return;
    }
    for (const item of this.#items(part.accessories, "id", scope)) {
      if (part.event === "EVENT_REMOVE" && fromFeed) this.#remove(item.id);
      else
        this.#staleAccessories.set(item.id, ACCESSORY_EVENTS.get(part.event));
    }
  }

  #serviceEvent(part, scope) {
    if (!Array.isArray(part?.services)) {
      this.#unknownEvent(scope);
      return;
    }
    for (const item of this.#items(part.services, "aId", scope)) {
      this.#staleAccessories.set(item.aId, "service_changed");
    }
  }

  // A room's name follows its event; a room added, moved in the order or
  // unknown has the room list read again, a removed one the whole home
  // (its devices move).
  #roomEvent(part, fromFeed) {
    if (!Array.isArray(part?.rooms)) {
      this.#stale ??= "unknown_event";
      return;
    }
    if (part.event === "EVENT_REMOVE") {
      this.#stale ??= "room_removed";
      return;
    }
    if (part.event === "EVENT_ADD" || !fromFeed) {
      this.#roomsStale = true;
      for (const { id } of part.rooms.filter((item) => isStableId(item?.id))) {
        this.#absentRooms.delete(id);
        this.#roomsAskedFor.add(id);
      }
      return;
    }
    if (part.event !== "EVENT_UPDATE") {
      this.#stale ??= "unknown_event";
      return;
    }
    for (const item of part.rooms) {
      if (!isStableId(item?.id)) {
        this.#stale ??= "unknown_event";
        continue;
      }
      const room = this.#rooms.find(({ id }) => id === item.id);
      if (!room) {
        this.#askForRoom(item.id);
        continue;
      }
      const update = {};
      if (typeof item.name === "string" && item.name !== room.name) {
        update.name = item.name;
      }
      if (Number.isSafeInteger(item.order) && item.order !== room.order) {
        if (room.order !== undefined) this.#roomsStale = true;
        update.order = item.order;
      }
      if (Object.keys(update).length > 0) {
        this.#rooms = this.#rooms.map((other) =>
          other === room ? { ...room, ...update } : other,
        );
      }
    }
  }

  // A room the state lacks has the room list read, once.
  #askForRoom(id) {
    if (
      this.#rooms.some((room) => room.id === id) ||
      this.#absentRooms.has(id)
    ) {
      return;
    }
    this.#roomsStale = true;
    this.#roomsAskedFor.add(id);
  }

  #put(accessory) {
    const known = this.#byId.has(accessory.id);
    this.#accessories = known
      ? this.#accessories.map((item) =>
          item.id === accessory.id ? accessory : item,
        )
      : [...this.#accessories, accessory];
    this.#byId = new Map(this.#byId).set(accessory.id, accessory);
  }

  #remove(id) {
    if (this.#byId.has(id)) {
      this.#accessories = this.#accessories.filter((item) => item.id !== id);
      this.#byId = new Map(this.#byId);
      this.#byId.delete(id);
    }
    this.#staleAccessories.delete(id);
    this.#observedAt.delete(id);
    for (const [key, write] of this.#pending) {
      if (write.aId === id) this.#pending.delete(key);
    }
  }
}

const ACCESSORY_EVENTS = new Map([
  ["EVENT_ADD", "accessory_added"],
  ["EVENT_UPDATE", "accessory_changed"],
  ["EVENT_REMOVE", "accessory_removed"],
]);

function missingRooms(rooms, accessories) {
  const known = new Set(rooms.map(({ id }) => id));
  return new Set(
    accessories.map(({ roomId }) => roomId).filter((id) => !known.has(id)),
  );
}

function locate(accessory, sId, cId) {
  const service = accessory?.services?.find((item) => item.sId === sId);
  const characteristic = service?.characteristics?.find(
    (item) => item.cId === cId,
  );
  return characteristic ? { service, characteristic } : null;
}

function valueKey({ aId, sId, cId }) {
  return `${aId}:${sId}:${cId}`;
}

function isStableId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
