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
const headSha = process.env.HEAD_SHA ?? "";
const defaultBranch = process.env.DEFAULT_BRANCH || "main";

if (headSha.length === 0) {
  process.stderr.write("HEAD_SHA is required\n");
  process.exit(1);
}

const head = git(["rev-parse", `${headSha}^{commit}`]);
// GitHub sends 40 zeros as `before` on the first push of a ref; merge-base then fails.
const from = [process.env.BASE_SHA ?? "", `origin/${defaultBranch}`]
  .filter((rev) => rev.length > 0 && !/^0+$/.test(rev))
  .map((rev) => spawnGit(["merge-base", rev, head]))
  .find((result) => result.status === 0)
  ?.stdout.trim();

if (from === head) {
  process.stdout.write(`No new commits in ${from}..${head}\n`);
  process.exit(0);
}

if (from === undefined) {
  process.stderr.write(
    `No usable commit range base; linting all commits reachable from ${head}\n`,
  );
} else {
  const count = git(["rev-list", "--count", `${from}..${head}`]);
  process.stdout.write(`Linting ${count} commit(s) in ${from}..${head}\n`);
}

process.exit(
  runCommitlint(
    from === undefined ? ["--to", head] : ["--from", from, "--to", head],
  ),
);

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
