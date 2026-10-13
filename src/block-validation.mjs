import { isDeepStrictEqual } from "node:util";
import {
  BLOCK_ALLOWED_KEYS,
  BLOCK_CHILD_FIELDS,
  BRANCH_REPEAT,
  blockDataHasTrigger,
  blockScenarioRuns,
  blockScenarioTargets,
  CHARACTERISTIC_HOLD,
  CLEAR_ALL_DELAYS,
  canonicalBlockNode,
  HTTP_METHODS,
  httpUrlHidden,
  isBlockTrigger,
  NOTIFY_MODES,
  relativeStepNumber,
  SCENARIO_TARGET_MODES,
  SERVICE_ACTION_KINDS,
  scenarioTargetRuns,
  shownHttpUrl,
  timeTriggerProblem,
  visitKnownBlockNodes,
} from "./block-model.mjs";
import {
  blockPathToPointer,
  decodeJsonPointer,
  INACTIVE_PAUSE_STATUSES,
  inspectPauseOwnership,
  mergePauseOutcomes,
  parsePauseCode,
  pauseControllerId,
  replaceBlockValueAtPointer,
} from "./block-pause.mjs";
import {
  characteristicContract,
  typedNativeValue,
  validateCharacteristicValue,
  valuesEqual,
} from "./change-contracts.mjs";
import {
  isRecord,
  REDACTED_MARK,
  stableJson,
  stableNativeId,
} from "./change-refs.mjs";
import { validateNativeScalarValue } from "./native-option-contract.mjs";
import {
  checkNotificationRecipients,
  notificationPreview,
  notifyRecipients,
} from "./scenario-notifications.mjs";
import { SprutHubError, sanitizeNativeData } from "./spruthub-client.mjs";

// Checks BLOCK data before it is prepared, applied or restored. For
// block_data_update, editedFrom is the stored data the request edits:
// subtrees the edit keeps from it (keptBlockSubtrees) are written as stored
// without checks of their own shape, rights or values, so a BLOCK made in the
// SprutHub interface stays editable around nodes this contract cannot write.
// Pause controllers, scenario runs, delay references, bindings and the
// trigger count are checked over the whole data. Failing rules of the data
// itself and of its scenario runs are reported together; the device checks
// that follow stop at the first failure.
export async function validateBlockData(
  data,
  client,
  {
    editedFrom,
    allowUnknownFrom,
    allowedPauses = [],
    allowedPauseIntentId,
    allowActionOnly = false,
    scenarioIndex,
  },
) {
  if (
    !isRecord(data) ||
    !Array.isArray(data.targets) ||
    data.targets.length === 0
  ) {
    throw invalidBlock(
      "root.targets",
      "targets must be a non-empty array of nodes",
    );
  }
  const edit =
    editedFrom === undefined ? null : keptBlockSubtrees(data, editedFrom);
  const kept = (value) => edit?.kept.has(value) === true;
  const context = {
    kept,
    lostStoredNodes: edit === null ? new Set() : removedNodeForms(edit),
    blockIdsAbove: edit === null ? new WeakSet() : nodesWithBlockIdsAbove(data),
    removedNodes: edit === null ? null : removedBlockNodes(edit),
    grownOrGroups: edit === null ? [] : grownOrGroups(data, edit),
    problems: [],
    conditions: [],
    actions: [],
    delays: [],
    intervals: [],
    triggers: 0,
    scenarioRuns: [],
    notifications: [],
    notificationServices: [],
    httpRequests: [],
    clearDelays: [],
    uncheckedActions: [],
    pauseOwnership: inspectPauseOwnership(data, allowedPauses, {
      allowedIntentId: allowedPauseIntentId,
    }),
    allowedPauseCodeNodes: new WeakSet(),
  };
  const report = (path, message) => {
    context.problems.push({ path, message });
  };
  if (edit === null) reportUnknownFieldChanges(data, allowUnknownFrom, report);
  visitKnownBlockNodes(
    data,
    (node, kind, path) => {
      if (isBlockTrigger(node, kind, path)) context.triggers += 1;
      validateBlockNode(node, kind, path, context);
      if (edit !== null && !kept(node)) {
        reportUnknownNodeFields(
          node,
          kind,
          path,
          edit.counterparts.get(node),
          report,
        );
      }
    },
    (path, message, value, parent) => {
      // A node outside this contract that the edit keeps is written as stored.
      if (!kept(value) && !kept(parent)) {
        report(path, `${message}${storedNodeHint(value, context)}`);
      }
    },
  );

  for (const delay of context.delays) {
    if (
      !delay.kept &&
      delay.index > 0 &&
      context.delays.some(
        (other) => other !== delay && other.index === delay.index,
      )
    ) {
      report(
        `${delay.path}.index`,
        `delay index ${delay.index} is also used by another delay of this BLOCK`,
      );
    }
  }
  const delayIndexes = new Set(context.delays.map(({ index }) => index));
  const storedDelayIndexes =
    edit === null ? new Set() : blockDelayIndexes(editedFrom);
  for (const clear of context.clearDelays) {
    if (clear.index === CLEAR_ALL_DELAYS || delayIndexes.has(clear.index)) {
      continue;
    }
    // A kept clear_delay whose delay was already missing stays as stored.
    if (clear.kept && !storedDelayIndexes.has(clear.index)) continue;
    report(
      `${clear.path}.index`,
      `clear_delay index ${clear.index} has no delay with that index in this BLOCK`,
    );
  }
  if (context.intervals.length > 1) {
    for (const interval of context.intervals) {
      if (!interval.kept) {
        report(interval.path, "only one daily interval is supported");
      }
    }
  }
  if (context.triggers === 0) {
    if (edit !== null) {
      // A BLOCK without a trigger runs only when started manually or by
      // another scenario; an edit may keep that, not turn a triggered
      // BLOCK into one.
      if (blockDataHasTrigger(editedFrom)) {
        report(
          "root.targets",
          "this edit removes the last trigger of the BLOCK; keep a characteristic or interval with trigger=true, or a time_trigger cron",
        );
      }
    } else if (!(allowActionOnly && isLiteralActionOnlyBlock(data))) {
      report(
        "root.targets",
        "at least one trigger is required: trigger=true or a time_trigger cron",
      );
    }
  }

  const scenarios = new Map();
  for (const run of context.scenarioRuns) {
    // A BLOCK that fires itself would rerun its own targets without end;
    // switching itself off or resetting itself runs nothing.
    const runs = scenarioTargetRuns(run.mode);
    if (runs && run.index === scenarioIndex) {
      report(run.path, "a BLOCK cannot run itself");
      continue;
    }
    if (!scenarios.has(run.index)) {
      scenarios.set(run.index, await client.getScenario(run.index));
    }
    const record = scenarios.get(run.index);
    // Also for a kept target: an index could name another scenario by now.
    if (!record) {
      report(run.path, `scenario ${run.index} does not exist in this home`);
      continue;
    }
    run.scenario = {
      name: record.name,
      type: record.type,
      ...(typeof record.active === "boolean" ? { active: record.active } : {}),
    };
    if (runs && scenarioIndex !== undefined) {
      const loop = await scenarioRunLoop(run, scenarioIndex, scenarios, client);
      if (loop) report(run.path, loop);
    }
  }
  await checkNotificationRecipients(context, client, report);
  if (context.problems.length > 0) {
    throw invalidBlockProblems(context.problems);
  }

  // Every reference, kept or not, must still name the service and
  // characteristic types it names, so that a write never binds a BLOCK to
  // another device. Rights, values and comparisons are this contract's rules
  // for what the agent writes; a kept node that breaks them stays as stored.
  const accessories = new Map();
  // Sources are read by accessory.get or found missing without an error.
  const sourceAccessories = new Map();
  for (const reference of [...context.conditions, ...context.actions]) {
    if (!accessories.has(reference.aId)) {
      accessories.set(reference.aId, await client.getAccessory(reference.aId));
    }
    const accessory = accessories.get(reference.aId);
    const control = boundBlockControl(reference, accessory);
    let source;
    if (reference.source) {
      const { aId } = reference.source;
      if (!sourceAccessories.has(aId)) {
        sourceAccessories.set(aId, await client.getAccessoryOrNull(aId));
      }
      const sourceAccessory = sourceAccessories.get(aId);
      source = {
        accessory: sourceAccessory,
        control: boundSourceControl(reference, sourceAccessory),
      };
    }
    try {
      checkBlockReference(reference, accessory, control, source);
    } catch (error) {
      if (!reference.kept || !(error instanceof SprutHubError)) throw error;
      reference.unchecked = true;
      if (reference.role === "action") {
        context.uncheckedActions.push({
          configuration_pointer: blockPathToPointer(reference.path),
          reason: error.message,
        });
      }
    }
  }

  const feedback = context.conditions.find((condition) =>
    context.actions.some(
      (action) =>
        !(condition.kept && action.kept) &&
        action.aId === condition.aId &&
        action.sId === condition.sId &&
        action.cId === condition.cId,
    ),
  );
  if (feedback) {
    throw invalidBlock(
      feedback.path,
      "a condition cannot write the same characteristic in this slice",
    );
  }
  context.conditions = context.conditions.filter(({ unchecked }) => !unchecked);
  context.actions = context.actions.filter(({ unchecked }) => !unchecked);
  if (
    edit === null &&
    context.triggers === 0 &&
    context.actions.some(
      (action) =>
        action.hs !== "Lightbulb" ||
        action.hc !== "On" ||
        action.contract_kind !== "boolValue" ||
        action.parsed_value !== false,
    )
  ) {
    throw invalidBlock(
      "root.targets",
      "action-only BLOCK supports only literal Lightbulb On=false actions",
    );
  }
  return context;
}

