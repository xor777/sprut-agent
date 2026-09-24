// Runs household cases with an external agent CLI against the in-process
// SprutHub simulator and grades the result deterministically. A model run is
// not part of `npm run check`; see DEVELOPMENT.md.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "../test/support/simulated-hub.mjs";
import { CASES, gradeCase } from "./eval-agent-cases.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MCP_SERVER_NAME = "sprut-agent";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const USAGE = `Usage: npm run eval:agent -- <case[,case...]|all> [options]

Cases: ${Object.keys(CASES).join(", ")}

Options:
  --harness claude|codex   Agent CLI (default: claude)
  --model <name>           Model passed to the CLI (default: sonnet for claude)
  --plugin-dir <path>      Plugin build to test (default: dist/plugin)
  --evidence-dir <path>    Where results are written (default: new temp dir)
  --timeout <seconds>      Per-case limit (default: 600)
  --repeat <n>             Runs per case and fixture (default: 1)
  --fixture <names>        Comma-separated homes, e.g. apartment,house
                           (default: each case's own)
  --include-pending        With all, also run cases marked pending`;

export async function main(
  argv = process.argv.slice(2),
  { write = (text) => process.stdout.write(text) } = {},
) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      harness: { type: "string", default: "claude" },
      model: { type: "string" },
      "plugin-dir": { type: "string" },
      "evidence-dir": { type: "string" },
      timeout: { type: "string", default: "600" },
      repeat: { type: "string", default: "1" },
      fixture: { type: "string" },
      "include-pending": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [selected] = positionals;
  if (values.help || positionals.length !== 1) {
    write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const caseNames =
    selected === "all"
      ? Object.keys(CASES).filter(
          (name) => values["include-pending"] || !CASES[name].pending,
        )
      : selected.split(",");
  for (const name of caseNames) {
    if (!CASES[name]) throw new Error(`Unknown case ${name}\n${USAGE}`);
  }
  if (!HARNESSES[values.harness]) {
    throw new Error(`Unknown harness ${values.harness}`);
  }
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  const fixtures = values.fixture ? values.fixture.split(",") : [null];
  const pluginDir = path.resolve(
    values["plugin-dir"] ?? path.join(repo, "dist", "plugin"),
  );
  const plugin = await describePlugin(pluginDir);
  const evidenceRoot = await prepareEvidenceRoot(values["evidence-dir"]);
  const timeoutMs = Number(values.timeout) * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  const model =
    values.model ?? (values.harness === "claude" ? "sonnet" : undefined);
  const harnessVersion = cliVersion(values.harness);

  const outcomes = [];
  for (const name of caseNames) {
    const harnesses = CASES[name].harnesses;
    if (harnesses && !harnesses.includes(values.harness)) {
      write(`SKIP ${name}: needs ${harnesses.join(" or ")}\n`);
      continue;
    }
    for (const fixture of fixtures) {
      for (let attempt = 1; attempt <= repeat; attempt += 1) {
        const outcome = await runCase({
          caseName: name,
          fixture,
          harness: values.harness,
          harnessVersion,
          model,
          plugin,
          evidenceRoot,
          timeoutMs,
        });
        outcomes.push(outcome);
        write(`${summaryLine(outcome)}\n`);
      }
    }
  }
  const summary = summarizeRuns(outcomes, {
    harness: values.harness,
    harnessVersion,
    model,
    plugin,
  });
  await writeJson(path.join(evidenceRoot, "summary.json"), summary);
  for (const line of summaryTable(summary)) write(`${line}\n`);
  write(`evidence: ${evidenceRoot}\n`);
  return outcomes.every(({ pass }) => pass) ? 0 : 1;
}

export async function runCase({
  caseName,
  definition = CASES[caseName],
  fixture = null,
  harness,
  harnessVersion = null,
  model,
  plugin,
  evidenceRoot,
  timeoutMs,
}) {
  const fixtureName = fixture ?? definition.fixture ?? "apartment";
  if (definition.harnesses && !definition.harnesses.includes(harness)) {
    throw new Error(`${caseName} needs ${definition.harnesses.join(" or ")}`);
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-eval-run-"));
  // Credentials of this run only: nothing in the repository or an earlier
  // run lets another client pass as the MCP server.
  const runId = randomUUID();
  const hub = await startCaseHub(definition, fixtureName, {
    token: `eval-token-${runId}`,
    cid: `eval-mcp-${runId}`,
  });
  const startedAt = new Date().toISOString();
  try {
    const run = await HARNESSES[harness]({
      prompt: definition.prompt,
      followUps: definition.followUps ?? [],
      model,
      plugin,
      hub,
      scratch,
      timeoutMs,
    });
    const transcript = PARSERS[harness](run.stdout);
    if (typeof run.answer === "string" && run.answer.length > 0) {
      transcript.answer = run.answer;
    }
    transcript.model ??= run.session?.model ?? null;
    hub.settle();
    const evidence = collectEvidence(hub, transcript.answer);
    const graders = [
      {
        name: "run_completed",
        pass:
          run.exitCode === 0 &&
          !run.timedOut &&
          transcript.answer != null &&
          transcript.harnessError == null,
        detail: transcript.harnessError
          ? `harness error: ${transcript.harnessError}`
          : `exit=${run.exitCode} timed_out=${run.timedOut}`,
      },
      ...integrityGraders(evidence, {
        toolCalls: transcript.toolCalls,
        allowedRoots: await withRealPaths([plugin.dir]),
        forbiddenRoots: await withRealPaths([repo, evidenceRoot]),
      }),
      ...gradeCase(definition, evidence),
    ];
    const outcome = {
      case: caseName,
      fixture: fixtureName,
      prompt: definition.prompt,
      follow_ups: definition.followUps ?? [],
      harness,
      harness_version: harnessVersion,
      harness_session: run.session ?? transcript.session ?? null,
      model: { requested: model ?? null, reported: transcript.model ?? null },
      plugin,
      started_at: startedAt,
      pass: graders.every(({ pass }) => pass),
      failure_class: failureClass(graders),
      graders,
      metrics: {
        wall_seconds: Math.round(run.wallMs / 100) / 10,
        tool_calls: transcript.toolCalls.length,
        mcp_tool_calls: transcript.toolCalls.filter(({ mcp }) => mcp).length,
        tool_result_bytes: sum(transcript.toolCalls, "resultBytes"),
        mcp_tool_result_bytes: sum(
          transcript.toolCalls.filter(({ mcp }) => mcp),
          "resultBytes",
        ),
        tokens: transcript.usage,
        cost_usd: transcript.costUsd ?? null,
        turns: transcript.turns ?? null,
        hub_requests: hub.requests.length,
        hub_writes: hub.requests.filter(({ write }) => write).length,
      },
      answer: evidence.answer,
      tool_calls: transcript.toolCalls.map(
        ({ name, input, resultBytes, isError }) => ({
          name,
          input,
          result_bytes: resultBytes,
          is_error: isError,
        }),
      ),
      simulator_methods: hub.touchedMethods(),
      faults: definition.faults ?? null,
      fault_events: hub.faultEvents(),
      home_changes: evidence.diff,
      hub_writes: hub.requests
        .filter(({ write }) => write)
        .map(({ method, params, error }) => ({ method, params, error })),
      exit_code: run.exitCode,
      timed_out: run.timedOut,
      harness_setup: transcript.setup ?? null,
    };
    const runDir = path.join(
      evidenceRoot,
      `${startedAt.replaceAll(":", "-").replaceAll(".", "-")}-${caseName}-${fixtureName}-${harness}`,
    );
    await mkdir(runDir, { recursive: true });
    await writeJson(path.join(runDir, "result.json"), outcome);
    await writeFile(path.join(runDir, "transcript.jsonl"), run.stdout, {
      mode: 0o600,
    });
    await writeFile(path.join(runDir, "stderr.txt"), run.stderr, {
      mode: 0o600,
    });
    await writeJson(path.join(runDir, "hub-requests.json"), hub.requests);
    await writeJson(
      path.join(runDir, "hub-final-state.json"),
      hub.exportState(),
    );
    return { ...outcome, run_dir: runDir };
  } finally {
    await hub.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

// The simulated hub of a case: its fixture, patched by the case (for example
// a light that must start on), with the case's faults.
export async function startCaseHub(definition, fixtureName, options = {}) {
  const fixture = structuredClone(await loadHomeFixture(fixtureName));
  return startSimulatedHub(
    definition.patch ? definition.patch(fixture) : fixture,
    { faults: definition.faults, ...options },
  );
}

// The graders' view of one run: requests the simulator received, the home
// diff and the final answer.
export function collectEvidence(hub, answer) {
  const before = hub.initialSnapshot();
  const after = hub.snapshot();
  return {
    answer: answer ?? "",
    requests: hub.requests,
    connections: hub.connections(),
    expectedCid: hub.cid,
    before,
    after,
    diff: diffHomeSnapshots(before, after),
    initialState: hub.initialState,
    finalState: hub.state,
  };
}

// Checks of the run itself rather than the household result:
// - no_simulator_gap: a method the simulator does not implement (-32601)
//   means the run exercised behavior the simulator cannot judge;
// - single_mcp_connection: only the MCP server may talk to the hub. It has
//   this run's client id and one connection at a time (a restarted server
//   reconnects after its old socket closed); any other client id, a rejected
//   token or two connections in use at once means something else reached
//   the hub;
// - agent_stayed_in_bounds (with the transcript): the agent's own tools did
//   not name a path in the repository outside the plugin, in the evidence
//   directory, or an auth.json.
export function integrityGraders(evidence, run = null) {
  const gaps = [
    ...new Set(
      evidence.requests
        .filter(({ error }) => error?.code === -32601)
        .map(({ method }) => method ?? "invalid request"),
    ),
  ];
  const graders = [
    {
      name: "no_simulator_gap",
      pass: gaps.length === 0,
      detail:
        gaps.length === 0
          ? "every native method was simulated"
          : `simulator_gap: ${gaps.join(", ")}`,
    },
    singleConnection(evidence),
  ];
  if (run) graders.push(stayedInBounds(run));
  return graders;
}

function singleConnection({ requests, connections, expectedCid }) {
  const foreign = [
    ...new Set(
      requests
        .filter(({ cid, error }) => cid !== expectedCid || error?.code === 401)
        .map(({ cid, error }) =>
          error?.code === 401 ? "rejected token" : `cid ${cid}`,
        ),
    ),
  ];
  const used = connections.filter(
    ({ first_request_at: first }) => first !== null,
  );
  const concurrent = used.filter((connection) =>
    used.some(
      (other) =>
        other.id < connection.id &&
        (other.closed_at === null ||
          other.closed_at > connection.first_request_at),
    ),
  );
  const problems = [
    ...foreign,
    ...concurrent.map(({ id }) => `concurrent connection ${id}`),
  ];
  return {
    name: "single_mcp_connection",
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${used.length} sequential MCP connection(s)`
        : problems.join(", "),
  };
}

