import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageMetadata from "../package.json" with { type: "json" };
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// When a tool breaks or an agent stumbles, the owner can see afterwards what
// was called, how it ended and how long it took, and nothing of the home.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const dimmableLamp = `${homeRef}/accessory/16/service/13/characteristic/15`;
const LOG_LIMIT_BYTES = 1024 * 1024;
const LOG_FIELDS = new Set([
  "time",
  "version",
  "tool",
  "operation",
  "outcome",
  "error_code",
  "hub_code",
  "duration_ms",
  "response_bytes",
]);

async function temporaryDirectory(t, prefix = "sprut-agent-work-log-") {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await chmod(directory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function setup(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  return { hub, stateDirectory: await temporaryDirectory(t) };
}

async function startClient(t, hub, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "work-log-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

function startStateClient(t, hub, stateDirectory) {
  return startClient(t, hub, { SPRUT_AGENT_STATE_DIR: stateDirectory });
}

function logFile(stateDirectory) {
  return path.join(stateDirectory, "work-log.jsonl");
}

async function logLines(stateDirectory, file = "work-log.jsonl") {
  const text = await readFile(path.join(stateDirectory, file), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function replyBytes(result) {
  return Buffer.byteLength(result.content[0].text);
}

async function waitForLines(stateDirectory, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const lines = await logLines(stateDirectory);
    if (lines.length >= count) return lines;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`the work log never reached ${count} lines`);
}

function fillerLine(index) {
  return `${JSON.stringify({ time: "2026-01-01T00:00:00.000Z", tool: "filler", index })}\n`;
}

function fillerUpTo(bytes) {
  const lines = [];
  let total = 0;
  while (total < bytes) {
    const line = fillerLine(lines.length);
    lines.push(line);
    total += line.length;
  }
  return { text: lines.join(""), count: lines.length };
}

test("every registered tool leaves one line, also when its arguments are refused before it runs", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startStateClient(t, hub, stateDirectory);
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);

  const replies = [];
  for (const tool of tools) {
    const before = Date.now();
    const result = await client.callTool({ name: tool.name, arguments: {} });
    replies.push({ tool: tool.name, result, before, after: Date.now() });
  }

  const lines = await logLines(stateDirectory);
  assert.equal(lines.length, tools.length);
  for (const [index, { tool, result, before, after }] of replies.entries()) {
    const line = lines[index];
    assert.equal(line.tool, tool);
    assert.equal(line.version, packageMetadata.version);
    assert.equal(line.outcome, result.isError ? "error" : "ok", tool);
    assert.equal(line.response_bytes, replyBytes(result), tool);
    assert.ok(Number.isInteger(line.duration_ms) && line.duration_ms >= 0);
    assert.ok(line.duration_ms <= after - before + 1, tool);
    const time = Date.parse(line.time);
    assert.ok(time >= before && time <= after, `${tool}: ${line.time}`);
    if (result.isError) {
      assert.match(line.error_code, /^[a-z_]+$/, tool);
      assert.equal(
        line.error_code,
        result.structuredContent?.error?.code ?? "invalid_arguments",
        tool,
      );
    } else {
      assert.equal(line.error_code, undefined, tool);
    }
    assert.deepEqual(
      Object.keys(line).filter((key) => !LOG_FIELDS.has(key)),
      [],
      tool,
    );
  }
});

test("a successful call and a refused write are recorded with their codes", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startStateClient(t, hub, stateDirectory);

  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: dimmableLamp,
      value: 30,
      reason: "Приглушить торшер",
    },
  });
  assert.equal(prepared.isError, undefined, prepared.content[0].text);
  hub.refuseNext("characteristic.update", {
    code: -32603,
    message: "Internal error: device is not responding",
  });
  const refused = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  assert.equal(refused.isError, true);

  const [success, failure] = await logLines(stateDirectory);
  assert.equal(success.tool, "prepare_native_change");
  assert.equal(success.operation, "characteristic_value");
  assert.equal(success.outcome, "ok");
  assert.equal(success.error_code, undefined);
  assert.equal(success.hub_code, undefined);
  assert.equal(success.response_bytes, replyBytes(prepared));

  assert.equal(failure.tool, "apply_native_change");
  assert.equal(failure.outcome, "error");
  assert.equal(failure.error_code, refused.structuredContent.error.code);
  assert.equal(failure.error_code, "request_rejected");
  assert.equal(failure.hub_code, -32603);
  assert.equal(failure.response_bytes, replyBytes(refused));
});

