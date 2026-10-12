// A controller's device search: the agent opens the network for new devices
// by the controller's own search action (ZigBee «Поиск»), the owner puts a
// device into pairing mode, and the hub reports the new device and the
// accessory it creates. Facts this rests on are in
// research/protocol/2026-10-12-device-pairing.md: the start, a restart and
// the stop were seen on the owner's hub (check 1); how a device joins is
// inferred from the web client, so the controller's device list is read
// again as the truth and pushed events only wake that read.
//
// A search is not a configuration change: it has no restore, ends by
// itself and waits for a person, so it is kept in this process only, not
// in the change journal.
import { randomUUID } from "node:crypto";
import { serviceKind } from "./home-reads.mjs";
import {
  accessoryRef,
  DEVICE_SEARCH_SPACE,
  extensionChildRef,
  extensionRef,
  extensionSearchAction,
  homeRef,
  isHubReadFailure,
  parseEntityRef,
  roomRef,
  runningActionEnd,
  SprutHubError,
  searchEnd,
  serviceRef,
  UTC_TIMES_LIMITATION,
  windowLinkedAccessoryIds,
} from "./spruthub-client.mjs";

// How often a wait reads the device list when no event wakes it. The list
// of the owner's ZigBee is about 19 KB for 61 devices.
const POLL_MS = 3_000;
// After a pushed event, the read waits this long for the hub to settle.
const EVENT_SETTLE_MS = 250;
// Pushed event domains that may mean a search or a device changed.
const EVENT_DOMAINS = ["extension", "extensionChild", "accessory"];
// A start the hub acknowledged is read back once more after this long if
// it does not show yet: check 1 read it back 0.5 s after the answer.
const START_CONFIRM_MS = 1_000;
// A search seen ended within this long of its end counts as expired.
const EXPIRY_TOLERANCE_MS = 3_000;
// A device that joined may still be getting its accessory when the search
// ends; this long after the end a device still without one is reported as
// not added. How long the hub takes was not observed: one longest wait.
const ACCESSORY_GRACE_MS = 20_000;
// Devices listed per answer; the rest are counted.
const DEVICE_LIMIT = 10;
// Searches kept in this process.
const SEARCH_LIMIT = 20;
const SEARCH_REF_PART = "/device_search/";

const OWNER_STEP =
  "Tell the owner to put the new device into pairing mode now, as its manufacturer describes, close to the hub. Until ends_at the network is open: any device in pairing mode within range can join, not only the owner's. Then call next to wait for the hub to report the device. If the owner sees your messages only after your turn ends, tell them to put the device into pairing mode now, end the turn, and call get_device_search when they reply: a device that joined is still reported after the search ended.";

export class DeviceSearches {
  #client;
  #searches = new Map();
  #locks = new Map();

  constructor(client) {
    this.#client = client;
  }

