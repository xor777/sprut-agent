import { parseScript, walk } from "./parse-script.mjs";

// What the search of code (#readCodeMentions in spruthub-client.mjs) finds.
export const CODE_DEPENDENCY_NOTE =
  "Code is searched as get_entity relations search it (code_mentions): a Hub call with the device's id, its id in an array of plain numbers (a global list of lights) in code that also passes Hub calls a computed id, or its exact name in a string; an id kept in a variable or computed is not found. A number in such an array (found_by accessory_id_list) may only coincide with the id, and code that does not parse is named as unread (not_parsed).";

// Hub methods whose first argument is an accessory id, as the owner hub's
// scenario.sdk declares them: read on 2026-09-09
// (research/protocol/2026-09-09-automations.md) and again, the same
// SHA-256, on 2026-10-13.
export const ACCESSORY_ID_METHODS = new Set([
  "getAccessory",
  "getCharacteristic",
  "getCharacteristicValue",
  "setCharacteristicValue",
  "toggleCharacteristicValue",
]);

// Finds accessory IDs referenced by a hub code scenario that are absent from
// existingAccessoryIds, using iterative AST traversal so deep code cannot
// overflow the stack. Direct Hub.<method>(n, ...) calls report any missing
// non-negative integer literal; candidate arrays of positive integer literals
// are checked only when the source also calls a Hub id method with a dynamic
// first argument, and each array qualifies only when at least half of its
// distinct IDs exist in the home (avoiding RGB, delay, and step tables).
export function findMissingCodeAccessoryIds(source, existingAccessoryIds) {
  const program = parseScript(source);
  if (program === null) {
    return { parsed: false, missing_ids: [], lines: [], found_by: [] };
  }

  const directCalls = [];
  const candidateArrays = [];
  let looksUpIds = false;

  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.object.type === "Identifier" &&
      node.callee.object.name === "Hub" &&
      node.callee.property.type === "Identifier" &&
      ACCESSORY_ID_METHODS.has(node.callee.property.name) &&
      node.arguments.length > 0
    ) {
      const firstArg = node.arguments[0];
      if (firstArg.type === "NumericLiteral") {
        if (Number.isSafeInteger(firstArg.value) && firstArg.value >= 0) {
          directCalls.push({
            id: firstArg.value,
            line: firstArg.loc?.start.line ?? node.loc?.start.line,
          });
        }
      } else {
        looksUpIds = true;
      }
    }

    if (
      node.type === "ArrayExpression" &&
      node.elements.length > 0 &&
      node.elements.every(
        (element) =>
          element?.type === "NumericLiteral" &&
          Number.isSafeInteger(element.value) &&
          element.value > 0,
      )
    ) {
      candidateArrays.push(node.elements);
    }
  });

  const missingIds = new Set();
  const lines = new Set();
  const foundBy = new Set();

  for (const { id, line } of directCalls) {
    if (existingAccessoryIds.has(id)) continue;
    missingIds.add(id);
    if (typeof line === "number") lines.add(line);
    foundBy.add("accessory_id");
  }

  if (looksUpIds) {
    for (const elements of candidateArrays) {
      const present = new Set();
      const missing = new Set();
      for (const { value } of elements) {
        if (existingAccessoryIds.has(value)) present.add(value);
        else missing.add(value);
      }
      if (
        missing.size === 0 ||
        present.size < 1 ||
        present.size < missing.size
      ) {
        continue;
      }
      foundBy.add("accessory_id_list");
      for (const { value, loc } of elements) {
        if (!missing.has(value)) continue;
        missingIds.add(value);
        if (typeof loc?.start.line === "number") lines.add(loc.start.line);
      }
    }
  }

  const ascending = (left, right) => left - right;
  return {
    parsed: true,
    missing_ids: [...missingIds].sort(ascending),
    lines: [...lines].sort(ascending),
    found_by: ["accessory_id", "accessory_id_list"].filter((kind) =>
      foundBy.has(kind),
    ),
  };
}