// Finds what an edit keeps from stored BLOCK data. A requested subtree is
// kept when a stored subtree reached through the same parent fields and node
// types is the same in canonicalBlock form. It may sit at another position of
// its array, and each stored subtree is kept at most once. Other requested
// nodes pair with the remaining stored nodes of the same type in the same
// array, first by identity or shared content (BLOCK_NODE_MATCHES), then in
// order by position, so that their children are compared in turn; a node
// without a pair is new, and so is everything below it. A stored node that
// is neither kept nor paired is removed by the edit with everything below
// it; removed holds its path in the stored data; keptAs maps the top node of
// each kept subtree to the stored node it matches. A pair decides what the
// edit is checked against and reported as removed, not what is written: a
// subtree is written as stored only where the two are equal in
// canonicalBlock form.
export function keptBlockSubtrees(data, stored) {
  const kept = new WeakSet();
  const keptAs = new Map();
  const counterparts = new WeakMap();
  const removed = [];
  // Every edited rule is scored against every stored rule of its array, so
  // the content of each is built once per call.
  const ruleContents = new WeakMap();
  const contentOf = (node) => {
    if (!ruleContents.has(node)) ruleContents.set(node, ruleContent(node));
    return ruleContents.get(node);
  };
  const keep = (value) => {
    if (value === null || typeof value !== "object") return;
    kept.add(value);
    for (const child of Object.values(value)) keep(child);
  };
  const pair = (node, storedNode, kind, storedPath) => {
    counterparts.set(node, storedNode);
    for (const [key, rule] of Object.entries(BLOCK_CHILD_FIELDS[kind] ?? {})) {
      const path = `${storedPath}.${key}`;
      if (rule.shape !== "array") {
        pairChildren([node[key]], [storedNode[key]], () => path);
        continue;
      }
      pairChildren(
        Array.isArray(node[key]) ? node[key] : [],
        Array.isArray(storedNode[key]) ? storedNode[key] : [],
        (index) => `${path}[${index}]`,
      );
    }
  };
  const pairChildren = (children, storedChildren, storedPathOf) => {
    const candidates = storedChildren.map((child, index) => ({
      child,
      path: storedPathOf(index),
      comparable: stableJson(canonicalBlockNode(child)),
      used: false,
    }));
    const edited = [];
    for (const child of children) {
      const comparable = stableJson(canonicalBlockNode(child));
      const same = candidates.find(
        (candidate) => !candidate.used && candidate.comparable === comparable,
      );
      if (same) {
        same.used = true;
        keep(child);
        keptAs.set(child, same.child);
      } else {
        edited.push(child);
      }
    }
    const pairable = edited.filter(
      (child) =>
        isRecord(child) && Object.hasOwn(BLOCK_ALLOWED_KEYS, child.type),
    );
    const available = (candidate, child) =>
      !candidate.used &&
      isRecord(candidate.child) &&
      candidate.child.type === child.type;
    const pairs = new Map();
    for (const matches of BLOCK_NODE_MATCHES) {
      const scored = [];
      for (const child of pairable) {
        if (pairs.has(child)) continue;
        for (const candidate of candidates) {
          if (!available(candidate, child)) continue;
          const score = Number(matches(child, candidate.child, contentOf));
          if (score > 0) scored.push({ child, candidate, score });
        }
      }
      // The best pairs first; sort is stable, so equal ones keep the order
      // of the edit, then of the stored array.
      scored.sort((a, b) => b.score - a.score);
      for (const { child, candidate } of scored) {
        if (pairs.has(child) || candidate.used) continue;
        candidate.used = true;
        pairs.set(child, candidate);
      }
    }
    let next = 0;
    for (const child of pairable) {
      if (pairs.has(child)) continue;
      const index = candidates.findIndex(
        (candidate, position) =>
          position >= next && available(candidate, child),
      );
      if (index === -1) continue;
      candidates[index].used = true;
      next = index + 1;
      pairs.set(child, candidates[index]);
    }
    for (const child of pairable) {
      const candidate = pairs.get(child);
      if (candidate) pair(child, candidate.child, child.type, candidate.path);
    }
    for (const { child, path, used } of candidates) {
      if (!used && isRecord(child)) removed.push({ path, node: child });
    }
  };
  if (isRecord(data) && isRecord(stored)) pair(data, stored, "root", "root");
  return { kept, keptAs, counterparts, removed };
}

// get_entity shows a stored request URL other than scheme and host
// (httpUrlHidden) and other credential-shaped text of a BLOCK as
// [REDACTED]. An edit made from that read sends the mark back. Where
// exactly one node of the edit and one stored node carry the same blockId
// and type, the stored string is put back at each field the answers hide,
// so that the node stays as stored. A mark on a node whose blockId the edit
// carries more than once stays, and so does one without a stored node:
// copying the node would otherwise copy the owner's hidden URL or text into
// another branch. validateBlockNode refuses such a mark in a URL or a
// notification text with its pointer.
export function restoreHiddenBlockStrings(data, stored) {
  const storedNodes = nodesByBlockId(stored);
  for (const [blockId, requested] of nodesByBlockId(data)) {
    const originals = storedNodes.get(blockId) ?? [];
    if (requested.length !== 1 || originals.length !== 1) continue;
    const [node] = requested;
    const [original] = originals;
    if (original.type !== node.type) continue;
    for (const [key, field] of Object.entries(node)) {
      if (field === REDACTED_MARK && hiddenBlockString(original, key)) {
        node[key] = original[key];
      }
    }
  }
}

// Whether answers show a stored node's string field as [REDACTED].
export function hiddenBlockString(node, key) {
  const value = node[key];
  if (typeof value !== "string") return false;
  if (node.type === "http" && key === "url") return httpUrlHidden(value);
  return sanitizeNativeData(value, key) === REDACTED_MARK;
}

// The typed nodes of BLOCK data by blockId, anywhere in the data.
export function nodesByBlockId(data) {
  const nodes = new Map();
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!isRecord(value)) return;
    if (Number.isSafeInteger(value.blockId) && typeof value.type === "string") {
      nodes.set(value.blockId, [...(nodes.get(value.blockId) ?? []), value]);
    }
    for (const child of Object.values(value)) collect(child);
  };
  collect(data);
  return nodes;
}

// The data an edit writes: each subtree it keeps is replaced by the stored
// subtree it matches, so that what the canonical form reads alike (blockId,
// if.state, if defaults written out or left out, the mode of a one-condition
// group) stays as the hub holds it. The hub may read those fields
// differently than the canonical form assumes.
export function withKeptSubtreesAsStored(data, stored) {
  const { keptAs } = keptBlockSubtrees(data, stored);
  const rebuild = (value) => {
    if (keptAs.has(value)) return structuredClone(keptAs.get(value));
    if (Array.isArray(value)) return value.map(rebuild);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rebuild(child)]),
    );
  };
  return rebuild(data);
}

