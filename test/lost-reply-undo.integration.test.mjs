import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  diffHomeSnapshots,
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// «Верни как было» after a scenario change or a scenario setting change
// when one reply of the hub was lost: the write's request never reached the
// hub (loseNext), or it did and its answer did not come back, or the MCP
// server stopped after sending it and before the journal held the outcome.
// A fresh read decides: back as before is done, the agent's change still in
// place is undone again, anything else was changed since, by the agent's
// own later change (undone first) or by hand (left as it is).
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const homeRef = "spruthub://hub/sim-apartment-01";
const BLOCK = "5"; // Ночной режим
const LOGIC = "9"; // Защита от протечки

function scenarioRef(index) {
  return `${homeRef}/scenario/${index}`;
}

async function setup(t) {
  const hooks = {};
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"), {
    onRequest: (request) => hooks.onRequest?.(request),
  });
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-lost-reply-undo-"),
  );
  const servers = [];
  // Another MCP server process on the same journal, as a client starts
  // after the previous one stopped.
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.mjs"],
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        ...hub.connectionEnv(),
        SPRUTHUB_TIMEOUT_MS: "2000",
        SPRUT_AGENT_STATE_DIR: stateDirectory,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "lost-reply-undo", version: "1.0.0" });
    await client.connect(transport);
    servers.push({ client, transport });
    return client;
  };
  const client = await connect();
  t.after(async () => {
    for (const server of servers) await server.client.close();
    await hub.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  // Runs action once, the moment the hub receives the next request of
  // this method and before it handles it.
  const onNext = (method, action) =>
    new Promise((resolve) => {
      hooks.onRequest = (request) => {
        if (request.method !== method) return;
        hooks.onRequest = undefined;
        action(request);
        resolve();
      };
    });
  // The MCP server process is killed the moment the hub receives the next
  // request of this method, before any answer: what its journal holds then
  // is all the next server has. The hub then handles the request unless
  // the test lost it first (loseNext).
  const stopOnNext = (method) =>
    onNext(method, () => process.kill(servers.at(-1).transport.pid, "SIGKILL"));
  return { hub, client, connect, onNext, stopOnNext };
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

// Starts a call the server will not answer: it is stopped meanwhile.
function callUnanswered(client, name, args) {
  client.callTool({ name, arguments: args }).catch(() => {});
}

function scenarioOf(hub, index) {
  return hub.state.scenarios.find((scenario) => scenario.index === index);
}

function writesSince(hub, from) {
  return hub.requests.slice(from).filter(({ write }) => write);
}

// Every write since `from` went to this scenario: its data or its options
// window.
function assertOnlyWrites(hub, from, index) {
  const window = scenarioOf(hub, index).optionsWindow;
  for (const { method, params } of writesSince(hub, from)) {
    const target =
      method === "scenario.update"
        ? params.scenario.update.index === index
        : method === "window.update"
          ? params.window.update.windowKey === window
          : false;
    assert.ok(target, `${method} ${JSON.stringify(params)}`);
  }
}

function itemOf(restored, prepared) {
  const item = restored.results.find(
    ({ change_ref: ref }) => ref === prepared.change_ref,
  );
  assert.ok(item, JSON.stringify(restored.results));
  return item;
}

// The night light's level in the night BLOCK set to `level`.
function blockDataInput(hub, level) {
  const data = JSON.parse(scenarioOf(hub, BLOCK).data);
  data.targets[0].then[1].characteristics[1].value = level;
  return {
    operation: "block_data_update",
    target_ref: scenarioRef(BLOCK),
    data,
    reason: `Ночник на ${level}`,
  };
}

// The leak LOGIC's code with its journal line, or info.description,
// replaced.
function logicCodeInput(hub, from, to) {
  const source = scenarioOf(hub, LOGIC).data;
  assert.ok(source.includes(from), from);
  return {
    operation: "logic_source_update",
    target_ref: scenarioRef(LOGIC),
    source: source.replace(from, to),
    reason: "Поправить код",
  };
}

function renameInput(name) {
  return {
    operation: "window_option",
    target_ref: scenarioRef(BLOCK),
    option_key: "Name",
    value: name,
    reason: `Назвать «${name}»`,
  };
}

async function applied(client, input) {
  const prepared = await call(client, "prepare_native_change", input);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  const result = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(result.status, "applied", JSON.stringify(result));
  return prepared;
}

// The scenario's data or code, and for comparison a setting in its options
// window, which already sent its undo again.
const SCENARIO_CHANGES = [
  {
    name: "a BLOCK data change",
    index: BLOCK,
    method: "scenario.update",
    input: (hub) => blockDataInput(hub, "20"),
  },
  {
    name: "a LOGIC code change",
    index: LOGIC,
    method: "scenario.update",
    input: (hub) =>
      logicCodeInput(
        hub,
        'log("Протечка: розетка чайника отключена")',
        'log("Протечка: розетка отключена")',
      ),
  },
  {
    name: "a scenario rename",
    index: BLOCK,
    method: "window.update",
    input: () => renameInput("Ночь"),
  },
];

for (const { name, index, method, input } of SCENARIO_CHANGES) {
  test(`${name} whose undo request was lost is undone by restoring again, and once more writes nothing`, async (t) => {
    const { hub, client } = await setup(t);
    const initial = hub.snapshot();
    const changed = await applied(client, input(hub));
    const agentState = structuredClone(scenarioOf(hub, index));

    hub.loseNext(method);
    const lost = await call(client, "restore_native_change", {
      change_ref: changed.change_ref,
    });
    assert.equal(lost.status, "uncertain", JSON.stringify(lost));
    assert.deepEqual(scenarioOf(hub, index), agentState);

    // The check says the undo did not take effect and how to finish it.
    const read = await call(client, "get_native_change", {
      change_ref: changed.change_ref,
    });
    assert.equal(read.status, "uncertain", JSON.stringify(read));
    assert.equal(read.write_intent.direction, "restore");
    assert.deepEqual(read.next, {
      tool: "restore_native_change",
      arguments: { change_ref: changed.change_ref },
    });

    const sentBefore = hub.requests.length;
    const finished = await call(client, read.next.tool, read.next.arguments);
    assert.equal(finished.status, "restored", JSON.stringify(finished));
    assert.equal(writesSince(hub, sentBefore).length, 1);
    assertOnlyWrites(hub, sentBefore, index);
    assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);

    const again = hub.requests.length;
    const repeated = await call(client, "restore_native_change", {
      change_ref: changed.change_ref,
    });
    assert.equal(repeated.status, "restored");
    assert.deepEqual(writesSince(hub, again), []);
  });
}

test("«верни как было» after a lost undo of a BLOCK data change sends the undo again and puts the scenario back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const changed = await applied(client, blockDataInput(hub, "20"));

  hub.loseNext("scenario.update");
  const first = await call(client, "restore_native_change", {
    change_refs: [changed.change_ref],
  });
  const lost = itemOf(first, changed);
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));
  assert.equal(lost.reason, "restore_unconfirmed");
  assert.deepEqual(lost.next, {
    tool: "restore_native_change",
    arguments: { change_ref: changed.change_ref },
  });

  const sentBefore = hub.requests.length;
  const second = await call(client, "restore_native_change", {
    change_refs: [changed.change_ref],
  });
  assert.equal(second.status, "ok", JSON.stringify(second.results));
  assert.equal(itemOf(second, changed).sent, true);
  assert.equal(writesSince(hub, sentBefore).length, 1);
  assertOnlyWrites(hub, sentBefore, BLOCK);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);

  const again = hub.requests.length;
  const third = await call(client, "restore_native_change", {
    change_refs: [changed.change_ref],
  });
  assert.equal(third.status, "ok");
  assert.equal(itemOf(third, changed).sent, false);
  assert.deepEqual(writesSince(hub, again), []);
});

