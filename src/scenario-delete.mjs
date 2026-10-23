import { isDeepStrictEqual } from "node:util";
import { parse } from "@babel/parser";
import { blockScenarioTargets, canonicalBlock } from "./block-model.mjs";
import { isRecord } from "./change-refs.mjs";
import { mapWithConcurrency } from "./device-commands.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

// Deleting a scenario the owner names (scenario_delete). On SprutHub 3.0.0
// (research/protocol/2026-10-23-scenario-delete.md) scenario.delete removes
// a BLOCK, LOGIC or GLOBAL whether it is on or off, refuses nothing for
// what depends on it and leaves the other scenarios' numbers as they are.
// Scenario targets of other BLOCKs keep pointing at the deleted number, a
// LOGIC's device assignments go with it, and scenario.create from the
// stored fields brings it back whole, but under a new number: the hub's
// counter does not give a deleted number out again until it is reset,
// which happened once between 2026-09-24 and 2026-10-23.

export const SCENARIO_DELETE = "scenario_delete";
const DELETABLE_TYPES = new Set(["BLOCK", "LOGIC", "GLOBAL"]);
// Scenarios read at once while their dependencies are traced.
const SCENARIO_READ_CONCURRENCY = 8;

// Everything scenario.create needs to bring the scenario back, as the hub
// stores it: the code or BLOCK data text exactly as read.
export function deleteSnapshot(scenario) {
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.desc !== "string" ||
    typeof scenario.active !== "boolean" ||
    typeof scenario.onStart !== "boolean" ||
    typeof scenario.sync !== "boolean" ||
    typeof scenario.type !== "string" ||
    typeof scenario.data !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incomplete scenario configuration.",
    );
  }
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    type: scenario.type,
    name: scenario.name,
    desc: scenario.desc,
    active: scenario.active,
    onStart: scenario.onStart,
    sync: scenario.sync,
    data: scenario.data,
  };
}

export function refuseUndeletable(snapshot) {
  if (snapshot.predefined) {
    throw new SprutHubError(
      "built_in_scenario",
      "This is one of SprutHub's built-in scenarios; they are not deleted.",
    );
  }
  if (!DELETABLE_TYPES.has(snapshot.type)) {
    throw new SprutHubError(
      "unsupported_scenario_type",
      `Deleting a ${snapshot.type} scenario is not supported; only BLOCK, LOGIC and GLOBAL scenarios are deleted.`,
    );
  }
}

// What the owner set and the delete would lose. On/off is left out: other
// scenarios switch scenarios on and off as they run, and the scenario is
// recreated as it was at the delete.
export function deleteFieldsDiffering(saved, current) {
  return ["type", "name", "desc", "onStart", "sync", "data"].filter(
    (field) =>
      !isDeepStrictEqual(
        comparableField(saved, field),
        comparableField(current, field),
      ),
  );
}

function comparableField(snapshot, field) {
  if (field !== "data" || snapshot.type !== "BLOCK") return snapshot[field];
  // A running BLOCK changes the state of its ifs, and the hub numbers nodes
  // again on a write: compared in the one canonical BLOCK form.
  try {
    return canonicalBlock(JSON.parse(snapshot.data));
  } catch {
    return snapshot.data;
  }
}

export function recreateRequest(snapshot) {
  return {
    type: snapshot.type,
    name: snapshot.name,
    desc: snapshot.desc,
    active: snapshot.active,
    onStart: snapshot.onStart,
    sync: snapshot.sync,
    data: snapshot.data,
  };
}

// A scenario created after the undo's create went out without an answer is
// taken for it only by its content: a LOGIC's name and description come
// from its code, and on/off may be switched by another scenario meanwhile.
export function isRecreatedCopy(snapshot, scenario) {
  if (!isRecord(scenario) || scenario.type !== snapshot.type) return false;
  const fields =
    snapshot.type === "LOGIC"
      ? ["data", "sync"]
      : ["name", "desc", "data", "sync"];
  return fields.every((field) =>
    isDeepStrictEqual(
      comparableField(snapshot, field),
      comparableField(scenario, field),
    ),
  );
}

// The highest number among the home's scenarios: a scenario created after
// it got a higher one, unless the hub's counter was reset meanwhile.
export function highestScenarioNumber(summaries) {
  return Math.max(
    0,
    ...summaries
      .map(({ index }) => Number(index))
      .filter((number) => Number.isSafeInteger(number)),
  );
}

