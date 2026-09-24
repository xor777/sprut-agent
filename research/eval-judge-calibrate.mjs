// Runs the answer judge on the labelled answers of
// research/eval-judge-labels.mjs and prints how often it agrees, per case,
// with every disagreement. Each label is judged against its case's rubric
// on its home as the simulator starts it (nothing done during the run).
// It calls a model for every label, so it is not part of `npm test`; see
// DEVELOPMENT.md.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { collectEvidence, judgeCase, startCaseHub } from "./eval-agent.mjs";
import { CASES } from "./eval-agent-cases.mjs";
import { DEFAULT_JUDGE_MODEL } from "./eval-judge.mjs";
import { LABELS } from "./eval-judge-labels.mjs";

const USAGE = `Usage: npm run eval:judge-calibrate -- [options]

Options:
  --model <id>          Judge model id (default: ${DEFAULT_JUDGE_MODEL})
  --case <names>        Only these cases, comma-separated
  --ids <ids>           Only these labels, e.g. why-night-light/no-time,whats-on/desk-lamp-off
  --concurrency <n>     Judge calls at once (default: 4)
  --out <file>          Also write every judgement as JSON`;

export async function main(
  argv = process.argv.slice(2),
  { write = (text) => process.stdout.write(text) } = {},
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string", default: DEFAULT_JUDGE_MODEL },
      case: { type: "string" },
      ids: { type: "string" },
      concurrency: { type: "string", default: "4" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    write(`${USAGE}\n`);
    return 0;
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  const cases = values.case?.split(",") ?? null;
  const ids = values.ids?.split(",") ?? null;
  // Ids are written in the labels, so commits and notes can cite them
  // while labels are added; each names one label.
  const all = Object.entries(LABELS).flatMap(([caseName, labels]) =>
    labels.map((label) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label.id ?? "")) {
        throw new Error(`A ${caseName} label has no id or a malformed one`);
      }
      return {
        ...label,
        id: `${caseName}/${label.id}`,
        caseName,
        fixture: label.fixture ?? "apartment",
      };
    }),
  );
  const known = new Set(all.map(({ id }) => id));
  if (known.size !== all.length) throw new Error("Two labels share an id");
  const unknown = ids?.filter((id) => !known.has(id)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`No label has the id ${unknown.join(", ")}`);
  }
  const items = all.filter(
    ({ id, caseName }) =>
      (!cases || cases.includes(caseName)) && (!ids || ids.includes(id)),
  );
  for (const { caseName } of items) {
    if (!CASES[caseName]?.judge) {
      throw new Error(`Labels name ${caseName}, which has no judged answer`);
    }
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "sprut-judge-calibrate-"));
  const hubs = new Map();
  let judged;
  try {
    for (const { caseName, fixture } of items) {
      const key = `${caseName}@${fixture}`;
      if (!hubs.has(key)) {
        hubs.set(key, await startCaseHub(CASES[caseName], fixture));
      }
    }
    judged = await mapLimit(items, concurrency, async (item) => {
      const hub = hubs.get(`${item.caseName}@${item.fixture}`);
      const { graders, metrics } = await judgeCase(
        CASES[item.caseName],
        collectEvidence(hub, item.answer),
        {
          model: values.model,
          cwd: await mkdtemp(path.join(scratch, "judge-")),
        },
      );
      const judge = graders[0]?.judge ?? null;
      return {
        ...item,
        verdict: judge?.verdict ?? null,
        quote: judge?.quote ?? null,
        reason: judge?.reason ?? null,
        error: judge
          ? judge.error
          : (graders[0]?.detail ?? "the case gave no rubric for this home"),
        metrics,
      };
    });
  } finally {
    await Promise.all([...hubs.values()].map((hub) => hub.close()));
    await rm(scratch, { recursive: true, force: true });
  }

  const count = (list) => {
    const agree = list.filter(({ verdict, label }) => verdict === label);
    return `${agree.length}/${list.length}`;
  };
  const byCase = new Map();
  for (const item of judged) {
    byCase.set(item.caseName, [...(byCase.get(item.caseName) ?? []), item]);
  }
  for (const [caseName, list] of byCase) {
    write(
      `CASE ${caseName} agree ${count(list.filter(({ ambiguous }) => !ambiguous))} ambiguous ${count(list.filter(({ ambiguous }) => ambiguous))} judge_errors ${list.filter(({ error }) => error).length}\n`,
    );
  }
  const oneLine = (text) =>
    String(text ?? "")
      .replaceAll("\n", " ⏎ ")
      .slice(0, 400);
  for (const item of judged.filter(({ verdict, label }) => verdict !== label)) {
    write(
      `DISAGREE ${item.id} label=${item.label} judge=${item.error ? "judge_error" : item.verdict}${item.ambiguous ? " (ambiguous)" : ""} [${item.source}] ${item.why}\n`,
    );
    write(`  answer: ${oneLine(item.answer)}\n`);
    if (item.error) write(`  error: ${oneLine(item.error)}\n`);
    if (item.quote) write(`  quote: ${oneLine(item.quote)}\n`);
    if (item.reason) write(`  reason: ${oneLine(item.reason)}\n`);
  }
  const sure = judged.filter(({ ambiguous }) => !ambiguous);
  const cost = judged.reduce(
    (total, { metrics }) => total + (metrics?.cost_usd ?? 0),
    0,
  );
  const models = [
    ...new Set(judged.flatMap(({ metrics }) => metrics?.model.reported ?? [])),
  ];
  write(
    `TOTAL agree ${count(sure)} ambiguous ${count(judged.filter(({ ambiguous }) => ambiguous))} judge_errors ${judged.filter(({ error }) => error).length} calls ${judged.length} cost_usd ${Math.round(cost * 1e4) / 1e4} model ${values.model} reported ${models.join(",") || "none"}\n`,
  );
  if (values.out) {
    await writeFile(
      path.resolve(values.out),
      `${JSON.stringify(judged, null, 2)}\n`,
    );
  }
  return sure.every(({ verdict, label }) => verdict === label) &&
    judged.every(({ error }) => !error)
    ? 0
    : 1;
}

// Runs task over items with at most limit at once, results in item order.
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      results[at] = await task(items[at]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
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
