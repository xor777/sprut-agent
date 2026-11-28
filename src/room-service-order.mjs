// Native SprutHub 3.0 room tile ordering via service.orders (0 new MCP tools,
// 0 new prepare_native_change fields). Protocol live-verified on SprutHub 3.0.0
// (2026-11-28):
// - RPC: { service: { orders: { orders: [{ aId, sId, grid: { order } }, ...] } } }
// - Sending only grid.order preserves existing grid.width and grid.height.
// - Ordered tiles use 1-based order (1..N); newly created unsorted tiles use 0
//   and display after 1..N; sending { grid: { order: 0 } } restores order 0.
import {
  configuredHomeRef,
  isUncertainWriteError,
  parseRoomRef,
  parseServiceRef,
  serviceKey,
} from "./change-refs.mjs";
import {
  failedVerification,
  freshVerification,
  nativeIntentDirection,
} from "./native-values.mjs";
import {
  redactSensitiveText,
  roomVisibleTiles,
  SprutHubError,
  serviceRef,
} from "./spruthub-client.mjs";

export const ROOM_SERVICE_ORDER = "room_service_order";

const ALLOWED_PREPARE_FIELDS = new Set([
  "operation",
  "target_ref",
  "member_service_refs",
  "position",
  "reason",
]);

export function isRoomServiceOrderKind(kind) {
  return kind === ROOM_SERVICE_ORDER;
}

function isPendingApplyIntent(change) {
  return (
    ["applying", "uncertain"].includes(change?.status) &&
    nativeIntentDirection(change) === "apply" &&
    change?.write_intent?.rejection === undefined
  );
}

function isPendingRestoreIntent(change) {
  return (
    ["restoring", "uncertain"].includes(change?.status) &&
    nativeIntentDirection(change) === "restore" &&
    change?.write_intent?.rejection === undefined
  );
}

export function roomServiceOrderHubStepsSent(change, direction) {
  if (!isRoomServiceOrderKind(change?.kind)) return false;
  if (direction === "apply" && change.status === "applied") return false;
  return (
    ["applying", "restoring", "uncertain"].includes(change.status) &&
    nativeIntentDirection(change) === direction &&
    change.write_intent?.rejection === undefined
  );
}

// Compact contract (well under 4096 B) so prepare_native_change attaches it
// inline on caller field/value errors.
export function roomServiceOrderContract(room = null, tileOrder = null) {
  return {
    ...(room
      ? {
          current: {
            room_ref: room.ref,
            room_name: redactSensitiveText(room.name ?? ""),
            tile_count: Array.isArray(tileOrder) ? tileOrder.length : 0,
            read_tile_order: {
              tool: "get_entity",
              arguments: { entity_ref: room.ref },
            },
          },
        }
      : {}),
    write: "service.orders({orders:[{aId,sId,grid:{order}}, ...]})",
    fields: {
      target_ref: "room_ref from home_overview or get_entity",
      member_service_refs:
        "non-empty array of unique visible non-system service refs in this room, in desired order (may be a subset — moved as a block; remaining tiles keep their relative order)",
      position: {
        optional: true,
        default: 0,
        note: "0-based insertion index among remaining visible tiles (0..remaining.length); 0 places member_service_refs first.",
      },
      reason: "required",
    },
    numbering:
      "SprutHub assigns 1-based grid.order (1..N) to ordered tiles and 0 to unsorted new tiles (shown after 1..N). Sending grid.order alone preserves existing grid.width and grid.height.",
    restore:
      "writes back exact saved baseline grid.order (including 0) for every visible tile while live visible tiles and orders match the applied layout.",
    restore_supported: true,
  };
}

function roomNotFoundError() {
  return new SprutHubError(
    "room_not_found",
    "The selected SprutHub room was not found.",
    "home_overview",
  );
}

function forbidUnexpectedFields(input) {
  for (const [field, value] of Object.entries(input)) {
    if (!ALLOWED_PREPARE_FIELDS.has(field) && value !== undefined) {
      throw new SprutHubError(
        "invalid_native_change",
        `${field} is not accepted by ${ROOM_SERVICE_ORDER}.`,
        "prepare_native_change",
      );
    }
  }
}

function toOrderSnapshot(tiles) {
  return tiles.map(({ aId, sId, order }) => ({ aId, sId, order }));
}

function toWireOrders(entries) {
  return entries.map(({ aId, sId, order }) => ({
    aId,
    sId,
    grid: { order },
  }));
}