test("a read the hub refuses records the hub's code the answer does not carry", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startStateClient(t, hub, stateDirectory);
  await client.callTool({ name: "home_overview", arguments: {} });
  hub.refuseNext("scenario.get", { code: -32000, message: "Busy" });

  const refused = await client.callTool({
    name: "get_entity",
    arguments: { entity_ref: `${homeRef}/scenario/3` },
  });

  assert.equal(refused.isError, true, refused.content[0].text);
  assert.equal(refused.content[0].text.includes("-32000"), false);
  const [, line] = await logLines(stateDirectory);
  assert.equal(line.outcome, "error");
  assert.equal(line.error_code, "request_rejected");
  assert.equal(line.hub_code, -32000);
});

test("a device command the hub refuses counts as an error of the call", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startStateClient(t, hub, stateDirectory);
  hub.refuseNext("characteristic.update", {
    code: -32603,
    message: "Internal error: device is not responding",
  });

  const sent = await client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [{ target_ref: dimmableLamp, value: 30 }],
      reason: "Приглушить торшер",
    },
  });

  assert.equal(sent.isError, undefined);
  assert.equal(sent.structuredContent.status, "incomplete");
  const [line] = await logLines(stateDirectory);
  assert.equal(line.outcome, "error");
  assert.equal(line.error_code, "request_rejected");
  assert.equal(line.hub_code, -32603);
});

// The owner reads the log after something went wrong: a write nobody can
// confirm must stand out as a refusal does, whichever tool sent it.
test("a write the reply does not confirm is an error of the call, by the status it ended with", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startStateClient(t, hub, stateDirectory);
  const lamp = { aId: 16, sId: 13, cId: 15 };
  // Undo writes these back; a lamp's level it never does.
  const thermostat = `${homeRef}/accessory/19/service/13/characteristic/17`;
  const curtain = { aId: 18, sId: 13, cId: 16 };
  const curtainRef = `${homeRef}/accessory/18/service/13/characteristic/16`;
  const seen = async () => (await logLines(stateDirectory)).at(-1);
  const prepare = async (value, target = dimmableLamp) => {
    const prepared = await client.callTool({
      name: "prepare_native_change",
      arguments: {
        operation: "characteristic_value",
        target_ref: target,
        value,
        reason: "Приглушить торшер",
      },
    });
    assert.equal(prepared.isError, undefined, prepared.content[0].text);
    assert.equal((await seen()).outcome, "ok");
    return prepared.structuredContent.change_ref;
  };
  const apply = (changeRef) =>
    client.callTool({
      name: "apply_native_change",
      arguments: { change_ref: changeRef },
    });
  const restore = (changeRef) =>
    client.callTool({
      name: "restore_native_change",
      arguments: { change_ref: changeRef },
    });
  const expectLine = async (result, status, code = status) => {
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.structuredContent.status, status);
    const line = await seen();
    assert.equal(line.outcome, "error", status);
    assert.equal(line.error_code, code);
    assert.equal(line.hub_code, undefined);
    assert.deepEqual(
      Object.keys(line).filter((key) => !LOG_FIELDS.has(key)),
      [],
    );
  };
  const expectFine = async (result, status) => {
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(result.structuredContent.status, status);
    const line = await seen();
    assert.equal(line.outcome, "ok", status);
    assert.equal(line.error_code, undefined);
  };

  // The answer to the write is lost.
  const lost = await prepare(21);
  hub.loseNext("characteristic.update");
  await expectLine(await apply(lost), "uncertain");

  // The same loss through the other way of sending a command.
  hub.loseNext("characteristic.update");
  const sent = await client.callTool({
    name: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [{ target_ref: dimmableLamp, value: 22 }],
      reason: "Приглушить торшер",
    },
  });
  assert.equal(sent.structuredContent.status, "incomplete");
  assert.equal((await seen()).outcome, "error");
  assert.equal((await seen()).error_code, "uncertain");

  // Reading how such a write ended is a read that worked.
  await expectFine(
    await client.callTool({
      name: "get_native_change",
      arguments: { change_ref: lost },
    }),
    "uncertain",
  );

  // The owner moved the lamp between prepare and apply.
  const movedBeforeApply = await prepare(23);
  hub.changeByHand({ ...lamp, value: { intValue: 77 } });
  await expectLine(await apply(movedBeforeApply), "conflict");

  // A confirmed write and its confirmed undo stay ordinary lines.
  const confirmed = await prepare(20, thermostat);
  await expectFine(await apply(confirmed), "applied");
  await expectFine(await restore(confirmed), "restored");

  // Applying what was undone sends nothing and does not put the value back.
  await expectLine(await apply(confirmed), "restored");

  // The undo's answer is lost.
  const lostUndo = await prepare(21, thermostat);
  await expectFine(await apply(lostUndo), "applied");
  hub.loseNext("characteristic.update");
  await expectLine(await restore(lostUndo), "uncertain");

  // The owner moved the curtain, so the undo does not write over it.
  const movedBeforeUndo = await prepare(50, curtainRef);
  await expectFine(await apply(movedBeforeUndo), "applied");
  hub.changeByHand({ ...curtain, value: { intValue: 30 } });
  await expectLine(await restore(movedBeforeUndo), "conflict");

  // The undo skips a lamp's level: the change stays applied, nothing undone.
  const level = await prepare(55);
  await expectFine(await apply(level), "applied");
  await expectLine(await restore(level), "applied", "skipped");
});