// Whether a stored node is an edited node's original besides its position,
// tried in order over all edited nodes of an array. Each gives true or, for
// shared content, the share the two nodes have in common (contentOf gives a
// node's ruleContent); the best pair is
// taken first, equal ones in order. The blockId the hub gave a node comes
// back from get_entity and stays in an edit made from that read; it is the
// only name of an if, a condition group, an interval, a cron or code.
// Without it, native ids name a device action, a condition, a scenario run
// or a delay, and what an if or a condition group tests and does names it.
export const BLOCK_NODE_MATCHES = [
  (node, stored) =>
    Number.isSafeInteger(node.blockId) && node.blockId === stored.blockId,
  (node, stored) => {
    const key = nativeBlockNodeKey(node);
    return key !== undefined && key === nativeBlockNodeKey(stored);
  },
  // A service action whose characteristic actions the edit changed still
  // names its device: first a stored action of the device that sets one of
  // the same characteristics, as when the edit adds a mode to a lamp's
  // brightness and drops its On action, then any action of the device.
  (node, stored) =>
    sameServiceDevice(node, stored) &&
    serviceActionCIds(node).some((cId) =>
      serviceActionCIds(stored).includes(cId),
    ),
  (node, stored) => sameServiceDevice(node, stored),
  // An if or a condition group the edit changed still has some of its
  // content, as when the edit adds «at night» to the motion rule and
  // deletes the rule before it: the stored one that shares the most of it,
  // counted over the content of both. The content is the conditions it
  // tests, for an if the actions of its branches, and the mode of its
  // group. The deleted rule may test every condition of the grown one, as
  // «motion and at night: brightness 30» beside «motion: light on»; the
  // actions and the mode tell them apart. A mode alone pairs nothing.
  (node, stored, contentOf) => {
    if (node.type !== "if" && node.type !== "condition") return 0;
    const content = contentOf(node);
    const storedContent = contentOf(stored);
    const shared = [...content].filter((part) =>
      storedContent.has(part),
    ).length;
    if (shared === 0) return 0;
    // The mode counts as one more part of each.
    const sameMode = Number(groupMode(node) === groupMode(stored));
    return (
      (shared + sameMode) /
      (content.size + storedContent.size - shared + 2 - sameMode)
    );
  },
];

// The conditions an if or a condition group tests and the actions of an
// if's branches, in canonicalBlock form.
export function ruleContent(node) {
  const content = new Set(
    [...conditionLeaves(node)].map((leaf) => `condition ${leaf}`),
  );
  if (node.type === "if") {
    for (const branch of ["then", "else"]) {
      for (const action of Array.isArray(node[branch]) ? node[branch] : []) {
        content.add(`${branch} ${stableJson(canonicalBlockNode(action))}`);
      }
    }
  }
  return content;
}

// The mode of a condition group, or of the group an if tests, as written
// rather than in canonical form: a group the edit grows keeps the OR the web
// client wrote on it over one condition, which the canonical form reads as
// AND.
export function groupMode(node) {
  const group = node.type === "if" ? node.if : node;
  return isRecord(group) && group.type === "condition" ? group.mode : undefined;
}

// The conditions an if or a condition group tests, below any groups, in
// canonicalBlock form.
export function conditionLeaves(node) {
  const leaves = new Set();
  const collect = (condition) => {
    if (
      isRecord(condition) &&
      condition.type === "condition" &&
      Array.isArray(condition.conditions)
    ) {
      for (const child of condition.conditions) collect(child);
    } else if (condition !== undefined && condition !== null) {
      leaves.add(stableJson(canonicalBlockNode(condition)));
    }
  };
  collect(node.type === "if" ? node.if : node);
  return leaves;
}

export function nativeBlockNodeKey(node) {
  if (node.type === "service") {
    return JSON.stringify([node.aId, node.sId, serviceActionCIds(node)]);
  }
  if (node.type === "characteristic") {
    return JSON.stringify([node.aId, node.sId, node.cId]);
  }
  if (SERVICE_ACTION_KINDS.includes(node.type)) {
    return JSON.stringify([node.cId]);
  }
  if (["scenario", "delay", "clear_delay"].includes(node.type)) {
    return JSON.stringify([node.index]);
  }
  return undefined;
}

export function serviceActionCIds(node) {
  return Array.isArray(node.characteristics)
    ? node.characteristics.map((action) => action?.cId)
    : [];
}

export function sameServiceDevice(node, stored) {
  return (
    node.type === "service" &&
    stored.type === "service" &&
    JSON.stringify([node.aId, node.sId]) ===
      JSON.stringify([stored.aId, stored.sId])
  );
}

// Condition groups an edit grows from one condition to several while
// their mode stays OR. The web client makes every group OR, which over one
// condition means that condition; over several, any one of them runs the
// branch, which the preview names so that the agent says so or sets AND.
// A group grew when the stored group it was edited from had one condition
// with mode OR; a group without a stored counterpart is new.
export function grownOrGroups(data, edit) {
  const grown = [];
  visitKnownBlockNodes(data, (node, kind, path) => {
    if (
      kind !== "condition" ||
      edit.kept.has(node) ||
      node.mode !== "OR" ||
      !Array.isArray(node.conditions) ||
      node.conditions.length <= 1
    ) {
      return;
    }
    const counterpart = edit.counterparts.get(node);
    if (
      isRecord(counterpart) &&
      counterpart.mode === "OR" &&
      Array.isArray(counterpart.conditions) &&
      counterpart.conditions.length <= 1
    ) {
      grown.push({
        pointer: blockPathToPointer(path),
        conditions: node.conditions.length,
      });
    }
  });
  return grown;
}

// Stored nodes an edit removes, with what below each of them this contract
// cannot write.
export function removedBlockNodes(edit) {
  return edit.removed.map(({ path, node }) => {
    const pointer = blockPathToPointer(path);
    return {
      pointer,
      type: typeof node.type === "string" ? node.type : null,
      unwritable: unwritableBlockNodes(node, pointer),
    };
  });
}

// Nodes of a stored subtree this contract cannot write: code other than
// sprut-agent's own pause condition, node types it does not know, and nodes
// the agent cannot write again as stored.
export function unwritableBlockNodes(node, pointer) {
  if (!isRecord(node)) return [];
  const kind = node.type;
  if (kind === "root" || !Object.hasOwn(BLOCK_ALLOWED_KEYS, kind)) {
    return [{ pointer, type: typeof kind === "string" ? kind : null }];
  }
  if (kind === "code") {
    return parsePauseCode(node.code) ? [] : [{ pointer, type: kind }];
  }
  // A request whose URL answers hide (anything beyond scheme and host, and
  // any URL this contract refuses): the agent never sees it to write it
  // again. A notification without text, which this contract refuses.
  if (
    (kind === "http" && httpUrlHidden(node.url)) ||
    (kind === "notify" &&
      (typeof node.text !== "string" || node.text.trim() === ""))
  ) {
    return [{ pointer, type: kind }];
  }
  return Object.entries(BLOCK_CHILD_FIELDS[kind] ?? {}).flatMap(
    ([key, rule]) => {
      const value = node[key];
      if (rule.shape !== "array") {
        return unwritableBlockNodes(value, `${pointer}/${key}`);
      }
      return Array.isArray(value)
        ? value.flatMap((child, index) =>
            unwritableBlockNodes(child, `${pointer}/${key}/${index}`),
          )
        : [];
    },
  );
}

export function blockDelayIndexes(data) {
  const indexes = new Set();
  visitKnownBlockNodes(data, (node, kind) => {
    if (kind === "delay" && Number.isSafeInteger(node.index)) {
      indexes.add(node.index);
    }
  });
  return indexes;
}

// Unknown fields of new data are refused; those of stored data must stay at
// the same path with the same value.
export function reportUnknownFieldChanges(data, storedData, report) {
  const requested = collectUnknownBlockFields(data);
  if (storedData === null || storedData === undefined) {
    for (const { path } of requested) report(path, "unsupported field");
    return;
  }
  const stored = new Map(
    collectUnknownBlockFields(storedData).map(({ path, value }) => [
      path,
      value,
    ]),
  );
  for (const { path, value } of requested) {
    if (!stored.has(path)) report(path, "unsupported field");
    else if (!isDeepStrictEqual(stored.get(path), value)) {
      report(path, "unknown field must be kept as stored");
    }
  }
  const requestedPaths = new Set(requested.map(({ path }) => path));
  for (const path of stored.keys()) {
    if (!requestedPaths.has(path)) {
      report(path, "unknown field of the stored BLOCK must be kept");
    }
  }
}

// Unknown fields of an edited node must be those of the stored node it was
// edited from, with the same values; a new node has none.
// An edit keeps stored code or another node this contract cannot write only
// under the stored node it pairs with. Without blockIds, on the node or on a
// node above it, that pair is found by content and may be another rule: the
// node is then refused as new while the same stored node is removed with
// the rule it sits in. The agent is told how to keep it. With every blockId
// kept the node was moved, and blockIds would not help: content alone does
// not tell, since moved code is the same code.
export function storedNodeHint(node, context) {
  return isRecord(node) &&
    typeof node.type === "string" &&
    !context.blockIdsAbove.has(node) &&
    context.lostStoredNodes.has(stableJson(canonicalBlockNode(node)))
    ? "; the stored BLOCK has the same node in a part this edit removes: keep the blockIds get_entity returned, on it and on the nodes above it, so that the edit is matched to the stored nodes it came from and the node stays as stored"
    : "";
}

