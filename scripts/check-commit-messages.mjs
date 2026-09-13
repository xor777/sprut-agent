import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const configPath = path.join(projectRoot, "commitlint.config.js");
const repo = process.cwd();
const baseSha = process.env.BASE_SHA ?? "";
const headSha = process.env.HEAD_SHA ?? "";
const defaultBranch = process.env.DEFAULT_BRANCH || "main";

if (headSha.length === 0) {
  process.stderr.write("HEAD_SHA is required\n");
  process.exit(1);
}

const head = git(["rev-parse", `${headSha}^{commit}`]);
const fromSha = resolveRangeBase(head, baseSha, defaultBranch);
process.exit(fromSha === null ? lintAll(head) : lintRange(fromSha, head));

function resolveRangeBase(head, requestedBase, branch) {
  if (isUsableBase(requestedBase, head)) {
    return git(["rev-parse", `${requestedBase}^{commit}`]);
  }
  // GitHub sends 40 zeros as `before` on the first push of a ref.
  for (const candidate of [`origin/${branch}`, branch]) {
    if (!isCommit(candidate)) continue;
    const mergeBase = gitMergeBase(candidate, head);
    if (mergeBase !== null) return mergeBase;
  }
  return null;
}

function isUsableBase(sha, head) {
  return isCommit(sha) && gitMergeBase(sha, head) !== null;
}

function isCommit(rev) {
  if (rev.length === 0 || /^0+$/.test(rev)) return false;
  return spawnGit(["cat-file", "-e", `${rev}^{commit}`]).status === 0;
}

function gitMergeBase(a, b) {
  const result = spawnGit(["merge-base", a, b]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function lintRange(fromSha, head) {
  if (fromSha === head) {
    process.stdout.write(`No new commits in ${fromSha}..${head}\n`);
    return 0;
  }
  const count = git(["rev-list", "--count", `${fromSha}..${head}`]);
  process.stdout.write(`Linting ${count} commit(s) in ${fromSha}..${head}\n`);
  return runCommitlint(["--from", fromSha, "--to", head]);
}

function lintAll(head) {
  process.stderr.write(
    `No usable commit range base; linting all commits reachable from ${head}\n`,
  );
  return runCommitlint(["--to", head]);
}

function git(args) {
  const result = spawnGit(args);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function spawnGit(args) {
  return spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
  });
}

function runCommitlint(args) {
  const result = spawnSync(
    "npm",
    [
      "exec",
      "--no",
      "--",
      "commitlint",
      "--config",
      configPath,
      "--cwd",
      repo,
      ...args,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  return result.status ?? 1;
}
