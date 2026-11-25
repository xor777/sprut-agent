import {
  isHubReadFailure,
  SprutHubError,
  sanitizeNativeData,
  windowLinkedAccessoryIds,
} from "./spruthub-client.mjs";
import {
  dependenciesWithin,
  foundDependencies,
  ownServices,
  unreadDependencies,
} from "./virtual-device.mjs";

const PERSISTENT_CODE_UNREAD_REASONS = new Set(["not_parsed", "not_read"]);

export async function auditPhysicalDeviceRemove({
  client,
  window,
  homeRef,
  hubSerial,
  extensionKey,
  childId,
  readAccessoryDependencies,
  failOnReadError = false,
}) {
  const linked = windowLinkedAccessoryIds(window);
  const hasConfirmedIds =
    linked.status === "confirmed" && linked.ids.length > 0;

  let child = null;
  let childUnread = false;
  try {
    const { children } = await client.nativeExtensionChildren(
      hubSerial,
      extensionKey,
      Date.now() + client.timeoutMs,
    );
    child = children.find((entry) => entry.id === childId) ?? null;
  } catch (error) {
    if (!isHubReadFailure(error) || (failOnReadError && !hasConfirmedIds)) {
      throw error;
    }
    childUnread = true;
  }

  const windowName =
    typeof window?.label?.text === "string" &&
    window.label.text.trim().length > 0
      ? sanitizeNativeData(window.label.text)
      : null;
  const spaceKey =
    typeof child?.spaceKey === "string" && child.spaceKey.trim().length > 0
      ? sanitizeNativeData(child.spaceKey)
      : null;
  const childName =
    typeof child?.name === "string" && child.name.trim().length > 0
      ? sanitizeNativeData(child.name)
      : windowName;
  const online = typeof child?.online === "boolean" ? child.online : null;

  const linkedAccessories = [];
  const perAccessory = [];
  const dependenciesByAccessory = {};
  let linkedIds = [];
  let linkedAccessoriesUnconfirmed = false;

  if (hasConfirmedIds) {
    linkedIds = [...linked.ids].sort((left, right) => left - right);
    for (const id of linkedIds) {
      const ref = `${homeRef}/accessory/${id}`;
      try {
        const accessory = await client.getAccessoryOrNull(id);
        if (accessory === null) {
          linkedAccessoriesUnconfirmed = true;
          linkedAccessories.push({
            ref,
            name: null,
            room_ref: null,
            room_name: null,
            services: [],
            unread_reason: "accessory_missing",
          });
          continue;
        }
        const [room, rawDependencies] = await Promise.all([
          readRoomOrNull(client, accessory.roomId),
          readAccessoryDependencies(accessory),
        ]);
        const name =
          typeof accessory.name === "string"
            ? sanitizeNativeData(accessory.name)
            : null;
        const roomRef =
          typeof accessory.roomId === "number"
            ? `${homeRef}/room/${accessory.roomId}`
            : null;
        const roomName =
          typeof room?.name === "string" ? sanitizeNativeData(room.name) : null;
        const services = ownServices(accessory).map((service) => ({
          type:
            typeof service.type === "string"
              ? sanitizeNativeData(service.type)
              : null,
          name:
            typeof service.name === "string"
              ? sanitizeNativeData(service.name)
              : null,
        }));
        const sanitizedDeps = sanitizeDependencies(rawDependencies);
        linkedAccessories.push({
          ref,
          name,
          room_ref: roomRef,
          room_name: roomName,
          services,
        });
        dependenciesByAccessory[String(id)] = sanitizedDeps;
        perAccessory.push({
          accessoryRef: ref,
          accessoryName: name,
          dependencies: sanitizedDeps,
        });
      } catch (error) {
        if (failOnReadError || !isHubReadFailure(error)) throw error;
        linkedAccessoriesUnconfirmed = true;
        linkedAccessories.push({
          ref,
          name: null,
          room_ref: null,
          room_name: null,
          services: [],
          unread_reason: error.code,
        });
      }
    }
  } else {
    // Protobuf3 omits empty validValues on AccessoriesList (observed live on
    // unpaired Xiaomi discovery children and orphaned offline ZigBee main
    // children). Only a confirmed discovery-space child has no accessory yet.
    linkedAccessoriesUnconfirmed = spaceKey !== "discovery";
  }

  const dependencies = aggregateAccessoryDependencies(perAccessory);

  return {
    summary: {
      controller_ref: `${homeRef}/extension/${encodeURIComponent(extensionKey)}`,
      extension_key: extensionKey,
      child_id: childId,
      child_name: childName,
      space_key: spaceKey,
      ...(online !== null ? { online } : {}),
      linked_accessories: linkedAccessories,
      dependencies,
      linked_accessories_unconfirmed: linkedAccessoriesUnconfirmed,
      child_unread: childUnread,
    },
    baseline: {
      linked_accessory_ids: linkedIds,
      dependencies_by_accessory: dependenciesByAccessory,
      linked_accessories_unconfirmed: linkedAccessoriesUnconfirmed,
    },
  };
}