for (const reached of [true, false]) {
  test(`an undo of a BLOCK data change that ${reached ? "reached" : "never reached"} the hub before the MCP server stopped is ${reached ? "found done after restart and not sent again" : "sent again after restart"}`, async (t) => {
    const { hub, client, connect, stopOnNext } = await setup(t);
    const initial = hub.snapshot();
    const changed = await applied(client, blockDataInput(hub, "20"));
    const agentData = scenarioOf(hub, BLOCK).data;

    if (!reached) hub.loseNext("scenario.update");
    const stopped = stopOnNext("scenario.update");
    callUnanswered(client, "restore_native_change", {
      change_ref: changed.change_ref,
    });
    await stopped;
    if (reached) {
      assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
    } else {
      assert.equal(scenarioOf(hub, BLOCK).data, agentData);
    }

    const restarted = await connect();
    const sentBefore = hub.requests.length;
    const undone = await call(restarted, "restore_native_change", {
      change_refs: [changed.change_ref],
    });
    assert.equal(undone.status, "ok", JSON.stringify(undone.results));
    assert.equal(itemOf(undone, changed).sent, !reached);
    assert.equal(writesSince(hub, sentBefore).length, reached ? 0 : 1);
    assertOnlyWrites(hub, sentBefore, BLOCK);
    assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  });
}

