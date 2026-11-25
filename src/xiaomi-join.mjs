import { valuesEqual } from "./change-contracts.mjs";
import { readRoomOrNull } from "./change-refs.mjs";
import { scalarEnvelope } from "./native-option-contract.mjs";
import {
  isHubReadFailure,
  isSensitiveNativeNode,
  SprutHubError,
  sanitizeNativeData,
  windowLinkedAccessoryIds,
} from "./spruthub-client.mjs";

export function xiaomiDeviceAlreadyJoined() {
  return new SprutHubError(
    "xiaomi_device_already_joined",
    "This Xiaomi device is already joined in SprutHub (already in main or linked to an accessory). Nothing was written.",
    "get_entity",
  );
}

export function readSelectedJoinRoom(window) {
  const option = (window?.options ?? []).find(
    (entry) => entry?.key === "joinRoom",
  );
  if (option?.read !== true || isSensitiveNativeNode(option)) {
    return null;
  }
  const typed = scalarEnvelope(option.value);
  if (!typed) return null;
  let name = null;
  if (Array.isArray(option.validValues)) {
    const matched = option.validValues.find((candidate) => {
      const candidateTyped = scalarEnvelope(candidate?.value);
      return candidateTyped && valuesEqual(candidateTyped, typed);
    });
    if (typeof matched?.name === "string" && matched.name.length > 0) {
      name = sanitizeNativeData(matched.name);
    }
  }
  if (typed.value === "" && name === null) return null;
  return {
    value: sanitizeNativeData(typed.value),
    name,
  };
}

export async function inspectXiaomiJoin({
  client,
  window,
  homeRef,
  hubSerial,
  extensionKey,
  childId,
  failOnReadError = false,
}) {
  const linked = windowLinkedAccessoryIds(window);
  if (linked.status === "confirmed" && linked.ids.length > 0) {
    return { alreadyJoined: true, summary: null };
  }

  let child = null;
  let childUnread = false;
  if (typeof extensionKey === "string" && typeof childId === "string") {
    try {
      const { children } = await client.nativeExtensionChildren(
        hubSerial,
        extensionKey,
        Date.now() + client.timeoutMs,
      );
      child = children.find((entry) => entry.id === childId) ?? null;
    } catch (error) {
      if (failOnReadError || !isHubReadFailure(error)) throw error;
      childUnread = true;
    }
  }

  const spaceKey =
    typeof child?.spaceKey === "string" && child.spaceKey.trim().length > 0
      ? sanitizeNativeData(child.spaceKey)
      : null;
  if (spaceKey === "main") {
    return { alreadyJoined: true, summary: null };
  }

  const windowName =
    typeof window?.label?.text === "string" &&
    window.label.text.trim().length > 0
      ? sanitizeNativeData(window.label.text)
      : null;
  const childName =
    typeof child?.name === "string" && child.name.trim().length > 0
      ? sanitizeNativeData(child.name)
      : windowName;
  const online = typeof child?.online === "boolean" ? child.online : null;
  const selectedRoom = readSelectedJoinRoom(window);

  return {
    alreadyJoined: false,
    summary: {
      controller_ref: `${homeRef}/extension/${encodeURIComponent(extensionKey)}`,
      extension_key: extensionKey,
      child_id: childId,
      child_name: childName,
      space_key: spaceKey,
      online,
      selected_room: selectedRoom,
      child_unread: childUnread,
    },
  };
}