// The nodes of BLOCK data that carry a blockId, as do all nodes above them.
export function nodesWithBlockIdsAbove(data) {
  const nodes = new WeakSet();
  const visit = (value, chained) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, chained);
      return;
    }
    if (!isRecord(value)) return;
    let own = chained;
    if (typeof value.type === "string") {
      own = chained && Number.isSafeInteger(value.blockId);
      if (own) nodes.add(value);
    }
    for (const child of Object.values(value)) visit(child, own);
  };
  visit(data, true);
  return nodes;
}

// Every typed node of the stored subtrees an edit removes, in canonicalBlock
// form.
export function removedNodeForms(edit) {
  const forms = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.type === "string") {
      forms.add(stableJson(canonicalBlockNode(value)));
    }
    for (const child of Object.values(value)) collect(child);
  };
  for (const { node } of edit.removed) collect(node);
  return forms;
}

export function reportUnknownNodeFields(node, kind, path, counterpart, report) {
  const allowed = BLOCK_ALLOWED_KEYS[kind];
  if (!allowed) return;
  for (const [key, value] of Object.entries(node)) {
    if (allowed.has(key)) continue;
    if (!isRecord(counterpart) || !Object.hasOwn(counterpart, key)) {
      report(`${path}.${key}`, "unsupported field");
    } else if (!isDeepStrictEqual(value, counterpart[key])) {
      report(`${path}.${key}`, "unknown field must be kept as stored");
    }
  }
  if (!isRecord(counterpart)) return;
  for (const key of Object.keys(counterpart)) {
    if (!allowed.has(key) && !Object.hasOwn(node, key)) {
      report(`${path}.${key}`, "unknown field of the stored node must be kept");
    }
  }
}

// The characteristic one condition or action names, with the service and
// characteristic types it names.
export function boundBlockControl(reference, accessory) {
  const { aId, sId, cId } = reference;
  const service = accessory?.services?.find(
    (candidate) => candidate.sId === sId,
  );
  const control = service?.characteristics?.find(
    (candidate) => candidate.cId === cId,
  )?.control;
  if (!control) {
    throw invalidBlock(
      reference.path,
      `no characteristic ${aId}/${sId}/${cId} in this home`,
    );
  }
  if (service.type !== reference.hs) {
    throw invalidBlock(
      `${reference.servicePath ?? reference.path}.hs`,
      `hs must be ${service.type}, the type of service ${aId}/${sId}`,
    );
  }
  if (control.type !== reference.hc) {
    throw invalidBlock(
      `${reference.path}.hc`,
      `hc must be ${control.type}, the type of characteristic ${aId}/${sId}/${cId}`,
    );
  }
  return control;
}

// Checks rights, value and comparison of one condition or action and keeps
// what the preview shows.
export function checkBlockReference(reference, accessory, control, source) {
  const contract = characteristicContract(control, {
    requireWrite: reference.role === "action",
  });
  if (reference.role === "action") {
    reference.contract_kind = contract.kind;
    reference.observation_available = accessory.online;
    reference.observed_value = observableBlockValue(control.value);
  }
  if (reference.operation === "from") {
    validateFromAction(reference, contract, source.accessory, source.control);
    return;
  }
  if (RELATIVE_ACTIONS.includes(reference.operation)) {
    validateRelativeAction(reference, contract);
    return;
  }
  const value = parseBlockValue(
    reference.value,
    contract.kind,
    `${reference.path}.value`,
  );
  if (reference.role === "action") reference.parsed_value = value;
  if (reference.role === "condition") {
    reference.parsed_value = value;
    reference.contract_kind = contract.kind;
    if (Object.hasOwn(contract, "valid_values")) {
      reference.valid_values = contract.valid_values;
    }
  }
  validateCharacteristicValue(value, contract);
  if (
    reference.role === "condition" &&
    !allowedConditions(contract.kind).includes(reference.cond)
  ) {
    throw invalidBlock(
      `${reference.path}.cond`,
      `comparison ${reference.cond} is not supported for ${contract.kind}; use ${allowedConditions(contract.kind).join(" ")}`,
    );
  }
}

// Scenario targets of other BLOCKs that run, switch or reset this scenario.
// Deleting it would leave them pointing at nothing, so restore names them
// instead. BLOCK data that cannot be parsed runs nothing the hub could
// resolve and is skipped.
export async function scenarioTargetReferences(client, homeRef, index) {
  const references = [];
  for (const summary of await client.listScenarios()) {
    if (summary.type !== "BLOCK" || summary.index === index) continue;
    const scenario = await client.getScenario(summary.index);
    let data;
    try {
      data = JSON.parse(scenario?.data);
    } catch {
      continue;
    }
    const scenarioRef = `${homeRef}/scenario/${encodeURIComponent(summary.index)}`;
    for (const run of blockScenarioTargets(data)) {
      if (run.index !== index) continue;
      const pointer = `/configuration/value${run.pointer}`;
      references.push({
        scenario_ref: scenarioRef,
        name: scenario.name,
        configuration_pointer: pointer,
        next: {
          tool: "get_entity",
          arguments: {
            entity_ref: scenarioRef,
            include: ["configuration"],
            pointer,
          },
        },
      });
    }
  }
  return references;
}

// Bounds the reads of one chain; a longer chain is refused, not assumed safe.
export const SCENARIO_RUN_CHAIN_LIMIT = 8;

// Follows the FIRE targets of BLOCK scenarios from one run of the BLOCK being
// written. A chain back to it would make the BLOCKs run each other without
// end. Scenarios run from LOGIC code are not followed. Returns why the run is
// refused, or null.
export async function scenarioRunLoop(run, scenarioIndex, records, client) {
  const explored = new Set();
  const walk = async (chain) => {
    const index = chain[chain.length - 1];
    if (index === scenarioIndex) {
      return `scenario ${run.index} runs this BLOCK again (${[scenarioIndex, ...chain].join(" -> ")}); remove a scenario target from that chain`;
    }
    if (explored.has(index)) return null;
    explored.add(index);
    if (chain.length > SCENARIO_RUN_CHAIN_LIMIT) {
      return `scenario targets from ${run.index} run more than ${SCENARIO_RUN_CHAIN_LIMIT} scenarios in a row (${chain.join(" -> ")}); a run back to this BLOCK cannot be ruled out`;
    }
    if (!records.has(index)) {
      records.set(index, await client.getScenario(index));
    }
    const record = records.get(index);
    if (record?.type !== "BLOCK") return null;
    let data;
    try {
      data = JSON.parse(record.data);
    } catch {
      return `scenario ${index} in the chain from ${run.index} has unreadable BLOCK data; a run back to this BLOCK cannot be ruled out`;
    }
    for (const next of blockScenarioRuns(data)) {
      const loop = await walk([...chain, next.index]);
      if (loop) return loop;
    }
    return null;
  };
  return walk([run.index]);
}

// The hub computes these values at run time from the characteristic.
export const RELATIVE_ACTIONS = ["toggle", "inc", "dec"];

export function validateRelativeAction(action, contract) {
  const { kind } = contract;
  const { operation, path } = action;
  if (operation === "toggle") {
    if (kind !== "boolValue") {
      throw invalidBlock(path, "toggle needs a boolean characteristic");
    }
    return;
  }
  if (!["intValue", "longValue", "doubleValue"].includes(kind)) {
    throw invalidBlock(path, `${operation} needs a numeric characteristic`);
  }
  // Listed values such as a heating mode are names, not a quantity.
  if (Object.hasOwn(contract, "valid_values")) {
    throw invalidBlock(
      path,
      `${operation} cannot step a characteristic with listed values; use set with one of them`,
    );
  }
  const step = relativeStepNumber(action.value);
  if (step === null || !(step > 0)) {
    throw invalidBlock(path, `${operation} step must be a positive number`);
  }
  if (contract.min !== undefined && contract.max !== undefined) {
    const range = contract.max - contract.min;
    if (step > range) {
      throw invalidBlock(
        path,
        `${operation} step ${step} is larger than the characteristic range ${range}`,
      );
    }
  }
  const aligned = validateNativeScalarValue(step, {
    kind,
    ...(contract.step !== undefined ? { step: contract.step } : {}),
  });
  if (!aligned.valid) {
    throw invalidBlock(
      path,
      aligned.reason === "step_mismatch"
        ? `${operation} step must be a multiple of ${contract.step}, the characteristic step`
        : `${operation} step does not match ${kind}`,
    );
  }
  action.parsed_value = step;
}