test("after a lost undo of a BLOCK data change, the owner's edit of the scenario is kept and named changed by hand", async (t) => {
  const { hub, client } = await setup(t);
  const changed = await applied(client, blockDataInput(hub, "20"));
  hub.loseNext("scenario.update");
  const lost = await call(client, "restore_native_change", {
    change_ref: changed.change_ref,
  });
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));

  // The owner sets the night light to 30 in the app.
  const owner = blockDataInput(hub, "30").data;
  hub.request({
    scenario: { update: { index: BLOCK, data: JSON.stringify(owner) } },
  });
  const ownerData = scenarioOf(hub, BLOCK).data;

  const sentBefore = hub.requests.length;
  const refused = await call(client, "restore_native_change", {
    change_ref: changed.change_ref,
  });
  assert.equal(refused.status, "conflict", JSON.stringify(refused));
  assert.equal(refused.conflict_reason, "manual_change");
  const undone = await call(client, "restore_native_change", {
    change_refs: [changed.change_ref],
  });
  const item = itemOf(undone, changed);
  assert.equal(item.status, "skipped");
  assert.equal(item.reason, "changed_since");
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.equal(scenarioOf(hub, BLOCK).data, ownerData);
});

// The agent's own later change of the scenario hides what the earlier
// unknown write did; it is named, not taken for a change by hand, and
// undoing both puts the scenario back.
for (const reached of [false, true]) {
  test(`after a lost undo of a LOGIC code change that ${reached ? "reached" : "never reached"} the hub, the agent's next code change of it is its own and «верни как было» puts both back`, async (t) => {
    const { hub, client, connect, stopOnNext } = await setup(t);
    const initial = hub.snapshot();
    const source = scenarioOf(hub, LOGIC).data;
    const first = await applied(
      client,
      logicCodeInput(
        hub,
        'log("Протечка: розетка чайника отключена")',
        'log("Протечка: розетка отключена")',
      ),
    );
    if (!reached) hub.loseNext("scenario.update");
    const stopped = stopOnNext("scenario.update");
    callUnanswered(client, "restore_native_change", {
      change_ref: first.change_ref,
    });
    await stopped;
    const restarted = await connect();

    const second = await applied(
      restarted,
      logicCodeInput(
        hub,
        'description: "Отключает розетку чайника при протечке под мойкой"',
        'description: "Отключает чайник при протечке"',
      ),
    );
    const sentBefore = hub.requests.length;
    const read = await call(restarted, "get_native_change", {
      change_ref: first.change_ref,
    });
    assert.notEqual(read.status, "restored", JSON.stringify(read));
    assert.equal(read.conflict_reason, "later_owned_change");
    assert.equal(read.restore_first_change_ref, second.change_ref);
    assert.equal(read.manual_change_observed, undefined);
    const alone = await call(restarted, "restore_native_change", {
      change_refs: [first.change_ref],
    });
    assert.equal(itemOf(alone, first).reason, "later_change");
    assert.equal(itemOf(alone, first).later_change_ref, second.change_ref);
    assert.deepEqual(writesSince(hub, sentBefore), []);

    const undone = await call(restarted, "restore_native_change", {
      change_refs: [first.change_ref, second.change_ref],
    });
    assert.equal(undone.status, "ok", JSON.stringify(undone.results));
    assert.equal(itemOf(undone, first).sent, !reached);
    assertOnlyWrites(hub, sentBefore, LOGIC);
    assert.equal(scenarioOf(hub, LOGIC).data, source);
    assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  });
}

