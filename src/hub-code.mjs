// Code the hub runs: a GLOBAL's or LOGIC's source and a BLOCK's code action.
// The hub's engine is Nashorn (research/protocol/2026-10-23-scenario-code.md,
// section 4): it stores code that does not compile or uses what it lacks,
// and only sets the scenario's error flag. Such code is refused here before
// anything is sent; what passes may still fail on the hub, which error then
// tells after the write.
import { parse } from "@babel/parser";
import { SprutHubError } from "./spruthub-client.mjs";

// What the probe saw Nashorn refuse, with what to write instead; the
// logical assignments came after ??, which it refused, and were not tried
// on the hub themselves. Object methods are matched by name, so a method
// of the owner's own object with such a name is refused too. A method the
// list lacks is not caught here, and inside a function that other
// scenarios call it fails only when they run it.
const UNSUPPORTED = {
  class: "a constructor function",
  destructuring: "reading the fields one by one",
  "...": "concat, apply or a loop",
  "?.": "&& or an if",
  "??": "a ternary that tests for null and undefined",
  "??=": "an if that tests for null and undefined",
  "||=": "x = x || …",
  "&&=": "x = x && …",
  async: "callbacks or setTimeout",
  "**": "Math.pow",
  ".includes": "indexOf(…) !== -1",
  ".padStart": "a loop or slice",
  ".find": "a loop, or filter(…)[0]",
  "Object.entries": "Object.keys",
  "Object.assign": "copying the fields in a loop over Object.keys",
};

function constructOf(node) {
  switch (node.type) {
    case "ClassDeclaration":
    case "ClassExpression":
      return "class";
    case "ObjectPattern":
    case "ArrayPattern":
      return "destructuring";
    case "SpreadElement":
    case "RestElement":
      return "...";
    case "OptionalMemberExpression":
    case "OptionalCallExpression":
      return "?.";
    case "LogicalExpression":
      return node.operator === "??" ? "??" : undefined;
    case "AwaitExpression":
      return "async";
    case "BinaryExpression":
      return node.operator === "**" ? "**" : undefined;
    case "AssignmentExpression":
      if (node.operator === "**=") return "**";
      return ["??=", "||=", "&&="].includes(node.operator)
        ? node.operator
        : undefined;
    case "MemberExpression": {
      const name = node.computed ? undefined : node.property?.name;
      if (["includes", "padStart", "find"].includes(name)) return `.${name}`;
      if (
        ["entries", "assign"].includes(name) &&
        node.object?.name === "Object"
      ) {
        return `Object.${name}`;
      }
      return undefined;
    }
    default:
      return node.async === true ? "async" : undefined;
  }
}