function publicTileEntries(tiles) {
  return tiles.map(({ service_ref, name, type, order }) => ({
    service_ref,
    name: redactSensitiveText(name ?? ""),
    type,
    order,
  }));
}

function sameRoomOrders(liveSnapshot, expectedOrders) {
  if (!Array.isArray(liveSnapshot) || !Array.isArray(expectedOrders)) {
    return false;
  }
  if (liveSnapshot.length !== expectedOrders.length) return false;
  const expectedByKey = new Map(
    expectedOrders.map(({ aId, sId, order }) => [
      serviceKey({ aId, sId }),
      order,
    ]),
  );
  if (expectedByKey.size !== expectedOrders.length) return false;
  return liveSnapshot.every(
    ({ aId, sId, order }) =>
      expectedByKey.get(serviceKey({ aId, sId })) === order,
  );
}

function changeApplicationTime(change) {
  return (
    change.history?.find(({ status }) => status === "applying")?.at ??
    change.created_at
  );
}

function isAppliedAfter(other, base) {
  const otherTime = changeApplicationTime(other);
  const baseTime = changeApplicationTime(base);
  if (otherTime !== baseTime) return otherTime > baseTime;
  if (other.created_at !== base.created_at) {
    return other.created_at > base.created_at;
  }
  return other.id > base.id;
}

function isActiveLaterRoomOrderChange(other) {
  if (other.status === "applied") return true;
  if (
    ["applying", "restoring", "uncertain"].includes(other.status) &&
    other.write_intent?.rejection === undefined
  ) {
    return true;
  }
  if (
    other.status === "conflict" &&
    other.applied_orders !== undefined &&
    other.conflict_reason === "later_owned_change"
  ) {
    return true;
  }
  return false;
}

async function findLaterRoomServiceOrderChange(ctx, change) {
  const stored = await ctx.store.list();
  const later = stored
    .filter(
      (other) =>
        other.id !== change.id &&
        other.home_ref === change.home_ref &&
        other.kind === ROOM_SERVICE_ORDER &&
        other.room_id === change.room_id &&
        isActiveLaterRoomOrderChange(other) &&
        isAppliedAfter(other, change),
    )
    .sort((left, right) =>
      changeApplicationTime(right).localeCompare(changeApplicationTime(left)),
    );
  return later[0] ?? null;
}

// ---- Prepare ---------------------------------------------------------------