  async start({ extensionRef: ref, spaceKey = DEVICE_SEARCH_SPACE }) {
    const target = this.#target(ref);
    return this.#exclusive(target.extensionKey, () =>
      this.#start(target, spaceKey),
    );
  }

  async get(searchRef, waitSeconds = 0) {
    const search = this.#search(searchRef);
    const until = Date.now() + waitSeconds * 1_000;
    let view = await this.#read(search);
    while (Date.now() < until && !worthReturning(search, view)) {
      await this.#wake(Math.min(POLL_MS, until - Date.now()));
      view = await this.#read(search);
    }
    return this.#report(search, view);
  }

  async stop(searchRef) {
    const search = this.#search(searchRef);
    return this.#exclusive(search.extensionKey, () => this.#stop(search));
  }

  async #start(target, spaceKey) {
    const client = this.#client;
    const deadline = Date.now() + client.timeoutMs;
    const { extension } = await client.nativeExtension(
      target.serial,
      target.extensionKey,
      deadline,
    );
    const action = searchActionOrRefuse(extension, spaceKey, target.ref);
    const timeZone = await client.hubTimeZone(target.serial, deadline);
    // The controller's latest watch goes on or has ended by now.
    const current = this.#latest(target.extensionKey);
    if (current) this.#updateState(current, extension);
    if (action.state === true) {
      // A resend would restart the hub's timer and keep the network open
      // longer (P3), so a running search is only watched.
      const search =
        current && current.ended === null
          ? current
          : this.#remember(
              target,
              extension,
              action,
              timeZone,
              await this.#baseline(target, current, deadline, true),
            );
      const view = await this.#read(search);
      search.lastFingerprint = view.fingerprint;
      return this.#startResult(search, view, "already_running");
    }

    const search = this.#remember(
      target,
      extension,
      action,
      timeZone,
      await this.#baseline(target, current, deadline, false),
    );
    let replyLost = false;
    try {
      await client.extensionAction(
        target.serial,
        {
          extensionKey: target.extensionKey,
          spaceKey: search.spaceKey,
          actionId: search.actionId,
          state: true,
        },
        Date.now() + client.timeoutMs,
      );
    } catch (error) {
      if (!(error instanceof SprutHubError) || !error.requestSent) {
        this.#forget(search);
        throw error;
      }
      if (error.hubError !== undefined) {
        this.#forget(search);
        throw refusedByHub(error, target.ref, "start");
      }
      // The start may have reached the hub: what runs is read back below.
      replyLost = true;
    }
    let view = await this.#readAfterWrite(search);
    if (view.active === false && !replyLost) {
      await this.#wake(START_CONFIRM_MS);
      view = await this.#readAfterWrite(search);
    }
    // From now on a search not shown running has ended: a start that never
    // showed ends this watch as unknown, and a search that shows later is
    // found by start_device_search, not resent.
    search.startRead = true;
    if (view.active === false && !search.seenRunning) {
      endWatch(search, "unknown");
    }
    search.lastFingerprint = view.fingerprint;
    if (view.active === true && !replyLost) {
      return this.#startResult(search, view, "started");
    }
    return {
      ...this.#startResult(search, view, "unknown"),
      message: `${replyLost ? "The hub did not answer the start" : "The hub acknowledged the start"}${
        view.active === true
          ? ", and the search shows as running."
          : view.active === false
            ? ", but the search does not show as running. Read the controller with get_entity before starting again."
            : ", and the search could not be read back; get_device_search reads it again."
      }`,
    };
  }

  async #stop(search) {
    const client = this.#client;
    let stopSent = false;
    let replyLost = false;
    if (search.ended === null) {
      const { extension } = await client.nativeExtension(
        search.serial,
        search.extensionKey,
        Date.now() + client.timeoutMs,
      );
      // Only this watch's search is stopped: by now it may have ended, or
      // a later run of the controller may be another's (#updateState).
      this.#updateState(search, extension);
      if (search.ended === null && search.active === true) {
        search.stopSent = true;
        try {
          await client.extensionAction(
            search.serial,
            {
              extensionKey: search.extensionKey,
              spaceKey: search.spaceKey,
              actionId: search.actionId,
              state: false,
            },
            Date.now() + client.timeoutMs,
          );
          stopSent = true;
        } catch (error) {
          if (!(error instanceof SprutHubError) || !error.requestSent) {
            search.stopSent = false;
            throw error;
          }
          if (error.hubError !== undefined) {
            search.stopSent = false;
            throw refusedByHub(error, search.extensionRef, "stop");
          }
          // Sent, its answer lost: the state is read back below.
          stopSent = true;
          replyLost = true;
        }
      }
    }
    let view = await this.#readAfterWrite(search);
    if (stopSent && view.active === true) {
      await this.#wake(START_CONFIRM_MS);
      view = await this.#readAfterWrite(search);
    }
    return {
      ...this.#report(search, view),
      stop_sent: stopSent,
      ...(replyLost
        ? {
            message:
              "The hub did not answer the stop; the state shown was read back after it.",
          }
        : {}),
    };
  }

  // The search's state and the controller's devices, compared with the
  // devices before the start.
  async #read(search) {
    const client = this.#client;
    const deadline = Date.now() + client.timeoutMs;
    const [{ extension }, children] = await Promise.all([
      client.nativeExtension(search.serial, search.extensionKey, deadline),
      this.#children(search, deadline),
    ]);
    this.#updateState(search, extension);
    const added = [];
    const changed = [];
    for (const child of children) {
      const before = search.baseline.get(child.id);
      if (!before) {
        added.push(child);
      } else {
        const fields = CHILD_FIELDS.filter(
          (field) => child[field] !== before[field],
        );
        if (fields.length > 0) changed.push({ child, fields });
      }
    }
    // A restart counts from this watch's start only while it has listed
    // no new device (#baseline).
    if (added.length > 0) search.newSeen = true;
    const newDevices = [];
    for (const child of added.slice(0, DEVICE_LIMIT)) {
      newDevices.push(await this.#newDevice(search, child, deadline));
    }
    const changedDevices = changed
      .slice(0, DEVICE_LIMIT)
      .map(({ child, fields }) => ({
        ...publicChild(search, child),
        changed: fields.map((field) => PUBLIC_FIELD[field]),
      }));
    const active = search.ended === null && search.active === true;
    const view = {
      active,
      newDevices,
      newTotal: added.length,
      changedDevices,
      changedTotal: changed.length,
    };
    view.result = searchResult(search, view);
    view.fingerprint = JSON.stringify([
      active,
      search.endsAt,
      search.ended,
      view.result,
      newDevices,
      changedDevices,
    ]);
    return view;
  }

  // A read right after a write: a read that fails leaves the state unknown
  // rather than failing the call whose write may have happened.
  async #readAfterWrite(search) {
    try {
      return await this.#read(search);
    } catch (error) {
      if (!(error instanceof SprutHubError)) throw error;
      return {
        active: null,
        readError: error.code,
        newDevices: [],
        newTotal: 0,
        changedDevices: [],
        changedTotal: 0,
        result: "waiting",
        fingerprint: null,
      };
    }
  }

  #updateState(search, extension) {
    if (search.ended !== null) return;
    const action = findAction(extension, search.spaceKey, search.actionId);
    const end = runningActionEnd(action);
    if (action?.state === true) {
      // Once the watched end has passed, a run that ends later is another
      // run, as one started again in the SprutHub app: this watch's search
      // expired unseen, and the new run is not this watch's to stop. A run
      // restarted before the watched end shows the same way if no read
      // came between; it is then left to a new watch too.
      if (
        search.endsAt !== null &&
        end !== null &&
        end > search.endsAt &&
        Date.now() >= search.endsAt
      ) {
        search.active = false;
        endWatch(search, "expired");
        return;
      }
      search.active = true;
      search.seenRunning = true;
      if (end !== null) search.endsAt = end;
      return;
    }
    search.active = false;
    // A start not shown yet is not an end while #start reads it back.
    if (!search.seenRunning && !search.stopSent && !search.startRead) return;
    // Once the search is seen ended it stays so: a later run is watched by
    // another search (start_device_search).
    endWatch(
      search,
      search.stopSent
        ? "stopped"
        : search.endsAt !== null &&
            Date.now() >= search.endsAt - EXPIRY_TOLERANCE_MS
          ? "expired"
          : "unknown",
    );
  }

  // A new device with the accessories its window links, read fresh so a
  // rename or move after the join shows. A read of this device that fails
  // leaves it unreadable; the search state and other devices are still
  // reported.
  async #newDevice(search, child, deadline) {
    const device = publicChild(search, child);
    const unreadable = (readError) => ({
      ...device,
      accessory_status: "unreadable",
      ...(readError ? { read_error: readError } : {}),
      accessories: [],
      next: { tool: "get_entity", arguments: { entity_ref: device.ref } },
    });
    try {
      const accessories = await this.#linkedAccessories(
        search,
        child,
        deadline,
      );
      if (accessories === null) return unreadable(null);
      return {
        ...device,
        accessory_status: accessories.length > 0 ? "found" : "pending",
        accessories,
      };
    } catch (error) {
      if (!isDeviceReadFailure(error)) throw error;
      return unreadable(error.code);
    }
  }

  // The accessories a device's window links; none yet while the hub has
  // not made one, null when the window's list cannot be read.
  async #linkedAccessories(search, child, deadline) {
    if (!child.optionsWindow) return [];
    let ids = search.linked.get(child.id);
    if (!ids) {
      const window = await this.#client.nativeWindow(
        search.serial,
        child.optionsWindow,
        deadline,
      );
      const linked = windowLinkedAccessoryIds(window);
      if (linked.status === "unreliable_form") return null;
      if (linked.ids.length === 0) return [];
      ids = linked.ids;
      search.linked.set(child.id, ids);
    }
    const accessories = [];
    for (const id of ids.slice(0, DEVICE_LIMIT)) {
      const { accessory } = await this.#client.nativeAccessory(
        search.serial,
        id,
        deadline,
      );
      if (accessory) {
        accessories.push(await this.#accessory(search, accessory, deadline));
      }
    }
    return accessories;
  }

  async #accessory(search, accessory, deadline) {
    if (!search.rooms.has(accessory.roomId)) {
      const { rooms } = await this.#client.nativeRooms(search.serial, deadline);
      search.rooms = new Map(rooms.map(({ id, name }) => [id, name]));
    }
    return {
      ref: accessoryRef(search.serial, accessory.id),
      name: accessory.name,
      room_ref: roomRef(search.serial, accessory.roomId),
      room: search.rooms.get(accessory.roomId) ?? null,
      services: (accessory.services ?? [])
        .filter(({ type }) => type !== "AccessoryInformation")
        .map((service) => ({
          ref: serviceRef(search.serial, accessory.id, service.sId),
          name: typeof service.name === "string" ? service.name : null,
          type: service.type,
          kind: serviceKind(service),
        })),
    };
  }

  #startResult(search, view, status) {
    const report = this.#report(search, view);
    return {
      status,
      search_ref: search.ref,
      home_ref: report.home_ref,
      extension: report.extension,
      action: {
        space_key: search.spaceKey,
        id: search.actionId,
        label: search.actionLabel,
      },
      active: report.active,
      ...(report.ends_at ? { ends_at: report.ends_at } : {}),
      ...(report.seconds_left === undefined
        ? {}
        : { seconds_left: report.seconds_left }),
      ...(report.read_error ? { read_error: report.read_error } : {}),
      time_zone: search.timeZone,
      devices_before: search.baseline.size,
      ...(search.startedBeforeWatch
        ? {
            note: "The search was already running when the count of new devices began: devices that joined before that are not counted as new.",
          }
        : {}),
      ...(report.active !== false ? { owner_step: OWNER_STEP } : {}),
      ...(report.limitations ? { limitations: report.limitations } : {}),
      next: getCall(search),
      ...(report.active !== false ? { stop: stopCall(search) } : {}),
    };
  }

  #report(search, view) {
    const ended = search.ended;
    const active = view.active;
    const result = view.result;
    const changed =
      view.fingerprint === null || view.fingerprint !== search.lastFingerprint;
    if (view.fingerprint !== null) search.lastFingerprint = view.fingerprint;
    return {
      status:
        active === true ? "searching" : active === false ? "ended" : "unknown",
      result,
      search_ref: search.ref,
      home_ref: homeRef(search.serial),
      extension: { ref: search.extensionRef, name: search.extensionName },
      active,
      ...(active === true && search.endsAt !== null
        ? searchEnd(search.endsAt, search.timeZone)
        : {}),
      ...(ended ? { ended } : {}),
      ...(view.readError ? { read_error: view.readError } : {}),
      changed,
      new_devices: view.newDevices,
      ...(view.newTotal > view.newDevices.length
        ? { new_devices_total: view.newTotal }
        : {}),
      changed_devices: view.changedDevices,
      ...(view.changedTotal > view.changedDevices.length
        ? { changed_devices_total: view.changedTotal }
        : {}),
      time_zone: search.timeZone,
      ...(search.timeZone === null
        ? { limitations: [UTC_TIMES_LIMITATION] }
        : {}),
      ...reportGuidance(search, view, result),
    };
  }

  // The devices a new watch counts from, and whether they were read while
  // a search already ran. After a watch of this controller that ended
  // without listing a new device, the new watch keeps that watch's
  // devices: one the hub added just after the network closed is then
  // reported by the restart rather than taken for one that was there.
  async #baseline(target, previous, deadline, running) {
    if (previous && previous.ended !== null && !previous.newSeen) {
      return {
        devices: [...previous.baseline.values()],
        startedBeforeWatch: previous.startedBeforeWatch,
        running,
      };
    }
    return {
      devices: await this.#children(target, deadline),
      startedBeforeWatch: running,
      running,
    };
  }

  async #children(target, deadline) {
    const { children } = await this.#client.nativeExtensionChildren(
      target.serial,
      target.extensionKey,
      deadline,
    );
    return children.map(childState);
  }

  // Resolves after ms, or soon after the hub pushes an event of a search,
  // device or accessory.
  #wake(ms) {
    return new Promise((resolve) => {
      let settle;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(settle);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      const unsubscribe = this.#client.onNativeEvent((event) => {
        if (settle || !EVENT_DOMAINS.some((key) => Object.hasOwn(event, key))) {
          return;
        }
        settle = setTimeout(finish, EVENT_SETTLE_MS);
      });
    });
  }

  #target(ref) {
    let parsed;
    try {
      parsed = parseEntityRef(ref);
    } catch {
      parsed = null;
    }
    if (parsed?.kind !== "extension") {
      throw new SprutHubError(
        "invalid_entity_ref",
        "Pass the ref of a device controller (an extension) from home_overview list=extensions.",
        "home_overview",
        {
          next: { tool: "home_overview", arguments: { list: "extensions" } },
        },
      );
    }
    const serial = this.#client.selectedSerial();
    if (parsed.serial !== serial) {
      throw new SprutHubError(
        "wrong_home",
        "A device search runs only on the configured SprutHub home. Use its extension refs from home_overview.",
        "home_overview",
        { next: { tool: "home_overview", arguments: { list: "extensions" } } },
      );
    }
    return {
      serial,
      extensionKey: parsed.extensionKey,
      ref: extensionRef(serial, parsed.extensionKey),
    };
  }

  #remember(target, extension, action, timeZone, baseline) {
    const search = {
      ref: `${target.ref}${SEARCH_REF_PART}${randomUUID()}`,
      serial: target.serial,
      extensionKey: target.extensionKey,
      extensionRef: target.ref,
      extensionName: extension.name,
      spaceKey: DEVICE_SEARCH_SPACE,
      actionId: action.id,
      actionLabel: typeof action.button === "string" ? action.button : null,
      timeZone,
      baseline: new Map(baseline.devices.map((child) => [child.id, child])),
      startedBeforeWatch: baseline.startedBeforeWatch,
      newSeen: false,
      active: null,
      seenRunning: false,
      startRead: baseline.running,
      endsAt: null,
      ended: null,
      endedAt: null,
      stopSent: false,
      linked: new Map(),
      rooms: new Map(),
      lastFingerprint: null,
    };
    this.#searches.set(search.ref, search);
    while (this.#searches.size > SEARCH_LIMIT) {
      this.#searches.delete(this.#searches.keys().next().value);
    }
    return search;
  }

  #forget(search) {
    this.#searches.delete(search.ref);
  }

  #latest(extensionKey) {
    let latest = null;
    for (const search of this.#searches.values()) {
      if (search.extensionKey === extensionKey) latest = search;
    }
    return latest;
  }

  #search(searchRef) {
    const search = this.#searches.get(searchRef);
    if (search) return search;
    const at = searchRef.lastIndexOf(SEARCH_REF_PART);
    let controller = null;
    try {
      const parsed = parseEntityRef(searchRef.slice(0, Math.max(0, at)));
      if (parsed.kind === "extension") {
        controller = extensionRef(parsed.serial, parsed.extensionKey);
      }
    } catch {
      controller = null;
    }
    throw new SprutHubError(
      "device_search_not_found",
      "This MCP process does not know this search, for example after a restart. Read the controller to see whether its search still runs; start_device_search returns a running search without restarting it.",
      controller ? "get_entity" : "home_overview",
      {
        next: controller
          ? { tool: "get_entity", arguments: { entity_ref: controller } }
          : { tool: "home_overview", arguments: { list: "extensions" } },
      },
    );
  }

  // Starts and stops of one controller run one at a time, so two calls
  // never both send a start.
  async #exclusive(key, run) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const current = previous.then(run, run);
    const settled = current.then(
      () => {},
      () => {},
    );
    this.#locks.set(key, settled);
    try {
      return await current;
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    }
  }
}

