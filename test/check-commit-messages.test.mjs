import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(projectRoot, "scripts", "check-commit-messages.mjs");
const zeros = "0".repeat(40);

test("first push of a new branch does not re-check historical commit messages", async (t) => {
  const repo = await initRepo(t);
  await commit(repo, "not a conventional history commit");
  await addOrigin(t, repo);
  await git(repo, "checkout", "-b", "candidate");
  await commit(repo, "feat: candidate change");

  const result = await check(repo, {
    BASE_SHA: zeros,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });

  assert.equal(
    result.status,
    0,
    `first push must not fail on already-landed history:\n${result.output}`,
  );
});

test("first push still rejects an invalid new commit message", async (t) => {
  const repo = await initRepo(t);
  await commit(repo, "feat: history");
  await addOrigin(t, repo);
  await git(repo, "checkout", "-b", "candidate");
  await commit(repo, "not a conventional new commit");

  const result = await check(repo, {
    BASE_SHA: zeros,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });

  assertRejectedByConventionalCommits(
    result,
    /not a conventional new commit/,
  );
});

test("a later valid commit does not hide an invalid new commit in the same range", async (t) => {
  const repo = await initRepo(t);
  const mainTip = await commit(repo, "feat: history");
  await git(repo, "checkout", "-b", "candidate");
  await commit(repo, "not a conventional middle commit");
  await commit(repo, "feat: later valid commit");

  const result = await check(repo, {
    BASE_SHA: mainTip,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });

  assertRejectedByConventionalCommits(
    result,
    /not a conventional middle commit/,
  );
});

test("push of an existing branch lints only commits after the previous tip", async (t) => {
  const repo = await initRepo(t);
  await commit(repo, "not a conventional history commit");
  await git(repo, "checkout", "-b", "candidate");
  const previousTip = await commit(repo, "feat: already pushed");
  await commit(repo, "fix: newly pushed");

  const accepted = await check(repo, {
    BASE_SHA: previousTip,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });
  assert.equal(accepted.status, 0, accepted.output);

  await commit(repo, "still not conventional");
  const rejected = await check(repo, {
    BASE_SHA: previousTip,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });
  assertRejectedByConventionalCommits(rejected, /still not conventional/);
});

test("pull request range lints commits after the base tip", async (t) => {
  const repo = await initRepo(t);
  const baseTip = await commit(repo, "not a conventional base commit");
  await git(repo, "checkout", "-b", "candidate");
  await commit(repo, "feat: pr change");

  const accepted = await check(repo, {
    BASE_SHA: baseTip,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });
  assert.equal(accepted.status, 0, accepted.output);

  await commit(repo, "pr body without type");
  const rejected = await check(repo, {
    BASE_SHA: baseTip,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });
  assertRejectedByConventionalCommits(rejected, /pr body without type/);
});

test("manual run with empty before SHA uses the default branch as the range base", async (t) => {
  const repo = await initRepo(t);
  await commit(repo, "not a conventional history commit");
  await addOrigin(t, repo);
  await git(repo, "checkout", "-b", "candidate");
  await commit(repo, "feat: manual dispatch");

  const result = await check(repo, {
    BASE_SHA: "",
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });

  assert.equal(
    result.status,
    0,
    `workflow_dispatch must not re-lint default-branch history:\n${result.output}`,
  );
});

test("without an available base, an invalid head message is still rejected", async (t) => {
  const repo = await initRepo(t, { branch: "orphan" });
  await commit(repo, "feat: only history");
  await commit(repo, "head without a type");

  const result = await check(repo, {
    BASE_SHA: zeros,
    HEAD_SHA: await sha(repo),
    DEFAULT_BRANCH: "main",
  });

  assertRejectedByConventionalCommits(result, /head without a type/);
});

test("empty new range is accepted without treating from and to as one commit", async (t) => {
  const repo = await initRepo(t);
  const head = await commit(repo, "feat: already on default branch");

  const result = await check(repo, {
    BASE_SHA: head,
    HEAD_SHA: head,
    DEFAULT_BRANCH: "main",
  });

  assert.equal(result.status, 0, result.output);
});

async function initRepo(t, { branch = "main" } = {}) {
  const repo = await mkdtemp(path.join(tmpdir(), "sprut-commitlint-range-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, "init", "-b", branch);
  await git(repo, "config", "user.name", "commitlint-range-test");
  await git(repo, "config", "user.email", "commitlint-range@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

async function addOrigin(t, repo, branch = "main") {
  const originParent = await mkdtemp(
    path.join(tmpdir(), "sprut-commitlint-origin-"),
  );
  t.after(() => rm(originParent, { recursive: true, force: true }));
  const origin = path.join(originParent, "origin.git");
  await run("git", ["clone", "--bare", "--branch", branch, repo, origin]);
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "fetch", "origin");
}

async function commit(repo, message) {
  const stamp = `${Date.now()}-${Math.random()}`;
  await writeFile(path.join(repo, "change"), `${stamp}\n`);
  await git(repo, "add", "change");
  await git(repo, "commit", "-m", message);
  return sha(repo);
}

async function sha(repo, rev = "HEAD") {
  const { stdout } = await git(repo, "rev-parse", rev);
  return stdout.trim();
}

function git(repo, ...args) {
  return run("git", ["-C", repo, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function assertRejectedByConventionalCommits(result, message) {
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, message);
  // Empty-rules still echoes the input and exits 9; rule names prove the conventional config loaded.
  assert.match(
    result.output,
    /\[(?:type-empty|subject-empty|type-enum)\]/,
    `rejection must come from Conventional Commits rules:\n${result.output}`,
  );
}

async function check(repo, env) {
  try {
    const { stdout, stderr } = await run(process.execPath, [script], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...env,
      },
    });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const status = typeof error.status === "number" ? error.status : error.code;
    return {
      status,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}