export function observableBlockValue(value) {
  const typed = typedNativeValue(value);
  const validation = validateNativeScalarValue(typed.value, {
    kind: typed.kind,
  });
  return validation.valid ? validation.value : null;
}

// A characteristic's value as read at preparation, when its accessory was
// online and the value was readable.
export function previewObservation({ observation_available, observed_value }) {
  const available = observation_available === true && observed_value !== null;
  return {
    status: available ? "available" : "unavailable",
    ...(observed_value ?? {}),
  };
}

export function blockActionPreview(validation, data, homeRef, capturedAt) {
  return {
    snapshot: {
      source: "accessory_read_during_preparation",
      captured_at: capturedAt,
    },
    actions: validation.actions.map((action) => {
      // The hub derives a relative or copied value at run time.
      const relative =
        RELATIVE_ACTIONS.includes(action.operation) ||
        action.operation === "from";
      const command =
        action.operation === "from"
          ? {
              operation: "from",
              source: {
                characteristic_ref: `${homeRef}/accessory/${action.source.aId}/service/${action.source.sId}/characteristic/${action.source.cId}`,
                service_type: action.source.hs,
                characteristic_type: action.source.hc,
                observation: previewObservation(action.source),
              },
              kind: action.contract_kind,
              execution: "write_if_action_runs",
            }
          : relative
            ? {
                operation: action.operation,
                ...(action.operation === "toggle"
                  ? {}
                  : { step: action.parsed_value }),
                kind: action.contract_kind,
                execution: "write_if_action_runs",
              }
            : {
                value: action.parsed_value,
                kind: action.contract_kind,
                execution: "write_if_action_runs",
              };
      const observation = previewObservation(action);
      const observationAvailable = observation.status === "available";
      const branch = actionBranchPreview(action, data, validation, homeRef);
      return {
        configuration_pointer: blockPathToPointer(action.path),
        characteristic_ref: `${homeRef}/accessory/${action.aId}/service/${action.sId}/characteristic/${action.cId}`,
        service_type: action.hs,
        characteristic_type: action.hc,
        command,
        observation,
        // A relative command writes a value derived at run time.
        comparison_to_observation: relative
          ? "not_applicable"
          : observationAvailable
            ? valuesEqual(command, action.observed_value)
              ? "equal"
              : "different"
            : "unknown",
        ...(branch ? { branch } : {}),
      };
    }),
    ...(validation.scenarioRuns.length > 0
      ? {
          scenario_runs: validation.scenarioRuns.map((run) => ({
            configuration_pointer: blockPathToPointer(run.path),
            mode: run.mode,
            scenario: {
              ref: `${homeRef}/scenario/${encodeURIComponent(run.index)}`,
              ...run.scenario,
            },
          })),
        }
      : {}),
    // Notifications this change adds or changes, with the services they go
    // through as read at preparation.
    ...(validation.notifications.some(({ kept }) => !kept)
      ? {
          notifications: validation.notifications
            .filter(({ kept }) => !kept)
            .map((notification) =>
              notificationPreview(
                notification,
                validation.notificationServices,
              ),
            ),
        }
      : {}),
    // Requests this change adds or changes, by scheme and host only.
    ...(validation.httpRequests.some(({ kept }) => !kept)
      ? {
          http_requests: validation.httpRequests
            .filter(({ kept }) => !kept)
            .map(({ path, method, url }) => ({
              configuration_pointer: blockPathToPointer(path),
              method,
              ...shownHttpUrl(url),
            })),
        }
      : {}),
    // Kept actions whose rights or value this contract would refuse.
    ...(validation.uncheckedActions.length > 0
      ? { unchecked_actions: structuredClone(validation.uncheckedActions) }
      : {}),
    ...(validation.triggers === 0
      ? {
          triggers: {
            status: "none",
            note: "runs only when started manually or by another scenario",
          },
        }
      : {}),
    ...(validation.removedNodes
      ? { removed_nodes: structuredClone(validation.removedNodes) }
      : {}),
    ...(validation.grownOrGroups.length > 0
      ? {
          warnings: validation.grownOrGroups.map(({ pointer, conditions }) => ({
            code: "or_group_grown",
            pointer,
            mode: "OR",
            conditions,
            message: `The condition group at ${pointer} of diff.data.to had one condition and now has ${conditions} with mode OR: any one of them runs its branch. Tell the owner, or set mode AND if all must hold.`,
          })),
        }
      : {}),
  };
}

export function actionBranchPreview(action, data, validation, homeRef) {
  const enclosing = enclosingBlockIfs(data, action.path);
  if (enclosing.length === 0) return undefined;

  const immediate = enclosing[enclosing.length - 1];
  const arm = blockIfArm(action.path, immediate.path);
  const branch = {
    condition_pointer: blockPathToPointer(`${immediate.path}.if`),
    ...(enclosing.length > 1
      ? {
          parent_condition_pointers: enclosing
            .slice(0, -1)
            .map((ancestor) => blockPathToPointer(`${ancestor.path}.if`)),
        }
      : {}),
  };
  if (arm === "then") branch.when = "condition_true";
  else if (arm === "else") branch.when = "condition_false";
  if (enclosing.length > 1) {
    // Inner equality is not the whole gate; keep the ancestor pointers.
    return {
      ...branch,
      coverage: { status: "undisclosed", reason: "nested_condition" },
    };
  }
  if (arm === null || !/^root\.targets\[\d+\]$/.test(immediate.path)) {
    return {
      ...branch,
      coverage: { status: "undisclosed", reason: "inapplicable_form" },
    };
  }

  const disclosed = simpleRootEqualityEnumCoverage(
    immediate.node,
    immediate.path,
    arm,
    validation,
    homeRef,
  );
  if (disclosed.status === "known_enum") {
    return { ...branch, coverage: disclosed };
  }
  return {
    ...branch,
    coverage: { status: "undisclosed", reason: disclosed.reason },
  };
}

export function enclosingBlockIfs(data, actionPath) {
  const ifs = [];
  visitKnownBlockNodes(data, (node, kind, path) => {
    if (kind !== "if") return;
    if (
      actionPath.startsWith(`${path}.then[`) ||
      actionPath.startsWith(`${path}.else[`)
    ) {
      ifs.push({ node, path });
    }
  });
  return ifs.sort((left, right) => left.path.length - right.path.length);
}

export function blockIfArm(actionPath, ifPath) {
  if (actionPath.startsWith(`${ifPath}.then[`)) return "then";
  if (actionPath.startsWith(`${ifPath}.else[`)) return "else";
  return null;
}

export function simpleRootEqualityEnumCoverage(
  ifNode,
  ifPath,
  arm,
  validation,
  homeRef,
) {
  const predicate = ifNode.if;
  if (!isRecord(predicate)) return { reason: "inapplicable_form" };

  let leaf;
  let leafPath;
  if (predicate.type === "characteristic") {
    leaf = predicate;
    leafPath = `${ifPath}.if`;
  } else if (predicate.type === "condition") {
    if (
      !Array.isArray(predicate.conditions) ||
      predicate.conditions.length !== 1
    ) {
      return { reason: "compound_condition" };
    }
    const only = predicate.conditions[0];
    if (!isRecord(only) || only.type === "condition") {
      return { reason: "compound_condition" };
    }
    if (only.type !== "characteristic") {
      return { reason: "inapplicable_form" };
    }
    leaf = only;
    leafPath = `${ifPath}.if.conditions[0]`;
  } else {
    return { reason: "inapplicable_form" };
  }
  if (leaf.cond !== "=") return { reason: "inapplicable_form" };
  // The result also depends on how long the value has held, not only on it.
  if (
    leaf.timeCond !== CHARACTERISTIC_HOLD.none.timeCond ||
    leaf.time !== CHARACTERISTIC_HOLD.none.time
  ) {
    return { reason: "held_condition" };
  }

  const condition = validation.conditions.find(
    (candidate) => candidate.path === leafPath,
  );
  if (!condition) return { reason: "inapplicable_form" };
  if (
    !Array.isArray(condition.valid_values) ||
    condition.valid_values.length === 0
  ) {
    // Missing listed values are unknown, not an empty else set.
    return { reason: "unknown_domain" };
  }
  const comparedEntry = condition.valid_values.find(
    (candidate) =>
      candidate.kind === condition.contract_kind &&
      Object.is(candidate.value, condition.parsed_value),
  );
  if (!comparedEntry) return { reason: "unknown_domain" };

  const values =
    arm === "then"
      ? [comparedEntry]
      : condition.valid_values.filter(
          (candidate) =>
            !(
              candidate.kind === comparedEntry.kind &&
              Object.is(candidate.value, comparedEntry.value)
            ),
        );
  return {
    status: "known_enum",
    source_ref: `${homeRef}/accessory/${condition.aId}/service/${condition.sId}/characteristic/${condition.cId}`,
    comparison: "=",
    compared: publicEnumCoverageValue(comparedEntry),
    values: values.map(publicEnumCoverageValue),
  };
}