// Problems of code for the hub, in order of position, or an empty list.
// A BLOCK action is the body of a function on the hub (return is allowed);
// a GLOBAL's or LOGIC's source runs at the top level.
export function hubCodeProblems(source, { functionBody = false } = {}) {
  let program;
  try {
    program = parse(source, {
      sourceType: "script",
      allowReturnOutsideFunction: functionBody,
    }).program;
  } catch (error) {
    return {
      code: "invalid_javascript",
      problems: [
        {
          line: error.loc?.line ?? null,
          column: error.loc?.column ?? null,
          message: String(error.message).replace(/\s*\(\d+:\d+\)$/, ""),
        },
      ],
    };
  }
  const problems = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (typeof node.type === "string") {
      const construct = constructOf(node);
      if (construct) {
        problems.push({
          line: node.loc.start.line,
          column: node.loc.start.column,
          construct,
          instead: UNSUPPORTED[construct],
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (!["loc", "start", "end", "extra", "comments"].includes(key)) {
        visit(child);
      }
    }
  };
  visit(program.body);
  // One problem per construct and line.
  const seen = new Set();
  return {
    code: "unsupported_javascript",
    problems: problems
      .filter(({ line, construct }) => {
        const key = `${line}:${construct}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.line - b.line || a.column - b.column),
  };
}

// Throws the refusal for code the hub would not run, with each problem.
export function refuseHubCode(source, { functionBody = false, where } = {}) {
  const found = hubCodeProblems(source, { functionBody });
  if (found.problems.length === 0) return;
  const at = where ? `${where}: ` : "";
  const message =
    found.code === "invalid_javascript"
      ? `${at}the code does not parse (line ${found.problems[0].line}: ${found.problems[0].message}); SprutHub would store it and only set the scenario's error. Nothing was sent.`
      : `${at}SprutHub runs scenario code in Nashorn, which lacks ${found.problems
          .map(
            ({ construct, line, instead }) =>
              `${construct} (line ${line}; use ${instead})`,
          )
          .join(
            ", ",
          )}. SprutHub would store such code and only set the scenario's error. Nothing was sent.`;
  throw new SprutHubError(found.code, message, "prepare_native_change", {
    problems: found.problems,
  });
}

// What a code change reports of the hub's error flag after its write
// (hub_code_error, from the latest read): when the hub holds the written
// code with error, the agent tells the owner and offers the restore; it is
// an offer, not a next call.
export function hubCodeErrorFields(change) {
  const before =
    typeof change.hub_code_error_before === "boolean"
      ? { hub_code_error_before: change.hub_code_error_before }
      : {};
  if (typeof change.hub_code_error !== "boolean") return before;
  if (change.hub_code_error !== true || change.status !== "applied") {
    return { ...before, hub_code_error: change.hub_code_error };
  }
  // The scenario had error before this change: the change did not cause it,
  // and its restore would not clear it.
  if (change.hub_code_error_before === true) {
    return {
      ...before,
      hub_code_error: true,
      tell_owner:
        "The scenario was already marked with error before this change, and still is: code this change did not touch does not compile or stops with an error. Tell the owner; restoring this change would not clear it.",
    };
  }
  return {
    ...before,
    hub_code_error: true,
    tell_owner:
      "SprutHub saved the code but marks the scenario with error: the code did not compile, or stopped with an error when the hub ran it. Tell the owner, and offer to put the previous code back (offer).",
    offer: {
      tool: "restore_native_change",
      arguments: { change_ref: `spruthub-change://native/${change.id}` },
    },
  };
}

// The lines a new source changes, as hunks of the old source: line is the
// first old line a hunk replaces (or the line it inserts before), removed
// and added are the old and new lines. A longest common subsequence of
// lines; at most MAX_DIFF_LINES lines are shown.
const MAX_DIFF_LINES = 40;

export function codeLineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  // Common head and tail first: an edit of a few lines in a long source
  // leaves a small middle for the quadratic table.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const lengths = Array.from({ length: x.length + 1 }, () =>
    new Array(y.length + 1).fill(0),
  );
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        x[i] === y[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const hunks = [];
  let hunk = null;
  const flush = () => {
    if (hunk) hunks.push(hunk);
    hunk = null;
  };
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    hunk ??= { line: head + i + 1, removed: [], added: [] };
    if (
      j >= y.length ||
      (i < x.length && lengths[i + 1][j] >= lengths[i][j + 1])
    ) {
      hunk.removed.push(x[i]);
      i += 1;
    } else {
      hunk.added.push(y[j]);
      j += 1;
    }
  }
  flush();
  let shown = 0;
  const limited = [];
  for (const { line, removed, added } of hunks) {
    if (shown >= MAX_DIFF_LINES) break;
    const keep = (lines) => {
      const taken = lines.slice(0, Math.max(0, MAX_DIFF_LINES - shown));
      shown += taken.length;
      return taken;
    };
    limited.push({ line, removed: keep(removed), added: keep(added) });
  }
  const total = hunks.reduce(
    (sum, { removed, added }) => sum + removed.length + added.length,
    0,
  );
  return { hunks: limited, truncated: total > shown, addedText: addedText() };

  function addedText() {
    return hunks.flatMap(({ added }) => added).join("\n");
  }
}
