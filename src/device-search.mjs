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
// itself and waits for a person, so it is not in the change journal. Its
// watch is kept in the state directory beside it (device-search-store.mjs),
// so a server started anew for the owner's reply still knows it.
import { createHash, randomUUID } from "node:crypto";
import { DeviceSearchStore } from "./device-search-store.mjs";
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
// Devices listed per answer; the rest are counted.
const DEVICE_LIMIT = 10;
const SEARCH_REF_PART = "/device_search/";

const OWNER_STEP =
  "Tell the owner to put the new device into pairing mode now, as its manufacturer describes, close to the hub. Until ends_at the network is open: any device in pairing mode within range can join, not only the owner's. Then call next to wait for the hub to report the device. If the owner sees your messages only after your turn ends, tell them to put the device into pairing mode now, end the turn, and call get_device_search when they reply: a device that joined is still reported after the search ended.";

export class DeviceSearches {
  #client;
  #stateDirectory;
  #stores = new Map();
  #inUse = new Map();
  #locks = new Map();

  constructor({ client, stateDirectory }) {
    this.#client = client;
    this.#stateDirectory = stateDirectory;
  }

  async start({ extensionRef: ref, spaceKey = DEVICE_SEARCH_SPACE }) {
    const target = this.#target(ref);
    return this.#exclusive(target.extensionKey, async () => {
      const begin = async (current) => {
        const { search, result } = await this.#start(target, spaceKey, current);
        await keepState(
          () => this.#save(search),
          async () =>
            result.status === "already_running"
              ? startNotSent(
                  result.active === true,
                  search.endsAt,
                  search.timeZone,
                )
              : startedNotKept(search, result, await this.#isKept(search)),
        );
        return result;
      };
      // Watches not written for days go first, so none of them is taken
      // for the controller's latest.
      const latest = await keepState(
        async () => {
          await this.#store(target.serial).prune();
          return this.#latest(target);
        },
        () => startNotSent(false),
      );
      return latest === null
        ? begin(null)
        : this.#using(
            latest.ref,
            async () => loadedWatch(target.serial, latest),
            begin,
          );
    });
  }

  async get(searchRef, waitSeconds = 0) {
    return this.#using(
      searchRef,
      () => this.#find(searchRef),
      async (search) => {
        const until = Date.now() + waitSeconds * 1_000;
        let view = await this.#read(search);
        while (Date.now() < until && !worthReturning(search, view)) {
          await this.#wake(Math.min(POLL_MS, until - Date.now()));
          view = await this.#read(search);
        }
        const report = this.#report(search, view);
        await keepState(
          () => this.#save(search),
          () => reportNotKept(search, report),
        );
        return report;
      },
    );
  }

  async stop(searchRef) {
    return this.#using(
      searchRef,
      () => this.#find(searchRef),
      (search) =>
        this.#exclusive(search.extensionKey, async () => {
          const report = await this.#stop(search);
          await keepState(
            () => this.#save(search),
            () => reportNotKept(search, report),
          );
          return report;
        }),
    );
  }

  // current: the controller's latest watch, which goes on or has ended by
  // now.
  async #start(target, spaceKey, current) {
    const client = this.#client;
    const deadline = Date.now() + client.timeoutMs;
    const { extension } = await client.nativeExtension(
      target.serial,
      target.extensionKey,
      deadline,
    );
    const action = searchActionOrRefuse(extension, spaceKey, target.ref);
    const timeZone = await client.hubTimeZone(target.serial, deadline);
    if (current) {
      this.#updateState(current, extension);
      await keepState(
        () => this.#save(current),
        () =>
          startNotSent(
            action.state === true,
            runningActionEnd(action),
            timeZone,
          ),
      );
    }
    if (action.state === true) {
      // A resend would restart the hub's timer and keep the network open
      // longer (P3), so a running search is only watched.
      const search =
        current && current.ended === null
          ? current
          : await this.#remember(
              target,
              extension,
              action,
              timeZone,
              await this.#children(target, deadline),
              true,
            );
      const view = await this.#read(search);
      search.lastFingerprint = view.fingerprint;
      return {
        search,
        result: this.#startResult(search, view, "already_running"),
      };
    }

    const search = await this.#remember(
      target,
      extension,
      action,
      timeZone,
      await this.#children(target, deadline),
      false,
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
        await this.#forget(search);
        throw error;
      }
      if (error.hubError !== undefined) {
        await this.#forget(search);
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
      search.ended = "unknown";
    }
    search.lastFingerprint = view.fingerprint;
    if (view.active === true && !replyLost) {
      return { search, result: this.#startResult(search, view, "started") };
    }
    return {
      search,
      result: {
        ...this.#startResult(search, view, "unknown"),
        message: `${replyLost ? "The hub did not answer the start" : "The hub acknowledged the start"}${
          view.active === true
            ? ", and the search shows as running."
            : view.active === false
              ? ", but the search does not show as running. Read the controller with get_entity before starting again."
              : ", and the search could not be read back; get_device_search reads it again."
        }`,
      },
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
    // Once this watch has ended, a run the controller shows is a later
    // search that this watch neither watches nor stops (#updateState).
    const action = findAction(extension, search.spaceKey, search.actionId);
    const later =
      search.ended !== null && action?.state === true
        ? { end: runningActionEnd(action) }
        : null;
    const view = {
      active,
      later,
      newDevices,
      newTotal: added.length,
      changedDevices,
      changedTotal: changed.length,
    };
    view.result = searchResult(view);
    view.fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          active,
          search.endsAt,
          search.ended,
          later,
          view.result,
          newDevices,
          changedDevices,
        ]),
      )
      .digest("hex");
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
        search.ended = "expired";
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
    search.ended = search.stopSent
      ? "stopped"
      : search.endsAt !== null &&
          Date.now() >= search.endsAt - EXPIRY_TOLERANCE_MS
        ? "expired"
        : "unknown";
  }

  // A new device with the accessories its window links, read fresh so a
  // rename or move after the join shows, and its outcome as the hub shows
  // it: found (an accessory), failed (an error and no accessory), pending
  // (neither yet) or unreadable. A read of this device that fails leaves
  // it unreadable; the search state and other devices are still reported.
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
        accessory_status:
          accessories.length > 0
            ? "found"
            : child.error !== null
              ? "failed"
              : "pending",
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
      ...(view.later
        ? {
            later_search: {
              active: true,
              ...(view.later.end !== null
                ? searchEnd(view.later.end, search.timeZone)
                : {}),
            },
          }
        : {}),
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
      ...reportGuidance(search, view),
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

  // A new watch counting from the controller's devices now; running when
  // its search already runs.
  async #remember(target, extension, action, timeZone, devices, running) {
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
      startedAt: Date.now(),
      baseline: new Map(devices.map((child) => [child.id, child])),
      startedBeforeWatch: running,
      active: null,
      seenRunning: false,
      startRead: running,
      endsAt: null,
      ended: null,
      stopSent: false,
      linked: new Map(),
      rooms: new Map(),
      lastFingerprint: null,
    };
    // Kept before the start is sent: a start whose watch cannot be kept is
    // not sent.
    await keepState(
      () => this.#save(search),
      () => startNotSent(running, runningActionEnd(action), timeZone),
    );
    return search;
  }

  // Removes the watch of a start that did not reach the hub or that the hub
  // refused. The caller's error says what happened on the hub, so a watch
  // that cannot be removed stays: its ref was never given out, and a later
  // start takes it as a start still on its way, watching a search only if
  // the controller shows one running, with devices counted from before the
  // refused start.
  async #forget(search) {
    await this.#store(search.serial)
      .delete(searchId(search.ref))
      .catch(() => {});
  }

  async #save(search) {
    await this.#store(search.serial).save(
      searchId(search.ref),
      storedWatch(search),
    );
  }

  // Whether the directory still holds a watch of this search, as saved
  // before a save that failed, for get_device_search to find by its ref.
  async #isKept(search) {
    const watch = await this.#store(search.serial)
      .get(searchId(search.ref))
      .catch(() => null);
    return watch?.ref === search.ref;
  }

  #store(serial) {
    let store = this.#stores.get(serial);
    if (!store) {
      store = new DeviceSearchStore({
        directory: this.#stateDirectory,
        hubUrl: this.#client.url,
        hubSerial: serial,
      });
      this.#stores.set(serial, store);
    }
    return store;
  }

  // The kept record of the controller's most recently started watch, by
  // this process or an earlier one.
  async #latest(target) {
    let latest = null;
    for (const watch of await this.#store(target.serial).list()) {
      if (
        watch.extension_key === target.extensionKey &&
        (latest === null || watch.started_at > latest.started_at)
      ) {
        latest = watch;
      }
    }
    return latest;
  }

  // Runs use with the watch of ref. Calls of this process that use one
  // watch at the same time share it, so a wait sees a stop beside it;
  // between calls the state directory holds it.
  async #using(ref, load, use) {
    let entry = this.#inUse.get(ref);
    if (!entry) {
      entry = { search: load(), calls: 0 };
      this.#inUse.set(ref, entry);
    }
    entry.calls += 1;
    try {
      return await use(await entry.search);
    } finally {
      entry.calls -= 1;
      if (entry.calls === 0) this.#inUse.delete(ref);
    }
  }

  // The kept watch of a search ref, or the error that it is unknown.
  async #find(searchRef) {
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
    if (controller !== null) {
      const serial = this.#client.selectedSerial();
      const watch = await this.#store(serial).get(searchId(searchRef));
      if (watch?.ref === searchRef) return loadedWatch(serial, watch);
    }
    throw new SprutHubError(
      "device_search_not_found",
      "No device search with this ref is kept: it was not started by this product, or it is older than 3 days. Read the controller to see whether its search runs; start_device_search returns a running search without restarting it.",
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

// The watch as kept in the state directory: what a later process needs to
// go on comparing the controller's devices and judging its search. Names of
// the devices before are not kept; reports take them from the hub.
function storedWatch(search) {
  return {
    ref: search.ref,
    extension_key: search.extensionKey,
    extension_name: search.extensionName,
    space_key: search.spaceKey,
    action_id: search.actionId,
    action_label: search.actionLabel,
    time_zone: search.timeZone,
    started_at: search.startedAt,
    started_before_watch: search.startedBeforeWatch,
    baseline: [...search.baseline.values()].map((child) => ({
      id: child.id,
      space_key: child.spaceKey,
      online: child.online,
      status: child.status,
      progress: child.progress,
      error: child.error,
    })),
    active: search.active,
    seen_running: search.seenRunning,
    start_read: search.startRead,
    ends_at: search.endsAt,
    ended: search.ended,
    stop_sent: search.stopSent,
    last_fingerprint: search.lastFingerprint,
  };
}

function loadedWatch(serial, watch) {
  return {
    ref: watch.ref,
    serial,
    extensionKey: watch.extension_key,
    extensionRef: extensionRef(serial, watch.extension_key),
    extensionName: watch.extension_name,
    spaceKey: watch.space_key,
    actionId: watch.action_id,
    actionLabel: watch.action_label,
    timeZone: watch.time_zone,
    startedAt: watch.started_at,
    baseline: new Map(
      watch.baseline.map((child) => [
        child.id,
        {
          id: child.id,
          spaceKey: child.space_key,
          online: child.online,
          status: child.status,
          progress: child.progress,
          error: child.error,
        },
      ]),
    ),
    startedBeforeWatch: watch.started_before_watch,
    active: watch.active,
    seenRunning: watch.seen_running,
    startRead: watch.start_read,
    endsAt: watch.ends_at,
    ended: watch.ended,
    stopSent: watch.stop_sent,
    linked: new Map(),
    rooms: new Map(),
    lastFingerprint: watch.last_fingerprint,
  };
}

function searchId(ref) {
  return ref.slice(ref.lastIndexOf(SEARCH_REF_PART) + SEARCH_REF_PART.length);
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

// Runs a step of the state directory. When it fails, notKept() gives the
// error that says what this call did on the hub, which the failed step does
// not undo, and how to fix the directory; the file system's error names the
// path, so it is left out.
async function keepState(step, notKept) {
  try {
    return await step();
  } catch {
    throw await notKept();
  }
}

const FIX_STATE_DIRECTORY =
  "Make that directory writable, or set SPRUT_AGENT_STATE_DIR to a writable directory and restart the MCP server";

// A start that sent nothing because its watch could not be kept. The
// network is as it was: closed, or open by the controller's search that
// already runs (running), which ends by itself at end.
function startNotSent(running, end = null, timeZone = null) {
  if (!running) {
    return new SprutHubError(
      "state_storage_unavailable",
      `The device search could not be saved in the local state directory, so this call sent nothing to the hub and did not open the network. ${FIX_STATE_DIRECTORY}; then start the search again.`,
      "restore_state_storage_then_retry",
    );
  }
  return new SprutHubError(
    "state_storage_unavailable",
    `The device search could not be saved in the local state directory, so this call sent nothing to the hub. The controller's search was already running and stays open until it ends by itself${end === null ? "" : " at ends_at"}: any device in pairing mode within range can join until then. ${FIX_STATE_DIRECTORY}; then start the search again: it returns the running search with its stop, without restarting it.`,
    "restore_state_storage_then_retry",
    { active: true, ...(end === null ? {} : searchEnd(end, timeZone)) },
  );
}

// A start that was sent, whose search as read back after it could not be
// kept. The watch saved before the start (kept) counts the controller's
// devices from before it, so get_device_search and stop_device_search
// follow the search by its ref; a new start after the search ended would
// count a device that joined meanwhile as an old one. Only when that watch
// is gone too does the agent start again, which returns a running search.
function startedNotKept(search, result, kept) {
  const running = result.active === true;
  const sent = running
    ? `The search was started: the controller's network is open, and any device in pairing mode within range can join until it closes by itself${result.ends_at ? " at ends_at" : ""}${kept ? " or is stopped" : ""}. Tell the owner the network is open.`
    : `The start was sent to the hub, but the search ${result.active === false ? "does not show as running" : "could not be read back"}; get_entity of the controller shows whether it runs.`;
  const follow = kept
    ? `Its state after the start could not be saved in the local state directory, but the watch saved before the start follows it by search_ref: get_device_search reports the devices that join, counted from before the start, and stop_device_search closes the network. Both reach the hub while the directory cannot be written; get_device_search lists the new devices once it can. ${FIX_STATE_DIRECTORY}; then call next.`
    : `The search could not be saved in the local state directory, so get_device_search and stop_device_search cannot follow it yet. ${FIX_STATE_DIRECTORY}; then start the search again: a running search is returned with its stop, without restarting it.`;
  return new SprutHubError(
    "state_storage_unavailable",
    `${sent} ${follow}`,
    "restore_state_storage_then_retry",
    {
      ...(kept ? { search_ref: search.ref } : {}),
      active: result.active,
      ...(result.ends_at
        ? { ends_at: result.ends_at, seconds_left: result.seconds_left }
        : {}),
      next: kept
        ? getCall(search)
        : {
            tool: "start_device_search",
            arguments: { extension_ref: search.extensionRef },
          },
      ...(kept && result.active !== false ? { stop: stopCall(search) } : {}),
    },
  );
}

// A read or a stop whose search, as read in the call, could not be kept:
// the stop it sent (stop_sent) is not undone. The new devices are summed
// up by result; get_device_search lists them once the search is kept.
function reportNotKept(search, report) {
  const stopSent = report.stop_sent === true;
  return new SprutHubError(
    "state_storage_unavailable",
    `${stopSent ? "The stop was sent to the hub" : "This call sent nothing to the hub"}; the fields beside this error are the search as read ${stopSent ? "after the stop" : "now"}. The search could not be saved in the local state directory. ${FIX_STATE_DIRECTORY}; then read it again with get_device_search.`,
    "restore_state_storage_then_retry",
    {
      search_ref: search.ref,
      active: report.active,
      ...(report.ends_at
        ? { ends_at: report.ends_at, seconds_left: report.seconds_left }
        : {}),
      result: report.result,
      ...(report.stop_sent === undefined
        ? {}
        : { stop_sent: report.stop_sent }),
      next: getCall(search),
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

// What the search has brought, summed up over its new devices: waiting
// (nothing new yet), joined (a new device has its accessory), joining (the
// hub is still adding one), unreadable (one could not be read now), failed
// (the hub shows an error for each) or no_new_device (ended with nothing
// new). The hints say what to do for each outcome present.
function searchResult(view) {
  const outcomes = deviceOutcomes(view);
  if (outcomes.size === 0) {
    return view.active === false ? "no_new_device" : "waiting";
  }
  if (outcomes.has("found")) return "joined";
  if (outcomes.has("pending")) return "joining";
  if (outcomes.has("unreadable")) return "unreadable";
  return "failed";
}

function deviceOutcomes(view) {
  return new Set(view.newDevices.map(({ accessory_status: status }) => status));
}

// Whether a wait has something to return: a change since the previous
// answer, or nothing left to wait for (the search ended and the hub is
// adding no new device).
function worthReturning(search, view) {
  if (view.fingerprint !== search.lastFingerprint) return true;
  return view.active === false && !deviceOutcomes(view).has("pending");
}

function getCall(search) {
  return { tool: "get_device_search", arguments: { search_ref: search.ref } };
}

function stopCall(search) {
  return { tool: "stop_device_search", arguments: { search_ref: search.ref } };
}

// One hint for each outcome among the new devices, and for the search
// itself when it ended with nothing new or a later search runs; next goes
// on reading while the search runs or the hub may still change a device.
function reportGuidance(search, view) {
  const running = view.active !== false;
  const outcomes = deviceOutcomes(view);
  const hints = {};
  if (view.later) {
    hints.search =
      "This search has ended, but the controller's network is open again by a later search, as one started in the SprutHub app, that this ref neither watches nor stops: any device in pairing mode within range can join. start_device_search returns that search with its own stop. Tell the owner the network is still open.";
  } else if (outcomes.size === 0 && !running) {
    hints.search = `The search ended and no new device is listed${
      search.startedBeforeWatch
        ? ": the search was already running when the count of new devices began, and devices that joined before that are not counted"
        : ""
    }.${
      view.changedTotal > 0
        ? " Earlier devices of the controller changed (changed_devices): a device paired again keeps its entry and shows there, not as new."
        : ""
    } Tell the owner and offer to start the search again once the device is in pairing mode near the hub.`;
  }
  if (outcomes.has("found")) {
    hints.found = `A new device joined. A device listed after the search ended may have been added another way, for example in the SprutHub app. Place and name only the device the owner's request covers, with prepare_native_change operation accessory_placement (target_ref, room_ref, name, reason). Keep a room or name the owner already gave it. If it still has a technical name, such as a model code, give it a name the owner recognises: what it is, with the room only if needed to tell it apart. If unsure which device is the owner's, ask.${running ? " Stop the search once no other device is to be added." : ""}`;
  }
  if (outcomes.has("pending")) {
    hints.pending = running
      ? "The hub is still adding a new device; its status and progress are the hub's text. Wait for it with next."
      : "The search has ended and the hub is still adding a new device: it shows no error; its status and progress are the hub's text. Check again later with next; if it stays so, tell the owner the device may not be supported or its pairing did not finish.";
  }
  if (outcomes.has("unreadable")) {
    hints.unreadable =
      "A new device's accessory could not be read now. Read the device with its next (get_entity), or call get_device_search again.";
  }
  if (outcomes.has("failed")) {
    hints.failed =
      "The hub shows an error for a new device and has made no accessory for it; its status and error are the hub's text. Tell the owner the device was not added: it may not be supported, or its pairing failed. If the hub adds it later, get_device_search still shows it.";
  }
  return {
    ...(Object.keys(hints).length > 0 ? { hints } : {}),
    next:
      running || outcomes.has("pending") || outcomes.has("unreadable")
        ? getCall(search)
        : view.later || outcomes.size === 0
          ? {
              tool: "start_device_search",
              arguments: { extension_ref: search.extensionRef },
            }
          : null,
    ...(running ? { stop: stopCall(search) } : {}),
  };
}