export function publicEnumCoverageValue(entry) {
  return {
    kind: entry.kind,
    value: entry.value,
    ...(typeof entry.key === "string" && entry.key.length > 0
      ? { key: entry.key }
      : {}),
    ...(typeof entry.name === "string" && entry.name.length > 0
      ? { name: entry.name }
      : {}),
  };
}

// A run plan reports what can be read from the scenario before the hub runs
// it. It never limits what may be run: the owner's request does.
export async function scenarioRunPlan(snapshot, client, homeRef) {
  if (snapshot.type !== "BLOCK") {
    return {
      targets: [],
      targets_known: false,
      effect: { predicted: false, reasons: ["targets_unknown"] },
    };
  }
  const shape = blockRunShape(snapshot.data);
  const accessories = new Map();
  const targets = [];
  for (const action of shape.actions) {
    if (!accessories.has(action.aId)) {
      accessories.set(action.aId, await client.getAccessoryOrNull(action.aId));
    }
    const target = resolvedRunTarget(
      action,
      accessories.get(action.aId),
      homeRef,
    );
    if (target) targets.push(target);
  }
  const targetsKnown =
    shape.complete && targets.length === shape.actions.length;
  const refs = new Set(targets.map((target) => target.characteristic_ref));
  const reasons = [
    ...(shape.conditions ? ["conditions_evaluated_by_hub"] : []),
    ...(shape.delays ? ["delayed_actions"] : []),
    ...(targetsKnown ? [] : ["targets_unknown"]),
    ...(refs.size === targets.length ? [] : ["repeated_target"]),
  ];
  return {
    targets,
    targets_known: targetsKnown,
    effect:
      reasons.length === 0
        ? { predicted: true }
        : { predicted: false, reasons },
  };
}

export function blockRunShape(data) {
  const shape = {
    actions: [],
    conditions: false,
    delays: false,
    // An uninterpreted field may change what an action writes.
    complete: isRecord(data) && collectUnknownBlockFields(data).length === 0,
  };
  visitKnownBlockNodes(
    data,
    (node, kind) => {
      if (
        ["if", "condition", "characteristic", "interval", "code"].includes(kind)
      ) {
        shape.conditions = true;
      }
      // Hub code runs while the condition is evaluated and can write any
      // device, so literal actions are not the whole target list.
      if (kind === "code") shape.complete = false;
      if (kind === "delay") shape.delays = true;
      // Another scenario's writes are not read here.
      if (kind === "scenario") shape.complete = false;
      // A request may switch a device on the home network.
      if (kind === "http") shape.complete = false;
      if (kind !== "service" || !Array.isArray(node.characteristics)) return;
      for (const action of node.characteristics) {
        // Non-records reach the invalid-child callback below.
        if (!isRecord(action)) continue;
        // toggle, inc and dec values are computed by the hub during the run.
        if (action.type !== "set") {
          shape.complete = false;
          continue;
        }
        if (
          typeof action.value !== "string" ||
          ![node.aId, node.sId, action.cId].every(
            (id) => Number.isSafeInteger(id) && id >= 0,
          )
        ) {
          shape.complete = false;
          continue;
        }
        shape.actions.push({
          aId: node.aId,
          sId: node.sId,
          cId: action.cId,
          hs: node.hs,
          hc: action.hc,
          value: action.value,
        });
      }
    },
    () => {
      shape.complete = false;
    },
  );
  return shape;
}

export function resolvedRunTarget(action, accessory, homeRef) {
  const service = accessory?.services?.find(({ sId }) => sId === action.sId);
  const control = service?.characteristics?.find(
    ({ cId }) => cId === action.cId,
  )?.control;
  if (!control || service.type !== action.hs || control.type !== action.hc) {
    return null;
  }
  let expected;
  try {
    const contract = characteristicContract(control, { requireWrite: true });
    const value = parseBlockValue(action.value, contract.kind, "root");
    validateCharacteristicValue(value, contract);
    expected = { value, kind: contract.kind };
  } catch (error) {
    if (error instanceof SprutHubError) return null;
    throw error;
  }
  return {
    characteristic_ref: `${homeRef}/accessory/${action.aId}/service/${action.sId}/characteristic/${action.cId}`,
    target: { aId: action.aId, sId: action.sId, cId: action.cId },
    service_type: action.hs,
    characteristic_type: action.hc,
    expected_value: expected,
  };
}

// Changes prepared before SPRUT-141 held only literal action-only BLOCKs.
export function storedScenarioRunPlan(change) {
  return {
    targets: change.targets,
    targets_known: change.targets_known ?? true,
    effect: change.effect ?? { predicted: true },
  };
}

export function requireActionOnlyRuntime(snapshot, validation) {
  if (validation.triggers > 0) return;
  if (
    snapshot.active === true &&
    snapshot.onStart === false &&
    snapshot.sync === false
  ) {
    return;
  }
  throw new SprutHubError(
    "invalid_native_change",
    "An action-only native command must be active with onStart=false and sync=false.",
    "get_native_change_contract",
  );
}

export function isLiteralActionOnlyBlock(data) {
  return (
    isRecord(data) &&
    Array.isArray(data.targets) &&
    data.targets.length > 0 &&
    data.targets.every(
      (target) =>
        isRecord(target) &&
        target.type === "service" &&
        Array.isArray(target.characteristics) &&
        target.characteristics.length > 0 &&
        target.characteristics.every(
          (action) =>
            isRecord(action) &&
            action.type === "set" &&
            typeof action.value === "string",
        ),
    )
  );
}

