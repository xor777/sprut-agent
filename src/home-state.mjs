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
// EVENT_UPDATE renames a room, an accessory EVENT_REMOVE removes it. The
// hub also announces the other edits of rooms, devices and services
// (2026-10-13-structure-events); the state does not apply them but reads
// what they changed: an added, renamed or moved accessory, a service event,
// a changed value of a device's information service (its name or
// availability), a value of a characteristic the state lacks, a
// characteristic event of another shape or over another connection have
// that accessory read again by accessory.get; a room added, moved in the
// order or unknown has the room list read again; a room removed (its
// devices move) and an event part the state cannot read have the whole
// home read again.
//
// One rule keeps an answer from showing what it may have missed: every
// event the state cannot apply, a configuration write of this process (not
// a device value, a scenario, a device search or a notification setting),
// a connection retired or lost and more events during reads than it keeps
// change its generation, and a read is taken only if the generation did
// not change since the read began; its caller reads again. What the state
// applied while a read was in flight is applied again over the read. The
// whole home is also read again MAX_AGE_MS after the last whole read, when
// the connection that feeds the state has pushed no event for QUIET_MS or
// none at all (only a pushed event shows that the hub still pushes them
// there), and when the clock has moved back past either. A value this
// process writes is unconfirmed until an event of that value received
// after the write's reply (the hub pushes one for every write, after its
// reply, 2026-10-13-lamp-logic-undo 4.2, 4.5) or a read begun after the
// reply.
import { extractTypedValue } from "./spruthub-client.mjs";

