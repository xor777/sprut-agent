import {
  BLOCK_ALLOWED_KEYS,
  blockSubgraphHasTrigger,
  canonicalBlockNode,
  visitKnownBlockNodes,
} from "./block-model.mjs";
import { isRecord } from "./change-refs.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export function blockNode(value) {
  return isRecord(value) && typeof value.type === "string";
}

export const PAUSE_CODE_PATTERN =
  /^return Date\.now\(\) >= (\d+); \/\* sprut-agent:block-action-pause:([a-f0-9]{24}) \*\/$/;

export function parsePauseCode(code) {
  if (typeof code !== "string") return null;
  const match = PAUSE_CODE_PATTERN.exec(code);
  if (!match) return null;
  const deadline = Number(match[1]);
  return Number.isSafeInteger(deadline) ? { deadline, id: match[2] } : null;
}

export function pauseControllerId(node) {
  if (!isRecord(node) || node.type !== "if") return null;
  const conditions = node.if?.conditions;
  if (!Array.isArray(conditions) || conditions.length !== 1) return null;
  return parsePauseCode(conditions[0]?.code)?.id ?? null;
}

export function pauseControllerShapeMatches(node) {
  return (
    isRecord(node) &&
    node.type === "if" &&
    node.mode === "EVERY" &&
    node.then_delay === 0 &&
    node.else_delay === 0 &&
    isRecord(node.if) &&
    node.if.type === "condition" &&
    node.if.mode === "AND" &&
    Array.isArray(node.if.conditions) &&
    node.if.conditions.length === 1 &&
    node.if.conditions[0]?.type === "code" &&
    parsePauseCode(node.if.conditions[0]?.code) !== null &&
    Object.keys(node.if.conditions[0]).every((key) =>
      BLOCK_ALLOWED_KEYS.code.has(key),
    ) &&
    Array.isArray(node.then) &&
    node.then.length === 1 &&
    blockNode(node.then[0]) &&
    Array.isArray(node.else) &&
    node.else.length === 0 &&
    Object.keys(node).every((key) => BLOCK_ALLOWED_KEYS.if.has(key)) &&
    Object.keys(node.if).every((key) => BLOCK_ALLOWED_KEYS.condition.has(key))
  );
}

// The controller is compared in canonicalBlock form: the hub may keep its if
// defaults written out or left out.
export function pauseControllerMatches(node, change) {
  const parsed = parsePauseCode(node?.if?.conditions?.[0]?.code);
  return (
    pauseControllerShapeMatches(canonicalBlockNode(node)) &&
    parsed?.id === change.id &&
    parsed.deadline === change.pause_expires_at_ms
  );
}

export function pauseController(change, action) {
  return {
    type: "if",
    mode: "EVERY",
    if: {
      type: "condition",
      mode: "AND",
      conditions: [
        {
          type: "code",
          code: `return Date.now() >= ${change.pause_expires_at_ms}; /* sprut-agent:block-action-pause:${change.id} */`,
        },
      ],
    },
    // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
    then: [structuredClone(action)],
    else: [],
    then_delay: 0,
    else_delay: 0,
  };
}

export function buildPauseRequestedSnapshot(change) {
  const requested = structuredClone(change.baseline_snapshot);
  replaceBlockValueAtPointer(
    requested.data,
    change.action_pointer,
    pauseController(change, change.selected_action_snapshot),
  );
  return requested;
}

