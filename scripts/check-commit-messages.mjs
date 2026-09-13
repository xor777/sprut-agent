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

if (headSha.length === 0) {
  process.stderr.write("HEAD_SHA is required\n");
  process.exit(1);
}

if (baseSha.length > 0 && !/^0+$/.test(baseSha)) {
  runCommitlint(["--from", baseSha, "--to", headSha]);
} else {
  const commits = git(["rev-list", headSha])
    .split("\n")
    .filter((commit) => commit.length > 0);
  for (const commit of commits) {
    runCommitlint([], { input: git(["show", "-s", "--format=%B", commit]) });
  }
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function runCommitlint(args, { input } = {}) {
  const result = spawnSync(
    "npm",
    [
      "exec",
      "--no",
      "--",
      "commitlint",
      "--config",
      configPath,
      ...(input === undefined ? ["--cwd", repo] : []),
      ...args,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      input,
      stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