// The fields of a device whose change the search reports, with their
// public names.
const CHILD_FIELDS = ["spaceKey", "online", "status", "progress", "error"];
const PUBLIC_FIELD = {
  spaceKey: "space_key",
  online: "online",
  status: "status",
  progress: "progress",
  error: "error",
};

function childState(child) {
  return {
    id: child.id,
    spaceKey: typeof child.spaceKey === "string" ? child.spaceKey : null,
    name: typeof child.name === "string" ? child.name : null,
    online: typeof child.online === "boolean" ? child.online : null,
    status:
      typeof child.status === "string" && child.status.length > 0
        ? child.status
        : null,
    // The web client draws a progress bar for progressBar >= 0 (K8).
    progress:
      Number.isFinite(child.progressBar) && child.progressBar >= 0
        ? child.progressBar
        : null,
    error:
      typeof child.error === "string" && child.error.length > 0
        ? child.error
        : null,
    optionsWindow:
      typeof child.optionsWindow === "string" ? child.optionsWindow : "",
  };
}

function publicChild(search, child) {
  return {
    ref: extensionChildRef(search.serial, search.extensionKey, child.id),
    space_key: child.spaceKey,
    name: child.name,
    online: child.online,
    status: child.status,
    progress: child.progress,
    error: child.error,
  };
}

