import { createHash } from "node:crypto";
import { SprutHubError } from "./spruthub-client.mjs";

const IDENTITY_KEYS = ["kind", "ref", "name", "type", "key", "id"];

export function presentEntityResult(
  result,
  { entityRef, include, pointer, maxBytes, offset = 0, version },
) {
  if (pointer === undefined && (offset !== 0 || version !== undefined)) {
    throw invalidProjection(
      "offset and version require an explicit JSON Pointer.",
    );
  }

  const selection = { entityRef, include, maxBytes };
  if (pointer === undefined) {
    const complete = withPage(
      {
        ...result,
        representation: {
          kind: "complete_entity",
          entity_complete: true,
          selected_pointer: "",
          selected_complete: true,
        },
      },
      maxBytes,
    );
    if (serializedBytes(complete) <= maxBytes) return complete;
    return containerOverview(
      result,
      result.entity,
      "",
      selection,
      false,
      0,
      undefined,
    );
  }

  const selected = resolveJsonPointer(result.entity, pointer);
  if (selected.status === "missing") {
    throw new SprutHubError(
      "entity_pointer_not_found",
      "The selected JSON Pointer does not exist in this entity.",
      "use_entity_overview",
      { pointer },
    );
  }
  if (selected.status === "redacted") {
    throw new SprutHubError(
      "entity_pointer_redacted",
      "The selected JSON Pointer crosses a terminal redacted value.",
      "use_safe_entity_part",
      { pointer: selected.pointer },
    );
  }
  if (typeof selected.value === "string") {
    return presentString(
      result,
      selected.value,
      pointer,
      selection,
      offset,
      version,
    );
  }
  if (
    selected.value !== null &&
    typeof selected.value === "object" &&
    (offset !== 0 || version !== undefined)
  ) {
    return containerOverview(
      result,
      selected.value,
      pointer,
      selection,
      true,
      offset,
      version,
    );
  }
  if (offset !== 0 || version !== undefined) {
    throw invalidProjection(
      "offset and version require a selected string or container map.",
    );
  }

  const exact = withPage(
    projectedResult(result, pointer, selected.value, true),
    maxBytes,
  );
  if (serializedBytes(exact) <= maxBytes) return exact;
  if (selected.value !== null && typeof selected.value === "object") {
    return containerOverview(
      result,
      selected.value,
      pointer,
      selection,
      true,
      offset,
      version,
    );
  }
  throw resultTooLarge(pointer, exact, maxBytes);
}

function projectedResult(result, pointer, value, selectedComplete) {
  return {
    status: result.status,
    home: result.home,
    identity: entityIdentity(result.entity),
    selection: {
      pointer,
      status: "found",
      value,
    },
    representation: {
      kind: "selected_value",
      entity_complete: false,
      selected_pointer: pointer,
      selected_complete: selectedComplete,
    },
    freshness: result.freshness,
  };
}

function containerOverview(
  result,
  container,
  pointer,
  selection,
  explicitlySelected,
  offset,
  version,
) {
  const identity = entityIdentity(result.entity);
  const entries = Array.isArray(container)
    ? container.map((value, index) => [String(index), value])
    : Object.entries(container).filter(
        ([key]) => pointer !== "" || !Object.hasOwn(identity, key),
      );
  const currentVersion = containerVersion(entries, pointer);
  if (offset > 0 && version === undefined) {
    throw continuationNeedsVersion(pointer, selection, currentVersion);
  }
  if (version !== undefined && version !== currentVersion) {
    throw staleContent(
      "The selected container map changed before its continuation was read.",
      pointer,
      selection,
      currentVersion,
    );
  }
  if (offset > entries.length) {
    throw invalidProjection(
      "offset is past the end of the selected container map.",
    );
  }
  const availableParts = entries.map(([key, value]) => {
    const childPointer = `${pointer}/${escapePointerToken(key)}`;
    return {
      pointer: childPointer,
      kind: valueKind(value),
      ...childIdentity(value),
      next: entityNext(selection, childPointer),
    };
  });
  if (offset === availableParts.length) {
    return containerOverviewResult(
      result,
      identity,
      container,
      pointer,
      selection,
      explicitlySelected,
      offset,
      offset,
      availableParts,
      currentVersion,
    );
  }
  let end = offset;
  let overview = null;
  while (end < availableParts.length) {
    const proposedEnd = end + 1;
    const candidate = containerOverviewResult(
      result,
      identity,
      container,
      pointer,
      selection,
      explicitlySelected,
      offset,
      proposedEnd,
      availableParts,
      currentVersion,
    );
    if (serializedBytes(candidate) > selection.maxBytes) break;
    overview = candidate;
    end = proposedEnd;
  }
  if (!overview) {
    throw resultTooLarge(pointer, overview, selection.maxBytes);
  }
  return overview;
}