export async function observeXiaomiJoinEffect(
  client,
  change,
  { checkedAt, readbackErrorSummary },
) {
  let window = null;
  let windowError = null;
  try {
    window = await client.nativeWindow(
      client.selectedSerial(),
      change.target.windowKey,
      Date.now() + client.timeoutMs,
    );
  } catch (error) {
    windowError = readbackErrorSummary(error);
  }

  const joinButtonVisible = windowError
    ? null
    : window === null
      ? false
      : (() => {
          const option = window.options.find(
            (entry) => entry.key === change.option_key,
          );
          return Boolean(option && option.visible !== false);
        })();

  const createdAccessories = [];
  const accessoryErrors = [];
  const homeRef = change.home_ref;
  if (window) {
    const linked = windowLinkedAccessoryIds(window);
    if (linked.status === "confirmed" && linked.ids.length > 0) {
      const ids = [...linked.ids].sort((left, right) => left - right);
      for (const id of ids) {
        const ref = `${homeRef}/accessory/${id}`;
        try {
          const accessory = await client.getAccessoryOrNull(id);
          if (accessory === null) {
            accessoryErrors.push({
              ref,
              code: "accessory_missing",
              message: "Linked accessory was not found on SprutHub.",
            });
            continue;
          }
          const room = await readRoomOrNull(client, accessory.roomId);
          createdAccessories.push({
            ref,
            name:
              typeof accessory.name === "string"
                ? sanitizeNativeData(accessory.name)
                : null,
            room_ref:
              typeof accessory.roomId === "number"
                ? `${homeRef}/room/${accessory.roomId}`
                : null,
            room_name:
              typeof room?.name === "string"
                ? sanitizeNativeData(room.name)
                : null,
          });
        } catch (error) {
          accessoryErrors.push({ ref, ...readbackErrorSummary(error) });
        }
      }
    }
  }

  let spaceKey = null;
  let online = null;
  let childPresent = null;
  let childError = null;
  const childId = change.xiaomi_join?.child_id;
  if (typeof change.extension_key === "string" && typeof childId === "string") {
    try {
      const { children } = await client.nativeExtensionChildren(
        client.selectedSerial(),
        change.extension_key,
        Date.now() + client.timeoutMs,
      );
      const child = children.find((entry) => entry.id === childId) ?? null;
      childPresent = child !== null;
      spaceKey =
        typeof child?.spaceKey === "string" && child.spaceKey.trim().length > 0
          ? sanitizeNativeData(child.spaceKey)
          : null;
      online = typeof child?.online === "boolean" ? child.online : null;
    } catch (error) {
      childError = readbackErrorSummary(error);
    }
  }

  const windowLabelError =
    window &&
    typeof window.label?.error === "string" &&
    window.label.error.trim().length > 0
      ? sanitizeNativeData(window.label.error)
      : undefined;

  const observedEffect = {
    space_key: spaceKey,
    online,
    child_present: childPresent,
    join_button_visible: joinButtonVisible,
    created_accessories: createdAccessories,
    ...(windowLabelError !== undefined
      ? { window_error: windowLabelError }
      : {}),
  };

  const readbackError =
    windowError || childError || accessoryErrors.length > 0
      ? {
          ...(windowError ? { window: windowError } : {}),
          ...(childError ? { extension_children: childError } : {}),
          ...(accessoryErrors.length > 0
            ? { accessories: accessoryErrors }
            : {}),
        }
      : undefined;

  const joinedObserved = createdAccessories.length > 0 || spaceKey === "main";
  const writeMayBeInFlight =
    change.native_write_sent === true && change.status !== "not_applied";
  const verification = readbackError
    ? {
        checked_at: checkedAt,
        fresh: false,
        result: "readback_incomplete",
        error:
          windowError?.code ??
          childError?.code ??
          accessoryErrors[0]?.code ??
          "readback_failed",
      }
    : {
        checked_at: checkedAt,
        fresh: true,
        result: joinedObserved
          ? "xiaomi_join_observed"
          : writeMayBeInFlight
            ? "xiaomi_join_pending"
            : "xiaomi_not_joined",
      };

  return { observedEffect, readbackError, verification };
}

export function mergeCreatedAccessoryRefs(change, observedEffect) {
  const observed = (observedEffect?.created_accessories ?? [])
    .map((entry) => entry?.ref)
    .filter((ref) => typeof ref === "string");
  if (observed.length === 0) return change.created_accessory_refs;
  return [...new Set([...(change.created_accessory_refs ?? []), ...observed])];
}
