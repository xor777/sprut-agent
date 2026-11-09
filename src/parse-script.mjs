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

// Every node of a program, parents first. Iterative: a chain of calls nests
// as deep as it is long, and the owner's code may overflow the call stack.
export function walk(root, visit) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        pending.push(node[index]);
      }
      continue;
    }
    if (typeof node?.type !== "string") continue;
    visit(node);
    const children = Object.entries(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const [key, child] = children[index];
      if (["loc", "extra", "leadingComments", "trailingComments"].includes(key))
        continue;
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
}