export async function prepareRoomServiceOrder(ctx, input) {
  const roomId = parseRoomRef(input.target_ref, ctx.hubSerial);
  forbidUnexpectedFields(input);

  if (
    !Array.isArray(input.member_service_refs) ||
    input.member_service_refs.length === 0
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "member_service_refs must be a non-empty array of visible service refs in this room.",
      "prepare_native_change",
    );
  }

  const parsedMembers = [];
  const seenKeys = new Set();
  for (const rawRef of input.member_service_refs) {
    const parsed = parseServiceRef(rawRef, ctx.hubSerial);
    const key = serviceKey(parsed);
    if (seenKeys.has(key)) {
      throw new SprutHubError(
        "invalid_native_value",
        `Duplicate service ref in member_service_refs: ${rawRef}.`,
        "prepare_native_change",
      );
    }
    seenKeys.add(key);
    parsedMembers.push({
      ref: serviceRef(ctx.hubSerial, parsed.aId, parsed.sId),
      aId: parsed.aId,
      sId: parsed.sId,
      key,
    });
  }

  const position = input.position === undefined ? 0 : input.position;
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new SprutHubError(
      "invalid_native_value",
      "position must be a non-negative integer (0-based insertion index).",
      "prepare_native_change",
    );
  }

  const room = await ctx.client.getRoom(roomId);
  if (!room) throw roomNotFoundError();
  const accessories = await ctx.client.listRoomAccessories(roomId);

  const allServicesByKey = new Map();
  for (const accessory of accessories) {
    for (const service of accessory.services ?? []) {
      allServicesByKey.set(
        serviceKey({ aId: accessory.id, sId: service.sId }),
        service,
      );
    }
  }

  const visibleTiles = roomVisibleTiles(accessories, ctx.hubSerial);
  const visibleByKey = new Map(
    visibleTiles.map((tile) => [serviceKey(tile), tile]),
  );

  for (const member of parsedMembers) {
    const service = allServicesByKey.get(member.key);
    if (!service) {
      throw new SprutHubError(
        "invalid_native_value",
        `Service ${member.ref} is not in room "${redactSensitiveText(room.name)}" (${input.target_ref}).`,
        "prepare_native_change",
      );
    }
    if (service.type === "AccessoryInformation" || service.system === true) {
      throw new SprutHubError(
        "invalid_native_value",
        `Service ${member.ref} (${service.type}) is a system service and cannot be ordered in the room tile grid.`,
        "prepare_native_change",
      );
    }
    if (service.visible === false) {
      throw new SprutHubError(
        "invalid_native_value",
        `Service ${member.ref} is hidden (visible=false) and cannot be ordered in the room tile grid. Make it visible first with service_visible.`,
        "prepare_native_change",
      );
    }
  }

  const remaining = visibleTiles.filter(
    (tile) => !seenKeys.has(serviceKey(tile)),
  );
  if (position > remaining.length) {
    throw new SprutHubError(
      "invalid_native_value",
      `position must be between 0 and ${remaining.length} for the remaining visible tiles in this room.`,
      "prepare_native_change",
    );
  }

  const movedTiles = parsedMembers.map(({ key }) => visibleByKey.get(key));
  const nextTiles = [
    ...remaining.slice(0, position),
    ...movedTiles,
    ...remaining.slice(position),
  ].map((tile, index) => ({
    ...tile,
    order: index + 1,
  }));

  const baselineOrders = toOrderSnapshot(visibleTiles);
  const targetOrders = toOrderSnapshot(nextTiles);

  if (sameRoomOrders(baselineOrders, targetOrders)) {
    return {
      status: "already_desired",
      operation: ROOM_SERVICE_ORDER,
      target_ref: input.target_ref,
      room: {
        ref: input.target_ref,
        name: redactSensitiveText(room.name),
      },
      tile_order: publicTileEntries(visibleTiles),
      native_write_sent: false,
      verification: freshVerification("room_tile_order_already_desired"),
    };
  }

  const targetOrderByKey = new Map(
    nextTiles.map((tile) => [serviceKey(tile), tile.order]),
  );
  const movedServices = movedTiles.map((tile) => ({
    service_ref: tile.service_ref,
    name: tile.name,
    type: tile.type,
    from_order: tile.order,
    to_order: targetOrderByKey.get(serviceKey(tile)),
  }));

  const now = new Date().toISOString();
  const change = {
    id: ctx.store.newId(),
    kind: ROOM_SERVICE_ORDER,
    status: "prepared",
    home_ref: configuredHomeRef(ctx.hubSerial),
    reason: input.reason,
    target_ref: input.target_ref,
    room_id: roomId,
    room_name: room.name,
    position,
    member_service_refs: parsedMembers.map(({ ref }) => ref),
    moved_services: movedServices,
    before_order: visibleTiles.map(({ service_ref, name, type, order }) => ({
      service_ref,
      name,
      type,
      order,
    })),
    after_order: nextTiles.map(({ service_ref, name, type, order }) => ({
      service_ref,
      name,
      type,
      order,
    })),
    baseline_orders: baselineOrders,
    target_orders: targetOrders,
    native_write_sent: false,
    native_acknowledged: false,
    last_verification: freshVerification("baseline_room_order_observed"),
    created_at: now,
    updated_at: now,
    history: [{ status: "prepared", at: now }],
  };
  await ctx.store.save(change);
  return publicRoomServiceOrderChange(change);
}

// ---- Apply -----------------------------------------------------------------

export async function applyRoomServiceOrder(ctx, change) {
  if (
    change.status === "restored" ||
    change.status === "applied" ||
    change.status === "conflict" ||
    change.status === "not_owned"
  ) {
    return ctx.publicStored(change);
  }
  if (["applying", "restoring", "uncertain"].includes(change.status)) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileRoomServiceOrder(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  const room = await ctx.client.getRoom(change.room_id);
  if (room === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "room_missing",
      last_verification: freshVerification("room_missing"),
    });
  }
  const accessories = await ctx.client.listRoomAccessories(change.room_id);
  const liveOrders = toOrderSnapshot(
    roomVisibleTiles(accessories, ctx.hubSerial),
  );
  if (!sameRoomOrders(liveOrders, change.baseline_orders)) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "room_layout_changed_since",
      last_verification: freshVerification("room_layout_changed_since"),
    });
  }
  await ctx.persistNativeIntent(change, "applying", "apply");
  try {
    await ctx.client.reorderServices(toWireOrders(change.target_orders));
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "not_applied", error);
    }
    return reconcileRoomServiceOrder(ctx, change, "apply", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileRoomServiceOrder(ctx, change, "apply", false);
}