// The action of a space by its id; an entry the client cannot read is
// not it.
function findAction(extension, spaceKey, actionId) {
  const space = (extension.spaces ?? []).find(({ key }) => key === spaceKey);
  const actions = Array.isArray(space?.actions) ? space.actions : [];
  return actions.find((action) => action?.id === actionId) ?? null;
}

// The controller's ordinary search, or the error that says why there is
// none to start.
function searchActionOrRefuse(extension, spaceKey, ref) {
  const refuse = (reason, message) =>
    new SprutHubError("device_search_unavailable", message, "get_entity", {
      reason,
      next: { tool: "get_entity", arguments: { entity_ref: ref } },
    });
  if (extension.bundleType !== "CONTROLLER") {
    throw refuse(
      "not_a_controller",
      "Only a device controller (bundle type CONTROLLER) has a device search; this extension is not one.",
    );
  }
  if (extension.state !== "LOADED" || extension.enabled !== true) {
    throw refuse(
      "not_loaded",
      "The controller is not running (it must be enabled and LOADED). The owner fixes or turns it on in SprutHub; a search cannot start before that.",
    );
  }
  if (spaceKey !== DEVICE_SEARCH_SPACE) {
    const other = extensionSearchAction(extension, spaceKey);
    throw refuse(
      other ? "nearby_search_not_supported" : "no_device_search",
      other
        ? "This is a search of devices nearby, as ZigBee's ZLL (Touchlink) search for lamps close to the hub; it can act on lamps of other networks and is not supported. Only the controller's ordinary device search can be started."
        : "This space of the controller has no device search.",
    );
  }
  const action = extensionSearchAction(extension, spaceKey);
  if (!action) {
    throw refuse(
      "no_device_search",
      "This controller has no device search of its own: its devices are added another way.",
    );
  }
  return action;
}

