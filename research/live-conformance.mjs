#!/usr/bin/env node
// Live conformance probe of the shipped MCP server against a real SprutHub.
//
// It talks only through dist/plugin/dist/server.mjs over stdio. Every write
// goes through a guard: it may create rooms, BLOCK and LOGIC scenarios whose
// names start with the run prefix, and may change or restore only objects it
// created in this run. BLOCKs are created turned off with onStart=false; a
// BLOCK is turned on only when its sole trigger is a one-date cron in
// FAR_FUTURE_YEAR or later. The owner's devices, scenarios, rooms and settings
// are only read. Everything created is restored (deleted) in reverse order and
// the final home snapshot must equal the initial one. A final sweep then
// deletes, through the product client, every inert object of this run that
// the product owns but its restore left behind, and fails the run for it.
// `--sweep-only <prefix> [--state-dir <dir>]` runs only that sweep.
//
// Output: a JSON report in a new temporary directory and a console table.
// Hub names are stored only as SHA-256; credentials never pass through here.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AutomationStore } from "../src/automation-store.mjs";
import { SprutHubConnection } from "../src/spruthub-connection.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SERVER = path.join(REPO_ROOT, "dist", "plugin", "dist", "server.mjs");
const CALL_TIMEOUT_MS = 300_000;
const FAR_FUTURE_YEAR = 2030;
const ONE_DATE_CRON = `0 0 12 1 1 ? ${FAR_FUTURE_YEAR}`;
const ONE_DATE_CRON_UPDATED = `0 0 13 1 1 ? ${FAR_FUTURE_YEAR}`;
const WEEKDAY_CRON = "0 30 7 ? * MON,TUE,WED,THU,FRI *";
const SUN_CRON = "0 0 0 ? * * *";
const SUNSET_OFFSET_MINUTES = -30;
const HOLD_MS = 60_000;
const DELAY_MS = 60_000;
const PROBE_DESCRIPTION = "sprut-agent live conformance probe; safe to delete";
// On 2026-09-24 SprutHub 3.0.0 stored inc/dec value "10" as 10; sprut-agent
// 0.1.44 then saw a manual change and refused to delete its own BLOCK
// (research/protocol/2026-09-24-live-conformance.md). These families are
// created only with --include-orphaning, to check a product fix.
const ORPHANING_FAMILIES = new Set(["inc", "dec"]);
const REASON =
  "Owner-authorized live conformance probe; only objects created by this run are changed and all are removed.";
const PROBE_PREFIX = /^zz-sprut-agent-probe-\d{8}T\d{6}Z$/;
// How the product marks what it creates (src/automation-service.mjs): the
// desc of a BLOCK and the source of a LOGIC carry the change marker. A room
// has no field for one; its proof is the run's room_create in the journal.
const BLOCK_MARKER = /\[sprut-agent:(?:native|automation):[0-9a-f]{24}\]/;
const LOGIC_MARKER = /\/\* \[sprut-agent:native:[0-9a-f]{24}\] \*\//;

const READ_TOOLS = new Set([
  "list_homes",
  "inspect_home",
  "get_entity",
  "list_rooms",
  "read_services",
  "get_native_change_contract",
  "get_scenario_sdk",
  "get_native_change",
  "list_native_changes",
  "read_hub_log",
]);
const PREPARE_OPERATIONS = new Set([
  "room_create",
  "room_name",
  "block_create",
  "block_data_update",
  "scenario_active",
  "window_option",
  "logic_source_create",
  "logic_source_update",
]);

class GuardError extends Error {}

class ProbeFailure extends Error {
  constructor(message, result) {
    super(message);
    this.code = result?.error?.code;
    this.result = result;
  }
}

// The only path from this script to the MCP server.
class GuardedHub {
  #client;
  constructor(client, prefix) {
    this.#client = client;
    this.prefix = prefix;
    this.homeRef = null;
    this.anchors = new Set();
    this.created = new Map();
    this.changes = new Map();
    this.calls = [];
    this.allowLogicActivation = false;
  }

  async read(tool, args) {
    if (!READ_TOOLS.has(tool)) throw new GuardError(`${tool} is not a read`);
    return this.#call(tool, args);
  }

  async prepare(input) {
    this.#checkPrepare(input);
    const result = await this.#call("prepare_native_change", {
      reason: REASON,
      ...input,
    });
    if (typeof result.change_ref === "string") {
      this.changes.set(result.change_ref, {
        operation: input.operation,
        target_ref: input.target_ref,
        activatable:
          input.operation === "block_create" &&
          input.on_start === false &&
          onlyFarFutureOneDateTriggers(input.data),
      });
    }
    return result;
  }

  async apply(changeRef) {
    const change = this.#ownChange(changeRef);
    const result = await this.#call("apply_native_change", {
      change_ref: changeRef,
    });
    this.#trackCreated(change, result);
    return result;
  }

  async restore(changeRef) {
    this.#ownChange(changeRef);
    return this.#call("restore_native_change", { change_ref: changeRef });
  }

  async get(changeRef) {
    const result = await this.read("get_native_change", {
      change_ref: changeRef,
    });
    this.#trackCreated(this.changes.get(changeRef), result);
    return result;
  }

  #ownChange(changeRef) {
    const change = this.changes.get(changeRef);
    if (!change) throw new GuardError(`${changeRef} was not prepared here`);
    return change;
  }

  #trackCreated(change, result) {
    if (!change) return;
    if (change.operation === "room_create" && result?.room?.ref) {
      this.created.set(result.room.ref, { kind: "room" });
    }
    if (
      ["block_create", "logic_source_create"].includes(change.operation) &&
      typeof result?.scenario_ref === "string" &&
      !this.created.has(result.scenario_ref)
    ) {
      this.created.set(result.scenario_ref, {
        kind: change.operation === "block_create" ? "block" : "logic",
        activatable: change.activatable === true,
      });
    }
  }

  #checkPrepare(input) {
    const { operation: op, target_ref: target } = input;
    const refuse = (why) => {
      throw new GuardError(`refused ${op} on ${target}: ${why}`);
    };
    if (!PREPARE_OPERATIONS.has(op)) refuse("operation is not allowed");
    const owned = this.created.get(target);
    if (["room_create", "block_create"].includes(op)) {
      if (target !== this.homeRef) refuse("target must be the home ref");
      if (!input.name?.startsWith(this.prefix)) refuse("name lacks prefix");
    }
    if (op === "block_create") {
      if (input.active !== false || input.on_start !== false) {
        refuse("a BLOCK must be created off with onStart=false");
      }
    }
    if (op === "logic_source_create") {
      if (!this.anchors.has(target)) refuse("not the chosen anchor service");
      if (!input.name?.startsWith(this.prefix)) refuse("name lacks prefix");
      if (input.active !== false || input.on_start !== false) {
        refuse("LOGIC must be created off with onStart=false");
      }
    }
    if (op === "room_name") {
      if (owned?.kind !== "room") refuse("room not created by this run");
      if (!String(input.value).startsWith(this.prefix)) refuse("name prefix");
    }
    if (op === "block_data_update") {
      if (owned?.kind !== "block") refuse("BLOCK not created by this run");
      if (owned.activatable && !onlyFarFutureOneDateTriggers(input.data)) {
        refuse("an activatable BLOCK must keep only far-future triggers");
      }
    }
    if (op === "window_option") {
      if (owned?.kind !== "block") refuse("BLOCK not created by this run");
      if (!["Name", "Desc"].includes(input.option_key)) refuse("option key");
      if (
        input.option_key === "Name" &&
        !String(input.value).startsWith(this.prefix)
      ) {
        refuse("name prefix");
      }
    }
    if (op === "scenario_active") {
      if (!owned || owned.kind === "room") refuse("not created by this run");
      if (input.value === true) {
        const allowed =
          owned.kind === "block"
            ? owned.activatable
            : this.allowLogicActivation;
        if (!allowed) refuse("turning this scenario on is not allowed");
      }
    }
    if (op === "logic_source_update" && owned?.kind !== "logic") {
      refuse("LOGIC not created by this run");
    }
  }

  async #call(tool, args) {
    const started = Date.now();
    const response = await this.#client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const result =
      response.structuredContent ??
      JSON.parse(response.content?.[0]?.text ?? "null");
    this.calls.push({
      tool,
      ...(args.operation ? { operation: args.operation } : {}),
      ref: relativeRef(
        args.target_ref ?? args.entity_ref ?? args.change_ref ?? "",
      ),
      status: result?.status ?? null,
      ...(result?.error?.code ? { error: result.error.code } : {}),
      ms: Date.now() - started,
    });
    return result;
  }
}

