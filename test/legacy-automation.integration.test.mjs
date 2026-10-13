import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";
import { FAKE_HUB_HOST, ORDINARY_HUB_TIMEOUT_MS } from "./support/fake-hub.mjs";

// Rules that the boolean automation tools of 0.4.0 and earlier created
// stay in the owner's journal under spruthub-change://automation refs. The
// tools are gone; these records are read by get_native_change and undone by
// restore_native_change. The fixture holds the records and scenarios as
// those tools wrote them.
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serial = "automation-test-hub";
const homeRef = `spruthub://hub/${serial}`;
const observedContext = JSON.parse(
  await readFile(
    new URL(
      "../research/protocol/2026-09-09-automation-context.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/legacy-boolean-automation.json", import.meta.url),
    "utf8",
  ),
);

async function startHub() {
  const requests = [];
  const state = {
    scenarios: [
      {
        index: "existing-block",
        name: "Существующий сценарий",
        type: "BLOCK",
        predefined: false,
        active: true,
      },
    ],
  };
  const server = new WebSocketServer({ host: FAKE_HUB_HOST, port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", async (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request.params);
      if (request.params.scenario?.list && state.closeNextScenarioList) {
        state.closeNextScenarioList = false;
        socket.close();
        return;
      }
      if (request.params.scenario?.delete && state.rejectNextDelete) {
        state.rejectNextDelete = false;
        socket.send(
          JSON.stringify({
            id: request.id,
            error: { code: 409, message: "Scenario rejected" },
          }),
        );
        return;
      }
      const result = respond(state, request.params);
      if (request.params.scenario?.list && state.afterScenarioList) {
        const afterScenarioList = state.afterScenarioList;
        state.afterScenarioList = undefined;
        await afterScenarioList();
      }
      if (request.params.scenario?.delete && state.afterDelete) {
        const afterDelete = state.afterDelete;
        state.afterDelete = undefined;
        await afterDelete();
      }
      if (request.params.scenario?.delete && state.incompatibleDeleteResponse) {
        state.incompatibleDeleteResponse = false;
        state.closeNextScenarioList = state.closeReadbackAfterWrite === true;
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { scenario: {} },
          }),
        );
        return;
      }
      if (
        request.params.scenario?.delete &&
        state.closeReadbackAfterSuccessfulWrite
      ) {
        state.closeReadbackAfterSuccessfulWrite = false;
        state.closeNextScenarioList = true;
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    requests,
    server,
    state,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function respond(state, params) {
  if (params.scenario?.list) {
    return { scenario: { list: { scenarios: state.scenarios } } };
  }
  if (params.scenario?.get) {
    const scenario = state.scenarios.find(
      ({ index }) => index === params.scenario.get.index,
    );
    if (!scenario) return { scenario: { get: null } };
    const observed = observedContext.scenarioGet.result.scenario.get;
    return {
      scenario: {
        get: {
          ...scenario,
          onStart: scenario.onStart ?? false,
          sync: scenario.sync ?? false,
          data: scenario.data ?? observed.data,
        },
      },
    };
  }
  if (params.scenario?.delete) {
    const index = state.scenarios.findIndex(
      ({ index }) => index === params.scenario.delete.index,
    );
    if (index >= 0 && !state.keepScenarioOnDelete)
      state.scenarios.splice(index, 1);
    return { scenario: { delete: {} } };
  }
  throw new Error(`Unexpected operation: ${JSON.stringify(params)}`);
}

async function startClient(t, hub, stateDirectory) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      SPRUTHUB_URL: hub.url,
      SPRUTHUB_TOKEN: "automation-test-token",
      SPRUTHUB_SERIAL: serial,
      SPRUTHUB_CID: "automation-test-client",
      SPRUTHUB_TIMEOUT_MS: String(ORDINARY_HUB_TIMEOUT_MS),
      SPRUT_AGENT_STATE_DIR: stateDirectory,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "automation-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);
  return client;
}

async function setup(t) {
  const hub = await startHub();
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-automation-"),
  );
  t.after(async () => {
    for (const socket of hub.server.clients) socket.terminate();
    await new Promise((resolve) => hub.server.close(resolve));
    await rm(stateDirectory, { recursive: true, force: true });
  });
  return { hub, stateDirectory };
}