function refusedByHub(error, ref, step) {
  return new SprutHubError(
    "request_rejected",
    `SprutHub refused to ${step} the search.`,
    "get_entity",
    {
      hub_effect: "not_applied",
      rejection: {
        code: error.code,
        protocol_code: error.hubError.code,
        ...(error.hubError.message !== undefined
          ? { hub_message: error.hubError.message }
          : {}),
      },
      next: { tool: "get_entity", arguments: { entity_ref: ref } },
    },
  );
}

// A read of one device that failed: the hub refused it or did not answer
// in time, or answered in a form this client cannot read.
function isDeviceReadFailure(error) {
  return (
    isHubReadFailure(error) ||
    (error instanceof SprutHubError && error.code === "incompatible_response")
  );
}

// Marks the watch ended (stopped, expired or unknown) from now on; an
// expired search ended at its end time.
function endWatch(search, how) {
  const now = Date.now();
  search.ended = how;
  search.endedAt =
    how === "expired" && search.endsAt !== null
      ? Math.min(now, search.endsAt)
      : now;
}

// What the search has brought: waiting (nothing new yet), joining (a new
// device whose accessory the hub has not made yet), not_added (the search
// ended a while ago and a new device still has none), unreadable (a new
// device whose accessory could not be read), joined (every new device
// with its accessory) or no_new_device (ended with nothing new).
function searchResult(search, view) {
  const statuses = view.newDevices.map(
    ({ accessory_status: status }) => status,
  );
  if (statuses.length === 0) {
    return view.active === false ? "no_new_device" : "waiting";
  }
  if (statuses.includes("pending")) {
    return view.active === false &&
      search.endedAt !== null &&
      Date.now() >= search.endedAt + ACCESSORY_GRACE_MS
      ? "not_added"
      : "joining";
  }
  if (statuses.includes("unreadable")) return "unreadable";
  return "joined";
}