// What stops working once the scenario is gone: BLOCK scenario targets that
// run or switch it, a LOGIC's device assignments, and for a GLOBAL the
// scenarios whose code uses a name it sets on global.
export async function scenarioDeleteDependencies(client, homeRef, snapshot) {
  const summaries = (await client.listScenarios()).filter(
    (summary) =>
      summary.index !== snapshot.index &&
      (summary.type === "BLOCK" ||
        (snapshot.type === "GLOBAL" &&
          ["LOGIC", "GLOBAL"].includes(summary.type) &&
          summary.predefined !== true)),
  );
  const others = (
    await mapWithConcurrency(summaries, SCENARIO_READ_CONCURRENCY, (summary) =>
      client.getScenario(summary.index),
    )
  ).filter(
    (scenario) => isRecord(scenario) && typeof scenario.data === "string",
  );
  const dependencies = {};
  const targets = scenarioTargetsOf(others, homeRef, snapshot.index);
  if (targets.length > 0) dependencies.scenario_targets = targets;
  if (snapshot.type === "GLOBAL") {
    const set = globalNamesSet(snapshot.data);
    if (set === null) {
      dependencies.code_users_unknown =
        "The GLOBAL's code does not parse here, so which names it sets on global and which scenarios use them is not known.";
    } else if (set.size > 0) {
      const users = codeUsersOf(others, homeRef, set);
      if (users.length > 0) dependencies.code_users = users;
    }
  }
  if (snapshot.type === "LOGIC") {
    const assignments = await client.findLogicAssignments(snapshot.index);
    if (assignments.length > 0) {
      dependencies.logic_assignments = assignments.map((assignment) => ({
        service_ref: `${homeRef}/accessory/${assignment.aId}/service/${assignment.sId}`,
        ...(assignment.accessoryName
          ? { accessory: assignment.accessoryName }
          : {}),
        ...(assignment.serviceName ? { service: assignment.serviceName } : {}),
        active: assignment.active,
      }));
    }
  }
  return dependencies;
}

// BLOCK scenario targets pointing at a scenario number, in any mode.
export function scenarioTargetsOf(scenarios, homeRef, index) {
  const references = [];
  for (const scenario of scenarios) {
    if (scenario.type !== "BLOCK") continue;
    let data;
    try {
      data = JSON.parse(scenario.data);
    } catch {
      continue;
    }
    for (const target of blockScenarioTargets(data)) {
      if (target.index !== index) continue;
      references.push({
        scenario_ref: `${homeRef}/scenario/${encodeURIComponent(scenario.index)}`,
        name: scenario.name,
        mode: target.mode,
        configuration_pointer: `/configuration/value${target.pointer}`,
      });
    }
  }
  return references;
}

function codeUsersOf(scenarios, homeRef, names) {
  const users = [];
  for (const scenario of scenarios) {
    const used = new Set();
    for (const code of scenarioCode(scenario)) {
      for (const name of globalNamesUsed(code)) {
        if (names.has(name)) used.add(name);
      }
    }
    if (used.size === 0) continue;
    users.push({
      scenario_ref: `${homeRef}/scenario/${encodeURIComponent(scenario.index)}`,
      name: scenario.name,
      type: scenario.type,
      uses: [...used].sort(),
    });
  }
  return users;
}

// The code a scenario runs: a LOGIC's or GLOBAL's source, a BLOCK's code
// nodes («Код»: {type: "code", code}).
function scenarioCode(scenario) {
  if (scenario.type !== "BLOCK") return [scenario.data];
  let data;
  try {
    data = JSON.parse(scenario.data);
  } catch {
    return [];
  }
  const codes = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "code" && typeof value.code === "string") {
      codes.push(value.code);
    }
    Object.values(value).forEach(visit);
  };
  visit(data);
  return codes;
}

// The names a script assigns on global (global.x = …, global["x"] = …), or
// null when it does not parse.
export function globalNamesSet(source) {
  const program = parseScript(source);
  if (!program) return null;
  const names = new Set();
  walk(program, (node) => {
    if (node.type !== "AssignmentExpression") return;
    const name = globalMemberName(node.left);
    if (name !== undefined) names.add(name);
  });
  return names;
}

// The names a script reads or writes on global. Code that does not parse
// is searched as text, so a usage is not missed for a syntax the parser
// does not know.
export function globalNamesUsed(source) {
  const program = parseScript(source);
  const names = new Set();
  if (!program) {
    for (const match of source.matchAll(
      /\bglobal\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\\]+)\2\s*\])/g,
    )) {
      names.add(match[1] ?? match[3]);
    }
    return names;
  }
  walk(program, (node) => {
    const name = globalMemberName(node);
    if (name !== undefined) names.add(name);
  });
  return names;
}