// Puts one record of the fixture into the journal of this hub and, for an
// applied one, the scenario it created into the hub. id and index give a
// second copy its own record and scenario; edit changes the record.
async function seed(
  hub,
  stateDirectory,
  name,
  { id, index, edit = () => {} } = {},
) {
  const record = structuredClone(fixture[name]);
  const change = record.change;
  let scenario = record.hub_scenario;
  if (id !== undefined) {
    const marker = `sprut-agent:automation:${id}`;
    if (scenario) {
      scenario = {
        ...scenario,
        desc: scenario.desc.replace(change.marker, marker),
      };
    }
    Object.assign(change, { id, marker });
  }
  if (index !== undefined) {
    change.scenario_index = index;
    if (scenario) scenario = { ...scenario, index };
  }
  edit(change);
  const fingerprint = createHash("sha256")
    .update(`${hub.url}\0${serial}`)
    .digest("hex");
  const file = path.join(
    stateDirectory,
    `automation-changes-${fingerprint.slice(0, 24)}.json`,
  );
  let journal;
  try {
    journal = JSON.parse(await readFile(file, "utf8"));
  } catch {
    journal = { version: 1, hub_fingerprint: fingerprint, changes: {} };
  }
  journal.changes[change.id] = change;
  await writeFile(file, `${JSON.stringify(journal, null, 2)}\n`);
  if (scenario) hub.state.scenarios.push(scenario);
  return {
    changeRef: `spruthub-change://automation/${change.id}`,
    change,
    scenario,
  };
}

async function blockStateDirectory(t, stateDirectory) {
  const backupDirectory = `${stateDirectory}-backup`;
  await rename(stateDirectory, backupDirectory);
  await writeFile(stateDirectory, "local state storage unavailable\n");
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await rm(stateDirectory, { force: true });
    await rename(backupDirectory, stateDirectory);
    restored = true;
  };
  t.after(async () => {
    if (!restored) await rm(stateDirectory, { force: true });
    await rm(backupDirectory, { recursive: true, force: true });
  });
  return restore;
}

async function readStateJournal(stateDirectory) {
  const [file] = (await readdir(stateDirectory)).filter((name) =>
    name.startsWith("automation-changes-"),
  );
  return readFile(path.join(stateDirectory, file), "utf8");
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return result.structuredContent;
}

function deletes(hub) {
  return hub.requests.filter(({ scenario }) => scenario?.delete).length;
}

function scenarioExists(hub, index) {
  return hub.state.scenarios.some((scenario) => scenario.index === index);
}

test("the history lists an earlier automation by its devices and scenario", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  // A record of an even earlier version: no home_ref, refs without a home.
  const { changeRef, change } = await seed(hub, stateDirectory, "prepared", {
    edit(record) {
      delete record.home_ref;
      record.condition.characteristic.ref =
        "spruthub://accessory/32/service/13/characteristic/15";
      record.action.characteristic.ref =
        "spruthub://accessory/34/service/13/characteristic/15";
      record.scenario_index = "23";
    },
  });
  const client = await startClient(t, hub, stateDirectory);

  const history = await call(client, "get_native_change", {
    entity_ref: `${homeRef}/scenario/23`,
  });
  assert.deepEqual(history.changes, [
    {
      change_ref: changeRef,
      operation: "legacy_boolean_automation",
      name: change.name,
      reason: change.reason,
      target_ref: `${homeRef}/scenario/23`,
      recorded_status: "prepared",
      created_at: change.created_at,
      updated_at: change.updated_at,
      next: { tool: "get_native_change", arguments: { change_ref: changeRef } },
    },
  ]);
  for (const ref of [
    `${homeRef}/accessory/32/service/13/characteristic/15`,
    `${homeRef}/accessory/34/service/13/characteristic/15`,
    `${homeRef}/accessory/32`,
    `${homeRef}/accessory/32/service/13`,
    `${homeRef}/accessory/34`,
    `${homeRef}/accessory/34/service/13`,
  ]) {
    const found = await call(client, "get_native_change", { entity_ref: ref });
    assert.deepEqual(
      found.changes.map(({ change_ref: listed }) => listed),
      [changeRef],
      ref,
    );
  }
});

test("an earlier automation is read back as applied and owned after a restart", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  const client = await startClient(t, hub, stateDirectory);

  const status = await call(client, "get_native_change", {
    change_ref: changeRef,
  });

  assert.equal(status.status, "applied");
  assert.equal(status.change_ref, changeRef);
  assert.equal(status.scenario_index, scenario.index);
  assert.equal(status.owned, true);
  assert.equal(status.configuration_matches, true);
  assert.equal(deletes(hub), 0);
});