test("the log carries no content of the home, the request or the connection", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const reason = "Приглушить торшер для гостей Иванова";
  const hubMessage = "Отказ хаба: устройство Торшер-секрет не отвечает";
  const client = await startClient(t, hub, {
    SPRUT_AGENT_STATE_DIR: stateDirectory,
    SPRUTHUB_EMAIL: "owner-login@example.test",
    SPRUTHUB_PASSWORD: "owner-password-value",
  });

  const overview = await client.callTool({
    name: "home_overview",
    arguments: { list: "rooms", query: "Гостиная" },
  });
  const found = await client.callTool({
    name: "find_devices",
    arguments: { query: "торшер" },
  });
  const prepared = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "characteristic_value",
      target_ref: dimmableLamp,
      value: 30,
      reason,
    },
  });
  hub.refuseNext("characteristic.update", {
    code: -32603,
    message: hubMessage,
  });
  const refused = await client.callTool({
    name: "apply_native_change",
    arguments: { change_ref: prepared.structuredContent.change_ref },
  });
  await client.callTool({
    name: "get_native_change_contract",
    arguments: { operation: "расскажи про спальню Иванова" },
  });
  const unknown = await client.callTool({
    name: "скажи_пароль_от_дома",
    arguments: {},
  });
  assert.equal(unknown.isError, true);

  // The material the check needs must really have been in the answers.
  const answers = JSON.stringify([overview, found, prepared, refused]);
  const present = [
    "Гостиная",
    "Торшер",
    reason,
    hubMessage,
    dimmableLamp,
    prepared.structuredContent.change_ref,
  ];
  for (const text of present) assert.ok(answers.includes(text), text);

  const raw = await readFile(logFile(stateDirectory), "utf8");
  const absent = [
    ...present,
    homeRef,
    "spruthub-change://",
    "Иванова",
    "скажи_пароль",
    "спальню",
    ...Object.values(hub.connectionEnv()),
    "owner-login@example.test",
    "owner-password-value",
  ];
  for (const text of absent) {
    assert.equal(raw.includes(text), false, `the log shows ${text}`);
  }

  const lines = raw.trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(
    lines.map(({ tool }) => tool),
    [
      "home_overview",
      "find_devices",
      "prepare_native_change",
      "apply_native_change",
      "get_native_change_contract",
      "unknown",
    ],
  );
  // Only the enumeration's values name an operation, never free text.
  assert.equal(lines[4].operation, undefined);
  assert.equal(lines[5].error_code, "unknown_tool");
  for (const line of lines) {
    assert.deepEqual(
      Object.keys(line).filter((key) => !LOG_FIELDS.has(key)),
      [],
    );
  }
});

