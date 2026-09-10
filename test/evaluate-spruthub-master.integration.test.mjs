import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evaluator = path.join(repo, "research", "evaluate-spruthub-master.mjs");

test("evaluator startup failure removes its scratch without using Codex auth", async () => {
  const isolatedTmp = await mkdtemp(
    path.join(tmpdir(), "sprut-evaluator-startup-test-"),
  );
  try {
    const result = spawnSync(process.execPath, [evaluator], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: isolatedTmp,
        SPRUT_EVAL_CODEX_AUTH: "/dev/null",
        SPRUT_EVAL_CODEX_BIN: path.join(isolatedTmp, "missing-codex"),
      },
      timeout: 5_000,
    });

    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
    assert.deepEqual(
      (await readdir(isolatedTmp)).filter((name) =>
        name.startsWith("sprut-session-"),
      ),
      [],
    );
  } finally {
    await rm(isolatedTmp, { recursive: true });
  }
});

test("evaluator closes its hub and preserves a completed child result", async () => {
  const isolatedTmp = await mkdtemp(
    path.join(tmpdir(), "sprut-evaluator-child-test-"),
  );
  const sessionTmp = path.join(isolatedTmp, "sessions");
  const evidenceRoot = path.join(isolatedTmp, "evidence");
  const fakeCodex = path.join(isolatedTmp, "fake-codex");
  await mkdir(sessionTmp);
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("fake-codex 1.0\\n");
  process.exit(0);
}
process.stdin.resume();
process.stdin.on("end", () => process.exit(7));
`,
  );
  await chmod(fakeCodex, 0o700);

  try {
    const result = spawnSync(
      process.execPath,
      [evaluator, "contact-option", "baseline"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: sessionTmp,
          SPRUT_EVAL_CODEX_AUTH: "/dev/null",
          SPRUT_EVAL_CODEX_BIN: fakeCodex,
          SPRUT_EVAL_OUTPUT: evidenceRoot,
        },
        timeout: 5_000,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.deepEqual(
      (await readdir(sessionTmp)).filter((name) =>
        name.startsWith("sprut-session-"),
      ),
      [],
    );
    const evidenceEntries = await readdir(evidenceRoot);
    assert.equal(evidenceEntries.length, 1);
    const execution = JSON.parse(
      await readFile(
        path.join(evidenceRoot, evidenceEntries[0], "execution.json"),
        "utf8",
      ),
    );
    const hubRequests = JSON.parse(
      await readFile(
        path.join(evidenceRoot, evidenceEntries[0], "hub-requests.json"),
        "utf8",
      ),
    );
    assert.equal(execution.exitCode, 7);
    assert.equal(execution.timedOut, false);
    assert.deepEqual(hubRequests, []);
  } finally {
    await rm(isolatedTmp, { recursive: true });
  }
});