// Reports each rule one node breaks, one problem per rule. A node the edit
// keeps is written as stored: its problems are not reported, but what it adds
// to the checks over the whole BLOCK is still collected.
export function validateBlockNode(node, kind, path, context) {
  const kept = context.kept(node);
  let valid = true;
  const report = (at, message) => {
    valid = false;
    if (!kept) context.problems.push({ path: at, message });
  };
  const field = (key) => `${path}.${key}`;
  if (kind === "root") return;
  if (kind === "if") {
    const pauseId = pauseControllerId(node);
    if (pauseId !== null) {
      const parsed = parsePauseCode(node.if?.conditions?.[0]?.code);
      const owner = context.pauseOwnership.get(pauseId);
      // Checked also when the edit keeps the controller.
      if (
        owner?.state !== "owned" ||
        owner.node !== node ||
        owner.change.pause_expires_at_ms !== parsed?.deadline
      ) {
        context.problems.push({
          path,
          message: "unowned or changed action-pause controller",
        });
        return;
      }
      context.allowedPauseCodeNodes.add(node.if.conditions[0]);
      return;
    }
    // An if without mode is EVERY, as the web client creates it.
    if (Object.hasOwn(node, "mode") && !["EVERY", "ONCE"].includes(node.mode)) {
      report(
        field("mode"),
        "if mode must be EVERY or ONCE; omitted means EVERY",
      );
    }
    for (const key of ["then_delay", "else_delay"]) {
      const period = node[key];
      if (
        Object.hasOwn(node, key) &&
        period !== BRANCH_REPEAT.no_repeat &&
        !(Number.isSafeInteger(period) && period >= BRANCH_REPEAT.minimum)
      ) {
        report(
          field(key),
          `${key} is the branch repeat period: 0 or omitted for no repeat, or whole milliseconds from ${BRANCH_REPEAT.minimum}`,
        );
      }
    }
    return;
  }
  if (kind === "condition") {
    if (!["AND", "OR"].includes(node.mode)) {
      report(field("mode"), "condition mode must be AND or OR");
    }
    if (Array.isArray(node.conditions) && node.conditions.length === 0) {
      report(field("conditions"), "conditions must not be empty");
    }
    return;
  }
  if (kind === "code") {
    const parsed = parsePauseCode(node.code);
    if (
      !parsed ||
      context.pauseOwnership.get(parsed.id)?.state !== "owned" ||
      !context.allowedPauseCodeNodes.has(node) ||
      Object.keys(node).some(
        (key) => !["type", "blockId", "code"].includes(key),
      )
    ) {
      report(
        path,
        `node type code is not supported by this contract; only sprut-agent's own action pause uses it${storedNodeHint(node, context)}`,
      );
    }
    return;
  }
  if (kind === "characteristic") {
    for (const key of ["aId", "sId", "cId"]) {
      if (!stableNativeId(node[key])) {
        report(field(key), `${key} must be a native id, an integer from 0`);
      }
    }
    for (const key of ["hs", "hc", "cond", "value"]) {
      if (typeof node[key] !== "string") {
        report(field(key), `${key} must be a string`);
      }
    }
    if (typeof node.trigger !== "boolean") {
      report(field("trigger"), "trigger must be true or false");
    }
    const { none, ...holds } = CHARACTERISTIC_HOLD;
    const held = Object.values(holds).some(
      (hold) =>
        node.timeCond === hold.timeCond &&
        Number.isSafeInteger(node.time) &&
        node.time >= hold.time.minimum,
    );
    if (
      !(node.timeCond === none.timeCond && node.time === none.time) &&
      !held
    ) {
      report(
        field("timeCond"),
        `characteristic hold needs timeCond "" with time 0, or timeCond ${Object.values(
          holds,
        )
          .map(({ timeCond }) => `"${timeCond}"`)
          .join(" or ")} with a positive time in milliseconds`,
      );
    }
    if (!valid) return;
    context.conditions.push({
      role: "condition",
      kept,
      path,
      aId: node.aId,
      sId: node.sId,
      cId: node.cId,
      hs: node.hs,
      hc: node.hc,
      trigger: node.trigger,
      cond: node.cond,
      value: node.value,
    });
    return;
  }
  if (kind === "interval") {
    if (typeof node.trigger !== "boolean") {
      report(field("trigger"), "trigger must be true or false");
    }
    context.intervals.push({ path, kept });
    const start = parseDailyCron(node.start, field("start"), report);
    const end = parseDailyCron(node.end, field("end"), report);
    if (
      start &&
      end &&
      start.hour === end.hour &&
      start.minute === end.minute
    ) {
      report(path, "daily interval start and end must differ");
    }
    return;
  }
  if (kind === "cron") {
    // Interval boundaries are checked with their interval.
    if (!isBlockTrigger(node, kind, path)) return;
    const problem = timeTriggerProblem(node);
    if (problem) report(path, problem);
    return;
  }
  if (kind === "service") {
    for (const key of ["aId", "sId"]) {
      if (!stableNativeId(node[key])) {
        report(field(key), `${key} must be a native id, an integer from 0`);
      }
    }
    if (typeof node.hs !== "string") report(field("hs"), "hs must be a string");
    if (
      Array.isArray(node.characteristics) &&
      node.characteristics.length === 0
    ) {
      report(field("characteristics"), "characteristics must not be empty");
    }
    if (!Array.isArray(node.characteristics)) return;
    const serviceValid = valid;
    node.characteristics.forEach((action, index) => {
      // Other types are named by the child check after this node.
      if (!isRecord(action) || !SERVICE_ACTION_KINDS.includes(action.type)) {
        return;
      }
      const actionPath = `${field("characteristics")}[${index}]`;
      const actionKept = context.kept(action);
      let actionValid = true;
      const reportAction = (key, message) => {
        actionValid = false;
        if (!actionKept) {
          context.problems.push({ path: `${actionPath}.${key}`, message });
        }
      };
      if (!stableNativeId(action.cId)) {
        reportAction("cId", "cId must be a native id, an integer from 0");
      }
      if (typeof action.hc !== "string") {
        reportAction("hc", "hc must be a string");
      }
      if (action.type === "set" && typeof action.value !== "string") {
        reportAction("value", "set value must be a native scalar string");
      }
      if (
        ["inc", "dec"].includes(action.type) &&
        relativeStepNumber(action.value) === null
      ) {
        reportAction(
          "value",
          `${action.type} value must be a positive step: a number or a plain decimal string such as "10" or "2.5"`,
        );
      }
      const source =
        action.type === "from" ? fromSource(action, reportAction) : undefined;
      if (
        source &&
        source.aId === node.aId &&
        source.sId === node.sId &&
        source.cId === action.cId
      ) {
        reportAction(
          "from_cId",
          "the source is the characteristic this action sets; name another one",
        );
      }
      if (!serviceValid || !actionValid) return;
      context.actions.push({
        role: "action",
        kept: actionKept,
        operation: action.type,
        path: actionPath,
        servicePath: path,
        aId: node.aId,
        sId: node.sId,
        cId: action.cId,
        hs: node.hs,
        hc: action.hc,
        value: action.value,
        ...(source ? { source } : {}),
      });
    });
    return;
  }
  if (SERVICE_ACTION_KINDS.includes(kind)) return;
  if (kind === "scenario") {
    if (typeof node.index !== "string" || node.index.length === 0) {
      report(
        field("index"),
        "scenario index must be the index of an existing scenario, the last segment of its scenario_ref",
      );
    }
    if (!Object.hasOwn(SCENARIO_TARGET_MODES, node.mode)) {
      report(
        field("mode"),
        `scenario mode must be one of ${Object.keys(SCENARIO_TARGET_MODES).join(", ")}`,
      );
    }
    if (valid) {
      context.scenarioRuns.push({ path, index: node.index, mode: node.mode });
    }
    return;
  }
  if (kind === "notify") {
    // The text is the owner's message: data, never an instruction.
    if (typeof node.text !== "string" || node.text.trim() === "") {
      report(field("text"), "notify text must be the message, not empty");
    } else if (node.text.includes(REDACTED_MARK)) {
      report(
        field("text"),
        `notify text contains ${REDACTED_MARK}, which sprut-agent shows in place of credential-shaped text; the stored text is kept only on the one node of the edit that carries its blockId from get_entity, so write the message itself for a new or copied notification`,
      );
    }
    if (!Object.hasOwn(NOTIFY_MODES, node.mode)) {
      report(
        field("mode"),
        "notify mode must be PUSH (through notification services) or MESSAGE (system)",
      );
    }
    const to = notifyRecipients(node, field("to"), report);
    if (valid) {
      context.notifications.push({
        path,
        kept,
        mode: node.mode,
        text: node.text,
        to,
      });
    }
    return;
  }
  if (kind === "http") {
    if (!HTTP_METHODS.includes(node.method)) {
      report(
        field("method"),
        `http method must be one of ${HTTP_METHODS.join(", ")}`,
      );
    }
    // Messages never repeat the URL: it may carry a key or a password.
    const problem = httpUrlProblem(node.url);
    if (problem) report(field("url"), problem);
    if (valid) {
      context.httpRequests.push({
        path,
        kept,
        method: node.method,
        url: node.url,
      });
    }
    return;
  }
  if (kind === "delay") {
    if (!["RESET", "CONTINUE"].includes(node.mode)) {
      report(field("mode"), "delay mode must be RESET or CONTINUE");
    }
    if (!Number.isSafeInteger(node.index) || node.index <= 0) {
      report(field("index"), "delay index must be a positive integer");
    }
    if (!Number.isSafeInteger(node.time) || node.time <= 0) {
      report(
        field("time"),
        "delay time must be a positive integer in milliseconds",
      );
    }
    if (Number.isSafeInteger(node.index)) {
      context.delays.push({ path, index: node.index, kept });
    }
    return;
  }
  if (kind === "clear_delay") {
    if (!Number.isSafeInteger(node.index)) {
      report(
        field("index"),
        "clear_delay index must be an integer: the index of a delay of this BLOCK, or 0 for all its delays",
      );
      return;
    }
    // The delay may come later in the tree; checked after the walk.
    context.clearDelays.push({ path, index: node.index, kept });
    return;
  }
  report(path, `node type ${kind ?? "missing"} is not supported`);
}

// The characteristic a from action copies, as the web client writes it: the
// source's ids and types in from_* fields and value "" or none (the hub
// stores it without value), since the value comes from the source when the
// action runs.
export function fromSource(action, reportAction) {
  if (action.value !== undefined && action.value !== "") {
    reportAction(
      "value",
      'from value must be "" or omitted: the value comes from the source characteristic',
    );
  }
  for (const key of ["from_aId", "from_sId", "from_cId"]) {
    if (!stableNativeId(action[key])) {
      reportAction(
        key,
        `${key} must be a native id of the source characteristic, an integer from 0`,
      );
    }
  }
  for (const key of ["from_hs", "from_hc"]) {
    if (typeof action[key] !== "string") {
      reportAction(key, `${key} must be the source's native type`);
    }
  }
  return {
    aId: action.from_aId,
    sId: action.from_sId,
    cId: action.from_cId,
    hs: action.from_hs,
    hc: action.from_hc,
  };
}