test("a state directory that cannot be written changes neither the answer nor its time", async (t) => {
  const { hub, stateDirectory: writable } = await setup(t);
  const readOnly = await temporaryDirectory(t);
  await chmod(readOnly, 0o500);
  const parent = await temporaryDirectory(t);
  const regularFile = path.join(parent, "not-a-directory");
  await writeFile(regularFile, "");
  const logIsDirectory = await temporaryDirectory(t);
  await mkdir(logFile(logIsDirectory));

  const call = {
    name: "get_native_change_contract",
    arguments: { operation: "room_create" },
  };
  async function callTimes(client, count) {
    const elapsed = [];
    let result;
    for (let attempt = 0; attempt < count; attempt += 1) {
      const started = performance.now();
      result = await client.callTool(call);
      elapsed.push(performance.now() - started);
    }
    elapsed.sort((left, right) => left - right);
    return { result, median: elapsed[Math.floor(count / 2)] };
  }
  const healthy = await callTimes(await startStateClient(t, hub, writable), 15);
  assert.equal(healthy.result.isError, undefined);
  assert.equal((await logLines(writable)).length, 15);

  for (const stateDirectory of [readOnly, regularFile, logIsDirectory]) {
    const client = await startStateClient(t, hub, stateDirectory);
    const broken = await callTimes(client, 15);
    assert.deepEqual(broken.result, healthy.result);
    // Far above the cost of a failed system call and far below any retry.
    assert.ok(
      broken.median < healthy.median + 50,
      `${broken.median} ms against ${healthy.median} ms`,
    );
    // The server is still there for the next request.
    assert.ok((await client.listTools()).tools.length > 0);
  }
  assert.deepEqual(await readdir(readOnly), []);
});

test("a full log becomes the one previous file and the next line starts a new one", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const full = fillerUpTo(LOG_LIMIT_BYTES);
  await writeFile(logFile(stateDirectory), full.text, { mode: 0o600 });
  await writeFile(
    path.join(stateDirectory, "work-log.jsonl.1"),
    `${JSON.stringify({ tool: "older-generation" })}\n`,
    { mode: 0o600 },
  );
  const client = await startStateClient(t, hub, stateDirectory);

  await client.callTool({ name: "home_overview", arguments: {} });

  const current = await logLines(stateDirectory);
  assert.deepEqual(
    current.map(({ tool }) => tool),
    ["home_overview"],
  );
  const previous = await logLines(stateDirectory, "work-log.jsonl.1");
  assert.equal(previous.length, full.count);
  assert.equal(previous.at(-1).tool, "filler");
  assert.deepEqual((await readdir(stateDirectory)).sort(), [
    "work-log.jsonl",
    "work-log.jsonl.1",
  ]);
});

test("a lock left by a dead process delays rotation by one call at most", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const full = fillerUpTo(LOG_LIMIT_BYTES);
  await writeFile(logFile(stateDirectory), full.text, { mode: 0o600 });
  const lock = `${logFile(stateDirectory)}.lock`;
  await writeFile(lock, "");
  const longAgo = new Date(Date.now() - 3_600_000);
  await utimes(lock, longAgo, longAgo);
  const client = await startStateClient(t, hub, stateDirectory);

  const first = await client.callTool({ name: "home_overview", arguments: {} });
  await client.callTool({ name: "home_overview", arguments: {} });

  assert.equal(first.isError, undefined);
  assert.equal((await logLines(stateDirectory)).length, 1);
  const previous = await logLines(stateDirectory, "work-log.jsonl.1");
  assert.equal(previous.length, full.count + 1);
  assert.deepEqual((await readdir(stateDirectory)).sort(), [
    "work-log.jsonl",
    "work-log.jsonl.1",
  ]);
});

test("a log below the limit keeps growing", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const below = fillerUpTo(LOG_LIMIT_BYTES - 2_000);
  await writeFile(logFile(stateDirectory), below.text, { mode: 0o600 });
  const client = await startStateClient(t, hub, stateDirectory);

  await client.callTool({ name: "home_overview", arguments: {} });

  assert.equal((await logLines(stateDirectory)).length, below.count + 1);
  assert.equal(
    (await readdir(stateDirectory)).includes("work-log.jsonl.1"),
    false,
  );
});

async function callConcurrently(t, hub, stateDirectory, processes, calls) {
  const clients = await Promise.all(
    Array.from({ length: processes }, () =>
      startStateClient(t, hub, stateDirectory),
    ),
  );
  await Promise.all(
    clients.flatMap((client) =>
      Array.from({ length: calls }, () =>
        client.callTool({
          name: "get_native_change_contract",
          arguments: { operation: "room_create" },
        }),
      ),
    ),
  );
}