test("an earlier automation the hub stores without if defaults stays owned and is undone", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  // A hub that keeps an if without the defaults the official web client
  // also leaves out: mode EVERY, zero branch delays and an empty else
  // (research/protocol/2026-09-24-web-client-evidence.md).
  const data = JSON.parse(scenario.data);
  for (const key of ["mode", "then_delay", "else_delay", "else"]) {
    delete data.targets[0][key];
  }
  scenario.data = JSON.stringify(data);
  const client = await startClient(t, hub, stateDirectory);

  const status = await call(client, "get_native_change", {
    change_ref: changeRef,
  });
  assert.equal(status.status, "applied");
  const restored = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(restored.status, "rolled_back");
  assert.equal(restored.removed, true);
  assert.equal(scenarioExists(hub, scenario.index), false);
});

test("an earlier automation's runtime state does not block its status or undo", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  const executedData = JSON.parse(scenario.data);
  executedData.targets[0].state = true;
  scenario.data = JSON.stringify(executedData);
  const client = await startClient(t, hub, stateDirectory);

  const status = await call(client, "get_native_change", {
    change_ref: changeRef,
  });
  const restored = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });

  assert.equal(status.status, "applied");
  assert.equal(status.configuration_matches, true);
  assert.equal(restored.status, "rolled_back");
  assert.equal(scenarioExists(hub, scenario.index), false);
});

test("an earlier automation turned off in the SprutHub interface stays owned and is undone", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  scenario.active = false;
  const client = await startClient(t, hub, stateDirectory);

  const status = await call(client, "get_native_change", {
    change_ref: changeRef,
  });
  assert.equal(status.status, "applied");
  assert.equal(status.owned, true);

  const restored = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(restored.status, "rolled_back");
  assert.deepEqual(
    hub.requests
      .filter(({ scenario: request }) => request?.delete)
      .map(({ scenario: request }) => request.delete),
    [{ index: scenario.index }],
  );
  assert.equal(scenarioExists(hub, scenario.index), false);
});

test("an auto-off journal of an earlier version matches after SprutHub assigns block IDs", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(
    hub,
    stateDirectory,
    "applied_auto_off",
    {
      edit(record) {
        const legacyDelay = record.native_data.targets[0].then[1];
        delete legacyDelay.blockId;
        legacyDelay.targets[0].blockId = 6;
        legacyDelay.targets[0].characteristics[0].blockId = 7;
      },
    },
  );
  const normalizedData = JSON.parse(scenario.data);
  const normalizedDelay = normalizedData.targets[0].then[1];
  normalizedDelay.blockId = 6;
  normalizedDelay.targets[0].blockId = 7;
  normalizedDelay.targets[0].characteristics[0].blockId = 8;
  scenario.data = JSON.stringify(normalizedData);
  const journalBeforeStatus = await readStateJournal(stateDirectory);
  const client = await startClient(t, hub, stateDirectory);

  const result = await call(client, "get_native_change", {
    change_ref: changeRef,
  });

  assert.equal(result.status, "applied");
  assert.equal(result.owned, true);
  assert.equal(result.configuration_matches, true);
  assert.equal(await readStateJournal(stateDirectory), journalBeforeStatus);
  assert.equal(deletes(hub), 0);
});

test("undo keeps an earlier automation whose configuration was changed by hand", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  const manuallyEditedData = JSON.parse(scenario.data);
  manuallyEditedData.targets[0].manual_extension = true;
  scenario.data = JSON.stringify(manuallyEditedData);
  const client = await startClient(t, hub, stateDirectory);

  const restored = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });

  assert.equal(restored.status, "conflict");
  assert.equal(restored.action, "review_manual_changes");
  assert.equal(scenarioExists(hub, scenario.index), true);
  assert.equal(deletes(hub), 0);
});

test("undo deletes only an unchanged earlier automation and keeps a renamed one", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const unchanged = await seed(hub, stateDirectory, "applied");
  const renamed = await seed(hub, stateDirectory, "applied", {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    index: "created-2",
  });
  renamed.scenario.name = "Ручная правка после создания";
  const client = await startClient(t, hub, stateDirectory);

  const restored = await call(client, "restore_native_change", {
    change_ref: unchanged.changeRef,
  });
  assert.equal(restored.status, "rolled_back");
  assert.equal(scenarioExists(hub, unchanged.scenario.index), false);

  const refused = await call(client, "restore_native_change", {
    change_ref: renamed.changeRef,
  });
  assert.equal(refused.status, "conflict");
  assert.equal(refused.action, "review_manual_changes");
  assert.equal(scenarioExists(hub, renamed.scenario.index), true);
  assert.equal(deletes(hub), 1);
});

