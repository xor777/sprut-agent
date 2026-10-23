// Preloaded by the test scripts in package.json. The server reads the
// owner's SprutHub login and session from ~/.config/sprut-agent (or
// XDG_CONFIG_HOME) and keeps its change journal in the per-user state
// directory under HOME (or XDG_STATE_HOME). The MCP SDK hands HOME to every
// server it launches, so a test that forgets the hub connection would use the
// owner's credentials. Tests get an empty temporary HOME instead.
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "sprut-agent-test-home-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
process.env.HOME = home;
for (const name of Object.keys(process.env)) {
  if (
    name === "XDG_CONFIG_HOME" ||
    name === "XDG_STATE_HOME" ||
    name.startsWith("SPRUTHUB_") ||
    name.startsWith("SPRUT_AGENT_")
  ) {
    delete process.env[name];
  }
}

await import("./loopback-only.mjs");

// Every child gets the temporary HOME, also when a test passes its own env
// without one (the system user database would give the owner's), and Node
// children get the same network guard.
const guard = `--import=${new URL("./loopback-only.mjs", import.meta.url).href}`;
const isNode = (file) => file === process.execPath || file === "node";

// spawn, execFile, exec and fork all start the child here, with the env
// already flattened into envPairs and argv0 first in args.
const { ChildProcess } = childProcess;
const spawnChild = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  if (
    Array.isArray(options.envPairs) &&
    !options.envPairs.some((pair) => pair.startsWith("HOME="))
  ) {
    options.envPairs.push(`HOME=${home}`);
  }
  if (isNode(options.file) && Array.isArray(options.args)) {
    options.args = [options.args[0], guard, ...options.args.slice(1)];
  }
  return spawnChild.call(this, options);
};

// The synchronous calls go to the native binding directly.
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, ...rest) {
    let args = Array.isArray(rest[0]) ? rest.shift() : undefined;
    let [options, ...more] = rest;
    if (options?.env && !Object.hasOwn(options.env, "HOME")) {
      options = { ...options, env: { ...options.env, HOME: home } };
    }
    if (args && isNode(file)) args = [guard, ...args];
    return args === undefined
      ? original.call(this, file, options, ...more)
      : original.call(this, file, args, options, ...more);
  };
}
syncBuiltinESMExports();