export function assertNoNewTransientUnread(current, prepared) {
  if (!prepared || !current) return;
  for (const id of current.linked_accessory_ids ?? []) {
    const key = String(id);
    const prev = prepared.dependencies_by_accessory?.[key];
    const next = current.dependencies_by_accessory?.[key];
    if (!prev || !next) continue;
    const prevCodeKeys = new Set(
      (prev.code_unread ?? []).map(unreadCodeEntryKey),
    );
    const newTransientCode = (next.code_unread ?? []).filter(
      (entry) =>
        !PERSISTENT_CODE_UNREAD_REASONS.has(entry.reason) &&
        !prevCodeKeys.has(unreadCodeEntryKey(entry)),
    );
    const prevBridgeRefs = new Set(
      (prev.bridges_unread ?? []).map(({ ref }) => ref),
    );
    const newUnreadBridge = (next.bridges_unread ?? []).some(
      ({ ref }) => !prevBridgeRefs.has(ref),
    );
    if (newTransientCode.length > 0 || newUnreadBridge) {
      const timedOut = newTransientCode.some(
        ({ reason }) => reason === "timed_out",
      );
      throw new SprutHubError(
        timedOut ? "timeout" : "connection_failed",
        "Could not re-verify code or bridge dependencies before removing the physical device; retry apply_native_change.",
        "apply_native_change",
      );
    }
  }
}

export function physicalDeviceRemoveDrifted(current, prepared) {
  if (!prepared || !current) return true;
  if (
    !sameNumberList(current.linked_accessory_ids, prepared.linked_accessory_ids)
  ) {
    return true;
  }
  if (
    prepared.linked_accessories_unconfirmed === false &&
    current.linked_accessories_unconfirmed === true
  ) {
    return true;
  }
  for (const id of current.linked_accessory_ids) {
    const key = String(id);
    const prev = prepared.dependencies_by_accessory?.[key];
    const next = current.dependencies_by_accessory?.[key];
    if (!prev && !next) continue;
    if (!prev || !next) return true;
    if (!dependenciesWithin(next, prev)) return true;
    if (!unreadDependenciesWithin(next, prev)) return true;
  }
  return false;
}

function unreadCodeEntryKey(entry) {
  return `${entry.ref ?? ""}\0${entry.reason}\0${JSON.stringify(entry.scenarios ?? null)}`;
}

function unreadDependenciesWithin(current, prepared) {
  const keys = (dependencies) =>
    new Set(
      (dependencies.code_unread ?? [])
        .filter((entry) => PERSISTENT_CODE_UNREAD_REASONS.has(entry.reason))
        .map((entry) => `code_unread ${unreadCodeEntryKey(entry)}`),
    );
  const known = keys(prepared);
  return [...keys(current)].every((key) => known.has(key));
}

export async function readRoomOrNull(client, roomId) {
  if (typeof roomId !== "number") return null;
  try {
    return await client.getRoom(roomId);
  } catch (error) {
    if (!isHubReadFailure(error)) throw error;
    return null;
  }
}

export function physicalDeviceRemoveTellOwner(deviceRemove) {
  const dependencies = deviceRemove?.dependencies ?? {};
  const hasFound = foundDependencies(dependencies);
  const hasUnread = Object.keys(unreadDependencies(dependencies)).length > 0;
  const unconfirmed = deviceRemove?.linked_accessories_unconfirmed === true;
  const childUnread = deviceRemove?.child_unread === true;
  const hasIdList = (dependencies.code ?? []).some(({ found_by }) =>
    found_by?.includes("accessory_id_list"),
  );

  const parts = [
    "Name the physical device, its linked accessory/room(s) (or note if it is an unpaired discovery child), before calling apply_native_change.",
  ];
  if (unconfirmed) {
    parts.push(
      "Warn the owner explicitly that SprutHub did not list or allow reading all linked accessories (linked_accessories_unconfirmed: true), so dependencies could not be fully verified automatically.",
    );
  }
  if (hasFound || hasUnread) {
    parts.push(
      "List every found and unread dependency from device_remove.dependencies (scenarios, code, links, bridges, logics, code_unread, bridges_unread): scenarios and code remain on the hub but will no longer reach the removed device, while links, bridge exports, and assigned logics are lost.",
    );
    if (hasIdList) {
      parts.push(
        "Code entries with found_by accessory_id_list hold the numeric id in an array and may only coincide.",
      );
    }
  } else if (!unconfirmed) {
    parts.push(
      "Confirm to the owner that no referencing scenarios, code mentions, links, bridge exports, or assigned logics were found.",
    );
  }
  if (childUnread) {
    parts.push(
      "Note that the controller child list could not be read (child_unread: true).",
    );
  }
  parts.push(
    "State that removing a physical device removes it from the controller network and cannot be undone with restore_native_change (bringing it back requires physical re-pairing). Call apply_native_change ONLY after the owner confirms once.",
  );
  return parts.join(" ");
}