test("undo of earlier automations in change_refs says whether each delete was sent", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const item = (result, ref) =>
    result.results.find(({ change_ref: listed }) => listed === ref);
  // Its creation never became known, and no rule like it is on the hub:
  // nothing is deleted.
  const unknown = await seed(hub, stateDirectory, "prepared", {
    edit(record) {
      record.status = "uncertain";
      record.apply_started_at = record.updated_at;
    },
  });
  const client = await startClient(t, hub, stateDirectory);
  const notSent = item(
    await call(client, "restore_native_change", {
      change_refs: [unknown.changeRef],
    }),
    unknown.changeRef,
  );
  assert.equal(notSent.status, "uncertain");
  assert.equal(notSent.sent, false);
  assert.equal(notSent.reason, "apply_unconfirmed");
  assert.deepEqual(notSent.next, {
    tool: "get_native_change",
    arguments: { change_ref: unknown.changeRef },
  });
  assert.equal(deletes(hub), 0);

  const unchanged = await seed(hub, stateDirectory, "applied");
  const lost = await seed(hub, stateDirectory, "applied", {
    id: "bbbbbbbbbbbbbbbbbbbbbbbb",
    index: "created-2",
  });
  const restored = item(
    await call(client, "restore_native_change", {
      change_refs: [unchanged.changeRef],
    }),
    unchanged.changeRef,
  );
  assert.equal(restored.status, "restored");
  assert.equal(restored.operation, "legacy_boolean_automation");
  assert.equal(deletes(hub), 1);

  // Its delete got no usable answer: the delete was sent.
  hub.state.incompatibleDeleteResponse = true;
  hub.state.closeReadbackAfterWrite = true;
  const sent = item(
    await call(client, "restore_native_change", {
      change_refs: [lost.changeRef],
    }),
    lost.changeRef,
  );
  assert.equal(sent.status, "uncertain");
  assert.equal(sent.sent, true);
  assert.equal(sent.reason, "restore_unconfirmed");
  assert.equal(deletes(hub), 2);
});

test("undo keeps an earlier automation whose ownership marker was removed by hand", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  scenario.desc = "Ручное описание без маркера";
  const client = await startClient(t, hub, stateDirectory);

  const result = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.owned, false);
  assert.equal(result.action, "review_manual_changes");
  assert.equal(scenarioExists(hub, scenario.index), true);
  assert.equal(deletes(hub), 0);
});

test("the status of an earlier conflicting automation names the equivalent rule once it matches", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const owner = await seed(hub, stateDirectory, "applied");
  // Applied while the owner's rule was turned off, it was a conflict and
  // created nothing.
  const foreign = await seed(hub, stateDirectory, "prepared", {
    edit(record) {
      Object.assign(record, {
        name: "Внешнее правило",
        status: "conflict",
        owned: false,
        conflict_reason: "equivalent_rule_runtime_mismatch",
        scenario_index: owner.scenario.index,
        apply_started_at: record.updated_at,
      });
    },
  });
  const journalBeforeStatus = await readStateJournal(stateDirectory);
  const client = await startClient(t, hub, stateDirectory);

  const result = await call(client, "get_native_change", {
    change_ref: foreign.changeRef,
  });

  assert.equal(result.status, "already_present");
  assert.equal(result.scenario_index, owner.scenario.index);
  assert.equal(result.owned, false);
  assert.equal(result.configuration_matches, true);
  assert.equal(await readStateJournal(stateDirectory), journalBeforeStatus);
  assert.equal(deletes(hub), 0);
});

test("an incompatible delete response is reconciled after restart without another delete", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef } = await seed(hub, stateDirectory, "applied");
  const firstClient = await startClient(t, hub, stateDirectory);
  hub.state.incompatibleDeleteResponse = true;
  hub.state.closeReadbackAfterWrite = true;

  const uncertain = await call(firstClient, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.action, "inspect_hub_before_retry");
  assert.equal(deletes(hub), 1);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const journalBeforeStatus = await readStateJournal(stateDirectory);
  const recovered = await call(secondClient, "get_native_change", {
    change_ref: changeRef,
  });
  assert.equal(await readStateJournal(stateDirectory), journalBeforeStatus);
  const repeated = await call(secondClient, "restore_native_change", {
    change_ref: changeRef,
  });

  assert.equal(recovered.status, "rolled_back");
  assert.equal(repeated.status, "rolled_back");
  assert.equal(deletes(hub), 1);
});

