import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { withColorScenes } from "./fixtures/homes/color-scenes.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// When the owner asks «Что в доме не так?», home_overview must surface user
// code scenarios that still point at accessory IDs absent from the home —
// ahead of offline devices so offline sensors cannot crowd them past the cap —
// without false positives on ordinary numeric tables, without reading code on
// list/query calls, and without leaking secrets or crashing on hostile code.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const home = "spruthub://hub/sim-apartment-01";

async function setup(t, fixture, { timeoutMs = 3000 } = {}) {
  const hub = await startSimulatedHub(fixture);
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-home-audit-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: String(timeoutMs),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "home-audit-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, client };
}

async function overview(client, args = {}) {
  const result = await client.callTool({
    name: "home_overview",
    arguments: args,
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  return {
    body: result.structuredContent,
    rawText: result.content[0].text,
  };
}

function codeScenario(index, name, data, extra = {}) {
  return {
    index,
    name,
    desc: "",
    type: "GLOBAL",
    active: true,
    onStart: true,
    sync: false,
    data,
    ...extra,
  };
}

test("home_overview reports stale id 63 in Цветные сцены and keeps it ahead of offline devices", async (t) => {
  const baseFixture = withColorScenes(
    structuredClone(await loadHomeFixture("apartment")),
  );
  const { hub, client } = await setup(t, baseFixture);

  const { body } = await overview(client);

  assert.deepEqual(body.problems, [
    {
      kind: "code_missing_device",
      ref: `${home}/scenario/80`,
      name: "Цветные сцены",
      scenario_type: "GLOBAL",
      missing_ids: [63],
      lines: [2],
      found_by: ["accessory_id_list"],
    },
    {
      kind: "device_unavailable",
      ref: `${home}/accessory/34`,
      name: "Датчик окна в кабинете",
      room: "Кабинет",
    },
    {
      kind: "device_unavailable",
      ref: `${home}/accessory/37`,
      name: "Датчик протечки в ванной",
      room: "Ванная",
    },
  ]);
  assert.equal(body.problems_total, 3);
  assert.equal(Object.hasOwn(body, "problems_unchecked"), false);
  assert.equal(Object.hasOwn(body.problems[0], "next"), false);
  assert.deepEqual(
    hub.requests.filter(({ write }) => write),
    [],
    "overview audit never writes",
  );

  // Even with a failed extension, an errored scenario, and 12 extra offline
  // devices (14 total offline), code_missing_device stays ahead of
  // device_unavailable and is never pushed past PROBLEM_LIMIT (10).
  const crowded = withColorScenes(
    structuredClone(await loadHomeFixture("apartment")),
  );
  const telegram = crowded.extensions.find(({ type }) => type === "telegram");
  telegram.enabled = true;
  telegram.state = "FAILED";
  crowded.scenarios.find(({ name }) => name === "Ночной режим").error = true;
  for (const accessory of crowded.accessories.slice(0, 12)) {
    accessory.online = false;
  }
  const crowdedRun = await setup(t, crowded);
  const { body: crowdedBody } = await overview(crowdedRun.client);

  assert.equal(crowdedBody.problems.length, 10);
  assert.equal(crowdedBody.problems_total, 1 + 1 + 1 + 14);
  assert.deepEqual(crowdedBody.problems.slice(0, 3), [
    {
      kind: "extension",
      ref: `${home}/extension/Notification%3Atelegram`,
      name: "Telegram",
      state: "FAILED",
      enabled: true,
    },
    {
      kind: "scenario_error",
      ref: `${home}/scenario/5`,
      name: "Ночной режим",
    },
    {
      kind: "code_missing_device",
      ref: `${home}/scenario/80`,
      name: "Цветные сцены",
      scenario_type: "GLOBAL",
      missing_ids: [63],
      lines: [2],
      found_by: ["accessory_id_list"],
    },
  ]);
  assert.ok(
    crowdedBody.problems
      .slice(3)
      .every(({ kind }) => kind === "device_unavailable"),
  );
});

test("home_overview detects direct Hub calls, combined direct and list references, and caps >10 missing IDs", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  fixture.scenarios.push(
    codeScenario(
      "90",
      "Прямые вызовы Hub",
      [
        'info = { name: "Прямые вызовы Hub", description: "", onStart: false };',
        "function trigger() {",
        "  Hub.getAccessory(999);",
        "  Hub.setCharacteristicValue(888, 14, true);",
        "  Hub.getCharacteristic(0, 13, 14);",
        "  Hub.getCharacteristicValue(16, 13, 14);",
        "  Hub.toggleCharacteristicValue(999, 13, 14);",
        "}",
      ].join("\n"),
      { type: "LOGIC" },
    ),
    codeScenario(
      "91",
      "Вызов и список",
      [
        "Hub.getAccessory(777);",
        "var lamps = [15, 63];",
        "lamps.forEach(function (id) { Hub.getAccessory(id); });",
        "var healthy = [15, 16];",
      ].join("\n"),
    ),
    codeScenario(
      "92",
      "Прямой пропуск и живой список",
      [
        "Hub.getAccessory(700);",
        "var lamps = [15, 16];",
        "lamps.forEach(function (id) { Hub.getAccessory(id); });",
      ].join("\n"),
    ),
    codeScenario(
      "93",
      "Много пропавших",
      Array.from(
        { length: 12 },
        (_, index) => `Hub.getAccessory(${512 - index});`,
      ).join("\n"),
    ),
  );
  const { client } = await setup(t, fixture);
  const { body } = await overview(client);

  const codeProblems = body.problems.filter(
    ({ kind }) => kind === "code_missing_device",
  );
  assert.deepEqual(codeProblems, [
    {
      kind: "code_missing_device",
      ref: `${home}/scenario/90`,
      name: "Прямые вызовы Hub",
      scenario_type: "LOGIC",
      missing_ids: [0, 888, 999],
      lines: [3, 4, 5, 7],
      found_by: ["accessory_id"],
    },
    {
      kind: "code_missing_device",
      ref: `${home}/scenario/91`,
      name: "Вызов и список",
      scenario_type: "GLOBAL",
      missing_ids: [63, 777],
      lines: [1, 2],
      found_by: ["accessory_id", "accessory_id_list"],
    },
    {
      kind: "code_missing_device",
      ref: `${home}/scenario/92`,
      name: "Прямой пропуск и живой список",
      scenario_type: "GLOBAL",
      missing_ids: [700],
      lines: [1],
      found_by: ["accessory_id"],
    },
    {
      kind: "code_missing_device",
      ref: `${home}/scenario/93`,
      name: "Много пропавших",
      scenario_type: "GLOBAL",
      missing_ids: [501, 502, 503, 504, 505, 506, 507, 508, 509, 510],
      missing_ids_total: 12,
      lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      found_by: ["accessory_id"],
    },
  ]);
  for (const entry of body.problems) {
    assert.equal(Object.hasOwn(entry, "next"), false);
  }
});

test("home_overview avoids false positives on non-ID tables, predefined/BLOCK scenarios, and list/query calls", async (t) => {
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  const lookup = "Hub.getAccessory(global.nextId());";
  fixture.scenarios.push(
    codeScenario(
      "90",
      "Таблицы и константы",
      [
        "var rgbZero = [255, 128, 0];",
        "var rgbMajorityMissing = [255, 128, 20];",
        "var delays = [1000, 2000];",
        "var steps = [10, 50, 100, 200];",
        "var stepsWithCollision = [15, 50, 100, 200];",
        "var zeroSteps = [0, 50, 100];",
        "var zeroWithPresent = [0, 15, 16];",
        "var floats = [15, 16.5, 63];",
        "var negatives = [15, -1, 63];",
        "var sparse = [15, , 63];",
        "var empty = [];",
        'var mixed = [15, "63"];',
        "var dupSkewed = [15, 15, 63, 64];",
        'Hub["getAccessory"](999);',
        "Hub.getAccessory(1.5);",
        "// Hub.getAccessory(999)",
        'var text = "Hub.getAccessory(999) [15, 16, 63]";',
        lookup,
      ].join("\n"),
    ),
    codeScenario(
      "91",
      "Список без динамического Hub",
      "var lamps = [15, 16, 63];\nHub.getAccessory(15);",
    ),
    codeScenario(
      "92",
      "Другой объект и метод",
      "var lamps = [15, 16, 63];\nother.getAccessory(id);\nHub.getAccessories(id);",
    ),
    codeScenario(
      "93",
      "Встроенная логика",
      'info = { name: "Встроенная логика", description: "", onStart: false };\nfunction trigger() { Hub.getAccessory(999); }',
      { type: "LOGIC", predefined: true },
    ),
    {
      index: "94",
      name: "Блочный с кодом",
      desc: "",
      type: "BLOCK",
      active: true,
      data: {
        targets: [
          {
            type: "if",
            mode: "EVERY",
            if: { type: "condition", mode: "AND", conditions: [] },
            // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
            then: [{ type: "code", code: "Hub.getAccessory(999);" }],
            else: [],
            then_delay: 0,
            else_delay: 0,
          },
        ],
      },
    },
  );
  const { hub, client } = await setup(t, fixture);

  const { body } = await overview(client);

  assert.deepEqual(
    body.problems.filter(({ kind }) => kind === "code_missing_device"),
    [],
  );
  assert.equal(body.problems_total, 2);
  assert.equal(Object.hasOwn(body, "problems_unchecked"), false);
  const readIndexes = hub.requests
    .filter(({ method }) => method === "scenario.get")
    .map(({ params }) => params.scenario.get.index)
    .sort();
  assert.deepEqual(
    readIndexes,
    ["9", "90", "91", "92"],
    "only user code scenarios are read for audit",
  );

  // list=... and query=... must never read scenario sources.
  for (const args of [
    { list: "scenarios" },
    { list: "rooms" },
    { list: "extensions" },
    { query: "спальне" },
  ]) {
    const before = hub.requests.length;
    await overview(client, args);
    const scenarioGets = hub.requests
      .slice(before)
      .filter(({ method }) => method === "scenario.get");
    assert.deepEqual(
      scenarioGets,
      [],
      `${JSON.stringify(args)} must not read scenario sources`,
    );
  }
});

test("home_overview does not leak secrets from parsed or unparseable code scenarios", async (t) => {
  const secretParsed = "sk-live-super-secret-9876543210";
  const secretUnparsed = "ghp_UnparseableSecretToken1234567890";
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  fixture.scenarios.push(
    codeScenario(
      "90",
      "Секрет и пропавший id",
      `var apiKey = "${secretParsed}";\nHub.getAccessory(999);`,
    ),
    codeScenario(
      "91",
      "Секрет и ошибка разбора",
      `var token = "${secretUnparsed}";\nfor each (var id in [15, 63]) { Hub.getAccessory(id); }`,
    ),
  );
  const { client } = await setup(t, fixture);

  const { body, rawText } = await overview(client);

  assert.equal(rawText.includes(secretParsed), false, "parsed secret leaked");
  assert.equal(
    rawText.includes(secretUnparsed),
    false,
    "unparsed secret leaked",
  );
  assert.equal(rawText.includes("apiKey"), false, "source code leaked");
  assert.equal(rawText.includes("for each"), false, "unparsed code leaked");
  assert.deepEqual(
    body.problems.filter(({ kind }) => kind === "code_missing_device"),
    [
      {
        kind: "code_missing_device",
        ref: `${home}/scenario/90`,
        name: "Секрет и пропавший id",
        scenario_type: "GLOBAL",
        missing_ids: [999],
        lines: [2],
        found_by: ["accessory_id"],
      },
    ],
  );
  assert.deepEqual(body.problems_unchecked, [
    {
      area: "scenario_code",
      outcome: "not_parsed",
      scenario_ref: `${home}/scenario/91`,
    },
  ]);
});

test("home_overview survives scenario.get failure, timeout, unparseable JS, deep nesting, and >24 cap honestly", async (t) => {
  const chain = `var chained = start${".next()".repeat(4000)};`;
  const fixture = structuredClone(await loadHomeFixture("apartment"));
  fixture.scenarios.push(
    codeScenario(
      "90",
      "Не разбирается Nashorn",
      "for each (var id in [15, 63]) { Hub.getAccessory(id); }",
    ),
    codeScenario("91", "Глубокая цепочка", `Hub.getAccessory(995);\n${chain}`),
  );
  const { hub, client } = await setup(t, fixture, { timeoutMs: 1200 });
  // Refuse the first scenario.get (scenario 9 in apartment).
  hub.refuseNext("scenario.get", { code: -32000, message: "Busy" });

  const { body } = await overview(client);

  assert.deepEqual(
    body.problems.filter(({ kind }) => kind === "code_missing_device"),
    [
      {
        kind: "code_missing_device",
        ref: `${home}/scenario/91`,
        name: "Глубокая цепочка",
        scenario_type: "GLOBAL",
        missing_ids: [995],
        lines: [1],
        found_by: ["accessory_id"],
      },
    ],
  );
  assert.deepEqual(body.problems_unchecked, [
    {
      area: "scenario_code",
      outcome: "failed",
      error_code: "request_rejected",
      scenario_ref: `${home}/scenario/9`,
    },
    {
      area: "scenario_code",
      outcome: "not_parsed",
      scenario_ref: `${home}/scenario/90`,
    },
  ]);

  // A timed-out scenario.get does not fail home_overview either.
  hub.loseNext("scenario.get");
  const timedOut = await overview(client);
  assert.deepEqual(timedOut.body.problems_unchecked, [
    {
      area: "scenario_code",
      outcome: "failed",
      error_code: "timeout",
      scenario_ref: `${home}/scenario/9`,
    },
    {
      area: "scenario_code",
      outcome: "not_parsed",
      scenario_ref: `${home}/scenario/90`,
    },
  ]);

  // More than 24 user code scenarios: read at most 24 and report the rest.
  const manyFixture = structuredClone(await loadHomeFixture("apartment"));
  // apartment already has 1 user code scenario (index "9"), so add 26 more -> 27 total.
  for (let n = 1; n <= 26; n += 1) {
    manyFixture.scenarios.push(
      codeScenario(
        String(100 + n),
        `Код ${n}`,
        n === 2 ? "Hub.getAccessory(902);" : "var ok = 1;",
      ),
    );
  }
  const manyRun = await setup(t, manyFixture);
  const { body: manyBody } = await overview(manyRun.client);

  const gets = manyRun.hub.requests.filter(
    ({ method }) => method === "scenario.get",
  );
  assert.equal(gets.length, 24);
  assert.deepEqual(
    manyBody.problems.filter(({ kind }) => kind === "code_missing_device"),
    [
      {
        kind: "code_missing_device",
        ref: `${home}/scenario/102`,
        name: "Код 2",
        scenario_type: "GLOBAL",
        missing_ids: [902],
        lines: [1],
        found_by: ["accessory_id"],
      },
    ],
  );
  assert.deepEqual(manyBody.problems_unchecked, [
    {
      area: "scenario_code",
      outcome: "not_read",
      limit: 24,
      scenarios_not_read: 3,
    },
  ]);
  for (const entry of manyBody.problems_unchecked) {
    assert.equal(Object.hasOwn(entry, "next"), false);
  }
});

test("home_overview still succeeds when every audited code scenario fails to read", async (t) => {
  const { hub, client } = await setup(
    t,
    structuredClone(await loadHomeFixture("apartment")),
    { timeoutMs: 1200 },
  );

  // apartment has one user code scenario (index "9"): refusing its scenario.get
  // leaves zero successful code reads and must not turn home_overview into an error.
  hub.refuseNext("scenario.get", { code: -32000, message: "Busy" });
  const refused = await overview(client);
  assert.equal(refused.body.status, "ok");
  assert.match(refused.body.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(refused.body.problems_total, 2);
  assert.deepEqual(refused.body.problems_unchecked, [
    {
      area: "scenario_code",
      outcome: "failed",
      error_code: "request_rejected",
      scenario_ref: `${home}/scenario/9`,
    },
  ]);

  // Same when the sole user code scenario read times out.
  hub.loseNext("scenario.get");
  const timedOut = await overview(client);
  assert.equal(timedOut.body.status, "ok");
  assert.match(timedOut.body.observed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(timedOut.body.problems_total, 2);
  assert.deepEqual(timedOut.body.problems_unchecked, [
    {
      area: "scenario_code",
      outcome: "failed",
      error_code: "timeout",
      scenario_ref: `${home}/scenario/9`,
    },
  ]);
});
