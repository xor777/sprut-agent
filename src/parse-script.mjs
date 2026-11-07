import { parse } from "@babel/parser";

// A hub code source as a program, or null when it does not parse. Code is
// the body of a function on the hub, so a top-level return is allowed.
export function parseScript(source) {
  try {
    return parse(source, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
    }).program;
  } catch {
    return null;
  }
}

export function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node?.type !== "string") return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "extra", "leadingComments", "trailingComments"].includes(key))
      continue;
    if (child !== null && typeof child === "object") walk(child, visit);
  }
}
