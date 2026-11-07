import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadHomeFixture,
  startSimulatedHub,
} from "./support/simulated-hub.mjs";

// MCP clients often pass an unfilled SPRUT_AGENT_STATE_DIR as an empty
// string. The change journal and configuration points must then stay in the
// default per-user state directory, so restore and command history survive a
// restart from another working directory.
const serverPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "server.mjs",
);
const homeRef = "spruthub://hub/sim-apartment-01";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startClient(t, hub, { cwd, home, stateDirectory, preload }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(preload ? ["--import", preload] : []), serverPath],
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...hub.connectionEnv(),
      SPRUTHUB_TIMEOUT_MS: "2000",
      SPRUT_AGENT_STATE_DIR: stateDirectory,
      XDG_STATE_HOME: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "state-directory-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => client.close());
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

test("a blank state directory keeps history in the user state directory across working directories", async (t) => {
  for (const stateDirectory of ["", " "]) {
    await t.test(JSON.stringify(stateDirectory), (t) =>
      historySurvivesAnotherWorkingDirectory(t, stateDirectory),
    );
  }
});

async function historySurvivesAnotherWorkingDirectory(t, stateDirectory) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const home = await temporaryDirectory(t, "sprut-agent-state-home-");
  const firstCwd = await temporaryDirectory(t, "sprut-agent-state-cwd-a-");
  const secondCwd = await temporaryDirectory(t, "sprut-agent-state-cwd-b-");

  const firstClient = await startClient(t, hub, {
    cwd: firstCwd,
    home,
    stateDirectory,
  });
  const prepared = await call(firstClient, "prepare_native_change", {
    operation: "characteristic_value",
    target_ref: `${homeRef}/accessory/16/service/13/characteristic/15`,
    value: 30,
    reason: "Приглушить торшер",
  });
  const point = await call(firstClient, "configuration_point", {
    home_ref: homeRef,
    entity_refs: [`${homeRef}/scenario/3`],
  });
  await firstClient.close();

  assert.deepEqual(await readdir(firstCwd), []);
  const secondClient = await startClient(t, hub, {
    cwd: secondCwd,
    home,
    stateDirectory,
  });
  const change = await call(secondClient, "get_native_change", {
    change_ref: prepared.change_ref,
  });
  assert.equal(change.status, "prepared");
  const points = await call(secondClient, "configuration_point", {
    home_ref: homeRef,
  });
  assert.deepEqual(
    points.points.map(({ point_ref }) => point_ref),
    [point.point_ref],
  );
  assert.deepEqual(await readdir(secondCwd), []);
}

// A network share or an exFAT disk has no hard links, and the journal's lock
// needs them. The owner hears that and what to do; reads go on.
test("a state directory without hard links names the reason for every write", async (t) => {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const stateDirectory = await temporaryDirectory(t, "sprut-agent-no-links-");
  const client = await startClient(t, hub, {
    cwd: stateDirectory,
    home: stateDirectory,
    stateDirectory,
    preload: pathToFileURL(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "support",
        "no-hard-links.mjs",
      ),
    ).href,
  });

  const assertNamesTheReason = (error) => {
    assert.equal(
      error.code,
      "state_storage_unavailable",
      JSON.stringify(error),
    );
    assert.equal(error.action, "restore_state_storage_then_retry");
    assert.match(error.message, /hard links/i);
    assert.ok(error.message.includes(stateDirectory), error.message);
    assert.match(error.message, /SPRUT_AGENT_STATE_DIR/);
  };

  const overview = await call(client, "home_overview", {});
  assert.equal(overview.home.ref, homeRef);

  const room = await client.callTool({
    name: "prepare_native_change",
    arguments: {
      operation: "room_create",
      target_ref: homeRef,
      name: "Кладовка",
      reason: "Завести кладовку",
    },
  });
  assert.equal(room.isError, true, room.content[0]?.text);
  assertNamesTheReason(room.structuredContent.error);

  const before = hub.requests.length;
  const command = await call(client, "send_device_commands", {
    home_ref: homeRef,
    commands: [
      {
        target_ref: `${homeRef}/accessory/12/service/13/characteristic/14`,
        value: true,
      },
    ],
    reason: "Включить свет",
  });
  const [item] = command.results;
  assert.equal(item.status, "not_sent", JSON.stringify(item));
  assertNamesTheReason(item.error);
  assert.deepEqual(
    hub.requests
      .slice(before)
      .filter(({ method }) => method === "characteristic.update"),
    [],
  );
});