// ---- Get & Reconcile -------------------------------------------------------

async function reconcileRoomServiceOrder(
  ctx,
  change,
  direction,
  uncertainWrite,
) {
  let room;
  let accessories;
  try {
    room = await ctx.client.getRoom(change.room_id);
    if (room !== null) {
      accessories = await ctx.client.listRoomAccessories(change.room_id);
    }
  } catch (error) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: failedVerification(error),
    });
  }
  if (room === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "room_missing",
      last_verification: freshVerification("room_missing"),
    });
  }
  const liveOrders = toOrderSnapshot(
    roomVisibleTiles(accessories, ctx.hubSerial),
  );
  const expectedOrders =
    direction === "apply" ? change.target_orders : change.baseline_orders;
  const previousOrders =
    direction === "apply"
      ? change.baseline_orders
      : (change.applied_orders ?? change.target_orders);

  if (sameRoomOrders(liveOrders, expectedOrders)) {
    return ctx.finishNative(
      change,
      direction === "apply" ? "applied" : "restored",
      undefined,
      {
        ...(direction === "apply"
          ? { applied_orders: structuredClone(expectedOrders) }
          : { restore_first_change_id: undefined }),
        ...(uncertainWrite ? { recovered_after_uncertain_write: true } : {}),
        last_verification: freshVerification(
          direction === "apply"
            ? "requested_room_order_observed"
            : "baseline_room_order_observed",
        ),
      },
    );
  }
  if (sameRoomOrders(liveOrders, previousOrders)) {
    return ctx.finishNative(change, "uncertain", undefined, {
      last_verification: freshVerification("previous_room_order_still_present"),
    });
  }
  return ctx.finishNative(change, "conflict", undefined, {
    conflict_reason:
      direction === "apply" ? "room_layout_changed_since" : "manual_change",
    last_verification: freshVerification(
      direction === "apply" ? "room_layout_changed_since" : "manual_change",
    ),
  });
}

export async function getRoomServiceOrder(ctx, change) {
  if (
    ["applying", "restoring", "uncertain"].includes(change.status) &&
    change.write_intent?.rejection === undefined
  ) {
    const direction = nativeIntentDirection(change) ?? "apply";
    return reconcileRoomServiceOrder(
      ctx,
      change,
      direction,
      change.write_intent?.acknowledged !== true,
    );
  }
  return ctx.publicStored(change);
}

// ---- Restore (Undo) --------------------------------------------------------

export async function restoreRoomServiceOrder(ctx, change) {
  if (change.status === "restored") return ctx.publicStored(change);
  if (
    change.native_write_sent !== true ||
    change.status === "prepared" ||
    change.status === "not_applied" ||
    change.status === "not_owned"
  ) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  if (isPendingApplyIntent(change)) {
    const reconciled = await reconcileRoomServiceOrder(
      ctx,
      change,
      "apply",
      change.write_intent?.acknowledged !== true,
    );
    if (change.status !== "applied") return reconciled;
  }
  if (!change.applied_orders) {
    return ctx.finishNative(change, "not_owned", undefined, {
      conflict_reason: "change_was_not_applied",
      last_verification: freshVerification("change_was_not_applied"),
    });
  }
  const room = await ctx.client.getRoom(change.room_id);
  if (room === null) {
    return ctx.finishNative(change, "conflict", undefined, {
      conflict_reason: "room_missing",
      last_verification: freshVerification("room_missing"),
    });
  }
  const accessories = await ctx.client.listRoomAccessories(change.room_id);
  const liveOrders = toOrderSnapshot(
    roomVisibleTiles(accessories, ctx.hubSerial),
  );
  const pendingRestore = isPendingRestoreIntent(change);
  if (!pendingRestore) {
    const later = await findLaterRoomServiceOrderChange(ctx, change);
    if (later) {
      return ctx.finishNative(change, "conflict", undefined, {
        conflict_reason: "later_owned_change",
        restore_first_change_id: later.id,
        last_verification: freshVerification("later_owned_change"),
      });
    }
  }
  if (sameRoomOrders(liveOrders, change.baseline_orders)) {
    return ctx.finishNative(change, "restored", undefined, {
      restore_first_change_id: undefined,
      ...(pendingRestore ? { recovered_after_uncertain_write: true } : {}),
      last_verification: freshVerification("baseline_room_order_observed"),
    });
  }
  if (!sameRoomOrders(liveOrders, change.applied_orders)) {
    const later = pendingRestore
      ? await findLaterRoomServiceOrderChange(ctx, change)
      : null;
    return ctx.finishNative(change, "conflict", undefined, {
      ...(later
        ? {
            conflict_reason: "later_owned_change",
            restore_first_change_id: later.id,
          }
        : { conflict_reason: "manual_change" }),
      last_verification: freshVerification(
        later ? "later_owned_change" : "manual_change",
      ),
    });
  }
  // persistNativeIntent replaces write_intent cleanly, clearing any stale rejection.
  change.restore_first_change_id = undefined;
  await ctx.persistNativeIntent(change, "restoring", "restore");
  try {
    await ctx.client.reorderServices(toWireOrders(change.baseline_orders));
  } catch (error) {
    if (!isUncertainWriteError(error)) {
      throw await ctx.finishRefusedWrite(change, "applied", error);
    }
    return reconcileRoomServiceOrder(ctx, change, "restore", true);
  }
  change.native_acknowledged = true;
  change.write_intent.acknowledged = true;
  return reconcileRoomServiceOrder(ctx, change, "restore", false);
}