function containerOverviewResult(
  result,
  identity,
  container,
  pointer,
  selection,
  explicitlySelected,
  offset,
  end,
  availableParts,
  version,
) {
  const complete = end === availableParts.length;
  return withPage(
    {
      status: result.status,
      home: result.home,
      identity,
      ...(explicitlySelected
        ? {
            selection: {
              pointer,
              status: "found",
              value_kind: valueKind(container),
            },
          }
        : {}),
      representation: {
        kind: explicitlySelected ? "selected_value" : "entity_overview",
        entity_complete: false,
        selected_pointer: pointer,
        selected_complete: false,
        available_parts_offset: offset,
        available_parts: availableParts.slice(offset, end),
        available_parts_complete: complete,
        remaining_parts: availableParts.length - end,
        next: complete
          ? null
          : entityNext(selection, pointer, { offset: end, version }),
      },
      freshness: result.freshness,
    },
    selection.maxBytes,
  );
}

function presentString(result, text, pointer, selection, offset, version) {
  const characters = Array.from(text);
  const currentVersion = stringVersion(text);
  if (offset > 0 && version === undefined) {
    throw continuationNeedsVersion(pointer, selection, currentVersion);
  }
  if (version !== undefined && version !== currentVersion) {
    throw staleContent(
      "The selected string changed before its continuation was read.",
      pointer,
      selection,
      currentVersion,
    );
  }
  if (offset > characters.length) {
    throw invalidProjection("offset is past the end of the selected string.");
  }

  const exact = withPage(
    projectedResult(result, pointer, text, true),
    selection.maxBytes,
  );
  if (offset === 0 && serializedBytes(exact) <= selection.maxBytes)
    return exact;

  let low = offset;
  let high = characters.length;
  let best = null;
  while (low <= high) {
    const end = Math.floor((low + high) / 2);
    const candidate = stringChunkResult(
      result,
      characters,
      pointer,
      selection,
      offset,
      end,
      currentVersion,
    );
    if (serializedBytes(candidate) <= selection.maxBytes) {
      best = candidate;
      low = end + 1;
    } else {
      high = end - 1;
    }
  }
  if (!best || best.selection.value.end_character === offset) {
    throw resultTooLarge(pointer, best, selection.maxBytes);
  }
  return best;
}

function stringChunkResult(
  result,
  characters,
  pointer,
  selection,
  start,
  end,
  version,
) {
  const complete = end === characters.length;
  return withPage(
    {
      ...projectedResult(result, pointer, undefined, false),
      selection: {
        pointer,
        status: "found",
        value: {
          kind: "string_chunk",
          text: characters.slice(start, end).join(""),
          start_character: start,
          end_character: end,
          total_characters: characters.length,
          version,
          complete,
        },
        next: complete
          ? null
          : entityNext(selection, pointer, { offset: end, version }),
      },
    },
    selection.maxBytes,
  );
}

function resolveJsonPointer(root, pointer) {
  if (pointer === "") return { status: "found", value: root };
  if (!pointer.startsWith("/"))
    throw invalidProjection("Invalid JSON Pointer.");
  let value = root;
  let traversed = "";
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = decodePointerToken(encodedToken);
    traversed += `/${encodedToken}`;
    if (isRedactedNode(value)) {
      return { status: "redacted", pointer: traversed };
    }
    if (value === null || typeof value !== "object") {
      return { status: "missing" };
    }
    if (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/.test(token)) {
      return { status: "missing" };
    }
    if (!Object.hasOwn(value, token)) return { status: "missing" };
    value = value[token];
  }
  return value === undefined
    ? { status: "missing" }
    : { status: "found", value };
}