// A BLOCK may be turned on only if nothing but a far-future one-date cron can
// start it: no characteristic, interval or code node at all.
function onlyFarFutureOneDateTriggers(data) {
  let farFuture = 0;
  let other = 0;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isRecord(node)) return;
    if (node.type === "cron") {
      const match = /^0 \d{1,2} \d{1,2} \d{1,2} \d{1,2} \? (\d{4})$/.exec(
        node.cron ?? "",
      );
      if (
        node.mode === "NONE" &&
        match &&
        Number(match[1]) >= FAR_FUTURE_YEAR
      ) {
        farFuture += 1;
      } else {
        other += 1;
      }
    }
    if (["characteristic", "interval", "code"].includes(node.type)) other += 1;
    for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return farFuture > 0 && other === 0;
}

const rows = [];
const report = {
  generated_at: new Date().toISOString(),
  sprut_agent: {},
  hub: {},
  targets: {},
  steps: rows,
  cleanup: [],
  snapshot: {},
  aborted: null,
};

function row(step, nativeOp, expected, observed, verdict, details) {
  rows.push({
    step,
    native_op: nativeOp,
    expected,
    observed,
    verdict,
    ...(details ? { details } : {}),
  });
}

// Discovery results and the initial snapshot, for the final comparison.
const run = { targets: null, before: null };

let abortReason = null;
function abort(reason) {
  abortReason ??= reason;
}

async function main() {
  if (process.argv.includes("--sweep-only")) return sweepOnly();
  const prefix = `zz-sprut-agent-probe-${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}`;
  const reportDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-conformance-"),
  );
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sprut-agent-conformance-state-"),
  );
  report.prefix = prefix;
  report.state_directory = stateDirectory;
  report.sprut_agent = {
    server: path.relative(REPO_ROOT, SERVER),
    git_sha: gitSha(),
  };

  const client = new Client({
    name: "sprut-agent-live-conformance",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: REPO_ROOT,
    env: serverEnvironment(stateDirectory),
    stderr: "pipe",
  });
  // Drained and counted only: server diagnostics stay out of the report.
  report.server_stderr_bytes = 0;
  transport.stderr?.on("data", (chunk) => {
    report.server_stderr_bytes += chunk.length;
  });
  await client.connect(transport);
  report.sprut_agent.version = client.getServerVersion()?.version;
  const hub = new GuardedHub(client, prefix);
  const cleanup = [];
  let exitCode = 0;
  const readOnly = process.argv.includes("--read-only");
  try {
    const homes = await hub.read("list_homes", {});
    expectOk(homes, "list_homes");
    if (homes.selection?.required) {
      throw new Error("Several homes: pin one with list_homes selection.pin.");
    }
    hub.homeRef = homes.selection.default_home_ref;
    const home = homes.homes.find(({ ref }) => ref === hub.homeRef);
    report.hub = { firmware: home.firmware, model: home.model };

    const targets = await discoverTargets(hub);
    report.targets = {
      lamp_service: relativeRef(targets.lamp.serviceRef),
      sensor: relativeRef(targets.sensor.ref),
      lamp_values_before: await lampValues(hub, targets.lamp),
    };
    hub.anchors.add(targets.lamp.serviceRef);
    const sdk = await hub.read("get_scenario_sdk", { home_ref: hub.homeRef });
    report.scenario_sdk = { sha256: sdk.sha256, complete: sdk.sdk_complete };

    const before = await homeSnapshot(hub, targets);
    report.snapshot.before_sha256 = sha256(stableJson(before));
    run.targets = targets;
    run.before = before;
    const ctx = { hub, targets, before, cleanup, prefix };

    if (readOnly) {
      // Rehearses discovery and both snapshots without any write.
      row("1-4", "-", "-", "--read-only: no write sent", "skipped");
    } else {
      await guardedStep(ctx, "1", stepRoom);
      await guardedStep(ctx, "2", stepBlockStorage);
      await guardedStep(ctx, "3", stepPartialUpdates);
      await guardedStep(ctx, "4", stepLogic);
    }
  } catch (error) {
    abort(`script error: ${error.message}`);
    exitCode = 1;
  } finally {
    try {
      const clean = await runCleanup(hub, cleanup);
      if (!clean) exitCode = 1;
      if (hub.homeRef && !readOnly) {
        const entries = await runSweep({
          prefix,
          stateDirectory,
          homeRef: hub.homeRef,
          sweptIsFailure: true,
        });
        if (entries?.length !== 0) exitCode = 1;
      }
      if (hub.homeRef) {
        const ok = await finalChecks(hub);
        if (!ok) exitCode = 1;
      }
    } catch (error) {
      row("5 cleanup", "-", "all restored", error.message, "mismatch");
      exitCode = 1;
    }
    report.aborted = abortReason;
    report.calls = hub.calls;
    if (abortReason) exitCode = 1;
    await client.close();
    const reportPath = path.join(reportDirectory, "report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    printTable();
    console.log(`\nReport: ${reportPath}`);
    console.log(`State directory: ${stateDirectory}`);
    if (abortReason) console.log(`Stopped: ${abortReason}`);
  }
  return exitCode;
}