// The longest the state answers without a whole read: a safety net for an
// edit the hub does not announce or an event this code cannot follow, at
// the cost of one whole read (245 ms on the owner's hub) per 5 minutes of
// use. It is the age the session catalog of names had before.
export const MAX_AGE_MS = 5 * 60_000;
// A connection that pushed no event this long may be gone without a close
// (a network drop, a sleeping laptop) or have stopped pushing while it
// still answers requests: its events may be lost, and replies to this
// process's requests do not count. The next answer reads the whole home.
// The owner's hub pushes 14 to 25 events a minute at rest
// (2026-10-13-voice-latency-baseline, section 5;
// 2026-10-13-structure-events); in a home that pushes fewer, an answer
// after a quiet minute costs the whole read it cost before this state.
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
  // The virtual lamp groups and the lamps they link, as the last whole read
  // found them (SprutHubClient #readLampGroups); null when that read could
  // not read them.
  // Links are read only with the whole home: a link this process writes
  // has the whole home read again; one made in the app shows within
  // MAX_AGE_MS at the latest (whether the hub announces link changes was
  // not checked).
  #lampGroups = null;
  #catalogObservedAt = null;
  #builtAt = 0;
  // The record of the connection whose events the state follows; the
  // client keeps lastEventAt on it, the time its last pushed event came
  // (null before the first).
  #feed = null;
  // Changes whenever the state learns of something it cannot follow; a
  // read begun before is not taken.
  #generation = 0;
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
  // The order in which events and this process's write replies came: each
  // takes the next number. The client counts a reply when it handles the
  // reply's frame, before any frame after it.
  #seq = 0;
  // The last value write of this process to a characteristic awaiting its
  // event: key -> {key, aId, value, ackSeq}.
  #pending = new Map();
  // Accessory id -> when it was read or its latest event came.
  #observedAt = new Map();
  // Reads numbered in the order they begin, and the number of the whole
  // read the state holds.
  #reads = 0;
  #wholeRead = 0;
  // While reads are in flight: the events that came meanwhile.
  #log = null;

  constructor(serial) {
    this.serial = serial;
  }

  get generation() {
    return this.#generation;
  }

  // The number of the last read begun: a call takes it when it starts, so
  // that a whole read it makes itself is told apart.
  readMark() {
    return this.#reads;
  }

  // What must be read before the next answer: the whole home, or the rooms
  // and the accessories to read one by one; null when nothing. A whole read
  // begun after the mark since answers what only time asks for, so that a
  // call does not read again for a quiet connection it just read over, and
  // a refresh, which asks for such a read.
  needs(now = Date.now(), since = Number.POSITIVE_INFINITY, refresh = false) {
    if (
      this.#stale !== null ||
      (this.#wholeRead <= since && (refresh || this.#expired(now)))
    ) {
      return { whole: true };
    }
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
      lampGroups: this.#lampGroups,
      observedAt: this.#catalogObservedAt,
      accessoryObservedAt: new Map(this.#observedAt),
    };
  }

  #expired(now) {
    const heard = this.#feed.lastEventAt;
    return (
      heard === null ||
      now < this.#builtAt ||
      now < heard ||
      now - this.#builtAt >= MAX_AGE_MS ||
      now - heard >= QUIET_MS
    );
  }

  beginRead() {
    this.#log ??= { entries: [], readers: 0 };
    this.#log.readers += 1;
    return {
      number: ++this.#reads,
      generation: this.#generation,
      log: this.#log,
      start: this.#log.entries.length,
      at: Date.now(),
      seq: this.#seq,
    };
  }

  endRead(token) {
    if (token.ended) return;
    token.ended = true;
    token.log.readers -= 1;
    if (token.log.readers === 0 && this.#log === token.log) this.#log = null;
  }

  // The whole home as read. feed is the connection both lists came over,
  // null when they came over two.
  replaceWhole({ rooms, accessories, observedAt, feed, lampGroups }, token) {
    if (token.generation !== this.#generation) return;
    this.#rooms = rooms;
    this.#accessories = accessories;
    this.#lampGroups = lampGroups ?? null;
    this.#byId = new Map(accessories.map((item) => [item.id, item]));
    this.#catalogObservedAt = observedAt;
    this.#builtAt = token.at;
    this.#wholeRead = token.number;
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
    if (token.generation !== this.#generation) return;
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
    if (token.generation !== this.#generation) return;
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
    const entry = { event, record, receivedAt, seq: ++this.#seq };
    this.#append(entry);
    if (this.#accessories !== null) this.#apply(entry, { all: true });
  }

  // Something the state cannot follow: the whole home is read again.
  invalidate(reason) {
    this.#generation += 1;
    this.#stale ??= reason;
  }

  // A connection retired or lost: a read over it may have missed events,
  // and the state may have followed its events.
  connectionGone(record, reason) {
    this.#generation += 1;
    if (record === this.#feed) this.#stale ??= reason;
  }

  // A value write of this process to target; returns the write to name
  // when its reply comes or it fails.
  writeSent(target, value) {
    const key = valueKey(target);
    const write = { key, aId: target.aId, value, ackSeq: null };
    this.#pending.set(key, write);
    return write;
  }

  // Called as the reply's frame is handled, before any later frame.
  writeAnswered(write) {
    write.ackSeq = ++this.#seq;
  }

  // The client reads again what a failed write may have changed: a write
  // without a reply retires or loses the connection the state follows.
  writeFailed(write) {
    if (this.#pending.get(write.key) === write) this.#pending.delete(write.key);
  }

  // A read sent after a write's reply shows what the write did.
  #confirmWrites(token, id) {
    for (const [key, write] of this.#pending) {
      if (
        (id === null || write.aId === id) &&
        write.ackSeq !== null &&
        write.ackSeq <= token.seq
      ) {
        this.#pending.delete(key);
      }
    }
  }

  #append(entry) {
    const log = this.#log;
    if (!log) return;
    if (log.entries.length < EVENT_LOG_LIMIT) {
      log.entries.push(entry);
      return;
    }
    // The reads in flight cannot be given all that came: none is taken,
    // and later reads keep a new log.
    this.#log = null;
    this.invalidate("event_burst");
  }

  #replay(token, scope) {
    for (const entry of token.log.entries.slice(token.start)) {
      this.#apply(entry, scope);
    }
  }

  // An event as received; scope: all, the rooms, or one accessory (what a
  // read just replaced).
  #apply(entry, scope) {
    // While the whole home is due, as after a lost connection, the state
    // answers nothing and follows no connection: an event is nobody else's.
    // The whole read in flight, over the connection that brings them, has
    // them in its log and tells them apart by its own connection.
    const fromFeed = entry.record === this.#feed || this.#stale !== null;
    for (const [domain, part] of Object.entries(entry.event)) {
      if (domain === "characteristic") {
        this.#characteristicEvent(part, entry, scope, fromFeed);
      } else if (domain === "accessory") {
        this.#accessoryEvent(part, scope, fromFeed);
      } else if (domain === "service") {
        this.#serviceEvent(part, scope);
      } else if (domain === "room") {
        if (scope.all || scope.rooms) this.#roomEvent(part, fromFeed);
      } else if (domain === "hub") {
        this.invalidate("hub_event");
      }
    }
  }

  // An accessory an event changed in a way only a read gives.
  #reread(id, reason) {
    this.#generation += 1;
    this.#staleAccessories.set(id, reason);
  }

  // Items of a domain's event that concern the scope; an item without a
  // stable id makes the whole state stale.
  #items(items, idKey, scope) {
    return items.filter((item) => {
      if (!isStableId(item?.[idKey])) {
        this.invalidate("unknown_event");
        return false;
      }
      return scope.all || scope.accessory === item[idKey];
    });
  }

  #characteristicEvent(part, entry, scope, fromFeed) {
    if (!Array.isArray(part?.characteristics)) {
      this.invalidate("unknown_event");
      return;
    }
    for (const item of this.#items(part.characteristics, "aId", scope)) {
      if (!fromFeed) {
        this.#reread(item.aId, "other_connection");
      } else if (
        part.event !== "EVENT_UPDATE" ||
        !isStableId(item.sId) ||
        !isStableId(item.cId) ||
        !extractTypedValue(item.control?.value).found
      ) {
        this.#reread(item.aId, "unknown_event");
      } else {
        this.#setValue(item, entry);
      }
    }
  }

  #setValue(item, { receivedAt, seq }) {
    const key = valueKey(item);
    // The hub pushes a write's event after its reply
    // (2026-10-13-lamp-logic-undo 4.2): an earlier one, or one of another
    // value, is another change or an earlier write's late event.
    const write = this.#pending.get(key);
    if (
      write &&
      write.ackSeq !== null &&
      seq > write.ackSeq &&
      extractTypedValue(item.control.value).value ===
        extractTypedValue(write.value).value
    ) {
      this.#pending.delete(key);
    }
    const accessory = this.#byId.get(item.aId);
    const located = locate(accessory, item.sId, item.cId);
    if (!located) {
      this.#reread(item.aId, "unknown_characteristic");
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
      this.#reread(item.aId, "device_information");
    }
  }

  #accessoryEvent(part, scope, fromFeed) {
    if (!Array.isArray(part?.accessories)) {
      // A camera's stream frames come without accessories.
      if (part?.streams === undefined) this.invalidate("unknown_event");
      return;
    }
    if (!ACCESSORY_EVENTS.has(part.event)) {
      this.invalidate("unknown_event");
      return;
    }
    for (const item of this.#items(part.accessories, "id", scope)) {
      if (part.event === "EVENT_REMOVE" && fromFeed) this.#remove(item.id);
      else this.#reread(item.id, ACCESSORY_EVENTS.get(part.event));
    }
  }

  #serviceEvent(part, scope) {
    if (!Array.isArray(part?.services)) {
      this.invalidate("unknown_event");
      return;
    }
    for (const item of this.#items(part.services, "aId", scope)) {
      this.#reread(item.aId, "service_changed");
    }
  }

  // A room's name follows its event; a room added, moved in the order or
  // unknown has the room list read again, a removed one the whole home
  // (its devices move).
  #roomEvent(part, fromFeed) {
    if (!Array.isArray(part?.rooms)) {
      this.invalidate("unknown_event");
      return;
    }
    if (part.event === "EVENT_REMOVE") {
      this.invalidate("room_removed");
      return;
    }
    if (part.event === "EVENT_ADD" || !fromFeed) {
      this.#generation += 1;
      this.#roomsStale = true;
      for (const { id } of part.rooms.filter((item) => isStableId(item?.id))) {
        this.#absentRooms.delete(id);
        this.#roomsAskedFor.add(id);
      }
      return;
    }
    if (part.event !== "EVENT_UPDATE") {
      this.invalidate("unknown_event");
      return;
    }
    for (const item of part.rooms) {
      if (!isStableId(item?.id)) {
        this.invalidate("unknown_event");
        continue;
      }
      const room = this.#rooms.find(({ id }) => id === item.id);
      if (!room) {
        if (this.#askForRoom(item.id)) this.#generation += 1;
        continue;
      }
      const update = {};
      if (typeof item.name === "string" && item.name !== room.name) {
        update.name = item.name;
      }
      if (Number.isSafeInteger(item.order) && item.order !== room.order) {
        if (room.order !== undefined) {
          this.#generation += 1;
          this.#roomsStale = true;
        }
        update.order = item.order;
      }
      if (Object.keys(update).length > 0) {
        this.#rooms = this.#rooms.map((other) =>
          other === room ? { ...room, ...update } : other,
        );
      }
    }
  }

  // A room the state lacks has the room list read, once; whether it is
  // asked for now.
  #askForRoom(id) {
    if (
      this.#rooms.some((room) => room.id === id) ||
      this.#absentRooms.has(id)
    ) {
      return false;
    }
    this.#roomsStale = true;
    this.#roomsAskedFor.add(id);
    return true;
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
