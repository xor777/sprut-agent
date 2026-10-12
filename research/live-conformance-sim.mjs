// Rehearses research/live-conformance.mjs against the simulated hub instead of
// a real SprutHub: `npm run conformance:sim -- [apartment|house] [script args]`.
// The script talks to the simulator through the same connection variables a
// live run reads, so its guard, steps and cleanup run unchanged.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "../test/support/simulated-hub.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [first, ...rest] = process.argv.slice(2);
const fixture = first && !first.startsWith("--") ? first : "apartment";
const args = first && !first.startsWith("--") ? rest : process.argv.slice(2);

const hub = await startSimulatedHub(await loadHomeFixture(fixture));
// A scratch HOME keeps the owner's connection file out of reach, so a
// rehearsal can never fall back to the real hub.
const home = await mkdtemp(path.join(tmpdir(), "sprut-agent-sim-home-"));
const child = spawn(
  process.execPath,
  [path.join(repo, "research/live-conformance.mjs"), ...args],
  {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...hub.connectionEnv(),
    },
    stdio: "inherit",
  },
);
child.on("exit", async (code) => {
  await hub.close();
  await rm(home, { recursive: true, force: true });
  process.exit(code ?? 1);
});