function serverEnvironment(stateDirectory) {
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SPRUT_AGENT_STATE_DIR: stateDirectory,
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (
      name === "XDG_CONFIG_HOME" ||
      name === "SPRUT_AGENT_SESSION_FILE" ||
      name.startsWith("SPRUTHUB_")
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

async function guardedStep(ctx, id, step) {
  if (abortReason) {
    row(id, "-", "-", `not run: ${abortReason}`, "skipped");
    return;
  }
  try {
    await step(ctx);
  } catch (error) {
    if (error instanceof GuardError) throw error;
    row(id, "-", "step completes", error.message, "rejected");
    if (!(error instanceof ProbeFailure)) abort(`step ${id}: ${error.message}`);
  }
  if (!abortReason) await houseUnchanged(ctx, id);
}

// --- discovery and snapshots -------------------------------------------------

async function discoverTargets(hub) {
  const lamps = [];
  for (const service of await catalogServices(hub, ["Lightbulb"])) {
    const entity = await hub.read("get_entity", {
      entity_ref: service.ref,
      max_bytes: 32_768,
    });
    if (entity.status !== "ok" || !entity.entity) continue;
    const on = characteristic(entity.entity, "On", "boolean");
    const brightness = characteristic(entity.entity, "Brightness", "number");
    if (on && brightness) {
      lamps.push({ serviceRef: service.ref, on, brightness });
    }
  }
  // An On=false lamp keeps the never-fired set action equal to its state.
  const lamp =
    lamps.find(({ on }) => on.current_value.value === false) ?? lamps[0];
  if (!lamp) throw new Error("No Lightbulb with writable On and Brightness.");

  let sensor;
  for (const [serviceType, characteristicType] of [
    ["MotionSensor", "MotionDetected"],
    ["OccupancySensor", "OccupancyDetected"],
  ]) {
    for (const service of await catalogServices(hub, [serviceType])) {
      const entity = await hub.read("get_entity", {
        entity_ref: service.ref,
        max_bytes: 32_768,
      });
      const found =
        entity.status === "ok" && entity.entity
          ? characteristic(entity.entity, characteristicType, "boolean", false)
          : undefined;
      if (found) {
        sensor = { ...found, serviceType };
        break;
      }
    }
    if (sensor) break;
  }
  if (!sensor) throw new Error("No boolean motion or occupancy sensor.");
  return { lamp, sensor };
}

function characteristic(service, type, valueType, writable = true) {
  const found = service.characteristics?.find(
    (item) =>
      item.type === type &&
      typeof item.current_value?.value === valueType &&
      (!writable || item.capabilities?.write === true),
  );
  return found ? { ...found, ids: nativeIds(found.ref) } : undefined;
}

function nativeIds(ref) {
  const match =
    /\/accessory\/(\d+)\/service\/(\d+)(?:\/characteristic\/(\d+))?$/.exec(ref);
  if (!match) throw new Error(`Unexpected ref ${relativeRef(ref)}`);
  return {
    aId: Number(match[1]),
    sId: Number(match[2]),
    cId: match[3] === undefined ? undefined : Number(match[3]),
  };
}

async function catalogServices(hub, serviceTypes) {
  let args = {
    home_ref: hub.homeRef,
    representation: "catalog",
    max_bytes: 32_768,
    ...(serviceTypes ? { service_types: serviceTypes } : {}),
  };
  const services = [];
  for (;;) {
    const page = await hub.read("read_services", args);
    expectOk(page, "read_services");
    services.push(...page.services);
    if (!page.next) return services;
    args = page.next.arguments;
  }
}

async function lampValues(hub, lamp) {
  const entity = await hub.read("get_entity", {
    entity_ref: lamp.serviceRef,
    max_bytes: 32_768,
  });
  if (entity.status !== "ok") return { error: entity.error?.code };
  return {
    on: characteristic(entity.entity, "On", "boolean")?.current_value.value,
    brightness: characteristic(entity.entity, "Brightness", "number")
      ?.current_value.value,
  };
}

async function homeSnapshot(hub, targets) {
  const inspect = await hub.read("inspect_home", { home_ref: hub.homeRef });
  expectOk(inspect, "inspect_home");
  const rooms = inspect.entities.rooms
    .map(({ ref, name }) => ({ ref, name_sha256: sha256(name) }))
    .sort(byRef);
  const scenarios = [];
  for (const scenario of inspect.entities.scenarios) {
    const entry = {
      ref: scenario.ref,
      name_sha256: sha256(scenario.name),
      type: scenario.type,
      predefined: scenario.predefined,
      active: scenario.active,
      on_start: scenario.on_start,
      sync: scenario.sync,
    };
    try {
      const configuration = await readEntityValue(
        hub,
        scenario.ref,
        ["configuration"],
        "/configuration",
      );
      entry.configuration_sha256 = sha256(stableJson(configuration));
    } catch (error) {
      entry.configuration_error = error.code ?? "read_failed";
    }
    scenarios.push(entry);
  }
  scenarios.sort(byRef);
  const accessories = new Map();
  const services = [];
  for (const service of await catalogServices(hub)) {
    services.push({
      ref: service.ref,
      name_sha256: sha256(service.name),
      type: service.type,
      room_ref: service.room?.ref ?? null,
    });
    accessories.set(service.accessory.ref, {
      ref: service.accessory.ref,
      name_sha256: sha256(service.accessory.name),
      room_ref: service.room?.ref ?? null,
    });
  }
  const anchor = await hub.read("get_entity", {
    entity_ref: targets.lamp.serviceRef,
    max_bytes: 32_768,
  });
  return {
    rooms,
    scenarios,
    accessories: [...accessories.values()].sort(byRef),
    services: services.sort(byRef),
    anchor_logic_types: (anchor.entity?.available_logic_types ?? [])
      .map(({ type }) => type)
      .sort(),
    anchor_assigned_logics: (anchor.entity?.assigned_logics ?? [])
      .map(({ type, active }) => ({ type, active }))
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
}

// Reassembles one value of get_entity through its paging contract.
async function readEntityValue(hub, entityRef, include, pointer) {
  const result = await hub.read("get_entity", {
    entity_ref: entityRef,
    include,
    pointer,
    max_bytes: 32_768,
  });
  if (result.status !== "ok") {
    throw new ProbeFailure(`get_entity ${pointer}`, result);
  }
  const representation = result.representation;
  if (representation.selected_complete) return result.selection.value;
  const chunk = result.selection?.value;
  if (chunk?.kind === "string_chunk") {
    let text = chunk.text;
    let next = result.selection.next;
    while (next) {
      const page = await hub.read("get_entity", next.arguments);
      if (page.status !== "ok") {
        throw new ProbeFailure(`get_entity ${pointer}`, page);
      }
      text += page.selection.value.text;
      next = page.selection.next;
    }
    return text;
  }
  const parts = [...representation.available_parts];
  let next = representation.next;
  while (next) {
    const page = await hub.read("get_entity", next.arguments);
    if (page.status !== "ok") {
      throw new ProbeFailure(`get_entity ${pointer}`, page);
    }
    parts.push(...page.representation.available_parts);
    next = page.representation.next;
  }
  const value = result.selection?.value_kind === "array" ? [] : {};
  for (const part of parts) {
    const key = part.pointer
      .slice(pointer.length + 1)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    value[Array.isArray(value) ? Number(key) : key] = await readEntityValue(
      hub,
      entityRef,
      include,
      part.pointer,
    );
  }
  return value;
}

async function readScenario(hub, ref) {
  const result = await hub.read("get_entity", {
    entity_ref: ref,
    include: ["configuration"],
    max_bytes: 32_768,
  });
  if (result.status !== "ok") throw new ProbeFailure("read scenario", result);
  const entity = result.entity ?? result.identity;
  const configuration =
    result.entity?.configuration ??
    (await readEntityValue(hub, ref, ["configuration"], "/configuration"));
  const option = (key) =>
    result.entity?.metadata_options?.find((item) => item.key === key)
      ?.configured_value;
  return {
    name: entity.name,
    description: entity.description,
    active: entity.active,
    on_start: entity.on_start,
    sync: entity.sync,
    type: entity.type,
    window_name: option("Name"),
    window_desc: option("Desc"),
    configuration_sha256: sha256(stableJson(configuration.value)),
    data: configuration.value,
  };
}

async function scenarioPresent(hub, ref) {
  const inspect = await hub.read("inspect_home", { home_ref: hub.homeRef });
  expectOk(inspect, "inspect_home");
  return inspect.entities.scenarios.some((scenario) => scenario.ref === ref);
}

async function roomName(hub, ref) {
  const rooms = await hub.read("list_rooms", {});
  expectOk(rooms, "list_rooms");
  return rooms.rooms.find((room) => room.ref === ref)?.name ?? null;
}

// Cheap check after every step: nothing outside this run's objects changed.
async function houseUnchanged(ctx, id) {
  const inspect = await ctx.hub.read("inspect_home", {
    home_ref: ctx.hub.homeRef,
  });
  expectOk(inspect, "inspect_home");
  const current = {
    rooms: inspect.entities.rooms
      .filter(({ ref }) => !ctx.hub.created.has(ref))
      .map(({ ref, name }) => ({ ref, name_sha256: sha256(name) }))
      .sort(byRef),
    scenarios: inspect.entities.scenarios
      .filter(({ ref }) => !ctx.hub.created.has(ref))
      .map((scenario) => ({
        ref: scenario.ref,
        name_sha256: sha256(scenario.name),
        active: scenario.active,
        on_start: scenario.on_start,
        sync: scenario.sync,
      }))
      .sort(byRef),
  };
  const expected = {
    rooms: ctx.before.rooms,
    scenarios: ctx.before.scenarios.map(
      ({ ref, name_sha256, active, on_start, sync }) => ({
        ref,
        name_sha256,
        active,
        on_start,
        sync,
      }),
    ),
  };
  const unknown = [
    ...inspect.entities.rooms,
    ...inspect.entities.scenarios,
  ].filter(
    ({ ref, name }) =>
      !ctx.hub.created.has(ref) && String(name).startsWith(ctx.prefix),
  );
  if (!isDeepStrictEqual(current, expected) || unknown.length > 0) {
    const diff = snapshotDiff(expected, current);
    row(
      `${id} house check`,
      "inspect_home",
      "foreign rooms and scenarios unchanged",
      `${diff.length} difference(s), ${unknown.length} untracked probe object(s)`,
      "mismatch",
      { diff, untracked: unknown.map(({ ref }) => relativeRef(ref)) },
    );
    abort(`unexpected change outside probe objects after step ${id}`);
  }
}

// --- step 1: room lifecycle --------------------------------------------------

async function stepRoom(ctx) {
  const { hub, before, prefix } = ctx;
  // room_create restore lists the room's accessories. Prove first that the
  // product reads an empty room; otherwise the created room cannot be removed.
  const occupied = new Set(before.services.map(({ room_ref }) => room_ref));
  const emptyRoom = before.rooms.find(({ ref }) => !occupied.has(ref));
  if (!emptyRoom) {
    row(
      "1 room lifecycle",
      "room.create/update/delete",
      "empty-room read works before creating a room",
      "no existing empty room to prove it",
      "blocked",
    );
    return;
  }
  const probe = await hub.read("get_entity", {
    entity_ref: emptyRoom.ref,
    max_bytes: 4_096,
  });
  if (probe.status !== "ok") {
    row(
      "1 preflight empty room",
      "accessory.list{roomId,expand}",
      "existing empty room is readable",
      `get_entity ${relativeRef(emptyRoom.ref)}: ${probe.error?.code}: ${probe.error?.message}`,
      "mismatch",
    );
    row(
      "1 room lifecycle",
      "room.create/update/delete",
      "create, rename, restore, delete",
      "not run: room_create restore reads accessory.list{roomId} with the same parser, so the created empty room could not be removed",
      "blocked",
    );
    return;
  }

  const name = `${prefix}-room`;
  const create = await prepareAndApply(hub, {
    operation: "room_create",
    target_ref: hub.homeRef,
    name,
  });
  const roomRef = create.applied?.room?.ref;
  if (!roomRef || create.applied.status !== "applied") {
    row(
      "1a room create",
      "room.create{name}",
      "room created",
      describe(create),
      "rejected",
    );
    if (create.applied?.native_write_sent) abort("room create not confirmed");
    return;
  }
  const createEntry = pushCleanup(ctx, {
    label: "room",
    changeRef: create.changeRef,
    verify: async () => (await roomName(hub, roomRef)) === null,
  });
  const created = await roomName(hub, roomRef);
  row(
    "1a room create",
    "room.create{name}",
    `name ${name}`,
    `applied; readback ${created}`,
    created === name ? "match" : "hub-normalized",
  );

  const renamed = `${prefix}-room-renamed`;
  const rename = await prepareAndApply(hub, {
    operation: "room_name",
    target_ref: roomRef,
    value: renamed,
  });
  if (!rename.applied) {
    row(
      "1b room rename",
      "room.update{id,name}",
      renamed,
      describe(rename),
      "rejected",
    );
    return;
  }
  const renameEntry = pushCleanup(ctx, {
    label: "room rename",
    parent: createEntry,
    changeRef: rename.changeRef,
    verify: async () => (await roomName(hub, roomRef)) === name,
  });
  const afterRename = await roomName(hub, roomRef);
  row(
    "1b room rename",
    "room.update{id,name}",
    `name ${renamed}`,
    `${rename.applied.status}; readback ${afterRename}`,
    rename.applied.status !== "applied"
      ? "mismatch"
      : afterRename === renamed
        ? "match"
        : "hub-normalized",
  );
  const restoredName = await runRestore(hub, renameEntry);
  row(
    "1c restore rename",
    "room.update{id,name}",
    `name ${name}`,
    restoredName.observed,
    restoredName.verified ? "match" : "mismatch",
  );
  // A rename that reset visible or order makes this delete a conflict.
  const deleted = await runRestore(hub, createEntry);
  row(
    "1d restore create",
    "room.delete{id}",
    "room absent",
    deleted.observed,
    deleted.verified ? "match" : "mismatch",
  );
  if (!deleted.verified) abort("created room was not removed");
}

// --- step 2: BLOCK storage conformance ---------------------------------------

function setLamp(lamp, value) {
  return {
    type: "service",
    aId: lamp.on.ids.aId,
    sId: lamp.on.ids.sId,
    hs: "Lightbulb",
    characteristics: [
      { type: "set", cId: lamp.on.ids.cId, hc: "On", value: String(value) },
    ],
  };
}

function lampAction(lamp, action) {
  return {
    type: "service",
    aId: lamp.on.ids.aId,
    sId: lamp.on.ids.sId,
    hs: "Lightbulb",
    characteristics: [action],
  };
}

function cronCondition(mode, cron, offset, conditionMode = "AND") {
  return {
    type: "condition",
    mode: conditionMode,
    conditions: [{ type: "cron", mode, cron, offset }],
  };
}

function ifNode(mode, condition, then, otherwise = []) {
  return {
    type: "if",
    mode,
    if: condition,
    then,
    else: otherwise,
    then_delay: 0,
    else_delay: 0,
  };
}

function blockFamilies(targets, controlIndex) {
  const { lamp, sensor } = targets;
  const oneDate = () => cronCondition("NONE", ONE_DATE_CRON, 0);
  const off = () => setLamp(lamp, false);
  const families = [
    {
      id: "weekday_cron",
      expected: `cron NONE "${WEEKDAY_CRON}" stored as sent`,
      node: ifNode("EVERY", cronCondition("NONE", WEEKDAY_CRON, 0), [off()]),
    },
    {
      id: "one_date_cron",
      expected: `cron NONE "${ONE_DATE_CRON}" stored as sent`,
      node: ifNode("EVERY", oneDate(), [off()]),
    },
    {
      id: "sunset_offset",
      expected: `cron SUNSET "${SUN_CRON}" offset ${SUNSET_OFFSET_MINUTES} stored as sent`,
      node: ifNode(
        "EVERY",
        cronCondition("SUNSET", SUN_CRON, SUNSET_OFFSET_MINUTES),
        [off()],
      ),
    },
    {
      id: "toggle",
      expected: "toggle On without value stored as sent",
      node: ifNode("EVERY", oneDate(), [
        lampAction(lamp, { type: "toggle", cId: lamp.on.ids.cId, hc: "On" }),
      ]),
    },
    {
      id: "inc",
      expected: 'inc Brightness value "10" stored as sent',
      node: ifNode("EVERY", oneDate(), [
        lampAction(lamp, {
          type: "inc",
          cId: lamp.brightness.ids.cId,
          hc: "Brightness",
          value: "10",
        }),
      ]),
    },
    {
      id: "dec",
      expected: 'dec Brightness value "10" stored as sent',
      node: ifNode("EVERY", oneDate(), [
        lampAction(lamp, {
          type: "dec",
          cId: lamp.brightness.ids.cId,
          hc: "Brightness",
          value: "10",
        }),
      ]),
    },
    {
      id: "if_once",
      expected: "if mode ONCE stored as sent",
      node: ifNode("ONCE", oneDate(), [off()]),
    },
    {
      id: "held_condition",
      expected: `characteristic timeCond ">" time ${HOLD_MS} stored as sent`,
      node: ifNode(
        "EVERY",
        {
          type: "condition",
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              ...pick(sensor.ids, ["aId", "sId", "cId"]),
              hs: sensor.serviceType,
              hc: sensor.type,
              trigger: true,
              cond: "=",
              value: "true",
              timeCond: ">",
              time: HOLD_MS,
            },
          ],
        },
        [off()],
      ),
    },
    {
      id: "delay_continue_clear_delay",
      expected: "delay CONTINUE and clear_delay stored as sent",
      node: ifNode(
        "EVERY",
        oneDate(),
        [
          {
            type: "delay",
            mode: "CONTINUE",
            index: 1,
            time: DELAY_MS,
            targets: [off()],
          },
        ],
        [{ type: "clear_delay", index: 1 }],
      ),
    },
  ];
  if (controlIndex) {
    families.push({
      id: "scenario_fire",
      expected: "scenario FIRE target stored as sent",
      node: ifNode("EVERY", oneDate(), [
        { type: "scenario", mode: "FIRE", index: controlIndex },
      ]),
    });
  }
  return families;
}

async function createBlock(ctx, { label, data, sync = false }) {
  const name = `${ctx.prefix}-${label}`;
  const result = await prepareAndApply(ctx.hub, {
    operation: "block_create",
    target_ref: ctx.hub.homeRef,
    name,
    description: PROBE_DESCRIPTION,
    active: false,
    on_start: false,
    sync,
    data,
  });
  const scenarioRef = result.applied?.scenario_ref;
  const cleanupEntry = scenarioRef
    ? pushCleanup(ctx, {
        label: `BLOCK ${label}`,
        changeRef: result.changeRef,
        verify: async () => !(await scenarioPresent(ctx.hub, scenarioRef)),
      })
    : undefined;
  // A clean refusal (status error, nothing created) lets other checks go on;
  // the per-step house check still catches an untracked probe object.
  if (
    result.applied &&
    result.applied.status !== "applied" &&
    (scenarioRef ||
      ["conflict", "uncertain", "applying"].includes(result.applied.status))
  ) {
    // A created but unowned BLOCK cannot be deleted by restore.
    abort(
      `BLOCK ${label} apply ended ${result.applied.status}` +
        (result.applied.conflict_reason
          ? ` (${result.applied.conflict_reason})`
          : ""),
    );
  }
  const stored = scenarioRef
    ? await readScenario(ctx.hub, scenarioRef)
    : undefined;
  return {
    ...result,
    name,
    scenarioRef,
    stored,
    sent: data,
    sync,
    cleanupEntry,
  };
}

function storedFlagsDiff(block) {
  const { stored, applied } = block;
  const marker = applied?.diff?.configuration?.to?.desc;
  const expected = {
    name: block.name,
    description: marker ?? PROBE_DESCRIPTION,
    active: false,
    on_start: false,
    sync: block.sync,
    type: "BLOCK",
  };
  return Object.entries(expected)
    .filter(([key, value]) => stored[key] !== value)
    .map(([key, value]) => ({ field: key, sent: value, read: stored[key] }));
}

async function stepBlockStorage(ctx) {
  const { targets } = ctx;
  const control = await createBlock(ctx, {
    label: "block-control",
    data: {
      targets: [
        ifNode(
          "EVERY",
          {
            type: "condition",
            mode: "AND",
            conditions: [
              {
                type: "interval",
                start: {
                  type: "cron",
                  mode: "NONE",
                  cron: "0 0 22 ? * * *",
                  offset: 0,
                },
                end: {
                  type: "cron",
                  mode: "NONE",
                  cron: "0 0 6 ? * * *",
                  offset: 0,
                },
                trigger: true,
              },
            ],
          },
          [setLamp(targets.lamp, true)],
          [setLamp(targets.lamp, false)],
        ),
      ],
    },
  });
  blockRow("2 control daily interval", control, "stored as sent");
  ctx.control = control;
  if (abortReason) return;
  const controlIndex = control.scenarioRef
    ? decodeURIComponent(control.scenarioRef.split("/").pop())
    : undefined;

  // prepare never writes; it shows which families the product accepts.
  const accepted = [];
  for (const family of blockFamilies(targets, controlIndex)) {
    const prepared = await ctx.hub.prepare({
      operation: "block_create",
      target_ref: ctx.hub.homeRef,
      name: `${ctx.prefix}-prepare-only-${family.id}`,
      description: PROBE_DESCRIPTION,
      active: false,
      on_start: false,
      sync: false,
      data: { targets: [family.node] },
    });
    if (
      prepared.status === "prepared" &&
      ORPHANING_FAMILIES.has(family.id) &&
      !process.argv.includes("--include-orphaning")
    ) {
      row(
        `2 ${family.id}`,
        "scenario.create{BLOCK}",
        family.expected,
        "not created: SprutHub stores this value as a number and the product then cannot delete the BLOCK (--include-orphaning to test a fix)",
        "blocked",
      );
    } else if (prepared.status === "prepared") {
      accepted.push(family);
    } else {
      row(
        `2 ${family.id}`,
        "prepare only",
        family.expected,
        `product rejected: ${prepared.error?.code}: ${prepared.error?.message}`,
        "rejected",
      );
    }
  }
  if (accepted.length === 0) return;

  const combined = await createBlock(ctx, {
    label: "block-schema",
    data: { targets: accepted.map(({ node }) => node) },
  });
  ctx.schema = combined;
  if (!combined.scenarioRef) {
    row(
      "2 schema BLOCK create",
      "scenario.create{BLOCK}",
      "applied",
      describe(combined),
      "rejected",
    );
    if (abortReason) return;
    // The hub refused the whole BLOCK: find the family it refuses.
    for (const family of accepted) {
      if (abortReason) return;
      const single = await createBlock(ctx, {
        label: `block-${family.id}`,
        data: { targets: [family.node] },
      });
      if (!single.scenarioRef) {
        row(
          `2 ${family.id}`,
          "scenario.create{BLOCK}",
          family.expected,
          describe(single),
          "rejected",
        );
        continue;
      }
      familyRow(family, single, 0, single.stored.data.targets?.[0]);
    }
    ctx.oneDateVerbatim = oneDateStoredVerbatim();
    return;
  }
  const flags = storedFlagsDiff(combined);
  row(
    "2 schema BLOCK create",
    "scenario.create{BLOCK}",
    "applied; flags off/onStart off/sync off; name and marked desc as sent",
    `${combined.applied.status}; configuration_matches=${combined.applied.configuration_matches}; flag differences ${flags.length}`,
    combined.applied.status !== "applied"
      ? "mismatch"
      : flags.length > 0
        ? "hub-normalized"
        : "match",
    flags.length > 0 ? { flags } : undefined,
  );
  const readTargets = combined.stored.data.targets ?? [];
  accepted.forEach((family, index) => {
    familyRow(
      family,
      combined,
      index,
      readTargets.length === accepted.length ? readTargets[index] : undefined,
    );
  });
  ctx.oneDateVerbatim = oneDateStoredVerbatim();
}

// Step 3 turns a BLOCK on only after the hub kept the far-future cron as sent.
function oneDateStoredVerbatim() {
  return rows.some(
    (item) => item.step === "2 one_date_cron" && item.verdict === "match",
  );
}

function familyRow(family, block, index, readNode) {
  const sentNode = block.sent.targets[index];
  const diff =
    readNode === undefined
      ? [{ path: "targets", kind: "reordered_or_missing" }]
      : structuralDiff(sentNode, readNode);
  const hubAssigned = diff.filter(isHubAssigned);
  const other = diff.filter((entry) => !isHubAssigned(entry));
  const productApplied = block.applied?.status === "applied";
  row(
    `2 ${family.id}`,
    "scenario.create{BLOCK}",
    family.expected,
    other.length === 0
      ? `stored as sent (+${hubAssigned.length} hub-assigned blockId/state)`
      : `${other.length} difference(s): ${other
          .slice(0, 3)
          .map((entry) => `${entry.kind} ${entry.path}`)
          .join("; ")}`,
    other.length === 0
      ? "match"
      : productApplied
        ? "mismatch"
        : "hub-normalized",
    other.length > 0 ? { differences: other, sent: sentNode } : undefined,
  );
}

function blockRow(step, block, expected) {
  if (!block.scenarioRef) {
    row(step, "scenario.create{BLOCK}", expected, describe(block), "rejected");
    return;
  }
  const diff = structuralDiff(block.sent, block.stored.data);
  const other = diff.filter((entry) => !isHubAssigned(entry));
  const flags = storedFlagsDiff(block);
  row(
    step,
    "scenario.create{BLOCK}",
    expected,
    `${block.applied.status}; data differences ${other.length}; flag differences ${flags.length}`,
    block.applied.status !== "applied"
      ? other.length > 0
        ? "hub-normalized"
        : "mismatch"
      : other.length > 0 || flags.length > 0
        ? "mismatch"
        : "match",
    other.length > 0 || flags.length > 0
      ? { differences: other, flags }
      : undefined,
  );
}

// blockId on every node and state on if are declared hub-assigned fields.
function isHubAssigned(entry) {
  const key = entry.path.split("/").pop();
  return (
    entry.kind === "added" &&
    (key === "blockId" || (key === "state" && entry.node_type === "if"))
  );
}

function structuralDiff(sent, read, pointer = "", nodeType = undefined) {
  if (isRecord(sent) && isRecord(read)) {
    const type = read.type ?? sent.type;
    const out = [];
    for (const key of new Set([...Object.keys(sent), ...Object.keys(read)])) {
      const child = `${pointer}/${key}`;
      if (!Object.hasOwn(sent, key)) {
        out.push({
          path: child,
          kind: "added",
          read: read[key],
          node_type: type,
        });
      } else if (!Object.hasOwn(read, key)) {
        out.push({
          path: child,
          kind: "removed",
          sent: sent[key],
          node_type: type,
        });
      } else {
        out.push(...structuralDiff(sent[key], read[key], child, type));
      }
    }
    return out;
  }
  if (Array.isArray(sent) && Array.isArray(read)) {
    const out = [];
    for (let index = 0; index < Math.max(sent.length, read.length); index++) {
      const child = `${pointer}/${index}`;
      if (index >= sent.length) {
        out.push({ path: child, kind: "added", read: read[index] });
      } else if (index >= read.length) {
        out.push({ path: child, kind: "removed", sent: sent[index] });
      } else {
        out.push(...structuralDiff(sent[index], read[index], child, nodeType));
      }
    }
    return out;
  }
  return isDeepStrictEqual(sent, read)
    ? []
    : [{ path: pointer, kind: "changed", sent, read, node_type: nodeType }];
}

// --- step 3: partial updates on a probe BLOCK -------------------------------

const SCENARIO_FIELDS = [
  "name",
  "description",
  "active",
  "on_start",
  "sync",
  "type",
  "configuration_sha256",
  "window_name",
  "window_desc",
];

async function stepPartialUpdates(ctx) {
  const { hub, targets, prefix } = ctx;
  if (!ctx.oneDateVerbatim) {
    row(
      "3 partial updates",
      "scenario.update / window.update",
      "far-future one-date BLOCK available",
      "not run: the one-date cron was not stored verbatim in step 2",
      "blocked",
    );
    return;
  }
  const probeData = (cron) => ({
    targets: [
      ifNode("EVERY", cronCondition("NONE", cron, 0), [
        setLamp(targets.lamp, false),
      ]),
    ],
  });
  const block = await createBlock(ctx, {
    label: "block-partial",
    data: probeData(ONE_DATE_CRON),
    sync: true,
  });
  blockRow("3 probe BLOCK create", block, "stored as sent; sync=true");
  if (!block.scenarioRef || abortReason) return;
  const ref = block.scenarioRef;
  if (!hub.created.get(ref)?.activatable) {
    throw new GuardError("probe BLOCK is not activatable");
  }
  let previous = await readScenario(hub, ref);

  const check = async (
    step,
    nativeOp,
    input,
    changedFields,
    expectedValues,
  ) => {
    const result = await prepareAndApply(hub, { target_ref: ref, ...input });
    if (result.applied) {
      pushCleanup(ctx, {
        label: `${step} (${input.operation})`,
        parent: block.cleanupEntry,
        changeRef: result.changeRef,
        restoreOptional: input.operation === "scenario_active",
      });
    }
    const current = await readScenario(hub, ref);
    const changed = SCENARIO_FIELDS.filter(
      (field) => !isDeepStrictEqual(previous[field], current[field]),
    );
    const unexpected = changed.filter(
      (field) => !changedFields.includes(field),
    );
    const valueMismatch = Object.entries(expectedValues).filter(
      ([field, value]) => current[field] !== value,
    );
    const status =
      result.applied?.status === "applied" ? "applied" : describe(result);
    row(
      step,
      nativeOp,
      `only ${changedFields.join(", ")} changes`,
      `${status}; changed [${changed.join(", ")}]` +
        (valueMismatch.length
          ? `; read ${valueMismatch.map(([field]) => `${field}=${JSON.stringify(current[field])}`).join(", ")}`
          : ""),
      result.applied?.status !== "applied"
        ? "rejected"
        : unexpected.length > 0
          ? "mismatch"
          : valueMismatch.length > 0
            ? "hub-normalized"
            : "match",
      {
        before: pick(previous, SCENARIO_FIELDS),
        after: pick(current, SCENARIO_FIELDS),
        ...(unexpected.length ? { unexpected_changes: unexpected } : {}),
      },
    );
    if (unexpected.length > 0) {
      abort(`${step} changed ${unexpected.join(", ")} of the probe BLOCK`);
    }
    previous = current;
    return result;
  };

  await check(
    "3a turn on",
    "scenario.update{index,active:true}",
    { operation: "scenario_active", value: true },
    ["active"],
    { active: true },
  );
  if (abortReason) return;
  const newName = `${prefix}-block-partial-renamed`;
  await check(
    "3b rename",
    "window.update{windowKey,options:[Name]}",
    { operation: "window_option", option_key: "Name", value: newName },
    ["name", "window_name"],
    { name: newName, window_name: newName },
  );
  if (abortReason) return;
  const newDesc = "sprut-agent probe description changed";
  const marker = /\[sprut-agent:native:[a-f0-9]+\]/.exec(
    previous.description ?? "",
  )?.[0];
  const expectedDesc = marker ? `${newDesc}\n\n${marker}` : newDesc;
  await check(
    "3c describe",
    "window.update{windowKey,options:[Desc]}",
    { operation: "window_option", option_key: "Desc", value: newDesc },
    ["description", "window_desc"],
    { description: expectedDesc, window_desc: expectedDesc },
  );
  if (abortReason) return;
  // Read-modify-write, as an agent edits a BLOCK: keep hub fields.
  const updated = structuredClone(previous.data);
  updated.targets[0].if.conditions[0].cron = ONE_DATE_CRON_UPDATED;
  await check(
    "3d data",
    "scenario.update{index,data}",
    { operation: "block_data_update", data: updated },
    ["configuration_sha256"],
    { active: true, on_start: false, sync: true },
  );
  await check(
    "3e turn off",
    "scenario.update{index,active:false}",
    { operation: "scenario_active", value: false },
    ["active"],
    { active: false },
  );
}

// --- step 4: LOGIC source lifecycle ------------------------------------------

function logicSource(name, version) {
  return `info = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(PROBE_DESCRIPTION)},
  version: "${version}",
  author: "sprut-agent",
  onStart: false,
  sourceServices: [HS.Lightbulb],
  sourceCharacteristics: [HC.On],
  options: {}
};

function trigger(source, value, variables, options, context) {
  // Intentionally empty: this probe is never assigned to a service.
}`;
}

async function stepLogic(ctx) {
  const { hub, targets, prefix } = ctx;
  const name = `${prefix}-logic`;
  const source = logicSource(name, "1.0");
  const create = await prepareAndApply(hub, {
    operation: "logic_source_create",
    target_ref: targets.lamp.serviceRef,
    name,
    description: PROBE_DESCRIPTION,
    active: false,
    on_start: false,
    sync: false,
    source,
  });
  const ref = create.applied?.scenario_ref;
  if (!ref) {
    row(
      "4a LOGIC create",
      "scenario.create{LOGIC}",
      "created",
      describe(create),
      "rejected",
    );
    if (create.applied?.native_write_sent) abort("LOGIC create not confirmed");
    return;
  }
  const markerComment = `/* [${create.prepared.ownership_marker}] */`;
  const createdSource = `${source}\n\n${markerComment}`;
  const createEntry = pushCleanup(ctx, {
    label: "LOGIC",
    changeRef: create.changeRef,
    verify: async () => !(await scenarioPresent(hub, ref)),
    fallback: async (result) => activateLogicForRestore(ctx, ref, result),
  });
  const stored = await readScenario(hub, ref);
  const expectedDesc = `${PROBE_DESCRIPTION}\n\n[${create.prepared.ownership_marker}]`;
  const flagDiff = [
    ["name", name],
    ["description", expectedDesc],
    ["active", false],
    ["on_start", false],
    ["sync", false],
    ["type", "LOGIC"],
  ].filter(([field, value]) => stored[field] !== value);
  row(
    "4a LOGIC create",
    "scenario.create{LOGIC}",
    "exact source; flags as sent",
    `${create.applied.status}; source exact ${stored.data === createdSource}; flag differences ${flagDiff.length}`,
    create.applied.status !== "applied" || stored.data !== createdSource
      ? "mismatch"
      : flagDiff.length > 0
        ? "hub-normalized"
        : "match",
    flagDiff.length
      ? {
          flags: flagDiff.map(([field, value]) => ({
            field,
            sent: value,
            read: stored[field],
          })),
        }
      : undefined,
  );
  if (create.applied.status !== "applied") {
    abort("LOGIC create not applied");
    return;
  }
  row(
    "4b LOGIC type on anchor",
    "logic.types{aId,sId}",
    "turned-off LOGIC type is listed for its source service",
    `mapping ${create.applied.logic_mapping_status ?? "none"}${create.applied.native_logic_type ? ` type ${create.applied.native_logic_type}` : ""}${create.applied.logic_mapping_reason ? ` (${create.applied.logic_mapping_reason})` : ""}`,
    create.applied.logic_mapping_status === "mapped" ? "match" : "mismatch",
  );

  const updatedSource = `${logicSource(name, "1.1")}\n\n${markerComment}`;
  const update = await prepareAndApply(hub, {
    operation: "logic_source_update",
    target_ref: ref,
    source: updatedSource,
  });
  if (!update.applied) {
    row(
      "4c LOGIC update",
      "scenario.update{index,data}",
      "applied",
      describe(update),
      "rejected",
    );
  } else {
    const updateEntry = pushCleanup(ctx, {
      label: "LOGIC source update",
      parent: createEntry,
      changeRef: update.changeRef,
      verify: async () => (await readScenario(hub, ref)).data === createdSource,
    });
    const afterUpdate = await readScenario(hub, ref);
    const changed = SCENARIO_FIELDS.filter(
      (field) => !isDeepStrictEqual(stored[field], afterUpdate[field]),
    );
    row(
      "4c LOGIC update",
      "scenario.update{index,data}",
      "exact new source; other fields kept",
      `${update.applied.status}; source exact ${afterUpdate.data === updatedSource}; changed [${changed.join(", ")}]`,
      update.applied.status === "applied" &&
        afterUpdate.data === updatedSource &&
        changed.every((field) => field === "configuration_sha256")
        ? "match"
        : "mismatch",
      {
        before: pick(stored, SCENARIO_FIELDS),
        after: pick(afterUpdate, SCENARIO_FIELDS),
      },
    );
    const restored = await runRestore(hub, updateEntry);
    row(
      "4d restore update",
      "scenario.update{index,data}",
      "created source back",
      restored.observed,
      restored.verified ? "match" : "mismatch",
    );
    if (!restored.verified) {
      abort("LOGIC update was not restored");
      return;
    }
  }
  const deleted = await runRestore(hub, createEntry);
  row(
    "4e restore create",
    "scenario.delete{index}",
    "LOGIC absent",
    deleted.observed,
    deleted.verified ? "match" : "mismatch",
  );
  if (!deleted.verified) abort("created LOGIC was not removed");
}

// LOGIC create restore needs the new type mapped on the anchor service. If a
// turned-off LOGIC is not listed there, turning it on (it is never assigned,
// so it runs nothing) lets restore map and delete it.
async function activateLogicForRestore(ctx, ref, result) {
  if (result.status !== "applied" || result.logic_mapping_status === "mapped") {
    return null;
  }
  ctx.hub.allowLogicActivation = true;
  try {
    const on = await prepareAndApply(ctx.hub, {
      operation: "scenario_active",
      target_ref: ref,
      value: true,
    });
    row(
      "4 cleanup fallback",
      "scenario.update{index,active:true}",
      "unassigned LOGIC turned on so restore can map its type",
      describe(on),
      on.applied?.status === "applied" ? "match" : "rejected",
    );
    return on.applied?.status === "applied" ? on.changeRef : null;
  } finally {
    ctx.hub.allowLogicActivation = false;
  }
}

// --- cleanup -----------------------------------------------------------------

function pushCleanup(ctx, entry) {
  const item = { ...entry, done: false };
  ctx.cleanup.push(item);
  return item;
}

async function runRestore(hub, entry) {
  if (entry.done) return entry.outcome;
  let result = await hub.restore(entry.changeRef);
  if (result.status !== "restored" && entry.fallback) {
    const fallbackChange = await entry.fallback(result);
    if (fallbackChange) {
      await hub.get(entry.changeRef);
      result = await hub.restore(entry.changeRef);
      // Still present: put the fallback's own change back.
      if (result.status !== "restored") await hub.restore(fallbackChange);
    }
  }
  const restored = result.status === "restored";
  const verified = restored && (entry.verify ? await entry.verify() : true);
  entry.done = verified;
  entry.outcome = {
    verified,
    observed: `${result.status ?? "error"}${result.conflict_reason ? ` (${result.conflict_reason})` : ""}${result.error ? ` ${result.error.code}: ${result.error.message}` : ""}; verified ${verified}`,
  };
  report.cleanup.push({
    label: entry.label,
    change_ref: entry.changeRef,
    status: result.status ?? null,
    ...(result.conflict_reason
      ? { conflict_reason: result.conflict_reason }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    verified,
  });
  return entry.outcome;
}

async function runCleanup(hub, cleanup) {
  let clean = true;
  for (const entry of [...cleanup].reverse()) {
    if (entry.done) continue;
    // Turning a probe back on to replay its history adds nothing: the create
    // restore ignores active, and the probe was left off.
    // A change of an object that is already verified deleted has nothing
    // left to restore.
    if (entry.restoreOptional || entry.parent?.done) {
      entry.done = true;
      report.cleanup.push({
        label: entry.label,
        change_ref: entry.changeRef,
        status: entry.restoreOptional
          ? "not_restored_by_design"
          : "owner_object_deleted",
      });
      continue;
    }
    const outcome = await runRestore(hub, entry);
    row(
      `5 cleanup ${entry.label}`,
      "restore_native_change",
      "restored and verified",
      outcome.observed,
      outcome.verified ? "match" : "mismatch",
    );
    if (!outcome.verified) {
      clean = false;
      abort(`cleanup of ${entry.label} failed`);
    }
  }
  return clean;
}

async function finalChecks(hub) {
  let ok = true;
  const inspect = await hub.read("inspect_home", { home_ref: hub.homeRef });
  expectOk(inspect, "inspect_home");
  const leftovers = [
    ...inspect.entities.rooms,
    ...inspect.entities.scenarios,
  ].filter(({ name }) => String(name).startsWith(report.prefix));
  row(
    "5 no probe objects",
    "inspect_home",
    "no room or scenario with the run prefix",
    leftovers.length === 0
      ? "none left"
      : `left: ${leftovers.map(({ ref }) => relativeRef(ref)).join(", ")}`,
    leftovers.length === 0 ? "match" : "mismatch",
  );
  if (leftovers.length > 0) ok = false;
  if (run.before) {
    const after = await homeSnapshot(hub, run.targets);
    report.snapshot.after_sha256 = sha256(stableJson(after));
    report.targets.lamp_values_after = await lampValues(hub, run.targets.lamp);
    const diff = snapshotDiff(run.before, after);
    report.snapshot.equal = diff.length === 0;
    report.snapshot.diff = diff;
    row(
      "5 final snapshot",
      "inspect_home, get_entity, read_services",
      "equal to the initial snapshot",
      diff.length === 0
        ? `equal (sha256 ${report.snapshot.after_sha256.slice(0, 12)})`
        : `${diff.length} difference(s)`,
      diff.length === 0 ? "match" : "mismatch",
    );
    if (diff.length > 0) {
      ok = false;
      console.log("\nSnapshot differences (ref, field):");
      for (const entry of diff) {
        console.log(
          `  ${entry.collection} ${relativeRef(entry.ref)} ${entry.field}`,
        );
      }
    }
  }
  return ok;
}

function snapshotDiff(before, after) {
  const diff = [];
  for (const collection of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    const left = before[collection];
    const right = after[collection];
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      !left.every((item) => isRecord(item) && typeof item.ref === "string")
    ) {
      if (!isDeepStrictEqual(left, right)) {
        diff.push({
          collection,
          ref: "",
          field: "value",
          before: left,
          after: right,
        });
      }
      continue;
    }
    const byRefLeft = new Map(left.map((item) => [item.ref, item]));
    const byRefRight = new Map(right.map((item) => [item.ref, item]));
    for (const ref of new Set([...byRefLeft.keys(), ...byRefRight.keys()])) {
      const a = byRefLeft.get(ref);
      const b = byRefRight.get(ref);
      if (!a || !b) {
        diff.push({ collection, ref, field: a ? "removed" : "added" });
        continue;
      }
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!isDeepStrictEqual(a[field], b[field])) {
          diff.push({
            collection,
            ref,
            field,
            before: a[field],
            after: b[field],
          });
        }
      }
    }
  }
  return diff;
}

