import { parse } from "@babel/parser";

// SprutHub takes a LOGIC's name, description and start on boot from the
// info object of its code, at create and again on every code write, even
// unchanged (owner hub, 3.0.0, research/protocol/2026-10-13-wave4-
// contracts.md 1.5, 1.6). These helpers find the three values in the code
// without running it and rewrite them in place, leaving every other byte
// of the code as it was. Only plain values are read: a name built from
// parts or taken from a variable has no value here.
export const LOGIC_INFO_FIELDS = ["name", "description", "onStart"];

const FIELD_LITERALS = {
  name: "StringLiteral",
  description: "StringLiteral",
  onStart: "BooleanLiteral",
};

// Why the three values cannot all be rewritten in place, or undefined when
// they can. A change of any one writes all three (the code sets all three
// on every write), so one unreadable field stops it.
export function logicInfoNotEditable(info) {
  return (
    info.problem ??
    (LOGIC_INFO_FIELDS.map((field) => info.problems[field])
      .filter(Boolean)
      .join("; ") ||
      undefined)
  );
}

// { fields, problems, problem }: fields holds each info field found as a
// plain value ({value, start, end, line, quote}); problems says why another
// field has none; problem, when set, why info itself cannot be read.
export function readLogicInfo(source) {
  let program;
  try {
    program = parse(source, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
    }).program;
  } catch {
    return unreadable("the code does not parse as JavaScript here");
  }
  const assignments = program.body.flatMap(infoAssignments);
  if (assignments.length === 0) {
    return unreadable("the code assigns no info object at its top level");
  }
  if (assignments.length > 1) {
    return unreadable("the code assigns info more than once");
  }
  const [{ node, value: object }] = assignments;
  if (object?.type !== "ObjectExpression") {
    return unreadable("info is not written as an object literal");
  }
  if (usesInfoElsewhere(program, node)) {
    return unreadable(
      "the code changes info or passes it on after assigning it",
    );
  }
  const fields = {};
  const problems = {};
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      return unreadable("info copies fields from another object");
    }
    if (property.computed) {
      return unreadable("info has a computed key");
    }
    const key = propertyKey(property);
    if (!LOGIC_INFO_FIELDS.includes(key)) continue;
    if (Object.hasOwn(fields, key) || Object.hasOwn(problems, key)) {
      return unreadable(`info sets ${key} more than once`);
    }
    const value = property.type === "ObjectProperty" ? property.value : null;
    if (value?.type !== FIELD_LITERALS[key]) {
      problems[key] =
        `info.${key} is not a plain ${key === "onStart" ? "true or false" : "string"}`;
      continue;
    }
    fields[key] = {
      value: value.value,
      start: value.start,
      end: value.end,
      line: value.loc.start.line,
      quote: source[value.start],
    };
  }
  for (const key of LOGIC_INFO_FIELDS) {
    if (!Object.hasOwn(fields, key) && !Object.hasOwn(problems, key)) {
      problems[key] = `info has no ${key}`;
    }
  }
  return { fields, problems };
}

// Sets the info fields in desired that differ from the code, each in place
// of its value; info is readLogicInfo(source) and must hold every field
// desired names. Edits come in the order of the code.
export function rewriteLogicInfo(source, info, desired) {
  const changed = LOGIC_INFO_FIELDS.filter(
    (field) =>
      Object.hasOwn(desired, field) &&
      info.fields[field].value !== desired[field],
  )
    .map((field) => ({ field, literal: info.fields[field] }))
    .sort((left, right) => left.literal.start - right.literal.start);
  let rewritten = source;
  for (const { field, literal } of [...changed].reverse()) {
    rewritten =
      rewritten.slice(0, literal.start) +
      literalText(desired[field], literal.quote) +
      rewritten.slice(literal.end);
  }
  return {
    source: rewritten,
    edits: changed.map(({ field, literal }) => ({
      field: `info.${field}`,
      line: literal.line,
      from: literal.value,
      to: desired[field],
    })),
  };
}

function unreadable(problem) {
  return { fields: {}, problems: {}, problem };
}