// Whether a wait has something to return: a change since the previous
// answer, or nothing left to wait for (the search ended and no new device
// may still get its accessory).
function worthReturning(search, view) {
  if (view.fingerprint !== search.lastFingerprint) return true;
  return view.active === false && view.result !== "joining";
}

function getCall(search) {
  return { tool: "get_device_search", arguments: { search_ref: search.ref } };
}

function stopCall(search) {
  return { tool: "stop_device_search", arguments: { search_ref: search.ref } };
}

function reportGuidance(search, view, result) {
  const running = view.active !== false;
  if (result === "no_new_device") {
    return {
      hint: `The search ended and no new device is listed${
        search.startedBeforeWatch
          ? ": the search was already running when the count of new devices began, and devices that joined before that are not counted"
          : ""
      }.${
        view.changedTotal > 0
          ? " Earlier devices of the controller changed (changed_devices): a device paired again keeps its entry and shows there, not as new."
          : ""
      } Tell the owner and offer to start the search again once the device is in pairing mode near the hub.`,
      next: {
        tool: "start_device_search",
        arguments: { extension_ref: search.extensionRef },
      },
    };
  }
  if (result === "not_added") {
    return {
      hint: "The search has ended and the hub has made no accessory for a new device listed here; its status and error are the hub's text. Tell the owner the device was not added: it may not be supported, or its pairing failed. If the hub adds it later, get_device_search still shows it.",
      next: null,
    };
  }
  if (result === "unreadable") {
    const device = view.newDevices.find(
      ({ accessory_status: status }) => status === "unreadable",
    );
    return {
      hint: "A new device is listed, but its accessory could not be read now. Read the device with its next (get_entity), or call get_device_search again.",
      next: running ? getCall(search) : device.next,
      ...(running ? { stop: stopCall(search) } : {}),
    };
  }
  if (result === "joined") {
    return {
      hint: `A new device joined. Set each new accessory's room and name with prepare_native_change operation accessory_placement (target_ref, room_ref, name, reason).${running ? " Stop the search once no other device is to be added." : ""}`,
      next: running ? getCall(search) : null,
      ...(running ? { stop: stopCall(search) } : {}),
    };
  }
  return {
    next: getCall(search),
    ...(running ? { stop: stopCall(search) } : {}),
  };
}