// The source characteristic of a from action, with the service and
// characteristic types it names, checked like every other reference.
export function boundSourceControl(reference, accessory) {
  const { aId, sId, cId, hs, hc } = reference.source;
  const service = accessory?.services?.find(
    (candidate) => candidate.sId === sId,
  );
  const control = service?.characteristics?.find(
    (candidate) => candidate.cId === cId,
  )?.control;
  if (!control) {
    throw invalidBlock(
      `${reference.path}.from_cId`,
      `no source characteristic ${aId}/${sId}/${cId} in this home`,
    );
  }
  if (service.type !== hs) {
    throw invalidBlock(
      `${reference.path}.from_hs`,
      `from_hs must be ${service.type}, the type of service ${aId}/${sId}`,
    );
  }
  if (control.type !== hc) {
    throw invalidBlock(
      `${reference.path}.from_hc`,
      `from_hc must be ${control.type}, the type of characteristic ${aId}/${sId}/${cId}`,
    );
  }
  return control;
}

export const VALUE_CLASSES = {
  boolValue: "a yes/no value",
  intValue: "a number",
  longValue: "a number",
  doubleValue: "a number",
  stringValue: "text",
};

// The hub copies the source's current value when the action runs. It must
// be readable and hold the same kind of value; a target with listed values
// (a mode) takes them only from a characteristic of its own type.
export function validateFromAction(
  action,
  contract,
  sourceAccessory,
  sourceControl,
) {
  const at = `${action.path}.from_cId`;
  let source;
  try {
    source = characteristicContract(sourceControl, { requireWrite: false });
  } catch (error) {
    if (!(error instanceof SprutHubError)) throw error;
    // The contract's own reason: not readable, no supported value type, or
    // listed values of another kind, told about the source.
    const reason = error.message.replace(/\.$/, "");
    throw invalidBlock(
      at,
      reason.startsWith("The selected characteristic")
        ? `the source${reason.slice("The selected".length)}`
        : `the source characteristic cannot be checked: ${reason}`,
    );
  }
  if (VALUE_CLASSES[source.kind] !== VALUE_CLASSES[contract.kind]) {
    throw invalidBlock(
      at,
      `the source holds ${VALUE_CLASSES[source.kind] ?? source.kind} and ${action.hc} takes ${VALUE_CLASSES[contract.kind] ?? contract.kind}; name a source of the same kind`,
    );
  }
  if (
    Object.hasOwn(contract, "valid_values") &&
    source.type !== contract.type
  ) {
    throw invalidBlock(
      at,
      `${action.hc} takes listed values; the source must be a ${contract.type} characteristic`,
    );
  }
  action.source.observation_available = sourceAccessory.online;
  action.source.observed_value = observableBlockValue(sourceControl.value);
}

// Why a request URL cannot be written, or null. See HTTP_URL in
// block-model.mjs for what is accepted and why.
export function httpUrlProblem(url) {
  const absolute = "url must be an absolute http or https URL";
  if (typeof url !== "string" || url === "") return absolute;
  if (url.includes(REDACTED_MARK)) {
    return `url contains ${REDACTED_MARK}, which sprut-agent shows in place of a URL it does not repeat; the stored URL is kept only on the one node of the edit that carries its blockId from get_entity, so write the URL itself for a new or copied request`;
  }
  if (/\s/.test(url)) return `${absolute} without spaces`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return absolute;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "url scheme must be http or https";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "a URL with a user name or password is refused; set up such a request in the SprutHub interface";
  }
  return null;
}

// Returns the time of a daily interval boundary, or null after reporting
// what is wrong with it. A missing or foreign boundary is named by the child
// check.
export function parseDailyCron(node, path, report) {
  if (!isRecord(node) || node.type !== "cron") return null;
  let valid = true;
  const fail = (at, message) => {
    valid = false;
    report(at, message);
  };
  if (node.mode !== "NONE")
    fail(`${path}.mode`, "daily cron mode must be NONE");
  if (node.offset !== 0) fail(`${path}.offset`, "daily cron offset must be 0");
  const match =
    typeof node.cron === "string"
      ? /^0 ([0-5]?\d) ([01]?\d|2[0-3]) \? \* \* \*$/.exec(node.cron)
      : null;
  if (!match) {
    fail(
      `${path}.cron`,
      "daily cron must match 0 MM HH ? * * * with MM 0-59 and HH 0-23 in the selected hub's local wall clock",
    );
  }
  return valid ? { minute: Number(match[1]), hour: Number(match[2]) } : null;
}

export function collectUnknownBlockFields(data) {
  const unknown = [];
  visitKnownBlockNodes(data, (node, kind, path) => {
    const allowed = BLOCK_ALLOWED_KEYS[kind] ?? new Set();
    for (const [key, value] of Object.entries(node)) {
      if (!allowed.has(key)) unknown.push({ path: `${path}.${key}`, value });
    }
  });
  return unknown.sort((left, right) => left.path.localeCompare(right.path));
}

export function prepareBlockWriteSource(input, pauseChanges, now) {
  const data = structuredClone(input);
  const owned = [
    ...inspectPauseOwnership(data, pauseChanges, {
      includeInactive: true,
    }).values(),
  ]
    .filter(
      (owner) =>
        owner.state === "owned" &&
        (INACTIVE_PAUSE_STATUSES.has(owner.change.status) ||
          owner.change.pause_expires_at_ms <= now),
    )
    .sort(
      (left, right) =>
        decodeJsonPointer(right.pointer).length -
        decodeJsonPointer(left.pointer).length,
    );
  for (const owner of owned) {
    replaceBlockValueAtPointer(
      data,
      owner.pointer,
      structuredClone(owner.node.then[0]),
    );
  }
  return {
    data,
    pauseOutcomes: owned
      .filter(({ change }) => !INACTIVE_PAUSE_STATUSES.has(change.status))
      .map(({ change }) => ({
        change_id: change.id,
        direction: "apply",
        status: "completed",
      })),
  };
}

export function prepareBlockUpdateSource(
  baseline,
  requested,
  pauseChanges,
  now,
) {
  const prepared = prepareBlockWriteSource(requested, pauseChanges, now);
  const baselineOwnership = inspectPauseOwnership(baseline, pauseChanges, {
    includeInactive: true,
  });
  const requestedOwnership = inspectPauseOwnership(
    prepared.data,
    pauseChanges,
    { includeInactive: true },
  );
  const explicitOutcomes = [...baselineOwnership.values()]
    .filter(
      (owner) =>
        owner.state === "owned" &&
        requestedOwnership.get(owner.change.id)?.state !== "owned" &&
        !INACTIVE_PAUSE_STATUSES.has(owner.change.status),
    )
    .map(({ change }) => ({
      change_id: change.id,
      direction: "apply",
      status: change.pause_expires_at_ms <= now ? "completed" : "restored",
    }));
  return {
    data: prepared.data,
    pauseOutcomes: mergePauseOutcomes(prepared.pauseOutcomes, explicitOutcomes),
  };
}

export function invalidBlock(path, message) {
  return invalidBlockProblems([{ path, message }]);
}

// Names every failing rule with its RFC 6901 pointer into the BLOCK data.
export function invalidBlockProblems(found) {
  const problems = found.map(({ path, message }) => ({
    pointer: blockPathToPointer(path),
    message,
  }));
  const [only] = problems;
  return new SprutHubError(
    "invalid_block_data",
    problems.length === 1
      ? `Unsupported BLOCK data at ${only.pointer}: ${only.message}.`
      : `Unsupported BLOCK data: ${problems.length} problems. ${problems
          .map(({ pointer, message }) => `At ${pointer}: ${message}.`)
          .join(" ")}`,
    "get_native_change_contract",
    { problems },
  );
}

export function parseBlockValue(value, kind, path) {
  if (kind === "boolValue") {
    if (value === "true") return true;
    if (value === "false") return false;
  } else if (["intValue", "longValue"].includes(kind)) {
    if (/^-?\d+$/.test(value)) return Number(value);
  } else if (kind === "doubleValue") {
    if (value.trim() !== "" && Number.isFinite(Number(value)))
      return Number(value);
  } else if (kind === "stringValue") {
    return value;
  }
  throw invalidBlock(path, `value does not match ${kind}`);
}

export function allowedConditions(kind) {
  if (kind === "boolValue") return ["="];
  if (kind === "stringValue") return ["=", "!="];
  return ["=", "!=", ">", ">=", "<", "<="];
}