function sameNumberList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sanitizeText(value) {
  return typeof value === "string" ? sanitizeNativeData(value) : value;
}

function sanitizeDependencies(dependencies) {
  return {
    scenarios: (dependencies.scenarios ?? []).map(({ ref, name }) => ({
      ref,
      name: sanitizeText(name),
    })),
    code: (dependencies.code ?? []).map(({ ref, name, found_by }) => ({
      ref,
      name: sanitizeText(name),
      found_by: [...(found_by ?? [])],
    })),
    ...(dependencies.code_unread?.length > 0
      ? {
          code_unread: dependencies.code_unread.map((entry) => ({
            ...(entry.ref ? { ref: entry.ref } : {}),
            reason: sanitizeText(entry.reason),
            ...(entry.scenarios
              ? { scenarios: structuredClone(entry.scenarios) }
              : {}),
          })),
        }
      : {}),
    links: (dependencies.links ?? []).map(
      ({ characteristic, with: others }) => ({
        characteristic: sanitizeText(characteristic),
        with: (others ?? []).map(({ ref, name }) => ({
          ref,
          name: sanitizeText(name),
        })),
      }),
    ),
    bridges: (dependencies.bridges ?? []).map(({ ref, name }) => ({
      ref,
      name: sanitizeText(name),
    })),
    ...(dependencies.bridges_unread?.length > 0
      ? {
          bridges_unread: dependencies.bridges_unread.map(({ ref, name }) => ({
            ref,
            name: sanitizeText(name),
          })),
        }
      : {}),
    logics: (dependencies.logics ?? []).map(({ name }) => ({
      name: sanitizeText(name),
    })),
  };
}

function aggregateAccessoryDependencies(perAccessory) {
  if (perAccessory.length === 0) {
    return {
      scenarios: [],
      code: [],
      links: [],
      bridges: [],
      logics: [],
    };
  }
  if (perAccessory.length === 1) {
    return structuredClone(perAccessory[0].dependencies);
  }

  const scenarios = [];
  const seenScenarios = new Set();
  const code = [];
  const seenCode = new Map();
  const codeUnread = [];
  const seenCodeUnread = new Set();
  const links = [];
  const seenLinks = new Set();
  const bridges = [];
  const seenBridges = new Set();
  const bridgesUnread = [];
  const seenBridgesUnread = new Set();
  const logics = [];
  const seenLogics = new Set();

  for (const { accessoryRef, accessoryName, dependencies } of perAccessory) {
    const tag = {
      accessory_ref: accessoryRef,
      accessory_name: accessoryName,
    };
    for (const entry of dependencies.scenarios ?? []) {
      const key = `${entry.ref}\0${accessoryRef}`;
      if (seenScenarios.has(key)) continue;
      seenScenarios.add(key);
      scenarios.push({ ...entry, ...tag });
    }
    for (const entry of dependencies.code ?? []) {
      const key = `${entry.ref}\0${accessoryRef}`;
      const existing = seenCode.get(key);
      if (existing) {
        existing.found_by = [
          ...new Set([...existing.found_by, ...(entry.found_by ?? [])]),
        ];
        continue;
      }
      const next = { ...entry, found_by: [...(entry.found_by ?? [])], ...tag };
      seenCode.set(key, next);
      code.push(next);
    }
    for (const entry of dependencies.code_unread ?? []) {
      const key = `${entry.ref ?? ""}\0${entry.reason}\0${JSON.stringify(entry.scenarios ?? null)}`;
      if (seenCodeUnread.has(key)) continue;
      seenCodeUnread.add(key);
      codeUnread.push(structuredClone(entry));
    }
    for (const entry of dependencies.links ?? []) {
      const withKey = (entry.with ?? []).map(({ ref }) => ref).join(",");
      const key = `${entry.characteristic}\0${accessoryRef}\0${withKey}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push({
        characteristic: entry.characteristic,
        with: structuredClone(entry.with ?? []),
        ...tag,
      });
    }
    for (const entry of dependencies.bridges ?? []) {
      const key = `${entry.ref}\0${accessoryRef}`;
      if (seenBridges.has(key)) continue;
      seenBridges.add(key);
      bridges.push({ ...entry, ...tag });
    }
    for (const entry of dependencies.bridges_unread ?? []) {
      if (seenBridgesUnread.has(entry.ref)) continue;
      seenBridgesUnread.add(entry.ref);
      bridgesUnread.push({ ...entry });
    }
    for (const entry of dependencies.logics ?? []) {
      const key = `${entry.name}\0${accessoryRef}`;
      if (seenLogics.has(key)) continue;
      seenLogics.add(key);
      logics.push({ ...entry, ...tag });
    }
  }

  return {
    scenarios,
    code,
    ...(codeUnread.length > 0 ? { code_unread: codeUnread } : {}),
    links,
    bridges,
    ...(bridgesUnread.length > 0 ? { bridges_unread: bridgesUnread } : {}),
    logics,
  };
}