function decodePointerToken(token) {
  if (/~(?:[^01]|$)/.test(token)) {
    throw invalidProjection("Invalid JSON Pointer escape.");
  }
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function escapePointerToken(token) {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function entityIdentity(entity) {
  if (isRedactedNode(entity)) return entity;
  return Object.fromEntries(
    Object.entries(entity).filter(
      ([key, value]) => IDENTITY_KEYS.includes(key) || isCompactScalar(value),
    ),
  );
}

function childIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const identity = Object.fromEntries(
    IDENTITY_KEYS.filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]])
      .filter(([, item]) => isCompactScalar(item)),
  );
  return Object.keys(identity).length > 0 ? { identity } : {};
}

function isCompactScalar(value) {
  if (value === null || ["boolean", "number"].includes(typeof value))
    return true;
  return typeof value === "string" && Buffer.byteLength(value) <= 256;
}

function entityNext(selection, pointer, continuation = {}) {
  return {
    tool: "get_entity",
    arguments: {
      entity_ref: selection.entityRef,
      ...(selection.include.length > 0 ? { include: selection.include } : {}),
      pointer,
      max_bytes: selection.maxBytes,
      ...continuation,
    },
  };
}

function valueKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRedactedNode(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.redacted === true &&
    value.reason === "sensitive_native_data"
  );
}

function stringVersion(text) {
  return `sha256:${createHash("sha256").update(text).digest("base64url")}`;
}

function containerVersion(entries, pointer) {
  const candidates = entries.map(([, value]) => {
    const identity = childIdentity(value).identity ?? null;
    const stableKey = stableIdentityKey(identity);
    return { identity, stableKey };
  });
  const stableKeyCounts = new Map();
  for (const { stableKey } of candidates) {
    if (stableKey === null) continue;
    stableKeyCounts.set(stableKey, (stableKeyCounts.get(stableKey) ?? 0) + 1);
  }
  const mapIdentity = entries.map(([key, value], index) => {
    const { identity, stableKey } = candidates[index];
    const unambiguous =
      stableKey !== null && stableKeyCounts.get(stableKey) === 1;
    return {
      pointer: `${pointer}/${escapePointerToken(key)}`,
      ...(unambiguous ? { identity } : { value }),
    };
  });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(mapIdentity))
    .digest("base64url")}`;
}

function stableIdentityKey(identity) {
  if (typeof identity?.ref === "string" && identity.ref.length > 0) {
    return JSON.stringify(["ref", identity.ref]);
  }
  if (typeof identity?.key === "string" && identity.key.length > 0) {
    return JSON.stringify(["key", identity.key]);
  }
  return null;
}

function withPage(result, maxBytes) {
  result.page = { max_bytes: maxBytes, serialized_bytes: 0 };
  serializedBytes(result);
  return result;
}

function serializedBytes(result) {
  if (!result) return Number.POSITIVE_INFINITY;
  let previous = -1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === previous) return bytes;
    result.page.serialized_bytes = bytes;
    previous = bytes;
  }
  return Buffer.byteLength(JSON.stringify(result));
}

function invalidProjection(message, details) {
  return new SprutHubError(
    "invalid_entity_projection",
    message,
    "use_entity_overview",
    details,
  );
}

function continuationNeedsVersion(pointer, selection, version) {
  return invalidProjection(
    "A non-zero continuation offset requires the returned content version.",
    {
      pointer,
      next: entityNext(selection, pointer, { offset: 0, version }),
    },
  );
}

function staleContent(message, pointer, selection, version) {
  return new SprutHubError(
    "stale_entity_content",
    message,
    "restart_get_entity_detail",
    {
      pointer,
      next: entityNext(selection, pointer, { offset: 0, version }),
    },
  );
}

function resultTooLarge(pointer, result, maxBytes) {
  return new SprutHubError(
    "result_too_large",
    "The selected entity map cannot be represented inside max_bytes.",
    "increase_max_bytes_or_select_a_deeper_pointer",
    {
      pointer,
      max_bytes: maxBytes,
      required_bytes: result ? serializedBytes(result) : null,
    },
  );
}