export function blockPathToPointer(path) {
  return path
    .replace(/^root/, "")
    .replace(/\.([^.[\]]+)/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .split("/")
    .map((part, index) =>
      index === 0 ? part : part.replaceAll("~", "~0").replaceAll("/", "~1"),
    )
    .join("/");
}

export function executableBlockActions(data) {
  const actions = new Map();
  visitKnownBlockNodes(data, (node, kind, path) => {
    if (["if", "service", "delay"].includes(kind)) {
      actions.set(blockPathToPointer(path), node);
    }
  });
  return actions;
}

export function selectBlockAction(data, pointer, pauseChanges) {
  const node = executableBlockActions(data).get(pointer);
  if (!node) throw invalidActionPointer(pointer);
  const ownership = inspectPauseOwnership(data, pauseChanges);
  for (const owner of ownership.values()) {
    if (owner.state !== "owned") continue;
    if (pointer === owner.pointer || pointer === `${owner.pointer}/then/0`) {
      ensurePauseableTriggerScope(data, owner.node.then[0], owner.pointer);
      return {
        action: owner.node.then[0],
        pointer: owner.pointer,
        replacesChangeId: owner.change.id,
      };
    }
    if (
      pointer.startsWith(`${owner.pointer}/`) ||
      owner.pointer.startsWith(`${pointer}/`)
    ) {
      throw pauseScopeOverlap(pointer, owner.pointer);
    }
  }
  if (pauseControllerId(node) !== null) {
    throw new SprutHubError(
      "pause_controller_changed",
      "The selected action-pause controller is not an unchanged owned controller.",
      "get_native_change",
    );
  }
  ensurePauseableTriggerScope(data, node, pointer);
  return { action: node, pointer };
}

export const INACTIVE_PAUSE_STATUSES = new Set([
  "restored",
  "superseded",
  "completed",
  "not_applied",
]);

export function inspectPauseOwnership(
  data,
  pauseChanges,
  { allowedIntentId, includeInactive = false } = {},
) {
  const candidates = new Map(
    pauseChanges
      .filter(
        (change) =>
          Number.isSafeInteger(change.pause_expires_at_ms) &&
          (includeInactive ||
            !INACTIVE_PAUSE_STATUSES.has(change.status) ||
            (change.status === "not_applied" && change.id === allowedIntentId)),
      )
      .map((change) => [change.id, change]),
  );
  const occurrences = new Map();
  visitKnownBlockNodes(data, (node, kind, path) => {
    if (kind !== "if") return;
    const parsed = parsePauseCode(node.if?.conditions?.[0]?.code);
    if (!parsed) return;
    const found = occurrences.get(parsed.id) ?? [];
    found.push({ node, parsed, pointer: blockPathToPointer(path) });
    occurrences.set(parsed.id, found);
  });
  const ownership = new Map();
  for (const [id, change] of candidates) {
    const found = occurrences.get(id) ?? [];
    const exact = found.filter(({ node }) =>
      pauseControllerMatches(node, change),
    );
    ownership.set(
      id,
      found.length === 1 && exact.length === 1
        ? { state: "owned", change, ...exact[0] }
        : {
            state: found.length === 0 ? "missing" : "changed_or_duplicated",
            change,
          },
    );
  }
  return ownership;
}

export function ensurePauseableTriggerScope(data, node, pointer) {
  if (!blockSubgraphHasTrigger(node)) return;
  const nested = [...executableBlockActions(data).entries()].filter(
    ([candidatePointer, candidate]) =>
      candidatePointer.startsWith(`${pointer}/`) &&
      !blockSubgraphHasTrigger(candidate),
  );
  const shallowest = nested
    .filter(([candidatePointer]) =>
      nested.every(
        ([otherPointer]) =>
          candidatePointer === otherPointer ||
          !candidatePointer.startsWith(`${otherPointer}/`),
      ),
    )
    .map(([candidatePointer]) => candidatePointer);
  throw new SprutHubError(
    "unsupported_pause_trigger_scope",
    "The selected BLOCK subgraph contains a trigger (trigger=true or a time_trigger cron), whose registration after nesting is not verified. Select an executable action below that trigger.",
    "get_entity",
    { suggested_action_pointers: shallowest },
  );
}

export function pauseScopeOverlap(pointer, ownedPointer) {
  return new SprutHubError(
    "pause_scope_overlap",
    `The selected BLOCK scope overlaps the owned pause at ${JSON.stringify(ownedPointer)} without selecting the same action. Restore that pause or select its controller or direct then/0 action.`,
    "get_native_change",
    {
      owned_pause_pointer: ownedPointer,
      owned_action_pointer: `${ownedPointer}/then/0`,
      requested_action_pointer: pointer,
    },
  );
}

export function decodeJsonPointer(pointer) {
  if (
    typeof pointer !== "string" ||
    !pointer.startsWith("/") ||
    /~(?:[^01]|$)/.test(pointer)
  ) {
    throw invalidActionPointer(pointer);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function blockPointerLocation(data, pointer) {
  const tokens = decodeJsonPointer(pointer);
  let parent;
  let key;
  let value = data;
  for (const token of tokens) {
    parent = value;
    key = Array.isArray(parent)
      ? /^(?:0|[1-9]\d*)$/.test(token)
        ? Number(token)
        : token
      : token;
    if (
      (Array.isArray(parent) && !Number.isSafeInteger(key)) ||
      (!isRecord(parent) && !Array.isArray(parent)) ||
      !Object.hasOwn(parent, key)
    ) {
      throw invalidActionPointer(pointer);
    }
    value = parent[key];
  }
  return { parent, key, value };
}

export function replaceBlockValueAtPointer(data, pointer, replacement) {
  const location = blockPointerLocation(data, pointer);
  location.parent[location.key] = replacement;
}

export function mergePauseOutcomes(current, additions) {
  const outcomes = new Map(
    current.map((outcome) => [
      `${outcome.direction}:${outcome.change_id}`,
      outcome,
    ]),
  );
  for (const outcome of additions) {
    outcomes.set(`${outcome.direction}:${outcome.change_id}`, outcome);
  }
  return [...outcomes.values()];
}

export function nativePauseOutcomes(change) {
  if (Array.isArray(change.pause_outcomes)) return change.pause_outcomes;
  return (change.collapsed_pause_change_ids ?? []).map((changeId) => ({
    change_id: changeId,
    direction: "apply",
    status: "completed",
  }));
}

export function invalidActionPointer(pointer) {
  return new SprutHubError(
    "invalid_action_pointer",
    `The BLOCK pointer ${JSON.stringify(pointer)} does not select one executable action or branch.`,
    "get_entity",
  );
}