// --- sweep -------------------------------------------------------------------

// Manual recovery: sweep one earlier run's objects without a probe.
async function sweepOnly() {
  const prefix = optionValue("--sweep-only");
  if (!PROBE_PREFIX.test(prefix ?? "")) {
    console.error(
      "--sweep-only needs a run prefix such as zz-sprut-agent-probe-20260924T121158Z.",
    );
    return 2;
  }
  const stateDirectory = optionValue("--state-dir");
  const entries = await runSweep({
    prefix,
    stateDirectory,
    homeRef: null,
    sweptIsFailure: false,
  });
  printTable();
  if (!stateDirectory) {
    console.log(
      "\nProbe rooms are only reported without --state-dir: their proof of ownership is the run's change journal (state_directory in its report).",
    );
  }
  return entries?.every(({ outcome }) => outcome === "deleted") ? 0 : 1;
}

// Runs the sweep through its own product client and records one row per
// object. Returns the entries, or null when the sweep could not finish.
async function runSweep({ prefix, stateDirectory, homeRef, sweptIsFailure }) {
  let entries;
  try {
    const client = await new SprutHubConnection({
      env: serverEnvironment(stateDirectory),
    }).getClient();
    try {
      const clientHomeRef =
        client.serial === null
          ? null
          : `spruthub://hub/${encodeURIComponent(client.serial)}`;
      if (clientHomeRef === null || (homeRef && clientHomeRef !== homeRef)) {
        throw new Error("the product client did not select the probed home");
      }
      entries = await sweepProbeObjects({
        client,
        prefix,
        changes: await readJournal(client, stateDirectory),
      });
    } finally {
      await client.close();
    }
  } catch (error) {
    row("5 sweep", "-", "sweep completes", error.message, "mismatch");
    return null;
  }
  report.sweep = entries.map((entry) => ({
    ...entry,
    ref: relativeRef(entry.ref),
  }));
  if (entries.length === 0) {
    row("5 sweep", "room.list, scenario.list", "nothing left", "none", "match");
  }
  for (const entry of entries) {
    const deleted = entry.outcome === "deleted";
    row(
      `5 sweep ${relativeRef(entry.ref)}`,
      `${entry.kind}.delete`,
      "nothing left",
      deleted
        ? "deleted by the sweep; restore had left it"
        : `left: ${entry.reason}`,
      deleted && !sweptIsFailure ? "match" : "mismatch",
    );
  }
  return entries;
}