// A BLOCK the agent creates: a button that turns the chandelier off.
const CREATED_BLOCK_NAME = "Выключить люстру";
const createdBlockInput = {
  operation: "block_create",
  target_ref: homeRef,
  name: CREATED_BLOCK_NAME,
  description: "Выключает люстру в гостиной",
  active: true,
  on_start: false,
  sync: false,
  data: {
    targets: [
      {
        type: "service",
        aId: 15,
        sId: 13,
        hs: "Lightbulb",
        characteristics: [{ type: "set", cId: 14, hc: "On", value: "false" }],
      },
    ],
  },
  reason: "Кнопка «выключить люстру»",
};

test("a BLOCK the agent created whose undo request was lost is deleted by restoring again", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const created = await applied(client, createdBlockInput);
  hub.loseNext("scenario.delete");
  const lost = await call(client, "restore_native_change", {
    change_ref: created.change_ref,
  });
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));
  assert.notDeepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  assert.equal(lost.next.tool, "restore_native_change");

  const sentBefore = hub.requests.length;
  const finished = await call(client, lost.next.tool, lost.next.arguments);
  assert.equal(finished.status, "restored", JSON.stringify(finished));
  assert.deepEqual(
    writesSince(hub, sentBefore).map(({ method }) => method),
    ["scenario.delete"],
  );
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// The apply never reached the hub: the scenario is as it was, and the undo
// writes nothing. That apply stays unconfirmed, as a setting's does: a
// write without an answer is never taken for one that cannot arrive.
test("«верни как было» after a BLOCK data change whose apply never reached the hub writes nothing and says the apply is unconfirmed", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const prepared = await call(
    client,
    "prepare_native_change",
    blockDataInput(hub, "20"),
  );
  hub.loseNext("scenario.update");
  const lost = await call(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));

  const sentBefore = hub.requests.length;
  const undone = await call(client, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });
  const item = itemOf(undone, prepared);
  assert.equal(item.status, "uncertain", JSON.stringify(item));
  assert.equal(item.reason, "apply_unconfirmed");
  assert.equal(item.sent, false);
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