// ---- Presentation, History & Summary Helpers -------------------------------

export function publicRoomServiceOrderChange(change, options = {}) {
  const verification = Object.hasOwn(options, "verification")
    ? options.verification
    : change.last_verification;
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    room: {
      ref: change.target_ref,
      name: redactSensitiveText(change.room_name ?? ""),
    },
    position: change.position ?? 0,
    moved_services: (change.moved_services ?? []).map((item) => ({
      service_ref: item.service_ref,
      name: redactSensitiveText(item.name ?? ""),
      type: item.type,
      from_order: item.from_order,
      to_order: item.to_order,
    })),
    before_order: publicTileEntries(change.before_order ?? []),
    after_order: publicTileEntries(change.after_order ?? []),
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(verification ? { verification } : {}),
    ...(change.recovered_after_uncertain_write
      ? { recovered_after_uncertain_write: true }
      : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...(change.conflict_reason === "later_owned_change" &&
    typeof change.restore_first_change_id === "string"
      ? {
          restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
        }
      : {}),
    restore_supported:
      change.status === "prepared" ||
      change.status === "applied" ||
      change.status === "restored" ||
      (["applying", "restoring", "uncertain"].includes(change.status) &&
        change.write_intent?.rejection === undefined) ||
      (change.status === "conflict" && change.applied_orders !== undefined),
    limitations: [
      "Updates grid.order for every visible non-system tile in this room in one service.orders RPC while preserving each tile's grid.width and grid.height.",
      "Restore writes back the exact saved baseline grid.order (including 0 for previously unsorted tiles) only while live visible tiles and orders still match the applied layout.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
}

export function roomServiceOrderChangeName(change) {
  return typeof change.room_name === "string" && change.room_name.length > 0
    ? redactSensitiveText(change.room_name)
    : undefined;
}

export function roomServiceOrderSummaryValue(change) {
  const moved = change.moved_services ?? [];
  if (moved.length === 0) return undefined;
  const format = (field) => {
    const shown = moved
      .slice(0, 3)
      .map(
        (item) =>
          `${redactSensitiveText(item.name || item.service_ref)} (#${item[field]})`,
      )
      .join(", ");
    return moved.length > 3 ? `${shown} (+${moved.length - 3})` : shown;
  };
  return {
    from: format("from_order"),
    to: format("to_order"),
  };
}

export function roomServiceOrderRestoreSupported(
  change,
  { activeStatus, isConflict },
) {
  if (
    change.native_write_sent !== true ||
    change.status === "not_applied" ||
    change.status === "not_owned"
  ) {
    return false;
  }
  return isConflict
    ? change.applied_orders !== undefined &&
        change.conflict_reason === "later_owned_change"
    : activeStatus;
}

export function roomServiceOrderAffectedRefs(
  change,
  homeRef,
  canonicalAncestors,
) {
  const refs = [change.target_ref];
  if (change.room_id !== undefined) {
    refs.push(`${homeRef}/room/${change.room_id}`);
  }
  for (const ref of change.member_service_refs ?? []) {
    if (typeof ref === "string") {
      refs.push(ref, ...canonicalAncestors(ref));
    }
  }
  return refs;
}