async function readJournal(client, stateDirectory) {
  if (!stateDirectory) return null;
  const store = new AutomationStore({
    directory: stateDirectory,
    hubUrl: client.url,
    hubSerial: client.serial,
  });
  try {
    await access(store.file);
  } catch {
    return null;
  }
  return store.list();
}

// Deletes, directly through the product client, every room and scenario of
// the run (name starts with prefix) that the product provably created and
// that cannot act: a scenario with the product's marker and active=false, a
// room from the run's room_create with no accessories. Everything else with
// the prefix is left and reported. `changes` is the run's change journal, or
// null when it is not available. The product's restore is not used: the
// sweep exists for objects that restore could not remove.
export async function sweepProbeObjects({ client, prefix, changes }) {
  const entries = [];
  const homeRef = `spruthub://hub/${encodeURIComponent(client.serial)}`;
  for (const summary of await client.listScenarios()) {
    if (!String(summary.name).startsWith(prefix)) continue;
    entries.push({
      kind: "scenario",
      ref: `${homeRef}/scenario/${encodeURIComponent(summary.index)}`,
      name: summary.name,
      ...(await settle(() => sweepScenario(client, summary.index))),
    });
  }
  for (const room of (await client.listRooms()).rooms) {
    if (!room.name.startsWith(prefix)) continue;
    entries.push({
      kind: "room",
      ref: room.ref,
      name: room.name,
      ...(await settle(() =>
        sweepRoom(client, Number(room.ref.split("/").at(-1)), changes),
      )),
    });
  }
  return entries;
}