test("a failed readback after a successful delete stays recoverable", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef } = await seed(hub, stateDirectory, "applied");
  const firstClient = await startClient(t, hub, stateDirectory);
  hub.state.closeReadbackAfterSuccessfulWrite = true;

  const uncertain = await call(firstClient, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(deletes(hub), 1);
  await firstClient.close();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await call(secondClient, "get_native_change", {
    change_ref: changeRef,
  });
  assert.equal(recovered.status, "rolled_back");
  assert.equal(deletes(hub), 1);
});

test("a confirmed delete reports its hub effect when the final journal save fails", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef } = await seed(hub, stateDirectory, "applied");
  const firstClient = await startClient(t, hub, stateDirectory);
  let restoreStateDirectory;
  hub.state.afterDelete = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const result = await call(firstClient, "restore_native_change", {
    change_ref: changeRef,
  });

  assert.equal(result.status, "rolled_back");
  assert.equal(result.change_ref, changeRef);
  assert.equal(result.removed, true);
  assert.deepEqual(result.local_state, {
    saved: false,
    action: "restore_state_storage_then_get_native_change",
  });
  assert.equal(deletes(hub), 1);
  await firstClient.close();
  await restoreStateDirectory();

  const secondClient = await startClient(t, hub, stateDirectory);
  const recovered = await call(secondClient, "get_native_change", {
    change_ref: changeRef,
  });
  const repeated = await call(secondClient, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(recovered.status, "rolled_back");
  assert.equal(repeated.status, "rolled_back");
  assert.equal(deletes(hub), 1);
});

test("undo of an earlier automation does not delete when its recovery intent cannot be saved", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef } = await seed(hub, stateDirectory, "applied");
  const client = await startClient(t, hub, stateDirectory);
  let restoreStateDirectory;
  hub.state.afterScenarioList = async () => {
    restoreStateDirectory = await blockStateDirectory(t, stateDirectory);
  };

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: changeRef },
  });

  assert.equal(refused.isError, true);
  assert.equal(
    refused.structuredContent.error.code,
    "state_storage_unavailable",
  );
  assert.equal(
    refused.structuredContent.error.action,
    "restore_state_storage_then_retry",
  );
  assert.equal(deletes(hub), 0);
  await restoreStateDirectory();

  const retried = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(retried.status, "rolled_back");
  assert.equal(deletes(hub), 1);
});

test("a successful delete response cannot claim an undo while the scenario remains", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  const client = await startClient(t, hub, stateDirectory);
  hub.state.keepScenarioOnDelete = true;

  const uncertain = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(scenarioExists(hub, scenario.index), true);

  hub.state.keepScenarioOnDelete = false;
  const retried = await call(client, "restore_native_change", {
    change_ref: changeRef,
  });
  assert.equal(retried.status, "rolled_back");
  assert.equal(deletes(hub), 2);
});

test("a delete of an earlier automation the hub refuses is a rejection and leaves it applied", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const { changeRef, scenario } = await seed(hub, stateDirectory, "applied");
  const client = await startClient(t, hub, stateDirectory);
  hub.state.rejectNextDelete = true;

  const refused = await client.callTool({
    name: "restore_native_change",
    arguments: { change_ref: changeRef },
  });

  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, "request_rejected");
  assert.equal(refused.structuredContent.change_ref, changeRef);
  assert.equal(refused.structuredContent.hub_effect, "not_applied");
  assert.equal(refused.structuredContent.rejection.protocol_code, 409);
  assert.equal(scenarioExists(hub, scenario.index), true);
  assert.equal(
    (await call(client, "get_native_change", { change_ref: changeRef })).status,
    "applied",
  );
});

test("an automation ref that names a native change or nothing is not found", async (t) => {
  const { hub, stateDirectory } = await setup(t);
  const client = await startClient(t, hub, stateDirectory);

  for (const tool of ["get_native_change", "restore_native_change"]) {
    const missing = await client.callTool({
      name: tool,
      arguments: {
        change_ref: "spruthub-change://automation/cccccccccccccccccccccccc",
      },
    });
    assert.equal(missing.isError, true, tool);
    assert.equal(missing.structuredContent.error.code, "change_not_found");
  }
  assert.equal(deletes(hub), 0);
});