// info = {...} or var/let/const info = {...} at the top level.
function infoAssignments(statement) {
  if (
    statement.type === "ExpressionStatement" &&
    statement.expression.type === "AssignmentExpression" &&
    statement.expression.left.type === "Identifier" &&
    statement.expression.left.name === "info"
  ) {
    return [
      {
        node: statement.expression,
        value:
          statement.expression.operator === "="
            ? statement.expression.right
            : null,
      },
    ];
  }
  if (statement.type === "VariableDeclaration") {
    return statement.declarations
      .filter(({ id }) => id.type === "Identifier" && id.name === "info")
      .map((declarator) => ({ node: declarator, value: declarator.init }));
  }
  return [];
}

// Any use of info but its assignment and reading its members
// (log(info.name), const { name } = info), anywhere in the code: it may set
// the fields after the literal. That is a write through a member, also by
// update, delete, destructuring or for-in, and info itself passed on or
// aliased (Object.assign(info, ...), Object.defineProperty(info, ...),
// const meta = info).
function usesInfoElsewhere(program, assignment) {
  let found = false;
  visit(program, [], (node, ancestors) => {
    if (found || node.type !== "Identifier" || node.name !== "info") return;
    const parent = ancestors.at(-1);
    if (!isReference(node, parent)) return;
    if (parent === assignment && (parent.left === node || parent.id === node)) {
      return;
    }
    if (
      parent.type === "VariableDeclarator" &&
      parent.init === node &&
      parent.id.type === "ObjectPattern"
    ) {
      return;
    }
    let top = node;
    let depth = ancestors.length - 1;
    while (MEMBER_TYPES.has(ancestors[depth]?.type)) {
      if (ancestors[depth].object !== top) break;
      top = ancestors[depth];
      depth -= 1;
    }
    found =
      top === node || writesTarget(top, ancestors[depth], ancestors[depth - 1]);
  });
  return found;
}

const MEMBER_TYPES = new Set(["MemberExpression", "OptionalMemberExpression"]);

// An identifier that names a binding, not a property name or a label.
function isReference(node, parent) {
  if (!parent) return true;
  if (MEMBER_TYPES.has(parent.type)) {
    return parent.object === node || parent.computed;
  }
  if (
    ["ObjectProperty", "ObjectMethod", "ClassProperty", "ClassMethod"].includes(
      parent.type,
    )
  ) {
    return parent.value === node || (parent.key === node && parent.computed);
  }
  return !["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(
    parent.type,
  );
}

// The member expression is written: assigned, updated, deleted, or the
// target of destructuring or for-in/for-of.
function writesTarget(target, parent, grandparent) {
  switch (parent?.type) {
    case "AssignmentExpression":
    case "AssignmentPattern":
    case "ForInStatement":
    case "ForOfStatement":
      return parent.left === target;
    case "UpdateExpression":
    case "ArrayPattern":
    case "RestElement":
      return true;
    case "UnaryExpression":
      return parent.operator === "delete";
    case "ObjectProperty":
      return parent.value === target && grandparent?.type === "ObjectPattern";
    default:
      return false;
  }
}

function visit(node, ancestors, visitor) {
  if (!node || typeof node.type !== "string") return;
  visitor(node, ancestors);
  const inner = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (
      [
        "loc",
        "extra",
        "leadingComments",
        "trailingComments",
        "innerComments",
      ].includes(key)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inner, visitor);
    } else if (value && typeof value === "object") {
      visit(value, inner, visitor);
    }
  }
}

function propertyKey(property) {
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "StringLiteral") return property.key.value;
  return undefined;
}

// A JavaScript literal of value, a string in the quote the code used.
function literalText(value, quote) {
  if (typeof value === "boolean") return String(value);
  let text = quote;
  for (const character of value) {
    if (character === "\\" || character === quote) {
      text += `\\${character}`;
    } else if (character === "\n") {
      text += "\\n";
    } else if (character === "\r") {
      text += "\\r";
    } else if (character < " " || character === " " || character === " ") {
      text += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      text += character;
    }
  }
  return text + quote;
}