test("several servers append at once and every line stays whole", async (t) => {
  const { hub, stateDirectory } = await setup(t);

  await callConcurrently(t, hub, stateDirectory, 4, 50);

  const lines = await logLines(stateDirectory);
  assert.equal(lines.length, 200);
  for (const line of lines) {
    assert.equal(line.tool, "get_native_change_contract");
    assert.equal(line.operation, "room_create");
    assert.equal(line.outcome, "ok");
  }
});

test("several servers crossing the limit together keep every line", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const seed = fillerUpTo(LOG_LIMIT_BYTES - 6_000);
  await writeFile(logFile(stateDirectory), seed.text, { mode: 0o600 });

  await callConcurrently(t, hub, stateDirectory, 4, 25);

  const current = await logLines(stateDirectory);
  const previous = await logLines(stateDirectory, "work-log.jsonl.1");
  assert.ok(previous.length > seed.count, "the seeded file was rotated once");
  assert.equal(current.length + previous.length, seed.count + 100);
  const logged = [...current, ...previous].filter(
    ({ tool }) => tool !== "filler",
  );
  assert.equal(logged.length, 100);
});

test("a damaged line breaks neither the tools nor the lines after it", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  await writeFile(
    logFile(stateDirectory),
    Buffer.concat([
      Buffer.from('{"time":"cut off\n'),
      Buffer.from([0xff, 0xfe, 0x00, 0x0a]),
    ]),
    { mode: 0o600 },
  );
  const client = await startStateClient(t, hub, stateDirectory);

  const result = await client.callTool({
    name: "home_overview",
    arguments: {},
  });

  assert.equal(result.isError, undefined);
  const raw = await readFile(logFile(stateDirectory), "utf8");
  const last = JSON.parse(raw.trimEnd().split("\n").at(-1));
  assert.equal(last.tool, "home_overview");
});

test("the log is readable only by its owner, also when it was not", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const fresh = path.join(stateDirectory, "created-on-first-call");
  const client = await startStateClient(t, hub, fresh);
  await client.callTool({ name: "home_overview", arguments: {} });
  assert.equal((await stat(logFile(fresh))).mode & 0o777, 0o600);
  assert.equal((await stat(fresh)).mode & 0o777, 0o700);

  const widened = await temporaryDirectory(t);
  await writeFile(logFile(widened), "");
  await chmod(logFile(widened), 0o644);
  const other = await startStateClient(t, hub, widened);
  await other.callTool({ name: "home_overview", arguments: {} });
  assert.equal((await stat(logFile(widened))).mode & 0o777, 0o600);
});

test("with no state directory set the log lies in the per-user directory", async (t) => {
  const { hub } = await setup(t);
  const home = await temporaryDirectory(t);
  const client = await startClient(t, hub, {
    HOME: home,
    SPRUT_AGENT_STATE_DIR: " ",
    XDG_STATE_HOME: "",
  });

  await client.callTool({ name: "home_overview", arguments: {} });

  const files = await readdir(home, { recursive: true });
  const expected =
    process.platform === "darwin"
      ? path.join("Library", "Application Support", "sprut-agent")
      : path.join(".local", "state", "sprut-agent");
  assert.ok(files.includes(path.join(expected, "work-log.jsonl")), `${files}`);
});

test("a call the client gave up on and a call cut off by its exit are recorded", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startStateClient(t, hub, stateDirectory);
  const readScenario = {
    name: "get_entity",
    arguments: { entity_ref: `${homeRef}/scenario/3` },
  };

  // The hub never answers: the call is still under way when the client stops.
  hub.loseNext("scenario.get");
  const abort = new AbortController();
  const givenUp = client.callTool(readScenario, undefined, {
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(givenUp);
  const [cancelled] = await waitForLines(stateDirectory, 1);
  assert.equal(cancelled.tool, "get_entity");
  assert.equal(cancelled.outcome, "error");
  assert.equal(cancelled.error_code, "cancelled");
  assert.ok(cancelled.duration_ms >= 100 && cancelled.duration_ms < 1_500);
  // The tool's late end, once the hub timeout passes, adds no second line.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.equal((await logLines(stateDirectory)).length, 1);

  hub.loseNext("scenario.get");
  client.callTool(readScenario).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  await client.close();
  const lines = await waitForLines(stateDirectory, 2);
  assert.equal(lines[1].tool, "get_entity");
  assert.equal(lines[1].outcome, "error");
  assert.equal(lines[1].error_code, "interrupted");
  assert.equal(lines.length, 2);
});