// A journal or state directory that fails is named as that, not as a room of
// the hub, whichever call meets it first, and with what can be done about it.
const journalOf = async (directory) =>
  path.join(
    directory,
    (await readdir(directory)).find((entry) =>
      /^automation-changes-[0-9a-f]+\.json$/.test(entry),
    ),
  );

const JOURNAL_CALLS = (changeRef) => [
  ["get", "get_native_change", { change_ref: changeRef }],
  ["apply", "apply_native_change", { change_ref: changeRef }],
  ["restore", "restore_native_change", { change_ref: changeRef }],
  ["batch restore", "restore_native_change", { change_refs: [changeRef] }],
  [
    "prepare pause",
    "prepare_native_change",
    {
      operation: "block_action_pause",
      target_ref: `${homeRef}/scenario/14`,
      action_pointer: "/targets/0/then/0",
      duration_seconds: 600,
      reason: "Пауза",
    },
  ],
  [
    "prepare room",
    "prepare_native_change",
    {
      operation: "room_create",
      target_ref: homeRef,
      name: "Кладовка",
      reason: "Завести кладовку",
    },
  ],
];

async function clientWithOwnState(t, prefix) {
  const hub = await startSimulatedHub(await loadHomeFixture("apartment"));
  t.after(() => hub.close());
  const stateDirectory = await temporaryDirectory(t, prefix);
  const home = await temporaryDirectory(t, "sprut-agent-home-");
  const client = await startClient(t, hub, {
    cwd: home,
    home,
    stateDirectory,
  });
  return { hub, client, stateDirectory };
}

async function journalCase(t, damage) {
  const { hub, client, stateDirectory } = await clientWithOwnState(
    t,
    "sprut-agent-broken-",
  );
  const prepared = await call(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: homeRef,
    name: "Гараж",
    reason: "Завести гараж",
  });
  const journal = await journalOf(stateDirectory);
  await damage(journal, stateDirectory);
  const answers = [];
  for (const [label, tool, input] of JOURNAL_CALLS(prepared.change_ref)) {
    const answer = await client.callTool({ name: tool, arguments: input });
    assert.equal(answer.isError, true, `${label}: ${answer.content[0]?.text}`);
    answers.push([label, answer.structuredContent.error]);
  }
  return { hub, client, journal, stateDirectory, answers };
}

for (const [variant, contents, reason] of [
  ["not JSON", "{not json", /not valid JSON/i],
  ["of another version", '{"version":2,"changes":{}}', /version/i],
]) {
  test(`a journal ${variant}: every call names it, and nothing overwrites it`, async (t) => {
    const { hub, client, journal, answers } = await journalCase(t, (file) =>
      writeFile(file, contents, { mode: 0o600 }),
    );
    for (const [label, error] of answers) {
      assert.equal(error.code, "state_storage_unavailable", label);
      assert.equal(error.action, "restore_state_storage_then_retry", label);
      assert.ok(error.message.includes(journal), `${label}: ${error.message}`);
      assert.match(error.message, reason, label);
      // What the file holds and what moving it means, not a fix of the disk.
      assert.match(error.message, /undo/i, label);
      assert.match(error.message, /new journal/i, label);
      assert.match(error.message, /left as it is/i, label);
      assert.doesNotMatch(error.message, /writable/i, label);
    }
    const command = await client.callTool({
      name: "send_device_commands",
      arguments: {
        home_ref: homeRef,
        commands: [
          {
            target_ref: `${homeRef}/accessory/12/service/13/characteristic/14`,
            value: true,
          },
        ],
        reason: "Включить свет",
      },
    });
    const { error } = command.structuredContent;
    assert.equal(error.code, "state_storage_unavailable");
    assert.ok(error.message.includes(journal), error.message);
    assert.match(error.message, /nothing was sent/i);
    assert.deepEqual(hub.writes(), []);
    assert.equal(await readFile(journal, "utf8"), contents);
  });
}

