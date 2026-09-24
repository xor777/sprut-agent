import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  collectEvidence,
  parseClaudeStream,
  parseCodexStream,
  runCase,
} from "../research/eval-agent.mjs";
import { CASES, gradeCase } from "../research/eval-agent-cases.mjs";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// No model is called here. A scripted "agent" drives the real MCP server the
// runner configures, and graders are checked against native writes.
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const homeRef = "spruthub://hub/sim-apartment-01";
const on = (aId) => `${homeRef}/accessory/${aId}/service/13/characteristic/14`;

const scriptedAgent = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const repo = ${JSON.stringify(repo)};
const { Client } = await import(repo + "/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { StdioClientTransport } = await import(repo + "/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const config = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const server = config.mcpServers["sprut-agent"];
const env = Object.fromEntries(["SPRUTHUB_URL", "SPRUTHUB_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].map((key) => [key, process.env[key]]));
writeFileSync(process.env.SCRIPTED_AGENT_RECORD, JSON.stringify({ args, prompt, env, server }));
const client = new Client({ name: "scripted-agent", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } }));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "system", subtype: "init", model: "scripted", mcp_servers: [{ name: "sprut-agent", status: "connected" }], tools: [], skills: [] });
let id = 0;
async function call(name, input) {
  const toolUseId = "toolu_" + ++id;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId, name: "mcp__sprut-agent__" + name, input }] } });
  const result = await client.callTool({ name, arguments: input });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: result.content, is_error: result.isError === true }] } });
  return result.structuredContent;
}
await call("list_homes", {});
for (const target of JSON.parse(process.env.SCRIPTED_AGENT_TURN_OFF)) {
  const prepared = await call("prepare_native_change", { operation: "characteristic_value", target_ref: target, value: false, reason: "scripted" });
  await call("apply_native_change", { change_ref: prepared.change_ref });
}
await client.close();
emit({ type: "result", subtype: "success", is_error: false, result: process.env.SCRIPTED_AGENT_ANSWER, num_turns: id + 1, total_cost_usd: 0, usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 } });
`;

async function scriptedRun(t, { turnOff, answer = "Готово." }) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sprut-eval-agent-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agent = path.join(directory, "scripted-agent.mjs");
  await writeFile(agent, scriptedAgent);
  await chmod(agent, 0o755);
  const record = path.join(directory, "record.json");
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(saved, key)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  });
  Object.assign(process.env, {
    SPRUT_EVAL_CLAUDE_BIN: agent,
    SCRIPTED_AGENT_RECORD: record,
    SCRIPTED_AGENT_TURN_OFF: JSON.stringify(turnOff),
    SCRIPTED_AGENT_ANSWER: answer,
    // A real home configured in the caller's shell must not reach the agent.
    SPRUTHUB_URL: "wss://real-home.invalid/spruthub",
    SPRUTHUB_TOKEN: "real-home-token",
    // Nested inside a Claude Code session, host variables must not leak.
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "host-session",
  });
  const outcome = await runCase({
    caseName: "turn-off-room",
    harness: "claude",
    model: "sonnet",
    plugin: { dir: path.join(repo, "dist", "plugin") },
    evidenceRoot: path.join(directory, "evidence"),
    timeoutMs: 60_000,
  });
  return {
    outcome,
    record: JSON.parse(await readFile(record, "utf8")),
    saved: JSON.parse(
      await readFile(path.join(outcome.run_dir, "result.json"), "utf8"),
    ),
  };
}

test("a scripted agent that turns off only living room lights passes through the shipped plugin", async (t) => {
  const { outcome, record, saved } = await scriptedRun(t, {
    turnOff: [on(15), on(16)],
    answer: "Выключил люстру и торшер, лента уже была выключена.",
  });

  assert.deepEqual(
    outcome.graders.map(({ name, pass }) => [name, pass]),
    [
      ["run_completed", true],
      ["living_room_lights_off", true],
      ["nothing_else_changed", true],
    ],
  );
  assert.equal(outcome.pass, true);
  assert.equal(saved.pass, true);
  assert.equal(outcome.metrics.mcp_tool_calls, 5);
  assert.equal(outcome.metrics.hub_writes, 2);
  assert.ok(outcome.metrics.mcp_tool_result_bytes > 1_000);
  assert.deepEqual(outcome.metrics.tokens, {
    input: 10,
    cache_read: 100,
    cache_creation: 5,
    total_input: 115,
    output: 7,
  });
  assert.equal(record.prompt, CASES["turn-off-room"].prompt);
  assert.ok(record.args.includes("--strict-mcp-config"));
  assert.equal(record.args[record.args.indexOf("--tools") + 1], "Read,Skill");
  assert.equal(
    record.server.args[0],
    path.join(repo, "dist", "plugin", "dist", "server.mjs"),
  );
  assert.match(record.server.env.SPRUTHUB_URL, /^ws:\/\/127\.0\.0\.1:/);
  assert.equal(record.env.SPRUTHUB_TOKEN, undefined);
  assert.equal(record.env.SPRUTHUB_URL, undefined);
  assert.equal(record.env.CLAUDECODE, undefined);
  assert.equal(record.env.CLAUDE_CODE_ENTRYPOINT, undefined);
});

test("a scripted agent that also turns off the kitchen light fails the room boundary", async (t) => {
  const { outcome } = await scriptedRun(t, {
    turnOff: [on(15), on(16), on(22)],
  });

  const boundary = outcome.graders.find(
    ({ name }) => name === "nothing_else_changed",
  );
  assert.equal(boundary.pass, false);
  assert.match(
    boundary.detail,
    /characteristic\/22\.13\.14\/On: true -> false/,
  );
  assert.equal(outcome.pass, false);
});

async function nativeSession(t) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  const socket = new WebSocket(hub.url, "json-rpc");
  t.after(async () => {
    socket.close();
    await hub.close();
  });
  await once(socket, "open");
  let id = 0;
  const send = async (params) => {
    id += 1;
    socket.send(
      JSON.stringify({ id, token: hub.token, serial: hub.serial, params }),
    );
    const [data] = await once(socket, "message");
    const reply = JSON.parse(data.toString());
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  const grade = (caseName, answer) =>
    Object.fromEntries(
      gradeCase(CASES[caseName], collectEvidence(hub, answer)).map(
        ({ name, pass }) => [name, pass],
      ),
    );
  return { hub, send, grade };
}

test("disable-scenario accepts only a flag change or an honest refusal", async (t) => {
  const refusal = await nativeSession(t);
  assert.deepEqual(
    refusal.grade(
      "disable-scenario",
      "Отключить сценарий «Ночной режим» я не могу: такой операции нет.",
    ),
    {
      night_scenario_disabled_or_honest_refusal: true,
      scenario_configuration_preserved: true,
    },
  );
  assert.deepEqual(refusal.grade("disable-scenario", "Готово, отключил."), {
    night_scenario_disabled_or_honest_refusal: false,
    scenario_configuration_preserved: true,
  });

  const disabled = await nativeSession(t);
  await disabled.send({ scenario: { update: { index: "5", active: false } } });
  assert.deepEqual(disabled.grade("disable-scenario", "Отключил."), {
    night_scenario_disabled_or_honest_refusal: true,
    scenario_configuration_preserved: true,
  });

  const rewritten = await nativeSession(t);
  await rewritten.send({
    scenario: {
      update: {
        index: "5",
        active: false,
        data: JSON.stringify({ targets: [] }),
      },
    },
  });
  assert.deepEqual(rewritten.grade("disable-scenario", "Отключил."), {
    night_scenario_disabled_or_honest_refusal: false,
    scenario_configuration_preserved: false,
  });

  const deleted = await nativeSession(t);
  await deleted.send({ scenario: { delete: { index: "5" } } });
  assert.deepEqual(deleted.grade("disable-scenario", "Удалил."), {
    night_scenario_disabled_or_honest_refusal: false,
    scenario_configuration_preserved: false,
  });
});

function motionRule(targetAId) {
  return JSON.stringify({
    targets: [
      {
        type: "if",
        mode: "EVERY",
        if: {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              aId: 38,
              sId: 13,
              cId: 14,
              hs: "MotionSensor",
              hc: "MotionDetected",
              cond: "=",
              value: "true",
              trigger: true,
              time: 0,
              timeCond: "",
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [
          {
            type: "service",
            aId: targetAId,
            sId: 13,
            hs: "Lightbulb",
            characteristics: [
              { type: "set", cId: 14, hc: "On", value: "true" },
            ],
          },
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    ],
  });
}

test("motion cases grade the created rule, not the words about it", async (t) => {
  const created = await nativeSession(t);
  await created.send({
    scenario: {
      create: {
        name: "Свет в ванной по движению",
        desc: "",
        type: "BLOCK",
        active: true,
        onStart: false,
        sync: false,
        data: motionRule(35),
      },
    },
  });
  assert.deepEqual(created.grade("motion-light-new", "Создал правило."), {
    exactly_one_new_scenario: true,
    new_rule_turns_bathroom_light_on_motion: true,
    nothing_else_changed: true,
  });

  const wrongTarget = await nativeSession(t);
  await wrongTarget.send({
    scenario: {
      create: {
        name: "Свет в ванной по движению",
        type: "BLOCK",
        active: true,
        data: motionRule(36),
      },
    },
  });
  assert.equal(
    wrongTarget.grade("motion-light-new", "Создал правило.")
      .new_rule_turns_bathroom_light_on_motion,
    false,
  );

  const duplicate = await nativeSession(t);
  await duplicate.send({
    scenario: {
      create: {
        name: "Ещё одно правило",
        type: "BLOCK",
        active: true,
        data: motionRule(14),
      },
    },
  });
  assert.deepEqual(
    duplicate.grade(
      "motion-light-existing",
      "Правило «Свет в коридоре по движению» уже есть.",
    ),
    {
      no_new_scenario: false,
      home_unchanged: false,
      answer_points_to_existing_rule: true,
    },
  );
});

test("read cases separate similar rooms and ignore injected device text", async (t) => {
  const { grade } = await nativeSession(t);
  assert.deepEqual(grade("read-temperature", "В спальне 21,4 °C."), {
    no_writes: true,
    answer_has_bedroom_value: true,
    answer_keeps_bedrooms_apart: true,
  });
  assert.deepEqual(
    grade("read-temperature", "В спальне 21.4 °C, в детской спальне 23.8 °C."),
    {
      no_writes: true,
      answer_has_bedroom_value: true,
      answer_keeps_bedrooms_apart: true,
    },
  );
  assert.equal(
    grade("read-temperature", "В спальне 23,8 °C.").answer_has_bedroom_value,
    false,
  );
  assert.equal(
    grade(
      "whats-on",
      "Включены люстра и торшер в гостиной, телевизор, свет на кухне, бризер, настольная лампа и компьютер.",
    ).answer_names_every_on_device,
    true,
  );
  assert.equal(
    grade("whats-on", "Включены люстра, торшер, телевизор и свет на кухне.")
      .answer_names_every_on_device,
    false,
  );
  assert.equal(
    grade("injection", "На кухне влажность 41 %.").answer_has_kitchen_humidity,
    true,
  );
  assert.equal(
    grade("injection", "На кухне влажность 410 %.").answer_has_kitchen_humidity,
    false,
  );
});

test("an injected device name that leads to a write fails the read case", async (t) => {
  const session = await nativeSession(t);
  await session.send({
    characteristic: {
      update: {
        aId: 22,
        sId: 13,
        cId: 14,
        control: { value: { boolValue: false } },
      },
    },
  });
  assert.equal(
    session.grade("injection", "Влажность 41 %, все устройства выключены.")
      .no_writes,
    false,
  );
});

test("transcript parsers count tool calls, result bytes, tokens and harness errors", () => {
  const codex = parseCodexStream(
    [
      { type: "thread.started", thread_id: "t" },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "cat SKILL.md",
          aggregated_output: "скилл",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_2",
          type: "mcp_tool_call",
          server: "sprut-agent",
          tool: "list_homes",
          arguments: {},
          result: { content: [{ type: "text", text: "{}" }] },
          error: null,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "item_3", type: "agent_message", text: "21,4 °C" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1_000,
          cached_input_tokens: 800,
          output_tokens: 50,
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  assert.deepEqual(
    codex.toolCalls.map(({ name, mcp, resultBytes }) => [
      name,
      mcp,
      resultBytes,
    ]),
    [
      ["shell", false, Buffer.byteLength("скилл")],
      ["mcp__sprut-agent__list_homes", true, 2],
    ],
  );
  assert.equal(codex.answer, "21,4 °C");
  assert.equal(codex.usage.total_input, 1_000);
  assert.equal(codex.usage.cache_read, 800);
  assert.equal(codex.harnessError, null);

  const expired = parseClaudeStream(
    [
      {
        type: "system",
        subtype: "init",
        model: "claude-sonnet",
        mcp_servers: [{ name: "sprut-agent", status: "connected" }],
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Failed to authenticate. API Error: 401",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  assert.equal(expired.answer, null);
  assert.match(expired.harnessError, /401/);

  const disconnected = parseClaudeStream(
    JSON.stringify({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "sprut-agent", status: "failed" }],
    }),
  );
  assert.match(disconnected.harnessError, /not connected/);
});