function stayedInBounds({ toolCalls, allowedRoots, forbiddenRoots }) {
  const within = (file, root) => file === root || file.startsWith(`${root}/`);
  const violations = [];
  for (const call of toolCalls.filter(({ mcp }) => !mcp)) {
    const text = JSON.stringify(call.input ?? "");
    for (const [file] of text.matchAll(/\/[^\s"'`<>|;&()\\]+/g)) {
      const forbidden =
        /(?:^|\/)auth\.json$/.test(file) ||
        (forbiddenRoots.some((root) => within(file, root)) &&
          !allowedRoots.some((root) => within(file, root)));
      if (forbidden) violations.push(`${call.name}: ${file}`);
    }
  }
  return {
    name: "agent_stayed_in_bounds",
    pass: violations.length === 0,
    detail:
      violations.length === 0
        ? "no path outside the plugin and workspace"
        : violations.slice(0, 5).join("; "),
  };
}

// The first failed grader family names why a run failed; agent means the
// household graders.
function failureClass(graders) {
  const failed = new Set(
    graders.filter(({ pass }) => !pass).map(({ name }) => name),
  );
  if (failed.size === 0) return null;
  if (failed.has("run_completed")) return "harness";
  if (
    failed.has("single_mcp_connection") ||
    failed.has("agent_stayed_in_bounds")
  ) {
    return "isolation";
  }
  if (failed.has("no_simulator_gap")) return "simulator_gap";
  return "agent";
}

// MCP calls and MCP result bytes are the cross-harness measure: the harness's
// own tools (Read, Skill, shell) differ between Claude Code and Codex.
export function summaryLine(outcome) {
  const tokens = outcome.metrics.tokens;
  const graderText = outcome.graders
    .map(({ name, pass }) => `${pass ? "+" : "-"}${name}`)
    .join(" ");
  return [
    outcome.pass ? "PASS" : `FAIL(${outcome.failure_class})`,
    `${outcome.case}@${outcome.fixture}`,
    `${outcome.harness}/${outcome.model.reported ?? outcome.model.requested ?? "default"}`,
    `mcp=${outcome.metrics.mcp_tool_calls}/${outcome.metrics.mcp_tool_result_bytes}B`,
    `tools=${outcome.metrics.tool_calls}`,
    `tokens_in=${tokens?.total_input ?? "?"} out=${tokens?.output ?? "?"}`,
    `${outcome.metrics.wall_seconds}s`,
    `plugin=${outcome.plugin.server_sha256?.slice(0, 12) ?? "?"}`,
    graderText,
    outcome.run_dir ?? "",
  ].join(" ");
}

// Per case and fixture: passes, failure classes and medians; per case run on
// both fixtures: the house/apartment ratio of the medians.
export function summarizeRuns(
  outcomes,
  { harness, harnessVersion, model, plugin },
) {
  const groups = new Map();
  for (const outcome of outcomes) {
    const key = `${outcome.case}@${outcome.fixture}`;
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  const cases = [...groups.values()].map((runs) => {
    const failureClasses = {};
    for (const { failure_class: failure } of runs) {
      if (failure) failureClasses[failure] = (failureClasses[failure] ?? 0) + 1;
    }
    return {
      case: runs[0].case,
      fixture: runs[0].fixture,
      runs: runs.length,
      passes: runs.filter(({ pass }) => pass).length,
      failure_classes: failureClasses,
      median_mcp_calls: median(
        runs.map(({ metrics }) => metrics.mcp_tool_calls),
      ),
      median_mcp_result_bytes: median(
        runs.map(({ metrics }) => metrics.mcp_tool_result_bytes),
      ),
      median_tokens: median(
        runs.map(({ metrics }) =>
          metrics.tokens
            ? metrics.tokens.total_input + metrics.tokens.output
            : null,
        ),
      ),
      median_wall_seconds: median(
        runs.map(({ metrics }) => metrics.wall_seconds),
      ),
      run_dirs: runs.map(({ run_dir: dir }) => dir ?? null),
    };
  });
  const ratio = (large, small) =>
    typeof large === "number" && typeof small === "number" && small > 0
      ? Math.round((large / small) * 100) / 100
      : null;
  const scale = [];
  for (const entry of cases.filter(({ fixture }) => fixture === "house")) {
    const small = cases.find(
      (candidate) =>
        candidate.case === entry.case && candidate.fixture === "apartment",
    );
    if (!small) continue;
    scale.push({
      case: entry.case,
      mcp_calls_ratio: ratio(entry.median_mcp_calls, small.median_mcp_calls),
      mcp_result_bytes_ratio: ratio(
        entry.median_mcp_result_bytes,
        small.median_mcp_result_bytes,
      ),
      tokens_ratio: ratio(entry.median_tokens, small.median_tokens),
    });
  }
  return {
    harness,
    harness_version: harnessVersion,
    model: {
      requested: model ?? null,
      reported: [
        ...new Set(outcomes.map((outcome) => outcome.model.reported)),
      ].filter((value) => value !== null),
    },
    plugin,
    cases,
    scale,
  };
}

function summaryTable(summary) {
  return [
    ...summary.cases.map(
      (entry) =>
        `SUMMARY ${entry.case}@${entry.fixture} ${entry.passes}/${entry.runs} mcp_calls=${entry.median_mcp_calls} mcp_bytes=${entry.median_mcp_result_bytes} tokens=${entry.median_tokens}${
          Object.keys(entry.failure_classes).length > 0
            ? ` failures=${JSON.stringify(entry.failure_classes)}`
            : ""
        }`,
    ),
    ...summary.scale.map(
      (entry) =>
        `SCALE ${entry.case} house/apartment mcp_calls=${entry.mcp_calls_ratio} mcp_bytes=${entry.mcp_result_bytes_ratio} tokens=${entry.tokens_ratio}`,
    ),
  ];
}

function median(values) {
  const numbers = values
    .filter((value) => typeof value === "number")
    .sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function cliVersion(harness) {
  const command =
    harness === "claude"
      ? (process.env.SPRUT_EVAL_CLAUDE_BIN ?? "claude")
      : (process.env.SPRUT_EVAL_CODEX_BIN ?? "codex");
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      env: isolatedEnvironment({}),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// --- Harnesses -------------------------------------------------------------

const HARNESSES = { claude: runClaude, codex: runCodex };
const PARSERS = { claude: parseClaudeStream, codex: parseCodexStream };

function hubConnection(hub) {
  return { ...hub.connectionEnv(), SPRUTHUB_TIMEOUT_MS: "5000" };
}

// Variables a Claude Code session exports to its own tools. A nested agent
// CLI that inherits them behaves as that session's child (host auth refresh,
// entrypoint, messaging socket) instead of as the owner's own CLI.
const HOST_SESSION_VARIABLES = [
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_/,
  /^CLAUDE_AGENT_SDK_VERSION$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_PREVIEW_/,
  /^USE_(?:LOCAL|STAGING)_OAUTH$/,
];

// The agent's environment never carries real SprutHub settings: explicit
// simulator variables win over the credential file, and XDG_CONFIG_HOME points
// to an empty scratch directory in case a server looks for connection.env.
function isolatedEnvironment(overrides) {
  const env = { ...process.env };
  const nested = Object.hasOwn(env, "CLAUDECODE");
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("SPRUTHUB_") ||
      key.startsWith("SPRUT_AGENT_") ||
      (nested && HOST_SESSION_VARIABLES.some((pattern) => pattern.test(key)))
    ) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

async function runClaude({
  prompt,
  followUps = [],
  model,
  plugin,
  hub,
  scratch,
  timeoutMs,
}) {
  const workspace = path.join(scratch, "workspace");
  const configHome = path.join(scratch, "config");
  const stateDir = path.join(scratch, "state");
  await Promise.all(
    [workspace, configHome, stateDir].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const mcpConfig = path.join(scratch, "mcp.json");
  // --strict-mcp-config drops plugin-declared servers, so the plugin's own
  // server is named explicitly; --plugin-dir still provides the skill.
  await writeJson(mcpConfig, {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [path.join(plugin.dir, "dist", "server.mjs")],
        env: {
          ...hubConnection(hub),
          SPRUT_AGENT_STATE_DIR: stateDir,
          XDG_CONFIG_HOME: configHome,
        },
      },
    },
  });
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(model ? ["--model", model] : []),
    "--plugin-dir",
    plugin.dir,
    "--add-dir",
    plugin.dir,
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--setting-sources",
    "",
    "--tools",
    "Read,Skill",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "Skill",
  ];
  const command = process.env.SPRUT_EVAL_CLAUDE_BIN ?? "claude";
  const env = isolatedEnvironment({ XDG_CONFIG_HOME: configHome });
  if (followUps.length === 0) {
    return runProcess({
      command,
      args: [...args, "--no-session-persistence"],
      stdin: prompt,
      cwd: workspace,
      env,
      timeoutMs,
    });
  }
  // Follow-up turns resume one session by id; the session transcript Claude
  // Code keeps is removed afterwards.
  const sessionId = randomUUID();
  const started = Date.now();
  const combined = {
    exitCode: 0,
    timedOut: false,
    stdout: "",
    stderr: "",
    wallMs: 0,
  };
  try {
    for (const [index, text] of [prompt, ...followUps].entries()) {
      const turn = await runProcess({
        command,
        args: [
          ...args,
          ...(index === 0
            ? ["--session-id", sessionId]
            : ["--resume", sessionId]),
        ],
        stdin: text,
        cwd: workspace,
        env,
        timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - started)),
      });
      combined.stdout += turn.stdout;
      combined.stderr += turn.stderr;
      combined.exitCode = turn.exitCode;
      combined.timedOut = turn.timedOut;
      if (turn.exitCode !== 0 || turn.timedOut) break;
    }
  } finally {
    combined.wallMs = Date.now() - started;
    await removeClaudeSession(sessionId);
  }
  return combined;
}

// Deletes only the files named by this run's session id.
async function removeClaudeSession(sessionId) {
  const projects = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
    "projects",
  );
  for (const project of await readdir(projects).catch(() => [])) {
    const directory = path.join(projects, project);
    const transcript = path.join(directory, `${sessionId}.jsonl`);
    const exists = await stat(transcript).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    await rm(transcript, { force: true });
    await rm(path.join(directory, sessionId), {
      recursive: true,
      force: true,
    });
    // The project directory of the scratch workspace held only this run.
    if ((await readdir(directory)).length === 0) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function runCodex({
  prompt,
  followUps = [],
  model,
  plugin,
  hub,
  scratch,
  timeoutMs,
}) {
  if (followUps.length > 0) {
    throw new Error("The codex harness does not run follow-up turns");
  }
  const codex = process.env.SPRUT_EVAL_CODEX_BIN ?? "codex";
  const workspace = path.join(scratch, "workspace");
  const home = path.join(scratch, "home");
  const codexHome = path.join(scratch, "codex-home");
  const marketplace = path.join(scratch, "marketplace");
  const answerPath = path.join(scratch, "answer.txt");
  await Promise.all(
    [workspace, home, codexHome].map((dir) => mkdir(dir, { recursive: true })),
  );
  await symlink(
    process.env.SPRUT_EVAL_CODEX_AUTH ??
      path.join(
        process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
        "auth.json",
      ),
    path.join(codexHome, "auth.json"),
  );
  // A one-plugin marketplace lets any --plugin-dir build install through the
  // same Codex plugin path an owner uses.
  await cp(plugin.dir, path.join(marketplace, "plugin"), { recursive: true });
  await writeJson(
    path.join(marketplace, ".agents", "plugins", "marketplace.json"),
    {
      name: "sprut-agent",
      interface: { displayName: "sprut-agent" },
      plugins: [
        {
          name: "sprut-agent",
          source: { source: "local", path: "./plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    },
  );
  const connectionDir = path.join(home, ".config", "sprut-agent");
  await mkdir(connectionDir, { recursive: true });
  await writeFile(
    path.join(connectionDir, "connection.env"),
    `${Object.entries(hubConnection(hub))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  await chmod(path.join(connectionDir, "connection.env"), 0o600);
  const env = isolatedEnvironment({
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
  execFileSync(codex, ["plugin", "marketplace", "add", marketplace, "--json"], {
    env,
    encoding: "utf8",
  });
  execFileSync(codex, ["plugin", "add", "sprut-agent@sprut-agent", "--json"], {
    env,
    encoding: "utf8",
  });
  const config = {
    ...(model ? { model } : {}),
    "features.plugins": true,
    "features.apps": false,
    "features.memories": false,
    "features.multi_agent": false,
    "features.tool_suggest": false,
    project_doc_max_bytes: 0,
    web_search: "disabled",
    default_permissions: "sprut_eval",
  };
  // The agent's shell commands read only system paths, the workspace
  // (writable) and the installed plugin: not the repository, the evidence,
  // HOME with connection.env or CODEX_HOME with auth.json. Checked offline
  // with `codex sandbox` on codex-cli 0.154.0; MCP servers run outside it.
  const readable = {
    ":minimal": "read",
    ":workspace_roots": "write",
    ...Object.fromEntries(
      (await withRealPaths([path.join(codexHome, "plugins"), marketplace])).map(
        (root) => [root, "read"],
      ),
    ),
  };
  const permissions = `{${Object.entries(readable)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
    .join(", ")}}`;
  // No --ephemeral: the rollout under CODEX_HOME/sessions names the model and
  // settings Codex actually used; the scratch CODEX_HOME is deleted after.
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--strict-config",
    "--approve-for-me",
    "--json",
    ...Object.entries(config).flatMap(([key, value]) => [
      "-c",
      `${key}=${JSON.stringify(value)}`,
    ]),
    "-c",
    `permissions.sprut_eval.filesystem=${permissions}`,
    "--output-last-message",
    answerPath,
    "-",
  ];
  const run = await runProcess({
    command: codex,
    args,
    stdin: prompt,
    cwd: workspace,
    env,
    timeoutMs,
  });
  run.answer = await readFile(answerPath, "utf8").catch(() => null);
  run.session = await readCodexSession(codexHome);
  return run;
}

// What a Codex rollout (session_meta, turn_context) says about the run.
export async function readCodexSession(codexHome) {
  const files = (
    await readdir(path.join(codexHome, "sessions"), {
      recursive: true,
    }).catch(() => [])
  ).filter((file) => /rollout-.*\.jsonl$/.test(file));
  if (files.length === 0) return null;
  const session = {};
  for (const file of files.sort()) {
    const text = await readFile(path.join(codexHome, "sessions", file), "utf8");
    for (const event of jsonLines(text)) {
      const payload = event.payload ?? {};
      if (event.type === "session_meta") {
        session.cli_version ??= payload.cli_version ?? null;
        session.model_provider ??= payload.model_provider ?? null;
      }
      if (event.type === "turn_context") {
        session.model ??= payload.model ?? null;
        session.approval_policy ??= payload.approval_policy ?? null;
        session.sandbox_policy ??= payload.sandbox_policy?.type ?? null;
        session.permission_profile ??= payload.permission_profile?.type ?? null;
      }
    }
  }
  return {
    cli_version: session.cli_version ?? null,
    model: session.model ?? null,
    model_provider: session.model_provider ?? null,
    approval_policy: session.approval_policy ?? null,
    sandbox_policy: session.sandbox_policy ?? null,
    permission_profile: session.permission_profile ?? null,
  };
}

function runProcess({ command, args, stdin, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        wallMs: Date.now() - started,
      });
    });
    child.stdin.end(stdin);
  });
}

// --- Transcripts -----------------------------------------------------------

function jsonLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function contentBytes(content) {
  if (content == null) return 0;
  if (typeof content === "string") return Buffer.byteLength(content);
  if (Array.isArray(content)) {
    return content.reduce(
      (total, part) =>
        total +
        (typeof part?.text === "string"
          ? Buffer.byteLength(part.text)
          : Buffer.byteLength(JSON.stringify(part))),
      0,
    );
  }
  return Buffer.byteLength(JSON.stringify(content));
}

// Claude Code `-p --output-format stream-json --verbose`: tool_use blocks in
// assistant messages, tool_result blocks in the following user messages and a
// final `result` event with the answer, usage and cost.
export function parseClaudeStream(text) {
  const toolCalls = [];
  const byId = new Map();
  let answer = null;
  let usage = null;
  let costUsd = null;
  let turns = null;
  let model = null;
  let harnessError = null;
  let setup = null;
  let session = null;
  for (const event of jsonLines(text)) {
    if (event.type === "system" && event.subtype === "init") {
      model = event.model ?? model;
      session = {
        cli_version: event.claude_code_version ?? null,
        model: event.model ?? null,
        permission_mode: event.permissionMode ?? null,
      };
      setup = {
        mcp_servers: event.mcp_servers ?? [],
        tools: event.tools ?? [],
        skills: event.skills ?? [],
      };
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        const call = {
          name: block.name,
          mcp: block.name.startsWith(MCP_TOOL_PREFIX),
          input: block.input,
          resultBytes: 0,
          isError: null,
        };
        toolCalls.push(call);
        byId.set(block.id, call);
      }
    }
    if (event.type === "user") {
      const content = event.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== "tool_result") continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        call.resultBytes += contentBytes(block.content);
        call.isError = block.is_error === true;
      }
    }
    if (event.type === "result") {
      if (event.is_error === true) {
        harnessError = String(event.result ?? event.subtype ?? "error");
      } else {
        answer = typeof event.result === "string" ? event.result : answer;
      }
      if (typeof event.total_cost_usd === "number") {
        costUsd = (costUsd ?? 0) + event.total_cost_usd;
      }
      if (typeof event.num_turns === "number") {
        turns = (turns ?? 0) + event.num_turns;
      }
      if (event.usage) {
        const input = event.usage.input_tokens ?? 0;
        const cacheRead = event.usage.cache_read_input_tokens ?? 0;
        const cacheCreation = event.usage.cache_creation_input_tokens ?? 0;
        const previous = usage ?? {
          input: 0,
          cache_read: 0,
          cache_creation: 0,
          total_input: 0,
          output: 0,
        };
        usage = {
          input: previous.input + input,
          cache_read: previous.cache_read + cacheRead,
          cache_creation: previous.cache_creation + cacheCreation,
          total_input: previous.total_input + input + cacheRead + cacheCreation,
          output: previous.output + (event.usage.output_tokens ?? 0),
        };
      }
    }
  }
  // Init may still say "pending"; a completed MCP call proves the connection.
  if (
    setup &&
    !setup.mcp_servers.some(
      ({ name, status }) => name === MCP_SERVER_NAME && status === "connected",
    ) &&
    !toolCalls.some(({ mcp, isError }) => mcp && isError === false)
  ) {
    harnessError ??= `MCP server ${MCP_SERVER_NAME} was not connected`;
  }
  return {
    toolCalls,
    answer,
    usage,
    costUsd,
    turns,
    model,
    harnessError,
    setup,
    session,
  };
}

// Codex `exec --json`: completed items for MCP calls, shell commands and agent
// messages; turn.completed carries usage.
export function parseCodexStream(text) {
  const toolCalls = [];
  let answer = null;
  let usage = null;
  let harnessError = null;
  for (const event of jsonLines(text)) {
    const item = event.item;
    if (event.type === "error" || event.type === "turn.failed") {
      harnessError = String(
        event.message ?? event.error?.message ?? event.type,
      );
    }
    if (event.type === "item.completed" && item?.type === "mcp_tool_call") {
      toolCalls.push({
        name: `${MCP_TOOL_PREFIX}${item.tool}`,
        mcp: item.server === MCP_SERVER_NAME,
        input: item.arguments,
        resultBytes: contentBytes(item.result?.content ?? item.error ?? null),
        isError: item.status !== "completed" || Boolean(item.error),
      });
    }
    if (event.type === "item.completed" && item?.type === "command_execution") {
      toolCalls.push({
        name: "shell",
        mcp: false,
        input: item.command,
        resultBytes: contentBytes(item.aggregated_output ?? null),
        isError: item.exit_code !== 0,
      });
    }
    if (event.type === "item.completed" && item?.type === "agent_message") {
      answer = item.text ?? answer;
    }
    if (event.type === "turn.completed" && event.usage) {
      const input = event.usage.input_tokens ?? 0;
      usage = {
        input,
        cache_read: event.usage.cached_input_tokens ?? 0,
        cache_creation: 0,
        // Codex reports cached tokens as part of input_tokens.
        total_input: input,
        output: event.usage.output_tokens ?? 0,
      };
    }
  }
  return {
    toolCalls,
    answer,
    usage,
    costUsd: null,
    turns: null,
    model: null,
    harnessError,
    setup: null,
  };
}

// --- Evidence --------------------------------------------------------------

async function describePlugin(dir) {
  const server = path.join(dir, "dist", "server.mjs");
  const skill = path.join(dir, "skills", "spruthub-master", "SKILL.md");
  await stat(server);
  const git = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const manifest = JSON.parse(
    await readFile(
      path.join(dir, ".claude-plugin", "plugin.json"),
      "utf8",
    ).catch(() => "{}"),
  );
  return {
    dir,
    version: manifest.version ?? null,
    git_sha: git(["rev-parse", "HEAD"]),
    dirty: (git(["status", "--porcelain", "--", "."]) ?? "").length > 0,
    server_sha256: await sha256File(server),
    skill_sha256: await sha256File(skill).catch(() => null),
  };
}

async function prepareEvidenceRoot(requested) {
  const root = requested
    ? path.resolve(requested)
    : process.env.SPRUT_EVAL_OUTPUT
      ? path.resolve(process.env.SPRUT_EVAL_OUTPUT)
      : await mkdtemp(path.join(tmpdir(), "sprut-agent-eval-"));
  const relative = path.relative(repo, root);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error(
      "The evidence directory must be outside the repository: transcripts are not committed.",
    );
  }
  await mkdir(root, { recursive: true });
  return root;
}

// Each path and, when it exists, its real path (macOS temp dirs live under
// /private/var while tmpdir() reports /var).
async function withRealPaths(paths) {
  const all = new Set();
  for (const item of paths) {
    all.add(path.resolve(item));
    try {
      all.add(await realpath(item));
    } catch {}
  }
  return [...all];
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sum(items, key) {
  return items.reduce((total, item) => total + (item[key] ?? 0), 0);
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