for (const [variant, damage] of [
  [
    "a directory in place of the journal",
    async (file) => {
      await rm(file);
      await mkdir(file);
    },
  ],
  ["an unreadable journal", (file) => chmod(file, 0o000)],
  [
    "a file in place of the state directory",
    async (_file, directory) => {
      await rm(directory, { recursive: true, force: true });
      await writeFile(directory, "x");
    },
  ],
]) {
  test(`${variant}: every call names the file system`, async (t) => {
    const { answers, stateDirectory } = await journalCase(t, damage);
    for (const [label, error] of answers) {
      assert.equal(error.code, "state_storage_unavailable", label);
      assert.equal(error.action, "restore_state_storage_then_retry", label);
      assert.ok(
        error.message.includes(stateDirectory),
        `${label}: ${error.message}`,
      );
      assert.doesNotMatch(error.message, /not valid JSON|new journal/i, label);
      assertNamesWhereTheVariableGoes(error.message, label);
    }
  });
}

function assertNamesWhereTheVariableGoes(message, label) {
  assert.match(message, /SPRUT_AGENT_STATE_DIR/, label);
  assert.match(message, /environment of the MCP/i, label);
  assert.match(message, /connection\.env/, label);
}

test("a read-only state directory: a journal write names it, and reads go on", async (t) => {
  const { hub, client, stateDirectory } = await clientWithOwnState(
    t,
    "sprut-agent-read-only-",
  );
  const prepared = await call(client, "prepare_native_change", {
    operation: "room_create",
    target_ref: homeRef,
    name: "Гараж",
    reason: "Завести гараж",
  });
  await chmod(stateDirectory, 0o500);
  let refused;
  let seen;
  try {
    seen = await call(client, "get_native_change", {
      change_ref: prepared.change_ref,
    });
    refused = await client.callTool({
      name: "apply_native_change",
      arguments: { change_ref: prepared.change_ref },
    });
  } finally {
    await chmod(stateDirectory, 0o700);
  }
  assert.equal(seen.status, "prepared");
  const { error } = refused.structuredContent;
  assert.equal(error.code, "state_storage_unavailable", JSON.stringify(error));
  assert.ok(error.message.includes(stateDirectory), error.message);
  assertNamesWhereTheVariableGoes(error.message, "apply");
  assert.deepEqual(hub.writes(), []);
});

test("configuration points in a state directory that fails name it", async (t) => {
  const selected = {
    home_ref: homeRef,
    entity_refs: [`${homeRef}/scenario/3`],
  };
  const assertNamed = (answer, stateDirectory, label) => {
    assert.equal(answer.isError, true, label);
    const { error } = answer.structuredContent;
    assert.equal(error.code, "state_storage_unavailable", label);
    assert.equal(error.action, "restore_state_storage_then_retry", label);
    assert.ok(error.message.includes(stateDirectory), error.message);
    assertNamesWhereTheVariableGoes(error.message, label);
  };

  await t.test("read-only: the new point", async (t) => {
    const { client, stateDirectory } = await clientWithOwnState(
      t,
      "sprut-agent-points-",
    );
    await chmod(stateDirectory, 0o500);
    let answer;
    try {
      answer = await client.callTool({
        name: "configuration_point",
        arguments: selected,
      });
    } finally {
      await chmod(stateDirectory, 0o700);
    }
    assertNamed(answer, stateDirectory, "create");
  });

  await t.test(
    "a file in place of the directory: new point and list",
    async (t) => {
      const { client, stateDirectory } = await clientWithOwnState(
        t,
        "sprut-agent-points-",
      );
      await rm(stateDirectory, { recursive: true, force: true });
      await writeFile(stateDirectory, "x");
      assertNamed(
        await client.callTool({
          name: "configuration_point",
          arguments: selected,
        }),
        stateDirectory,
        "create",
      );
      assertNamed(
        await client.callTool({
          name: "configuration_point",
          arguments: { home_ref: homeRef },
        }),
        stateDirectory,
        "list",
      );
    },
  );
});