test("a BLOCK data change whose apply reached the hub before the MCP server stopped is undone in one call after restart", async (t) => {
  const { hub, client, connect, stopOnNext } = await setup(t);
  const initial = hub.snapshot();
  const prepared = await call(
    client,
    "prepare_native_change",
    blockDataInput(hub, "20"),
  );
  const stopped = stopOnNext("scenario.update");
  callUnanswered(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  await stopped;
  assert.notDeepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);

  const restarted = await connect();
  const sentBefore = hub.requests.length;
  const undone = await call(restarted, "restore_native_change", {
    change_refs: [prepared.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone.results));
  assert.equal(itemOf(undone, prepared).sent, true);
  assert.equal(writesSince(hub, sentBefore).length, 1);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

test("a BLOCK data change whose apply reached the hub before the MCP server stopped, then changed again by the agent, is not taken for a change by hand", async (t) => {
  const { hub, client, connect, stopOnNext } = await setup(t);
  const initial = hub.snapshot();
  const prepared = await call(
    client,
    "prepare_native_change",
    blockDataInput(hub, "20"),
  );
  const stopped = stopOnNext("scenario.update");
  callUnanswered(client, "apply_native_change", {
    change_ref: prepared.change_ref,
  });
  await stopped;
  const restarted = await connect();
  const later = await applied(restarted, blockDataInput(hub, "40"));

  const sentBefore = hub.requests.length;
  const read = await call(restarted, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(
    read.conflict_reason,
    "later_owned_change",
    JSON.stringify(read),
  );
  assert.equal(read.restore_first_change_ref, later.change_ref);
  assert.deepEqual(writesSince(hub, sentBefore), []);

  const undone = await call(restarted, "restore_native_change", {
    change_refs: [prepared.change_ref, later.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone.results));
  assertOnlyWrites(hub, sentBefore, BLOCK);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

// A scenario's setting in its options window: the agent renames it, its
// undo is lost, and it renames it again.
test("after a lost undo of a scenario rename, the agent's next rename is its own and «верни как было» puts the first name back", async (t) => {
  const { hub, client } = await setup(t);
  const initial = hub.snapshot();
  const first = await applied(client, renameInput("Ночь"));
  hub.loseNext("window.update");
  const lost = await call(client, "restore_native_change", {
    change_ref: first.change_ref,
  });
  assert.equal(lost.status, "uncertain", JSON.stringify(lost));
  assert.equal(scenarioOf(hub, BLOCK).name, "Ночь");
  const second = await applied(client, renameInput("Ночь, свет"));

  const sentBefore = hub.requests.length;
  const read = await call(client, "get_native_change", {
    change_ref: first.change_ref,
  });
  assert.equal(
    read.conflict_reason,
    "later_owned_change",
    JSON.stringify(read),
  );
  assert.equal(read.restore_first_change_ref, second.change_ref);
  assert.equal(read.manual_change_observed, undefined);
  assert.deepEqual(writesSince(hub, sentBefore), []);

  const undone = await call(client, "restore_native_change", {
    change_refs: [first.change_ref, second.change_ref],
  });
  assert.equal(undone.status, "ok", JSON.stringify(undone.results));
  assert.equal(writesSince(hub, sentBefore).length, 2);
  assertOnlyWrites(hub, sentBefore, BLOCK);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
});

test("after a lost undo of a scenario rename and the agent's next rename, the owner's own rename is kept", async (t) => {
  const { hub, client } = await setup(t);
  const first = await applied(client, renameInput("Ночь"));
  hub.loseNext("window.update");
  await call(client, "restore_native_change", {
    change_ref: first.change_ref,
  });
  const second = await applied(client, renameInput("Ночь, свет"));
  hub.request({
    window: {
      update: {
        windowKey: scenarioOf(hub, BLOCK).optionsWindow,
        options: [{ key: "Name", value: { stringValue: "Сон" } }],
      },
    },
  });

  const sentBefore = hub.requests.length;
  const undone = await call(client, "restore_native_change", {
    change_refs: [first.change_ref, second.change_ref],
  });
  assert.deepEqual(
    undone.results.map(({ change_ref: ref, status, reason }) => [
      ref,
      status,
      reason,
    ]),
    [
      [second.change_ref, "skipped", "changed_since"],
      [first.change_ref, "skipped", "changed_since"],
    ],
  );
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.equal(scenarioOf(hub, BLOCK).name, "Сон");
});

for (const direction of ["undo", "apply"]) {
  test(`a scenario rename whose ${direction} reached the hub before the MCP server stopped, then renamed again by the agent, is put back by «верни как было»`, async (t) => {
    const { hub, client, connect, stopOnNext } = await setup(t);
    const initial = hub.snapshot();
    const first =
      direction === "undo"
        ? await applied(client, renameInput("Ночь"))
        : await call(client, "prepare_native_change", renameInput("Ночь"));
    const stopped = stopOnNext("window.update");
    callUnanswered(
      client,
      direction === "undo" ? "restore_native_change" : "apply_native_change",
      { change_ref: first.change_ref },
    );
    await stopped;
    const restarted = await connect();
    const second = await applied(restarted, renameInput("Ночь, свет"));

    const sentBefore = hub.requests.length;
    const read = await call(restarted, "get_native_change", {
      change_ref: first.change_ref,
    });
    assert.equal(
      read.conflict_reason,
      "later_owned_change",
      JSON.stringify(read),
    );
    assert.equal(read.restore_first_change_ref, second.change_ref);
    assert.deepEqual(writesSince(hub, sentBefore), []);

    const undone = await call(restarted, "restore_native_change", {
      change_refs: [first.change_ref, second.change_ref],
    });
    assert.equal(undone.status, "ok", JSON.stringify(undone.results));
    assertOnlyWrites(hub, sentBefore, BLOCK);
    assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  });
}

// Two changes of one scenario, the later built on the earlier. The later
// one's undo takes effect, but its outcome is not read: the read right
// after its write fails, or the MCP server stops first. The earlier one's
// undo then goes on, as the hub shows it in place, which it does only
// because the later undo took effect. That later undo is the agent's own
// and done, never a change by hand.
const CHAINS = [
  {
    name: "two BLOCK data changes",
    write: "scenario.update",
    read: "scenario.get",
    inputs: [
      (hub) => blockDataInput(hub, "20"),
      (hub) => blockDataInput(hub, "40"),
    ],
  },
  {
    name: "two scenario renames",
    write: "window.update",
    read: "window.get",
    inputs: [() => renameInput("Ночь"), () => renameInput("Ночь, свет")],
  },
];

async function assertBothUndone(hub, client, initial, first, second) {
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
  const sentBefore = hub.requests.length;
  const read = await call(client, "get_native_change", {
    change_ref: second.change_ref,
  });
  assert.equal(read.status, "restored", JSON.stringify(read));
  assert.equal(read.manual_change_observed, undefined);
  const again = await call(client, "restore_native_change", {
    change_refs: [first.change_ref, second.change_ref],
  });
  assert.equal(again.status, "ok", JSON.stringify(again.results));
  assert.deepEqual(writesSince(hub, sentBefore), []);
  assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
}

for (const { name, write, read, inputs } of CHAINS) {
  test(`«верни как было» over ${name} whose later undo was not read back puts both back and never names that undo a change by hand`, async (t) => {
    const { hub, client, onNext } = await setup(t);
    const initial = hub.snapshot();
    const first = await applied(client, inputs[0](hub));
    const second = await applied(client, inputs[1](hub));
    // The read right after the later undo's write fails once.
    const armed = onNext(write, () => hub.refuseNext(read));
    const undone = await call(client, "restore_native_change", {
      change_refs: [first.change_ref, second.change_ref],
    });
    await armed;
    assert.equal(
      itemOf(undone, second).status,
      "uncertain",
      JSON.stringify(undone.results),
    );
    assert.equal(itemOf(undone, first).status, "restored");
    await assertBothUndone(hub, client, initial, first, second);
  });

  test(`after the MCP server stopped during the undo of the later of ${name}, undoing the earlier one alone settles the later undo as done`, async (t) => {
    const { hub, client, connect, stopOnNext } = await setup(t);
    const initial = hub.snapshot();
    const first = await applied(client, inputs[0](hub));
    const second = await applied(client, inputs[1](hub));
    const stopped = stopOnNext(write);
    callUnanswered(client, "restore_native_change", {
      change_ref: second.change_ref,
    });
    await stopped;
    const restarted = await connect();
    const earlier = await call(restarted, "restore_native_change", {
      change_ref: first.change_ref,
    });
    assert.equal(earlier.status, "restored", JSON.stringify(earlier));
    await assertBothUndone(hub, restarted, initial, first, second);
  });
}

// The first delete of a created BLOCK got no answer and arrives at the hub
// late: right before the delete the next restore sends, which then finds
// nothing to delete, or between the read that finds the BLOCK still there
// and the one the restore checks again before deleting. The BLOCK is gone
// as the undo wanted.
for (const when of ["the resent delete", "the read before it"]) {
  test(`a resent undo of a created BLOCK whose late first delete arrives before ${when} is settled as done`, async (t) => {
    const { hub, client, onNext } = await setup(t);
    const initial = hub.snapshot();
    const created = await applied(client, createdBlockInput);
    const index = hub.state.scenarios.find(
      ({ name }) => name === CREATED_BLOCK_NAME,
    ).index;
    hub.loseNext("scenario.delete");
    const lost = await call(client, "restore_native_change", {
      change_ref: created.change_ref,
    });
    assert.equal(lost.status, "uncertain", JSON.stringify(lost));

    const firstDelete = () => hub.request({ scenario: { delete: { index } } });
    // The read that settles the lost delete passes; the next one meets it.
    const late =
      when === "the resent delete"
        ? onNext("scenario.delete", firstDelete)
        : onNext("scenario.get", () => onNext("scenario.get", firstDelete));
    const finished = await call(client, "restore_native_change", {
      change_ref: created.change_ref,
    });
    await late;
    assert.equal(finished.status, "restored", JSON.stringify(finished));
    assert.deepEqual(diffHomeSnapshots(initial, hub.snapshot()), []);
    const read = await call(client, "get_native_change", {
      change_ref: created.change_ref,
    });
    assert.equal(read.status, "restored", JSON.stringify(read));
  });
}