async function sweepScenario(client, index) {
  const scenario = await client.getScenario(index);
  if (scenario === null) return { outcome: "gone" };
  const marked =
    scenario.type === "BLOCK"
      ? BLOCK_MARKER.test(scenario.desc ?? "")
      : scenario.type === "LOGIC" && LOGIC_MARKER.test(scenario.data ?? "");
  if (!marked) return left("no_ownership_marker");
  if (scenario.active !== false) {
    return left(scenario.active === true ? "active" : "active_unknown");
  }
  return deleteAndVerify(
    () => client.deleteScenario(index),
    () => client.getScenario(index),
  );
}

async function sweepRoom(client, id, changes) {
  if (changes === null) return left("journal_unavailable");
  const created = changes.some(
    (change) =>
      change.kind === "room_create" &&
      change.room_creation_owned === true &&
      change.created_room_id === id,
  );
  if (!created) return left("no_ownership_marker");
  if ((await client.listAccessoriesInRoom(id)).length > 0) {
    return left("not_empty");
  }
  return deleteAndVerify(
    () => client.deleteRoom(id),
    () => client.getRoom(id),
  );
}

// A delete without a clear answer may still have happened; only a readback
// decides, and a failed readback leaves the object reported, not deleted.
async function deleteAndVerify(remove, read) {
  let failure;
  try {
    await remove();
  } catch (error) {
    failure = error;
  }
  if ((await read()) === null) return { outcome: "deleted" };
  return left(
    failure
      ? `delete_failed ${failure.code ?? failure.message}`
      : "still_present",
  );
}