function globalMemberName(node) {
  if (
    !["MemberExpression", "OptionalMemberExpression"].includes(node?.type) ||
    node.object?.type !== "Identifier" ||
    !["global", "globalThis"].includes(node.object.name)
  ) {
    return undefined;
  }
  if (!node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property?.type === "StringLiteral") {
    return node.property.value;
  }
  return undefined;
}

function parseScript(source) {
  try {
    return parse(source, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
    }).program;
  } catch {
    return null;
  }
}

function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isRecord(node) || typeof node.type !== "string") return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "extra", "leadingComments", "trailingComments"].includes(key))
      continue;
    if (child !== null && typeof child === "object") walk(child, visit);
  }
}

// What the agent tells the owner before a delete that breaks something.
export function scenarioDeleteTellOwner(dependencies) {
  if (Object.keys(dependencies).length === 0) return undefined;
  return [
    "Deleting this scenario breaks what dependencies lists. Tell the owner what will stop working, and apply only if they still want it deleted.",
    ...(dependencies.scenario_targets
      ? [
          "Those scenario targets keep pointing at the deleted scenario's number, and SprutHub may later give that number to an unrelated new scenario, which they would then run or switch; offer to remove them with block_data_update.",
        ]
      : []),
    ...(dependencies.code_users
      ? [
          "The code of code_users uses what this GLOBAL sets on global; without it that code fails, at the latest after the hub restarts.",
        ]
      : []),
    ...(dependencies.code_users_unknown
      ? [
          "Which scenarios use this GLOBAL is not known (code_users_unknown); say so.",
        ]
      : []),
    ...(dependencies.logic_assignments
      ? [
          "Its device assignments are deleted with it, and undo does not bring them back.",
        ]
      : []),
  ].join(" ");
}

export const SCENARIO_DELETE_LIMITATIONS = [
  "Undo creates the scenario again with the same name, description, data or code, on/off, start and sync, but under a new number: scenario targets of other BLOCKs still point at the old number, a LOGIC's device assignments are not made again, and runs it missed while deleted are not made up.",
  "Dependencies cover BLOCK scenario targets, a LOGIC's device assignments, and for a GLOBAL the names its code assigns on global (global.x = …) used in BLOCK code nodes and LOGIC or GLOBAL code. Scenarios run from code and other ways code can depend on a scenario are not traced.",
  "SprutHub exposes no native compare-and-set; a race remains after the pre-delete comparison.",
];

export function publicScenarioDelete(change, verification) {
  const snapshot = change.baseline_snapshot;
  const dependencies = change.dependencies ?? {};
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    scenario: {
      name: snapshot.name,
      description: snapshot.desc,
      type: snapshot.type,
      active: (change.deleted_snapshot ?? snapshot).active,
      on_start: snapshot.onStart,
      sync: snapshot.sync,
    },
    ...(Object.keys(dependencies).length > 0
      ? { dependencies: structuredClone(dependencies) }
      : {}),
    ...(change.configuration_differences
      ? { configuration_differences: [...change.configuration_differences] }
      : {}),
    ...(change.recreated_index !== undefined
      ? {
          recreated: {
            scenario_ref: `${change.home_ref}/scenario/${encodeURIComponent(change.recreated_index)}`,
            name: snapshot.name,
            new_number: change.recreated_index !== snapshot.index,
          },
        }
      : {}),
    ...(change.status === "restored" && change.not_restored
      ? { not_restored: structuredClone(change.not_restored) }
      : {}),
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(verification ? { verification } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    // Undo works for a delete that is or may be done; a prepared one is
    // undone the same way once applied.
    restore_supported: [
      "prepared",
      "applying",
      "uncertain",
      "applied",
    ].includes(change.status),
    limitations: SCENARIO_DELETE_LIMITATIONS,
  };
}

export function scenarioDeleteContract() {
  return {
    version: "2026-10-23",
    write: "scenario.delete({index})",
    scope: "one user BLOCK, LOGIC or GLOBAL scenario, on or off",
    fields: { target_ref: "the scenario's ref", reason: "required" },
    refused: {
      built_in_scenario: "SprutHub's built-in scenarios",
      unsupported_scenario_type: "types other than BLOCK, LOGIC and GLOBAL",
    },
    preparation:
      "saves the scenario and lists dependencies; with any, tell_owner and no next call",
    apply:
      "reads the scenario again: an edit since preparation (name, description, data or code, start, sync) is a conflict; on/off is not compared",
    restore:
      "scenario.create from the saved fields, under a new number; a lost reply is settled by finding a new scenario with the same content, else the outcome stays unknown and nothing is sent again",
    restore_supported: true,
    limitations: SCENARIO_DELETE_LIMITATIONS,
  };
}