async function settle(action) {
  try {
    return await action();
  } catch (error) {
    return left(`error ${error.code ?? error.message}`);
  }
}

function left(reason) {
  return { outcome: "left", reason };
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// --- helpers -----------------------------------------------------------------

async function prepareAndApply(hub, input) {
  const prepared = await hub.prepare(input);
  if (prepared.status !== "prepared") return { prepared };
  let applied = await hub.apply(prepared.change_ref);
  // A lost response is reconciled by readback, never by resending.
  if (["uncertain", "applying"].includes(applied.status)) {
    applied = await hub.get(prepared.change_ref);
  }
  return { prepared, applied, changeRef: prepared.change_ref };
}

function describe(result) {
  const failed = result.applied ?? result.prepared;
  if (!failed) return "no result";
  if (failed.error) return `${failed.error.code}: ${failed.error.message}`;
  return `${failed.status}${failed.conflict_reason ? ` (${failed.conflict_reason})` : ""}`;
}

function expectOk(result, what) {
  if (result?.status !== "ok") throw new ProbeFailure(`${what} failed`, result);
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byRef(left, right) {
  return left.ref.localeCompare(right.ref);
}

function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function relativeRef(ref) {
  return String(ref).replace(/^spruthub:\/\/hub\/[^/]+\/?/, "");
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function printTable() {
  const columns = [
    ["step", 26],
    ["native_op", 38],
    ["expected", 44],
    ["observed", 60],
    ["verdict", 14],
  ];
  const cell = (text, width) => {
    const value = String(text ?? "").replaceAll("\n", " ");
    return value.length > width
      ? `${value.slice(0, width - 1)}…`
      : value.padEnd(width);
  };
  console.log(columns.map(([name, width]) => cell(name, width)).join(" | "));
  console.log(columns.map(([, width]) => "-".repeat(width)).join("-|-"));
  for (const item of rows) {
    console.log(
      columns.map(([name, width]) => cell(item[name], width)).join(" | "),
    );
  }
}

// Imported by its offline test without touching a hub.
if (import.meta.main) process.exitCode = await main();
