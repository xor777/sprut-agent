#!/usr/bin/env node
// Live conformance probe of the shipped MCP server against a real SprutHub.
//
// It talks only through dist/plugin/dist/server.mjs over stdio. Every write
// goes through a guard: it may create BLOCK and LOGIC scenarios whose names
// start with the run prefix, rooms and one virtual Lightbulb without links
// named with the short run name (the hub keeps 30 characters of those), and
// may change or restore only objects it created in this run. By the owner's
// rules a BLOCK may act only on that virtual accessory and start only on a
// one-date cron in FAR_FUTURE_YEAR or later or on one daily time; it is
// created turned off with onStart=false. A run BLOCK may be turned on; a run
// LOGIC, whose source is an info object and an empty trigger, may be on only
// while it is not assigned, and is assigned only to the virtual accessory
// while it is off. The owner's devices, scenarios, rooms and settings are only
// read. Everything created is restored (deleted) in reverse order and the
// final home snapshot must equal the initial one. A final sweep then deletes,
// through the product client, every inert object of this run that the
// product owns but its restore left behind, the run's own unlinked virtual
// accessory and its one directly created room, and fails the run for each
// unless a step left that object to it on purpose.
// `--sweep-only <prefix> [--state-dir <dir>]` runs only that sweep;
// `--read-only` runs only the read steps and refuses every write;
// `--only <ids>` runs the named steps (STEPS below).
//
// Output: a JSON report in a new temporary directory and a console table.
// Hub names are stored only as SHA-256; credentials never pass through here.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { AutomationStore } from "../src/automation-store.mjs";
import { canonicalBlock } from "../src/block-model.mjs";
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
const HOLD_MS = 60_000;
const DELAY_MS = 60_000;
const PROBE_DESCRIPTION = "sprut-agent live conformance probe; safe to delete";
// How long a run or a turn-on is watched for a write to the virtual accessory.
const WATCH_MS = 6_000;
const POLL_MS = 500;
const DAY_MS = 86_400_000;
// How long scenario.get and the options window may disagree on active.
const AGREE_MS = 5_000;
const AGREE_POLL_MS = 250;
// The firing BLOCK of step 6t starts on the first whole minute at least
// FIRE_LEAD_MS ahead of the hub clock and is watched until FIRE_MARGIN_MS
// after it, never longer than FIRE_WAIT_MAX_MS.
const FIRE_LEAD_MS = 90_000;
const FIRE_MARGIN_MS = 30_000;
const FIRE_WAIT_MAX_MS = 200_000;
const FIRE_POLL_MS = 2_000;
// The web client's days_at_time trigger for every day (src/block-model.mjs).
const DAILY_TIME_CRON = /^0 ([0-5]?\d) ([01]?\d|2[0-3]) \? \* \* \*$/;
// A probe room name starts with the run's short name. The hub cut room names
// to 30 characters; step 1n sends longer ones on purpose.
const ROOM_NAME_PROBE_MAX = 40;
const REASON =
  "Owner-authorized live conformance probe; only objects created by this run are changed and all are removed.";
const PROBE_PREFIX = /^zz-sprut-agent-probe-\d{8}T\d{6}Z$/;
// How the product marks what it creates (src/automation-service.mjs): the
// desc of a BLOCK and the source of a LOGIC carry the change marker. A room
// has no field for one; its proof is the run's room_create in the journal.
const BLOCK_MARKER = /\[sprut-agent:(?:native|automation):[0-9a-f]{24}\]/;
const LOGIC_MARKER = /\/\* \[sprut-agent:native:[0-9a-f]{24}\] \*\//;

const READ_TOOLS = new Set([
  "home_overview",
  "find_devices",
  "get_entity",
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
  "logic_assignment",
  "scenario_run",
  "virtual_light_group",
]);

export class GuardError extends Error {}

class ProbeFailure extends Error {
  constructor(message, result) {
    super(message);
    this.code = result?.error?.code;
    this.result = result;
  }
}

// The only path from this script to the MCP server.
export class GuardedHub {
  #client;
  #listClient = null;
  #listClientGiven;
  // productClient: the product client for raw reads (lists, a LOGIC's window
  // and types); without it one is opened from this process's connection env.
  constructor(client, prefix, { readOnly = false, productClient } = {}) {
    this.#client = client;
    this.#listClient = productClient ?? null;
    this.#listClientGiven = productClient !== undefined;
    this.prefix = prefix;
    this.readOnly = readOnly;
    this.homeRef = null;
    this.settingsWindowRef = null;
    // ref -> { kind: room|block|logic, ... } for every object of this run.
    this.created = new Map();
    this.changes = new Map();
    this.calls = [];
    // The run's virtual accessory ids and the rooms that hold it.
    this.virtualAIds = new Set();
    this.virtualRooms = new Set();
    // Options windows of this run's BLOCKs and LOGICs: window ref -> scenario.
    this.ownWindows = new Map();
    this.logicWindows = new Map();
    this.directRoomSent = false;
    // Run objects a step leaves to the final sweep on purpose: ref -> reason.
    this.sweepExpected = new Map();
  }

  async read(tool, args) {
    if (!READ_TOOLS.has(tool)) throw new GuardError(`${tool} is not a read`);
    return this.#call(tool, args);
  }

  // Every room, scenario, accessory and extension of the home for the safety
  // snapshot.
  // The MCP reads answer questions, not full listings, so these lists are
  // read with the product client, as the sweep does.
  async lists() {
    const client = await this.#productClient();
    const serial = decodeURIComponent(this.homeRef.split("/").at(-1));
    const [rooms, scenarios, accessories, extensions] = await Promise.all([
      client.listRooms(),
      client.listScenarios(),
      client.listAccessories(),
      client.nativeExtensions(serial, Date.now() + 10_000),
    ]);
    return {
      accessories,
      extensions: extensions.extensions,
      rooms: rooms.rooms,
      scenarios: scenarios.map((scenario) => ({
        ref: `${this.homeRef}/scenario/${encodeURIComponent(scenario.index)}`,
        name: scenario.name,
        type: scenario.type,
        predefined: scenario.predefined === true,
        active: scenario.active === true,
        on_start: scenario.onStart === true,
        sync: scenario.sync === true,
      })),
    };
  }

  async closeListClient() {
    if (this.#listClientGiven) return;
    await this.#listClient?.close();
    this.#listClient = null;
  }

  async #productClient() {
    this.#listClient ??= await new SprutHubConnection({
      env: serverEnvironment(report.state_directory),
    }).getClient();
    return this.#listClient;
  }

  async prepare(input) {
    this.#writable(input.operation);
    this.#checkPrepare(input);
    if (input.operation === "logic_assignment") {
      await this.#checkAssignedType(input.target_ref);
    }
    const result = await this.#call("prepare_native_change", {
      reason: REASON,
      ...input,
    });
    const owned = this.created.get(input.target_ref);
    if (
      input.operation === "scenario_active" &&
      input.value === false &&
      result.status === "already_desired" &&
      owned?.kind === "logic"
    ) {
      owned.on.clear();
    }
    if (typeof result.change_ref === "string") {
      this.changes.set(result.change_ref, {
        operation: input.operation,
        target_ref: input.target_ref,
        value: input.value,
        active: input.active,
        // Product-created BLOCKs passed probeBlockViolation and act only on
        // the virtual accessory, so they may be turned on.
        activatable:
          input.operation === "block_create" && input.on_start === false,
        // The product's path to a BLOCK's Active window option is only
        // prepared, to learn whether it is offered; a virtual light group is
        // only prepared, to see its duplicate check.
        prepareOnly:
          this.ownWindows.has(input.target_ref) ||
          input.operation === "virtual_light_group",
        logicRef:
          input.operation === "logic_assignment"
            ? this.#assignedLogic(input.target_ref)
            : undefined,
      });
    }
    return result;
  }

  async apply(changeRef) {
    this.#writable("apply");
    const change = this.#ownChange(changeRef);
    if (change.prepareOnly)
      throw new GuardError(`${changeRef} is prepare-only`);
    // Recorded before the write: a lost answer may still have switched or
    // assigned the LOGIC.
    const owned = this.created.get(change.target_ref);
    if (
      change.operation === "scenario_active" &&
      change.value === true &&
      owned?.kind === "logic"
    ) {
      owned.on.add(changeRef);
    }
    if (change.operation === "logic_assignment") {
      this.created.get(change.logicRef).assignments.add(changeRef);
    }
    const result = await this.#call("apply_native_change", {
      change_ref: changeRef,
    });
    this.#trackCreated(change, result, changeRef);
    if (
      change.operation === "scenario_active" &&
      change.value === false &&
      owned?.kind === "logic" &&
      result.status === "applied"
    ) {
      owned.on.clear();
    }
    return result;
  }

  async restore(changeRef) {
    this.#writable("restore");
    const change = this.#ownChange(changeRef);
    const result = await this.#call("restore_native_change", {
      change_ref: changeRef,
    });
    if (result.status === "restored") {
      const owned = this.created.get(change.target_ref);
      if (change.operation === "scenario_active" && owned?.kind === "logic") {
        owned.on.delete(changeRef);
      }
      if (change.operation === "logic_assignment") {
        this.created.get(change.logicRef)?.assignments.delete(changeRef);
      }
    }
    return result;
  }

  async get(changeRef) {
    const result = await this.read("get_native_change", {
      change_ref: changeRef,
    });
    this.#trackCreated(this.changes.get(changeRef), result, changeRef);
    return result;
  }

  // Lets window_option reach the options window of a LOGIC of this run. The
  // product names only a BLOCK's window, so the key is read here from the
  // scenario itself.
  async registerLogicWindow(scenarioRef) {
    if (this.created.get(scenarioRef)?.kind !== "logic") {
      throw new GuardError(
        `${relativeRef(scenarioRef)} is no LOGIC of this run`,
      );
    }
    const scenario = await (await this.#productClient()).getScenario(
      scenarioIndex(scenarioRef),
    );
    if (typeof scenario?.optionsWindow !== "string") return null;
    const windowRef = `${this.homeRef}/window/${encodeURIComponent(scenario.optionsWindow)}`;
    this.logicWindows.set(windowRef, scenarioRef);
    return windowRef;
  }

  #writable(what) {
    if (this.readOnly) throw new GuardError(`${what}: this run is read-only`);
  }

  #ownChange(changeRef) {
    const change = this.changes.get(changeRef);
    if (!change) throw new GuardError(`${changeRef} was not prepared here`);
    return change;
  }

  #trackCreated(change, result, changeRef) {
    if (!change) return;
    if (change.operation === "room_create" && result?.room?.ref) {
      this.created.set(result.room.ref, { kind: "room" });
    }
    if (
      !["block_create", "logic_source_create"].includes(change.operation) ||
      typeof result?.scenario_ref !== "string"
    ) {
      return;
    }
    if (!this.created.has(result.scenario_ref)) {
      this.created.set(
        result.scenario_ref,
        change.operation === "block_create"
          ? { kind: "block", activatable: change.activatable === true }
          : {
              kind: "logic",
              type: null,
              // Changes that may have left it on, and its assignments.
              on: new Set(change.active === true ? [changeRef] : []),
              assignments: new Set(),
            },
      );
    }
    const owned = this.created.get(result.scenario_ref);
    if (
      owned.kind === "logic" &&
      typeof result.native_logic_type === "string"
    ) {
      owned.type = result.native_logic_type;
    }
  }

  // The LOGIC of this run whose native type a logic ref names.
  #assignedLogic(logicRef) {
    const match = /\/logic\/([^/]+)$/.exec(logicRef ?? "");
    if (!match) return undefined;
    const type = decodeURIComponent(match[1]);
    for (const [ref, owned] of this.created) {
      if (owned.kind === "logic" && owned.type === type) return ref;
    }
    return undefined;
  }

  // The product maps a LOGIC to the one new type on its anchor. A LOGIC the
  // owner created meanwhile could be that type; the type's entry must name
  // a scenario of this run.
  async #checkAssignedType(logicRef) {
    const match = /\/accessory\/(\d+)\/service\/(\d+)\/logic\/([^/]+)$/.exec(
      logicRef,
    );
    const type = decodeURIComponent(match[3]);
    const types = await (await this.#productClient()).listLogicTypes({
      aId: Number(match[1]),
      sId: Number(match[2]),
    });
    const entry = types.find((item) => item.type === type);
    if (!String(entry?.name).startsWith(this.prefix)) {
      throw new GuardError(
        `refused logic_assignment on ${logicRef}: the type does not name a scenario of this run`,
      );
    }
  }

  #isVirtualService(ref) {
    const match = /^(.*)\/accessory\/(\d+)\/service\/\d+$/.exec(ref ?? "");
    return (
      match !== null &&
      match[1] === this.homeRef &&
      this.virtualAIds.has(Number(match[2]))
    );
  }

  #checkPrepare(input) {
    const { operation: op, target_ref: target } = input;
    const refuse = (why) => {
      throw new GuardError(`refused ${op} on ${target}: ${why}`);
    };
    if (!PREPARE_OPERATIONS.has(op)) refuse("operation is not allowed");
    const owned = this.created.get(target);
    if (["room_create", "block_create", "virtual_light_group"].includes(op)) {
      if (target !== this.homeRef) refuse("target must be the home ref");
    }
    if (op === "block_create" && !input.name?.startsWith(this.prefix)) {
      refuse("name lacks prefix");
    }
    if (op === "room_create" && !isProbeRoomName(input.name, this.prefix)) {
      refuse("room name lacks the short run name");
    }
    if (op === "block_create") {
      if (input.active !== false || input.on_start !== false) {
        refuse("a BLOCK must be created off with onStart=false");
      }
    }
    if (["block_create", "block_data_update"].includes(op)) {
      const violation = probeBlockViolation(input.data, this.virtualAIds);
      if (violation) refuse(violation);
    }
    if (op === "logic_source_create") {
      if (!this.#isVirtualService(target)) {
        refuse("the anchor is not the run's virtual accessory");
      }
      if (!input.name?.startsWith(this.prefix)) refuse("name lacks prefix");
      if (typeof input.active !== "boolean" || input.on_start !== false) {
        refuse("LOGIC needs an explicit active and onStart=false");
      }
    }
    if (["logic_source_create", "logic_source_update"].includes(op)) {
      // On and unassigned, such a LOGIC still runs nothing.
      if (!isInertProbeLogic(input.source, this.prefix)) {
        refuse("the source is not an info object with an empty trigger");
      }
    }
    if (op === "logic_source_update" && owned?.kind !== "logic") {
      refuse("LOGIC not created by this run");
    }
    if (op === "room_name") {
      if (owned?.kind !== "room" || owned.direct) {
        refuse("room not created by this run");
      }
      if (!isProbeRoomName(input.value, this.prefix)) {
        refuse("room name lacks the short run name");
      }
    }
    if (op === "block_data_update" && owned?.kind !== "block") {
      refuse("BLOCK not created by this run");
    }
    if (op === "window_option") this.#checkWindowOption(input, owned, refuse);
    if (op === "scenario_active") {
      if (!owned || owned.kind === "room") refuse("not created by this run");
      if (
        input.value === true &&
        owned.kind === "block" &&
        !owned.activatable
      ) {
        refuse("turning this BLOCK on is not allowed");
      }
      if (
        input.value === true &&
        owned.kind === "logic" &&
        owned.assignments.size > 0
      ) {
        refuse("an assigned LOGIC stays off");
      }
    }
    if (op === "logic_assignment") {
      const service = /^(.*)\/logic\/[^/]+$/.exec(target ?? "")?.[1];
      if (!this.#isVirtualService(service)) {
        refuse("only on the run's virtual accessory");
      }
      const logicRef = this.#assignedLogic(target);
      if (!logicRef) refuse("not the type of a LOGIC of this run");
      if (this.created.get(logicRef).on.size > 0) {
        refuse("a LOGIC that may be on is not assigned");
      }
    }
    if (op === "virtual_light_group") {
      if (input.name !== probeShortName(this.prefix)) {
        refuse("name is not the run's virtual accessory name");
      }
      if (!this.virtualRooms.has(input.room_ref)) {
        refuse("room is not the run's virtual accessory room");
      }
    }
    if (op === "scenario_run" && owned?.kind !== "block") {
      refuse("BLOCK not created by this run");
    }
  }

  #checkWindowOption(input, owned, refuse) {
    const target = input.target_ref;
    const namePrefixed = String(input.value).startsWith(this.prefix);
    if (this.ownWindows.has(target)) {
      if (input.option_key !== "Active" || input.value !== false) {
        refuse("only Active=false on a probe BLOCK window");
      }
    } else if (this.logicWindows.has(target) || owned?.kind === "logic") {
      if (input.option_key !== "Name" || !namePrefixed) {
        refuse("only a Name with the run prefix on a probe LOGIC");
      }
    } else {
      if (owned?.kind !== "block") refuse("BLOCK not created by this run");
      if (!["Name", "Desc"].includes(input.option_key)) refuse("option key");
      if (input.option_key === "Name" && !namePrefixed) refuse("name prefix");
    }
  }

  async #call(tool, args) {
    const started = Date.now();
    const response = await this.#client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
    const text = (response.content ?? [])
      .map((item) => item.text ?? "")
      .join("");
    const result = response.structuredContent ?? JSON.parse(text || "null");
    this.calls.push({
      tool,
      ...(args.operation ? { operation: args.operation } : {}),
      ref: relativeRef(
        args.target_ref ?? args.entity_ref ?? args.change_ref ?? "",
      ),
      status: result?.status ?? null,
      ...(result?.error?.code ? { error: result.error.code } : {}),
      ms: Date.now() - started,
      // What an agent reads: the text content of the tool result.
      bytes: Buffer.byteLength(text),
    });
    return result;
  }
}

// The only path for writes that bypass the MCP server, through the product
// client: the run's virtual accessory (create, set, delete), turned-off
// BLOCKs made directly, a run of this run's BLOCK, the Active option of such
// a BLOCK's own options window and one directly created room. Its reads are
// raw hub reads (scenario, window, room, logic types) that the MCP answers
// only in part; history.list has no client method at all.
export class ProbeClient {
  #client;
  #hub;
  #stateDirectory;

  constructor(client, hub, stateDirectory) {
    this.#client = client;
    this.#hub = hub;
    this.#stateDirectory = stateDirectory;
  }

  static async open(hub, stateDirectory) {
    const client = await new SprutHubConnection({
      env: serverEnvironment(stateDirectory),
    }).getClient();
    if (
      client.serial === null ||
      `spruthub://hub/${encodeURIComponent(client.serial)}` !== hub.homeRef
    ) {
      await client.close();
      throw new Error("the product client did not select the probed home");
    }
    return new ProbeClient(client, hub, stateDirectory);
  }

  close() {
    return this.#client.close();
  }

  // --- reads ---

  getAccessoryOrNull(id) {
    return this.#client.getAccessoryOrNull(id);
  }

  listAccessories() {
    return this.#client.listAccessories();
  }

  listLinks(target) {
    return this.#client.listLinks(target);
  }

  getCharacteristic(target) {
    return this.#client.getCharacteristic(target);
  }

  getRoom(id) {
    return this.#client.getRoom(id);
  }

  listScenarios() {
    return this.#client.listScenarios();
  }

  getScenario(index) {
    return this.#client.getScenario(index);
  }

  getWindow(windowKey) {
    return this.#client.getWindow(windowKey);
  }

  listLogicTypes(target) {
    return this.#client.listLogicTypes(target);
  }

  listLogics(target) {
    return this.#client.listLogics(target);
  }

  // The stored BLOCK data exactly as scenario.get returns it.
  async storedBlockData(scenarioRef) {
    const scenario = await this.#client.getScenario(scenarioIndex(scenarioRef));
    return {
      active: scenario?.active,
      data:
        typeof scenario?.data === "string"
          ? JSON.parse(scenario.data)
          : scenario?.data,
    };
  }

  // scenario.get's active and the Active option of the scenario's options
  // window, read one right after the other; no other value is kept.
  async activeView(scenarioRef) {
    const scenario = await this.#client.getScenario(scenarioIndex(scenarioRef));
    if (scenario === null) return null;
    const windowKey =
      typeof scenario.optionsWindow === "string"
        ? scenario.optionsWindow
        : null;
    let window = null;
    let windowError = null;
    if (windowKey !== null) {
      try {
        window = await this.#client.getWindow(windowKey);
      } catch (error) {
        windowError = error.code ?? error.message;
      }
    }
    const option = window?.options.find(({ key }) => key === "Active");
    return {
      active: scenario.active,
      name: scenario.name,
      windowKey,
      windowError,
      keys: window?.options.map(optionShape) ?? [],
      option: option
        ? { ...optionShape(option), value: option.value?.boolValue }
        : null,
    };
  }

  // --- writes ---

  #writable(what) {
    if (this.#hub.readOnly) {
      throw new GuardError(`${what}: this run is read-only`);
    }
  }

  async createVirtualAccessory(roomRef, optional) {
    this.#writable("accessory.create");
    if (this.#hub.created.get(roomRef)?.kind !== "room") {
      throw new GuardError("the accessory room was not created by this run");
    }
    if (this.#hub.virtualAIds.size > 0) {
      throw new GuardError("this run already has its virtual accessory");
    }
    const name = probeShortName(this.#hub.prefix);
    const accessory = await this.#client.createAccessory({
      name,
      roomId: Number(roomRef.split("/").at(-1)),
      services: [{ name, type: "Lightbulb", optional }],
    });
    await recordProbeId(this.#stateDirectory, PROBE_ACCESSORIES, accessory.id);
    this.#hub.virtualAIds.add(accessory.id);
    this.#hub.virtualRooms.add(roomRef);
    return accessory;
  }

  deleteVirtualAccessory(id) {
    this.#writable("accessory.delete");
    if (!this.#hub.virtualAIds.has(id)) {
      throw new GuardError(`accessory ${id} is not the run's virtual one`);
    }
    return this.#client.deleteAccessory(id);
  }

  setVirtualValue(target, value) {
    this.#writable("characteristic.update");
    if (!this.#hub.virtualAIds.has(target.aId)) {
      throw new GuardError(
        `accessory ${target.aId} is not the run's virtual one`,
      );
    }
    return this.#client.updateCharacteristic({ ...target, value });
  }

  // One direct room.create per run, to see what the hub keeps of a name the
  // product refuses. It carries the run's short name, and its id, written
  // right after the hub's answer, proves it for the sweep.
  async createRoomDirect(name) {
    this.#writable("room.create");
    if (!isProbeRoomName(name, this.#hub.prefix)) {
      throw new GuardError("refused direct room.create: not a probe name");
    }
    if (this.#hub.directRoomSent) {
      throw new GuardError("refused direct room.create: one was sent");
    }
    this.#hub.directRoomSent = true;
    const room = await this.#client.createRoom(name);
    await recordProbeId(this.#stateDirectory, PROBE_ROOMS, room.id);
    const ref = `${this.#hub.homeRef}/room/${room.id}`;
    this.#hub.created.set(ref, { kind: "room", direct: true });
    return { ref, id: room.id, name: room.name };
  }

  async deleteDirectRoom(roomRef) {
    this.#writable("room.delete");
    const owned = this.#hub.created.get(roomRef);
    if (owned?.kind !== "room" || owned.direct !== true) {
      throw new GuardError(`${relativeRef(roomRef)} was not made directly`);
    }
    const id = Number(roomRef.split("/").at(-1));
    if ((await this.#client.listAccessoriesInRoom(id)).length > 0) {
      return { failure: new Error("the room is not empty"), gone: false };
    }
    return deleteChecked(
      () => this.#client.deleteRoom(id),
      () => this.#client.getRoom(id),
    );
  }

  // The product creates an action-only BLOCK only turned on; this is the
  // turned-off form an owner can have. Same rule as every probe BLOCK.
  // A marker of the sweep's form in desc lets the sweep delete this BLOCK if
  // its own cleanup fails; it is not a product change and has no journal.
  async createTurnedOffBlock(name, data) {
    this.#writable("scenario.create");
    const violation = probeBlockViolation(data, this.#hub.virtualAIds);
    if (!name.startsWith(this.#hub.prefix) || violation) {
      throw new GuardError(`refused direct BLOCK: ${violation ?? "name"}`);
    }
    const marker = `sprut-agent:native:${randomBytes(12).toString("hex")}`;
    const created = await this.#client.createScenario({
      name,
      desc: `${PROBE_DESCRIPTION}\n\n[${marker}]`,
      active: false,
      onStart: false,
      sync: false,
      type: "BLOCK",
      data: JSON.stringify(data),
    });
    const ref = `${this.#hub.homeRef}/scenario/${encodeURIComponent(created.index)}`;
    this.#hub.created.set(ref, {
      kind: "block",
      activatable: false,
      direct: true,
    });
    return ref;
  }

  async deleteDirectBlock(scenarioRef) {
    this.#writable("scenario.delete");
    if (!this.#hub.created.get(scenarioRef)?.direct) {
      throw new GuardError(`${relativeRef(scenarioRef)} was not made directly`);
    }
    const index = scenarioIndex(scenarioRef);
    return deleteChecked(
      () => this.#client.deleteScenario(index),
      () => this.#client.getScenario(index),
    );
  }

  runBlock(scenarioRef) {
    this.#writable("scenario.run");
    if (this.#hub.created.get(scenarioRef)?.kind !== "block") {
      throw new GuardError(`${relativeRef(scenarioRef)} is not a probe BLOCK`);
    }
    return this.#client.runScenario(scenarioIndex(scenarioRef));
  }

  async setBlockActiveByWindow(scenarioRef, active) {
    this.#writable("window.update");
    const owned = this.#hub.created.get(scenarioRef);
    if (owned?.kind !== "block" || (active && !owned.activatable)) {
      throw new GuardError(`${relativeRef(scenarioRef)} may not be set here`);
    }
    const scenario = await this.#client.getScenario(scenarioIndex(scenarioRef));
    return this.#client.updateWindowOption({
      windowKey: scenario.optionsWindow,
      key: "Active",
      value: { boolValue: active },
    });
  }

  // One JSON-RPC request on its own socket, in the product client's envelope.
  historyList(request) {
    const client = this.#client;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(client.url, "json-rpc");
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("history.list timed out"));
      }, 20_000);
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("history.list connection failed"));
      });
      socket.once("open", () => {
        socket.send(
          JSON.stringify({
            id: 1,
            token: client.token,
            serial: client.serial,
            cid: client.cid,
            params: { history: { list: request } },
          }),
        );
      });
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.id !== 1) return;
        clearTimeout(timer);
        socket.close();
        resolve(message);
      });
    });
  }
}

// A window option's shape without its value or label.
function optionShape(option) {
  return {
    key: option.key,
    type: option.type ?? null,
    input_type: option.inputType ?? null,
    read: option.read ?? null,
    write: option.write ?? null,
    disabled: option.disabled ?? null,
  };
}

// A delete without a clear answer may still have happened; only the
// readback decides.
async function deleteChecked(remove, read) {
  let failure;
  try {
    await remove();
  } catch (error) {
    failure = error;
  }
  return { failure, gone: (await read()) === null };
}

function isProbeRoomName(name, prefix) {
  return (
    typeof name === "string" &&
    name.startsWith(probeShortName(prefix)) &&
    [...name].length <= ROOM_NAME_PROBE_MAX
  );
}

// The probe LOGIC: an info object literal with no call, and a trigger whose
// body holds only comments, optionally followed by the product's marker.
// Such a LOGIC runs nothing even while it is on.
function isInertProbeLogic(source, prefix) {
  if (typeof source !== "string") return false;
  const body = source.replace(
    /\n\n\/\* \[sprut-agent:native:[0-9a-f]{24}\] \*\/$/,
    "",
  );
  const match =
    /^info = (\{\n[\s\S]*?\n\});\n\nfunction trigger\(source, value, variables, options, context\) \{\n((?: {2}\/\/[^\n]*\n)*)\}$/.exec(
      body,
    );
  if (!match || /[()`=]/.test(match[1])) return false;
  const name = /^ {2}name: ("[^"\n]*"),$/m.exec(match[1])?.[1];
  return name !== undefined && JSON.parse(name).startsWith(prefix);
}

function scenarioIndex(scenarioRef) {
  return decodeURIComponent(scenarioRef.split("/").at(-1));
}

// The owner's rule for every BLOCK of this run: act only on the run's virtual
// accessory, start only on a far-future one-date cron or at one daily time,
// run no code and no other scenario. A characteristic may only be read
// (trigger=false), and only on the virtual accessory. Such a BLOCK may be
// turned on. Returns the first violation or null.
function probeBlockViolation(data, virtualAIds) {
  let violation = null;
  walkNodes(data, (node) => {
    if (violation) return;
    if (
      ["service", "characteristic"].includes(node.type) &&
      !virtualAIds.has(node.aId)
    ) {
      violation = `${node.type} on accessory ${node.aId} is not the run's virtual accessory`;
    } else if (node.type === "characteristic" && node.trigger !== false) {
      violation = "a characteristic trigger is not a time trigger";
    } else if (
      node.type === "cron" &&
      !isFarFutureOneDate(node) &&
      !isDailyTime(node)
    ) {
      violation = `cron ${node.mode} ${node.cron} is neither a far-future one-date cron nor one daily time`;
    } else if (["interval", "code", "scenario"].includes(node.type)) {
      violation = `${node.type} nodes are not allowed`;
    }
  });
  return violation;
}

function isDailyTime(node) {
  return (
    node.mode === "NONE" &&
    node.offset === 0 &&
    DAILY_TIME_CRON.test(node.cron ?? "")
  );
}

function isFarFutureOneDate(node) {
  const match = /^0 \d{1,2} \d{1,2} \d{1,2} \d{1,2} \? (\d{4})$/.exec(
    node.cron ?? "",
  );
  return (
    node.mode === "NONE" &&
    match !== null &&
    Number(match[1]) >= FAR_FUTURE_YEAR
  );
}

function walkNodes(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walkNodes(item, visit);
    return;
  }
  if (!isRecord(node)) return;
  visit(node);
  for (const value of Object.values(node)) walkNodes(value, visit);
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

// Every step by its --only id, in run order. Read steps send no write and are
// the only ones --read-only runs. A step that needs an earlier one reports
// itself blocked when that one did not run.
const STEPS = [
  ["1", stepRoom],
  ["1n", stepRoomNames],
  ["V", stepVirtualAccessory],
  ["Vp", stepPhysicalAccessory, "read"],
  ["Vd", stepVirtualDuplicate],
  ["2", stepBlockStorage],
  ["2i", stepIfForms],
  ["2w", stepOwnerWindows, "read"],
  ["3", stepPartialUpdates],
  ["4", stepLogic],
  ["6", stepManualRun],
  ["6t", stepTimeTrigger],
  ["7", stepHistory, "read"],
  ["8", stepTiming, "read"],
];

async function main() {
  if (process.argv.includes("--sweep-only")) return sweepOnly();
  const only = optionValue("--only")?.split(",");
  const unknown = only?.filter((id) => !STEPS.some(([step]) => step === id));
  if (unknown?.length > 0) {
    console.error(
      `--only: unknown step ${unknown.join(", ")}; steps: ${STEPS.map(([id]) => id).join(", ")}`,
    );
    return 2;
  }
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
  const readOnly = process.argv.includes("--read-only");
  const hub = new GuardedHub(client, prefix, { readOnly });
  const cleanup = [];
  let exitCode = 0;
  let probe;
  try {
    const overview = await hub.read("home_overview", {});
    expectOk(overview, "home_overview");
    if (overview.selection?.required) {
      throw new Error(
        "Several homes: pin one with home_overview selection.pin.",
      );
    }
    hub.homeRef = overview.home.ref;
    hub.settingsWindowRef = overview.home.options_window_ref ?? null;
    report.hub = {
      firmware: overview.home.firmware,
      model: overview.home.model,
    };
    probe = await ProbeClient.open(hub, stateDirectory);

    // The lamp is never a BLOCK target; its values and logic types are
    // evidence that a real device stayed as it was.
    const targets = await discoverTargets(hub);
    report.targets = {
      lamp_service: relativeRef(targets.lamp.serviceRef),
      lamp_values_before: await lampValues(hub, targets.lamp),
    };
    const sdk = await hub.read("get_scenario_sdk", { home_ref: hub.homeRef });
    report.scenario_sdk = { sha256: sdk.sha256, complete: sdk.sdk_complete };

    const before = await homeSnapshot(hub, targets);
    report.snapshot.before_sha256 = sha256(stableJson(before));
    run.targets = targets;
    run.before = before;
    const ctx = { hub, probe, targets, before, cleanup, prefix };

    for (const [id, step, kind] of STEPS) {
      if (readOnly && kind !== "read") {
        row(id, "-", "-", "--read-only: no write sent", "skipped");
      } else if (only && !only.includes(id)) {
        row(id, "-", "-", "not selected by --only", "skipped");
      } else {
        await guardedStep(ctx, id, step);
      }
    }
  } catch (error) {
    abort(`script error: ${error.message}`);
    exitCode = 1;
  } finally {
    try {
      const clean = await runCleanup(hub, cleanup);
      await probe?.close();
      if (!clean) exitCode = 1;
      if (hub.homeRef && !readOnly) {
        const entries = await runSweep({
          prefix,
          stateDirectory,
          homeRef: hub.homeRef,
          sweptIsFailure: true,
          expected: hub.sweepExpected,
        });
        // Only an object a step left to the sweep on purpose may be swept.
        if (
          entries === null ||
          entries.some(
            ({ ref, outcome }) =>
              outcome !== "deleted" || !hub.sweepExpected.has(ref),
          )
        ) {
          exitCode = 1;
        }
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
    await hub.closeListClient();
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
  for (const service of await catalogServices(hub, "light", ["Lightbulb"])) {
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
  const lamp =
    lamps.find(({ on }) => on.current_value.value === false) ?? lamps[0];
  if (!lamp) throw new Error("No Lightbulb with writable On and Brightness.");
  return { lamp, lamps };
}

// The first readable sensor characteristic of this type in the home, or
// undefined.
async function firstCharacteristic(hub, serviceType, type, valueType) {
  for (const service of await catalogServices(hub, "sensor", [serviceType])) {
    const entity = await hub.read("get_entity", {
      entity_ref: service.ref,
      max_bytes: 32_768,
    });
    const found =
      entity.status === "ok" && entity.entity
        ? characteristic(entity.entity, type, valueType, false)
        : undefined;
    if (found) return found;
  }
  return undefined;
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

// Services of one household kind and native types, names only.
async function catalogServices(hub, kind, serviceTypes) {
  let args = {
    home_ref: hub.homeRef,
    kind,
    values: false,
    limit: 100,
    max_bytes: 32_768,
  };
  const services = [];
  for (;;) {
    const page = await hub.read("find_devices", args);
    expectOk(page, "find_devices");
    for (const room of page.rooms) {
      for (const device of room.devices) {
        services.push(
          ...device.services.filter(({ type }) => serviceTypes.includes(type)),
        );
      }
    }
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
  const lists = await hub.lists();
  const rooms = lists.rooms
    .map(({ ref, name }) => ({ ref, name_sha256: sha256(name) }))
    .sort(byRef);
  const scenarios = [];
  for (const scenario of lists.scenarios) {
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
      // An active BLOCK's if.state is runtime state the hub flips on its own
      // (owner's scenario/31 on 2026-09-24); the product's canonical form
      // drops it, so the snapshot compares that form.
      entry.configuration_sha256 = sha256(
        stableJson(
          configuration?.format === "json" && configuration.value
            ? { ...configuration, value: canonicalBlock(configuration.value) }
            : configuration,
        ),
      );
    } catch (error) {
      entry.configuration_error = error.code ?? "read_failed";
    }
    scenarios.push(entry);
  }
  scenarios.sort(byRef);
  const accessories = new Map();
  const services = [];
  for (const accessory of lists.accessories) {
    const accessoryRef = `${hub.homeRef}/accessory/${accessory.id}`;
    const roomRef = `${hub.homeRef}/room/${accessory.roomId}`;
    accessories.set(accessoryRef, {
      ref: accessoryRef,
      name_sha256: sha256(accessory.name),
      room_ref: roomRef,
    });
    for (const service of accessory.services ?? []) {
      services.push({
        ref: `${accessoryRef}/service/${service.sId}`,
        name_sha256: sha256(service.name),
        type: service.type,
        room_ref: roomRef,
      });
    }
  }
  const anchor = await hub.read("get_entity", {
    entity_ref: targets.lamp.serviceRef,
    max_bytes: 32_768,
  });
  // A bridge that exported the probe accessory would change its child count.
  const extensions = lists.extensions
    .map((extension, position) => ({
      ref: `${extension.ref}#${extension.index ?? position}`,
      bundle_type: extension.bundle_type ?? null,
      enabled: extension.enabled ?? null,
      child_count: extension.child_count ?? null,
    }))
    .sort(byRef);
  return {
    rooms,
    scenarios,
    extensions,
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
    // Canonical form: an active BLOCK's if.state is runtime state that the
    // hub flips on its own; data keeps the stored bytes.
    configuration_sha256: sha256(
      stableJson(
        configuration.format === "json" && configuration.value
          ? canonicalBlock(configuration.value)
          : configuration.value,
      ),
    ),
    data: configuration.value,
    execution_error: entity.execution_error,
    options_window_ref: entity.options_window_ref,
  };
}

// One options window, read through get_entity (read-only).
async function readWindow(hub, windowRef) {
  const result = await hub.read("get_entity", {
    entity_ref: windowRef,
    max_bytes: 32_768,
  });
  if (result.status !== "ok") {
    throw new ProbeFailure("read options window", result);
  }
  // A large window (the owner's home settings) comes back as an overview;
  // its options are then read by pointer.
  const options = result.entity
    ? (result.entity.options ?? [])
    : await readEntityValue(hub, windowRef, undefined, "/options");
  if (!Array.isArray(options)) {
    throw new ProbeFailure("read options window", result);
  }
  return {
    keys: options.map(({ key, input_type }) => `${key}:${input_type}`),
    value: (key) =>
      options.find((option) => option.key === key)?.configured_value,
  };
}

async function scenarioPresent(hub, ref) {
  const { scenarios } = await hub.lists();
  return scenarios.some((scenario) => scenario.ref === ref);
}

async function roomName(hub, ref) {
  const { rooms } = await hub.lists();
  return rooms.find((room) => room.ref === ref)?.name ?? null;
}

// Cheap check after every step: nothing outside this run's objects changed.
async function houseUnchanged(ctx, id) {
  const inspect = await ctx.hub.lists();
  const current = {
    rooms: inspect.rooms
      .filter(({ ref }) => !ctx.hub.created.has(ref))
      .map(({ ref, name }) => ({ ref, name_sha256: sha256(name) }))
      .sort(byRef),
    scenarios: inspect.scenarios
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
  const unknown = [...inspect.rooms, ...inspect.scenarios].filter(
    ({ ref, name }) =>
      !ctx.hub.created.has(ref) && isProbeName(name, ctx.prefix),
  );
  if (!isDeepStrictEqual(current, expected) || unknown.length > 0) {
    const diff = snapshotDiff(expected, current);
    row(
      `${id} house check`,
      "room.list, scenario.list",
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

  const name = `${probeShortName(prefix)}-r`;
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

  const renamed = `${probeShortName(prefix)}-r2`;
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

// Steps that create a room rely on step 1 having proved that the product
// removes a room it created.
function roomRemovalProved() {
  return rows.some(
    (item) => item.step === "1d restore create" && item.verdict === "match",
  );
}

// --- step 1n: room names beyond ASCII -----------------------------------------

// The product refuses a room name over 30 UTF-16 units (name_too_long); the
// hub cut a 42-character ASCII name to 30. What the hub keeps of Cyrillic and
// emoji is unknown: in UTF-8 a Cyrillic letter is 2 bytes and an emoji 4, in
// UTF-16 an emoji is 2 units. Each name starts with the run's short name
// (25 ASCII characters), so a cut name is still the run's.
function roomNameCases(short) {
  return [
    { id: "cyrillic_30", name: `${short}абвгд` },
    { id: "cyrillic_31", name: `${short}абвгде` },
    { id: "emoji_30_units", name: `${short}абв🙂` },
    { id: "emoji_30_chars", name: `${short}аб🙂🙂🙂` },
  ];
}

function nameLengths(name) {
  if (typeof name !== "string") return null;
  return {
    chars: [...name].length,
    utf16: name.length,
    utf8: Buffer.byteLength(name),
  };
}

function lengthsText(name) {
  const lengths = nameLengths(name);
  return lengths
    ? `${lengths.chars} chars/${lengths.utf16} UTF-16/${lengths.utf8} bytes`
    : "no name";
}

async function stepRoomNames(ctx) {
  const { hub, probe, prefix } = ctx;
  if (!roomRemovalProved()) {
    row(
      "1n room names",
      "room.create",
      "step 1 proved that a created room is removed",
      "not run: room removal was not proved",
      "blocked",
    );
    return;
  }
  const short = probeShortName(prefix);
  for (const { id, name } of roomNameCases(short)) {
    const tooLong = name.length > 30;
    const result = await prepareAndApply(hub, {
      operation: "room_create",
      target_ref: hub.homeRef,
      name,
    });
    const expected = tooLong
      ? `refused name_too_long (${lengthsText(name)})`
      : `created, stored exactly (${lengthsText(name)})`;
    if (!result.applied) {
      const code = result.prepared.error?.code;
      row(
        `1n ${id}`,
        "prepare room_create",
        expected,
        describe(result),
        tooLong && code === "name_too_long" ? "match" : "mismatch",
      );
      continue;
    }
    const roomRef = result.applied.room?.ref;
    const entry = roomRef
      ? pushCleanup(ctx, {
          label: `room ${id}`,
          changeRef: result.changeRef,
          verify: async () => (await roomName(hub, roomRef)) === null,
        })
      : undefined;
    const stored = roomRef
      ? (await probe.getRoom(Number(roomRef.split("/").at(-1))))?.name
      : undefined;
    row(
      `1n ${id}`,
      "room.create{name}",
      expected,
      `${result.applied.status}; stored ${JSON.stringify(stored ?? null)} (${lengthsText(stored)})`,
      tooLong || result.applied.status !== "applied"
        ? "mismatch"
        : stored === name
          ? "match"
          : "hub-normalized",
      { sent: name, stored: stored ?? null, product: result.applied.room },
    );
    if (!entry) {
      if (result.applied.native_write_sent) abort(`room ${id} not confirmed`);
      continue;
    }
    const deleted = await runRestore(hub, entry);
    row(
      `1n ${id} restore`,
      "room.delete{id}",
      "room absent",
      deleted.observed,
      deleted.verified ? "match" : "mismatch",
    );
    if (!deleted.verified) {
      abort(`room ${id} was not removed`);
      return;
    }
  }

  // The product refuses 31 characters, so one direct room.create shows what
  // the hub keeps of them. Its id is recorded for the sweep at once.
  const direct = `${short}абвгде`;
  let room;
  try {
    room = await probe.createRoomDirect(direct);
  } catch (error) {
    if (error instanceof GuardError) throw error;
    row(
      "1n direct cyrillic_31",
      "room.create{name} (direct)",
      "record what the hub keeps",
      `${error.code ?? error.message}`,
      "rejected",
    );
    abort("direct room.create without a clear answer");
    return;
  }
  const entry = pushCleanup(ctx, {
    label: "room direct cyrillic_31",
    run: async () => {
      const { failure, gone } = await probe.deleteDirectRoom(room.ref);
      return {
        verified: gone,
        status: gone ? "deleted" : "left",
        observed: `${failure ? `delete error ${failure.code ?? failure.message}` : "room.delete acknowledged"}; verified ${gone}`,
      };
    },
  });
  const stored = (await probe.getRoom(room.id))?.name;
  row(
    "1n direct cyrillic_31",
    "room.create{name} (direct)",
    `record what the hub keeps of ${lengthsText(direct)}`,
    `answer ${JSON.stringify(room.name)}; stored ${JSON.stringify(stored ?? null)} (${lengthsText(stored)})`,
    "observed",
    { sent: direct, answered: room.name, stored: stored ?? null },
  );
  const deleted = await runRestore(hub, entry);
  row(
    "1n direct restore",
    "room.delete{id} (direct)",
    "room absent",
    deleted.observed,
    deleted.verified ? "match" : "mismatch",
  );
  if (!deleted.verified) abort("the direct room was not removed");
}

// --- step V: the run's virtual accessory -------------------------------------

// Every BLOCK of the run acts only on this accessory: a virtual Lightbulb
// with On and Brightness and no links, in a probe room of its own. It is
// created through the product client, as virtual_light_group does, but
// without any link.
async function stepVirtualAccessory(ctx) {
  const { hub, probe, prefix } = ctx;
  // The accessory room is removed by the same room_create restore that step 1
  // has to prove first.
  if (!roomRemovalProved()) {
    row(
      "V virtual accessory",
      "room.create, accessory.create",
      "step 1 proved that a created room is removed",
      "not run: room removal was not proved",
      "blocked",
    );
    return;
  }
  // A bridge that adds new accessories by itself would export the probe to an
  // outside home; the accessory is created only when none does.
  // The overview names extensions only; the bundle type and options window
  // come from each extension's entity read.
  const overview = await hub.read("home_overview", { home_ref: hub.homeRef });
  expectOk(overview, "home_overview");
  const bridges = [];
  for (const { ref } of overview.extensions ?? []) {
    const extension = await hub.read("get_entity", { entity_ref: ref });
    expectOk(extension, "get_entity");
    if (extension.entity.bundle_type === "BRIDGE")
      bridges.push(extension.entity);
  }
  const autoAdd = [];
  for (const bridge of bridges) {
    const window = await readWindow(hub, bridge.options_window_ref);
    autoAdd.push(window.value("AutoAddNewAccessory"));
  }
  const exportFree = autoAdd.every((value) => value === false);
  row(
    "V bridges",
    "window.get{bridge optionsWindow}",
    "AutoAddNewAccessory=false on every bridge",
    `${bridges.length} bridge(s): ${JSON.stringify(autoAdd)}`,
    exportFree ? "match" : "blocked",
  );
  if (!exportFree) return;

  const name = `${probeShortName(prefix)}-v`;
  const room = await prepareAndApply(hub, {
    operation: "room_create",
    target_ref: hub.homeRef,
    name,
  });
  const roomRef = room.applied?.room?.ref;
  if (!roomRef || room.applied.status !== "applied") {
    row(
      "V room",
      "room.create{name}",
      "probe room created",
      describe(room),
      "rejected",
    );
    if (room.applied?.native_write_sent) abort("probe room not confirmed");
    return;
  }
  pushCleanup(ctx, {
    label: "virtual accessory room",
    changeRef: room.changeRef,
    verify: async () => (await roomName(hub, roomRef)) === null,
  });

  const created = await probe.createVirtualAccessory(roomRef, [
    "Brightness",
    "Hue",
  ]);
  const id = created.id;
  pushCleanup(ctx, {
    label: "virtual accessory",
    run: () => deleteVirtualAccessory(ctx, id),
  });
  const accessory = await probe.getAccessoryOrNull(id);
  const service = accessory?.services?.find(({ type }) => type === "Lightbulb");
  const control = (type) =>
    service?.characteristics?.find(({ control }) => control?.type === type);
  const on = control("On");
  const brightness = control("Brightness");
  // Only read by BLOCK conditions: a condition may not read what the same
  // BLOCK writes, and the storage BLOCK writes On and Brightness.
  const hue = control("Hue");
  const links = [];
  for (const item of service?.characteristics ?? []) {
    links.push(
      ...(await probe.listLinks({ aId: id, sId: service.sId, cId: item.cId })),
    );
  }
  const listed = (await probe.listAccessories()).find((item) => item.id === id);
  const ok =
    accessory?.virtual === true &&
    Boolean(on && brightness && hue) &&
    links.length === 0 &&
    accessory.roomId === Number(roomRef.split("/").at(-1));
  row(
    "V accessory create",
    "accessory.create{name,roomId,services:[Lightbulb+Brightness,Hue]}",
    "virtual Lightbulb with On, Brightness and Hue, no links, in the probe room",
    `accessory/${id}; name ${accessory?.name === probeShortName(prefix) ? "as sent" : "changed"}; virtual ${accessory?.virtual}; On ${Boolean(on)}; Brightness ${Boolean(brightness)}; Hue ${Boolean(hue)}; links ${links.length}`,
    ok ? "match" : "mismatch",
  );
  row(
    "V accessory.list virtual",
    "accessory.list{expand}",
    "virtual flag as accessory.get has it",
    `list has virtual: ${listed ? Object.hasOwn(listed, "virtual") : "not listed"}; get virtual: ${accessory?.virtual}`,
    listed && listed.virtual === accessory?.virtual ? "match" : "mismatch",
    listed ? { list_fields: Object.keys(listed).sort() } : undefined,
  );
  if (!ok) {
    abort("the virtual accessory is not as requested");
    return;
  }
  const valueKind = (item) => Object.keys(item.control.value ?? {})[0];
  ctx.virtual = {
    roomRef,
    serviceRef: `${hub.homeRef}/accessory/${id}/service/${service.sId}`,
    on: { ids: { aId: id, sId: service.sId, cId: on.cId } },
    brightness: {
      ids: { aId: id, sId: service.sId, cId: brightness.cId },
      kind: valueKind(brightness),
    },
    hue: { ids: { aId: id, sId: service.sId, cId: hue.cId } },
  };
  ctx.virtual.initial = await virtualState(probe, ctx.virtual);
  report.targets.virtual_accessory = {
    ref: `accessory/${id}`,
    initial: ctx.virtual.initial,
    brightness_kind: ctx.virtual.brightness.kind,
  };
}

// Cleanup of the virtual accessory. A probe scenario that is still there may
// act on it, so then the accessory is left for the sweep, which deletes
// scenarios first.
async function deleteVirtualAccessory(ctx, id) {
  const pending = ctx.cleanup.filter((entry) => entry.scenario && !entry.done);
  if (pending.length > 0) {
    return {
      verified: false,
      status: "left_for_sweep",
      observed: `left for the sweep: ${pending.length} probe scenario(s) not removed`,
    };
  }
  let failure;
  try {
    await ctx.probe.deleteVirtualAccessory(id);
  } catch (error) {
    failure = error;
  }
  const gone = (await ctx.probe.getAccessoryOrNull(id)) === null;
  return {
    verified: gone,
    status: gone ? "deleted" : "left",
    observed: `${failure ? `delete error ${failure.code ?? failure.message}` : "accessory.delete acknowledged"}; verified ${gone}`,
  };
}

async function virtualState(probe, virtual) {
  const [on, brightness] = await Promise.all([
    probe.getCharacteristic(virtual.on.ids),
    probe.getCharacteristic(virtual.brightness.ids),
  ]);
  return {
    on: on.control.value?.boolValue,
    brightness: brightness.control.value?.[virtual.brightness.kind],
  };
}

async function setVirtual(probe, virtual, state) {
  await probe.setVirtualValue(virtual.on.ids, { boolValue: state.on });
  await probe.setVirtualValue(virtual.brightness.ids, {
    [virtual.brightness.kind]: state.brightness,
  });
  const seen = await watchVirtual(probe, virtual, (current) =>
    isDeepStrictEqual(current, state),
  );
  if (!seen.reached) {
    throw new Error(
      `virtual accessory did not reach ${JSON.stringify(state)}: ${JSON.stringify(seen.state)}`,
    );
  }
  return seen.state;
}

// Polls the virtual accessory until done(state) or WATCH_MS. The first state
// that differs from `from` is kept with its time.
async function watchVirtual(probe, virtual, done, from) {
  const started = Date.now();
  let state;
  let firstChange;
  for (;;) {
    state = await virtualState(probe, virtual);
    if (from && !firstChange && !isDeepStrictEqual(state, from)) {
      firstChange = { after_ms: Date.now() - started, state };
    }
    if (done?.(state)) return { reached: true, state, firstChange };
    if (Date.now() - started >= WATCH_MS) {
      return { reached: false, state, firstChange };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function virtualChange(from, seen) {
  const final = seen.state;
  const first = seen.firstChange
    ? ` (first change after ${seen.firstChange.after_ms} ms)`
    : "";
  return `On ${from.on}→${final.on}, Brightness ${from.brightness}→${final.brightness}${first}`;
}

// --- step Vp: virtual flag of a physical accessory (read-only) ---------------

// The product tells virtual accessories by accessory.get's `virtual`
// (accessory.list has none on 3.0.0). Field names only, no values.
async function stepPhysicalAccessory(ctx) {
  const { probe, targets } = ctx;
  const read = [];
  for (const lamp of targets.lamps) {
    const accessory = await probe.getAccessoryOrNull(lamp.on.ids.aId);
    if (!accessory) continue;
    read.push(accessory);
    if (accessory.virtual !== true) break;
  }
  const accessory = read.at(-1);
  if (!accessory || accessory.virtual === true) {
    row(
      "Vp physical accessory.get",
      "accessory.get{id}",
      "virtual false or absent on a physical accessory",
      `no physical Lightbulb accessory among ${read.length} read`,
      "skipped",
    );
    return;
  }
  const present = Object.hasOwn(accessory, "virtual");
  row(
    "Vp physical accessory.get",
    "accessory.get{id}",
    "virtual false or absent on a physical accessory",
    `accessory/${accessory.id}: virtual ${present ? JSON.stringify(accessory.virtual) : "absent"}`,
    "observed",
    { fields: Object.keys(accessory).sort() },
  );
}

// --- step Vd: the duplicate check of virtual_light_group (prepare only) ------

// A virtual light group of the run's accessory name in its room must be
// refused as a duplicate. Prepare writes nothing; it is never applied.
async function stepVirtualDuplicate(ctx) {
  const { hub, probe, virtual, targets, prefix } = ctx;
  if (!virtual) {
    row(
      "Vd virtual duplicate",
      "prepare virtual_light_group",
      "the run's virtual accessory exists",
      "not run: no virtual accessory",
      "blocked",
    );
    return;
  }
  const members = targets.lamps.slice(0, 2);
  if (members.length < 2) {
    row(
      "Vd virtual duplicate",
      "prepare virtual_light_group",
      "two Lightbulb services with On and Brightness",
      `not run: ${members.length} found`,
      "blocked",
    );
    return;
  }
  const state = async () => ({
    accessories: (await probe.listAccessories())
      .map(({ id }) => id)
      .sort((a, b) => a - b),
    links: await Promise.all(
      members
        .flatMap(({ on, brightness }) => [on.ids, brightness.ids])
        .map((ids) => probe.listLinks(pick(ids, ["aId", "sId", "cId"]))),
    ),
  });
  const before = await state();
  const result = await hub.prepare({
    operation: "virtual_light_group",
    target_ref: hub.homeRef,
    name: probeShortName(prefix),
    room_ref: virtual.roomRef,
    member_service_refs: members.map(({ serviceRef }) => serviceRef),
    characteristic_types: ["On", "Brightness"],
  });
  const unchanged = isDeepStrictEqual(before, await state());
  const named = (result.matching_accessories ?? []).map(({ ref }) =>
    relativeRef(ref),
  );
  const own = `accessory/${virtual.on.ids.aId}`;
  row(
    "Vd virtual duplicate",
    "prepare virtual_light_group (never applied)",
    `conflict matching_virtual_accessory_exists naming ${own}; nothing written`,
    `${result.status}${result.conflict_reason ? ` (${result.conflict_reason})` : ""}${result.error ? ` ${result.error.code}: ${result.error.message}` : ""}; names [${named.join(", ")}]; native_write_sent ${result.native_write_sent}; accessories and member links ${unchanged ? "unchanged" : "changed"}`,
    result.status === "conflict" &&
      result.conflict_reason === "matching_virtual_accessory_exists" &&
      named.includes(own) &&
      result.native_write_sent === false &&
      unchanged
      ? "match"
      : "mismatch",
  );
  if (!unchanged) abort("preparing a virtual light group changed the home");
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

function setVirtualBrightness(virtual, value) {
  return lampAction(virtual, {
    type: "set",
    cId: virtual.brightness.ids.cId,
    hc: "Brightness",
    value: String(value),
  });
}

// Every family starts on the far-future one-date cron and acts only on the
// run's virtual accessory (the owner's rule for this run).
function blockFamilies(virtual) {
  const oneDate = () => cronCondition("NONE", ONE_DATE_CRON, 0);
  const off = () => setLamp(virtual, false);
  // Read-only condition (trigger=false) on Hue, which no family writes.
  const heldHue = (timeCond) => ({
    type: "condition",
    mode: "AND",
    conditions: [
      { type: "cron", mode: "NONE", cron: ONE_DATE_CRON, offset: 0 },
      {
        type: "characteristic",
        ...virtual.hue.ids,
        hs: "Lightbulb",
        hc: "Hue",
        trigger: false,
        cond: ">",
        value: "180",
        timeCond,
        time: HOLD_MS,
      },
    ],
  });
  const step = (type, value) =>
    lampAction(virtual, {
      type,
      cId: virtual.brightness.ids.cId,
      hc: "Brightness",
      value,
    });
  return [
    {
      id: "one_date_cron",
      expected: `cron NONE "${ONE_DATE_CRON}" stored as sent`,
      node: ifNode("EVERY", oneDate(), [off()]),
    },
    {
      id: "toggle",
      expected: "toggle On without value stored as sent",
      node: ifNode("EVERY", oneDate(), [
        lampAction(virtual, {
          type: "toggle",
          cId: virtual.on.ids.cId,
          hc: "On",
        }),
      ]),
    },
    {
      id: "inc",
      expected: "inc Brightness value 10 (number, as published) stored as sent",
      node: ifNode("EVERY", oneDate(), [step("inc", 10)]),
    },
    {
      id: "dec",
      expected:
        'dec Brightness value "10" (string, still accepted) stored as the number 10',
      node: ifNode("EVERY", oneDate(), [step("dec", "10")]),
      stored: ifNode("EVERY", oneDate(), [step("dec", 10)]),
    },
    {
      id: "if_once",
      expected: "if mode ONCE stored as sent",
      node: ifNode("ONCE", oneDate(), [off()]),
    },
    {
      id: "held_condition",
      expected: `characteristic trigger=false timeCond ">" time ${HOLD_MS} stored as sent`,
      node: ifNode("EVERY", heldHue(">"), [setVirtualBrightness(virtual, 30)]),
    },
    {
      id: "changed_back_within",
      expected: `characteristic trigger=false timeCond "<" time ${HOLD_MS} stored as sent`,
      node: ifNode("EVERY", heldHue("<"), [setVirtualBrightness(virtual, 30)]),
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
}

// Forms of the first run (research/protocol/2026-09-24-live-conformance.md,
// all stored as sent) that this run's BLOCK rule does not allow.
const RULE_EXCLUDED_FAMILIES = [
  [
    "weekday_cron",
    "a weekday cron trigger is neither a far-future one-date cron nor one daily time",
  ],
  [
    "sunset_offset",
    "a SUNSET cron trigger is neither a far-future one-date cron nor one daily time",
  ],
  [
    "scenario_fire",
    "a scenario FIRE action targets a scenario, not the virtual accessory",
  ],
];

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
        scenario: true,
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
  if (stored?.options_window_ref) {
    ctx.hub.ownWindows.set(stored.options_window_ref, scenarioRef);
  }
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
  const { virtual } = ctx;
  if (!virtual) {
    row(
      "2 BLOCK storage",
      "scenario.create{BLOCK}",
      "the run's virtual accessory as the only target",
      "not run: no virtual accessory",
      "blocked",
    );
    return;
  }
  const oneDate = () => cronCondition("NONE", ONE_DATE_CRON, 0);
  const control = await createBlock(ctx, {
    label: "block-control",
    data: {
      targets: [
        ifNode(
          "EVERY",
          oneDate(),
          [setLamp(virtual, true)],
          [setLamp(virtual, false)],
        ),
      ],
    },
  });
  blockRow("2 control one-date", control, "stored as sent");
  ctx.control = control;
  if (abortReason) return;
  for (const [id, why] of RULE_EXCLUDED_FAMILIES) {
    row(`2 ${id}`, "-", "-", `not created: ${why}`, "skipped");
  }

  // prepare never writes; it shows which families the product accepts.
  const accepted = [];
  for (const family of blockFamilies(virtual)) {
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
    if (prepared.status === "prepared") {
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
  // A family may name the documented hub form of what it sends.
  const expectedNode = family.stored ?? sentNode;
  const diff =
    readNode === undefined
      ? [{ path: "targets", kind: "reordered_or_missing" }]
      : structuralDiff(expectedNode, readNode);
  const hubAssigned = diff.filter(isHubAssigned);
  const other = diff.filter((entry) => !isHubAssigned(entry));
  const productApplied = block.applied?.status === "applied";
  row(
    `2 ${family.id}`,
    "scenario.create{BLOCK}",
    family.expected,
    other.length === 0
      ? `stored ${family.stored ? "in the documented form" : "as sent"} (+${hubAssigned.length} hub-assigned blockId/state)`
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

// --- step 2i: if node as the web client creates it --------------------------

// The web client creates an if without mode and delays and with else null
// (research/protocol/2026-09-24-web-client-evidence.md, section 3). Both
// forms are created directly, turned off, with no action, because the
// product may refuse or reshape the first; the stored if is reported as
// scenario.get returns it.
async function stepIfForms(ctx) {
  const { probe, prefix } = ctx;
  const condition = () => ({
    type: "condition",
    mode: "OR",
    conditions: [
      { type: "cron", mode: "NONE", cron: ONE_DATE_CRON, offset: 0 },
    ],
  });
  const forms = [
    {
      id: "web_client",
      sent: {
        type: "if",
        if: condition(),
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK grammar requires this field name.
        then: [],
        else: null,
      },
    },
    {
      id: "explicit",
      sent: {
        type: "if",
        mode: "EVERY",
        if: condition(),
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK grammar requires this field name.
        then: [],
        else: [],
        then_delay: 0,
        else_delay: 0,
      },
    },
  ];
  const stored = {};
  for (const form of forms) {
    const ref = await probe.createTurnedOffBlock(`${prefix}-if-${form.id}`, {
      targets: [form.sent],
    });
    pushDirectBlockCleanup(ctx, ref, `if-${form.id}`);
    const read = await probe.storedBlockData(ref);
    const node = read.data?.targets?.[0];
    const fields = Object.fromEntries(
      ["mode", "then_delay", "else_delay", "else", "state", "then"].map(
        (key) => [key, node && Object.hasOwn(node, key) ? node[key] : "absent"],
      ),
    );
    stored[form.id] = { active: read.active, if_node: node };
    row(
      `2i if ${form.id}`,
      "scenario.create{BLOCK} (direct), scenario.get",
      `stored ${JSON.stringify(form.sent, (key, value) => (key === "if" ? "…" : value))}`,
      JSON.stringify(fields),
      read.active === false && node?.type === "if" ? "observed" : "mismatch",
      { stored_if: node },
    );
  }
  report.if_forms = stored;
}

// --- step 2w: options windows of the owner's scenarios (read-only) ----------

// The product finds a scenario's options window through scenario.list's
// optionsWindow (schema; never seen live). One LOGIC, one GLOBAL and one
// predefined scenario of the home: option keys, types and access only,
// never a value; nothing is written.
async function stepOwnerWindows(ctx) {
  const { hub, probe, prefix } = ctx;
  const scenarios = (await probe.listScenarios()).filter(
    ({ name }) => !isProbeName(name, prefix),
  );
  const byType = new Map();
  for (const scenario of scenarios) {
    const key = `${scenario.type}${scenario.predefined === true ? " predefined" : ""}`;
    const count = byType.get(key) ?? { total: 0, window: 0 };
    count.total += 1;
    if (typeof scenario.optionsWindow === "string") count.window += 1;
    byType.set(key, count);
  }
  const counts = [...byType].map(
    ([key, { total, window }]) => `${key} ${window}/${total}`,
  );
  row(
    "2w scenario.list optionsWindow",
    "scenario.list",
    "every scenario carries optionsWindow (the product's window guard relies on it)",
    counts.join(", ") || "no scenarios",
    [...byType.values()].every(({ total, window }) => total === window)
      ? "match"
      : "mismatch",
  );
  for (const [label, chosen] of [
    ["LOGIC", ({ type, predefined }) => type === "LOGIC" && !predefined],
    ["GLOBAL", ({ type }) => type === "GLOBAL"],
    ["predefined", ({ predefined }) => predefined === true],
  ]) {
    const listed = scenarios.find(chosen);
    if (!listed) {
      row(`2w window ${label}`, "-", "-", `no ${label} scenario`, "skipped");
      continue;
    }
    const ref = `${hub.homeRef}/scenario/${encodeURIComponent(listed.index)}`;
    // The full scenario (with its data) is read only for optionsWindow.
    const got = await probe.getScenario(listed.index);
    const windowKey =
      typeof got?.optionsWindow === "string" ? got.optionsWindow : null;
    let options = [];
    let windowError = null;
    if (windowKey !== null) {
      try {
        options = (await probe.getWindow(windowKey)).options.map(optionShape);
      } catch (error) {
        windowError = error.code ?? error.message;
      }
    }
    const entity = await hub.read("get_entity", {
      entity_ref: ref,
      max_bytes: 4_096,
    });
    const active = options.find(({ key }) => key === "Active");
    row(
      `2w window ${label}`,
      "scenario.get, window.get",
      "record option keys and input types (no values)",
      windowKey === null
        ? "no optionsWindow in scenario.get"
        : windowError
          ? `window.get failed: ${windowError}`
          : `${options.map(({ key, input_type }) => `${key}:${input_type}`).join(", ")}; ${active ? `Active ${active.type}, read ${active.read}, write ${active.write}, disabled ${active.disabled}` : "no Active"}`,
      "observed",
      {
        scenario: relativeRef(ref),
        type: listed.type,
        predefined: listed.predefined === true,
        list_window_key: typeof listed.optionsWindow === "string",
        get_window_key: windowKey !== null,
        same_key: windowKey === listed.optionsWindow,
        product_window_ref:
          typeof (entity.entity ?? entity.identity)?.options_window_ref ===
          "string",
        options,
      },
    );
  }
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
  const { hub, virtual, prefix } = ctx;
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
        setLamp(virtual, false),
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
  // scenario_active writes the Active option of this window, as the web
  // client does; the window is read here to see it agree with scenario.get.
  const windowRef = previous.options_window_ref;
  const windowActive = async (step, expected) => {
    const window = await readWindow(hub, windowRef);
    const active = window.value("Active");
    row(
      step,
      "window.get{windowKey}",
      `option Active=${expected}`,
      `Active=${JSON.stringify(active)}; options [${window.keys.join(", ")}]`,
      active === expected ? "match" : "mismatch",
    );
  };
  if (!windowRef) {
    row(
      "3 options window",
      "scenario.get",
      "optionsWindow present",
      "no options_window_ref",
      "mismatch",
    );
  } else {
    await windowActive("3 window before turn on", false);
  }
  // Raw scenario.get and window.get, one right after the other.
  const windowKeys = [];
  const offBefore = await activeAgreement(
    ctx,
    "3 agreement before turn on",
    ref,
    false,
  );
  windowKeys.push(...offBefore.keys);
  const option = offBefore.view?.option;
  row(
    "3 Active option",
    "window.get{windowKey}",
    "record the option's type and access",
    option
      ? `type ${option.type}, input ${option.input_type}, read ${option.read}, write ${option.write}, disabled ${option.disabled}`
      : "no Active option",
    option ? "observed" : "mismatch",
  );

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
    "window.update{windowKey,options:[Active=true]}",
    { operation: "scenario_active", value: true },
    ["active"],
    { active: true },
  );
  if (abortReason) return;
  if (windowRef) await windowActive("3a window after turn on", true);
  windowKeys.push(
    ...(await activeAgreement(ctx, "3a agreement", ref, true)).keys,
  );
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
    "window.update{windowKey,options:[Active=false]}",
    { operation: "scenario_active", value: false },
    ["active"],
    { active: false },
  );
  if (windowRef) await windowActive("3e window after turn off", false);
  windowKeys.push(
    ...(await activeAgreement(ctx, "3e agreement", ref, false)).keys,
  );
  const distinct = new Set(windowKeys);
  row(
    "3 window key",
    "scenario.get{index}",
    "optionsWindow stays the same across reads",
    `${distinct.size} key(s) in ${windowKeys.length} read(s)`,
    distinct.size === 1 && !distinct.has(null) ? "match" : "mismatch",
  );
}

// Reads scenario.get and the scenario's Active window option until they
// agree, at most AGREE_MS, and records whether they agreed at once and on
// the expected value. Returns the last view and every window key seen.
async function activeAgreement(ctx, step, scenarioRef, expected) {
  const started = Date.now();
  const keys = [];
  let first;
  let view;
  for (;;) {
    view = await ctx.probe.activeView(scenarioRef);
    first ??= view;
    keys.push(view?.windowKey ?? null);
    if (
      !view?.option ||
      view.active === view.option.value ||
      Date.now() - started >= AGREE_MS
    ) {
      break;
    }
    await sleep(AGREE_POLL_MS);
  }
  const elapsed = Date.now() - started;
  const agreeAtOnce = first?.option && first.active === first.option.value;
  const agreed = view?.option && view.active === view.option.value;
  row(
    step,
    "scenario.get, window.get",
    `active=${expected} in scenario.get and window Active at once`,
    !first?.option
      ? `no Active option (window ${first?.windowKey ?? "none"}${first?.windowError ? `: ${first.windowError}` : ""})`
      : `first read scenario.get ${first.active}, window ${first.option.value}; ${agreeAtOnce ? "agree at once" : agreed ? `agree after ${elapsed} ms (${keys.length} reads)` : `still differ after ${elapsed} ms`}`,
    agreeAtOnce && first.active === expected
      ? "match"
      : agreed && view.active === expected
        ? "observed"
        : "mismatch",
  );
  return { view, keys };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- step 4: LOGIC source lifecycle ------------------------------------------

// The probe LOGIC runs nothing, on or off, assigned or not: an info object
// and an empty trigger (the guard's isInertProbeLogic).
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
  // Intentionally empty: this probe runs nothing.
}`;
}

// How a user LOGIC's native type is linked to its scenario: a LOGIC created
// off (restore, then on to see its type, renamed, off, assigned while off,
// restore again), then a LOGIC created on, turned off and deleted.
async function stepLogic(ctx) {
  const { virtual } = ctx;
  if (!virtual) {
    row(
      "4 LOGIC",
      "scenario.create{LOGIC}",
      "the virtual Lightbulb as the anchor service",
      "not run: no virtual accessory",
      "blocked",
    );
    return;
  }
  const anchor = pick(virtual.on.ids, ["aId", "sId"]);
  const off = await turnedOffLogic(ctx, anchor);
  if (abortReason) return;
  // A LOGIC created on is turned off through its Active window option; the
  // turned-off LOGIC showed whether a LOGIC has one.
  if (!off?.hasActive) {
    row(
      "4m LOGIC created on",
      "scenario.create{LOGIC,active:true}",
      "created on, turned off and deleted in this step",
      "not run: the turned-off LOGIC showed no Active option to turn it off",
      "skipped",
    );
    return;
  }
  await createdOnLogic(ctx, anchor);
}

async function turnedOffLogic(ctx, anchor) {
  const { hub, probe, virtual, prefix } = ctx;
  const name = `${prefix}-logic`;
  const source = logicSource(name, "1.0");
  const typesBefore = await probe.listLogicTypes(anchor);
  // The anchor only lets the product map the new LOGIC type.
  const create = await prepareAndApply(hub, {
    operation: "logic_source_create",
    target_ref: virtual.serviceRef,
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
    return null;
  }
  const markerComment = `/* [${create.prepared.ownership_marker}] */`;
  const createdSource = `${source}\n\n${markerComment}`;
  const createEntry = pushCleanup(ctx, {
    label: "LOGIC",
    scenario: true,
    changeRef: create.changeRef,
    verify: async () => !(await scenarioPresent(hub, ref)),
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
    return null;
  }
  const mapped = create.applied.logic_mapping_status === "mapped";
  row(
    "4b LOGIC type on anchor",
    "logic.types{aId,sId}",
    "turned-off LOGIC type is listed for its source service",
    mappingText(create.applied),
    mapped ? "match" : "mismatch",
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
      return null;
    }
  }

  // Read before the first restore, which deletes the LOGIC if it is mapped.
  const view = await probe.activeView(ref);
  const hasActive = Boolean(view?.option);
  row(
    "4f LOGIC options window",
    "scenario.get, window.get",
    "record whether a LOGIC has an options window with Active",
    !view || view.windowKey === null
      ? "no optionsWindow in scenario.get"
      : view.windowError
        ? `window.get failed: ${view.windowError}`
        : view.keys
            .map(({ key, input_type }) => `${key}:${input_type}`)
            .join(", ") || "no options",
    "observed",
    { active_option: view?.option ?? null },
  );

  const first = await logicCreateRestore(
    ctx,
    "4e restore create",
    createEntry,
    ref,
    mapped
      ? "LOGIC deleted"
      : "refused with logic_type_not_visible; LOGIC kept",
    (outcome, present) =>
      mapped
        ? outcome.verified
        : present && outcome.result?.error?.code === "logic_type_not_visible",
  );
  if (first.deleted) return { hasActive };
  if (!hasActive) {
    leaveForSweep(
      ctx,
      createEntry,
      ref,
      "a turned-off LOGIC without an Active option; its type is not seen",
    );
    row(
      "4g LOGIC turn on",
      "-",
      "-",
      "not run: no Active option; the LOGIC is left to the sweep",
      "skipped",
    );
    return { hasActive };
  }

  // On while unassigned: its source runs nothing.
  const on = await prepareAndApply(hub, {
    operation: "scenario_active",
    target_ref: ref,
    value: true,
  });
  const onEntry = on.applied
    ? pushCleanup(ctx, {
        label: "LOGIC turn on",
        parent: createEntry,
        changeRef: on.changeRef,
        verify: async () => (await probe.activeView(ref))?.active === false,
      })
    : undefined;
  row(
    "4g LOGIC turn on",
    "window.update{windowKey,options:[Active=true]}",
    "applied",
    describe(on),
    on.applied?.status === "applied" ? "match" : "rejected",
  );
  await activeAgreement(ctx, "4g agreement", ref, true);
  if (on.applied?.status === "applied") {
    await logicTypeWhileOn(ctx, "4h", {
      ref,
      anchor,
      typesBefore,
      changeRef: create.changeRef,
    });
    await renameLogic(ctx, {
      ref,
      anchor,
      typesBefore,
      name,
      markerComment,
      createEntry,
    });
    if (abortReason) return { hasActive };
  }
  if (onEntry) {
    const offOutcome = await runRestore(hub, onEntry);
    row(
      "4j LOGIC turn off",
      "restore scenario_active",
      "restored; active=false",
      offOutcome.observed,
      offOutcome.verified ? "match" : "mismatch",
    );
    await activeAgreement(ctx, "4j agreement", ref, false);
    if (!offOutcome.verified) {
      abort("the probe LOGIC was not turned off");
      return { hasActive };
    }
  }

  await assignmentWhileOff(ctx, { ref, anchor, createEntry });
  if (abortReason) return { hasActive };

  const second = await logicCreateRestore(
    ctx,
    "4l retry restore create",
    createEntry,
    ref,
    "record whether restore now maps and deletes the LOGIC",
    null,
  );
  if (!second.deleted) {
    leaveForSweep(
      ctx,
      createEntry,
      ref,
      "restore did not delete the turned-off LOGIC after it was on",
    );
  }
  return { hasActive };
}

// A LOGIC created on, as an agent may create it: the product may see its
// type at apply. Turned off and deleted in this step.
async function createdOnLogic(ctx, anchor) {
  const { hub, probe, virtual, prefix } = ctx;
  const name = `${prefix}-logic-on`;
  const typesBefore = await probe.listLogicTypes(anchor);
  const create = await prepareAndApply(hub, {
    operation: "logic_source_create",
    target_ref: virtual.serviceRef,
    name,
    description: PROBE_DESCRIPTION,
    active: true,
    on_start: false,
    sync: false,
    source: logicSource(name, "1.0"),
  });
  const ref = create.applied?.scenario_ref;
  if (!ref) {
    row(
      "4m LOGIC create on",
      "scenario.create{LOGIC,active:true}",
      "created",
      describe(create),
      "rejected",
    );
    if (create.applied?.native_write_sent) {
      abort("LOGIC created on not confirmed");
    }
    return;
  }
  const createEntry = pushCleanup(ctx, {
    label: "LOGIC created on",
    scenario: true,
    changeRef: create.changeRef,
    verify: async () => !(await scenarioPresent(hub, ref)),
  });
  const view = await probe.activeView(ref);
  row(
    "4m LOGIC create on",
    "scenario.create{LOGIC,active:true}",
    "created on; record whether the product maps its type at apply",
    `${create.applied.status}; active ${view?.active}; ${mappingText(create.applied)}`,
    create.applied.status === "applied" && view?.active === true
      ? "observed"
      : "mismatch",
  );
  await logicTypeWhileOn(ctx, "4m", {
    ref,
    anchor,
    typesBefore,
    changeRef: create.changeRef,
  });
  // Restoring this change would turn the LOGIC on again.
  const off = await prepareAndApply(hub, {
    operation: "scenario_active",
    target_ref: ref,
    value: false,
  });
  if (off.applied) {
    pushCleanup(ctx, {
      label: "4m turn off",
      parent: createEntry,
      changeRef: off.changeRef,
      restoreOptional: true,
    });
  }
  row(
    "4m turn off",
    "window.update{windowKey,options:[Active=false]}",
    "applied",
    describe(off),
    off.applied?.status === "applied" ? "match" : "mismatch",
  );
  const agreement = await activeAgreement(ctx, "4m agreement", ref, false);
  const deleted = await logicCreateRestore(
    ctx,
    "4m restore create",
    createEntry,
    ref,
    "LOGIC deleted",
    (outcome) => outcome.verified,
  );
  if (deleted.deleted) return;
  if (agreement.view?.active === false) {
    leaveForSweep(
      ctx,
      createEntry,
      ref,
      "restore did not delete a LOGIC created on, turned off since",
    );
  } else {
    abort("a LOGIC created on is neither off nor deleted");
  }
}

function mappingText(change) {
  return `mapping ${change.logic_mapping_status ?? "none"}${change.native_logic_type ? ` type ${change.native_logic_type}` : ""}${change.logic_mapping_reason ? ` (${change.logic_mapping_reason})` : ""}`;
}

// One restore of a LOGIC create. `ok(outcome, present)` gives the verdict;
// without it the row only records what happened.
async function logicCreateRestore(ctx, step, entry, ref, expected, ok) {
  const outcome = await runRestore(ctx.hub, entry);
  const present = await scenarioPresent(ctx.hub, ref);
  const product = outcome.result ?? {};
  row(
    step,
    "scenario.delete{index}",
    expected,
    `${outcome.observed}${product.logic_mapping_status ? `; ${mappingText(product)}` : ""}; present ${present}`,
    ok ? (ok(outcome, present) ? "match" : "mismatch") : "observed",
  );
  return { deleted: outcome.verified && !present };
}

function newLogicTypes(before, after) {
  const known = new Set(before.map(({ type }) => type));
  return after.filter(({ type }) => !known.has(type));
}

// How a native type names its scenario. The entry is the run's own.
function typeRelation(entry, scenario, index) {
  const type = String(entry.type);
  const marker = /sprut-agent:native:([0-9a-f]{24})/.exec(
    scenario?.data ?? "",
  )?.[1];
  const hasIndex = new RegExp(`(^|\\D)${index}(\\D|$)`).test(type);
  return [
    `type ${JSON.stringify(type)}`,
    `index ${index} ${hasIndex ? "in the type" : "not in the type"}`,
    ...(scenario?.name && type.includes(scenario.name)
      ? ["scenario name in the type"]
      : []),
    ...(marker && type.includes(marker) ? ["marker in the type"] : []),
    `name ${entry.name === scenario?.name ? "= scenario name" : `≠ scenario name (${JSON.stringify(entry.name ?? null)})`}`,
    `fields [${Object.keys(entry).sort().join(", ")}]`,
  ].join(", ");
}

async function logicTypeWhileOn(
  ctx,
  step,
  { ref, anchor, typesBefore, changeRef },
) {
  const { hub, probe } = ctx;
  const index = scenarioIndex(ref);
  const scenario = await probe.getScenario(index);
  const entries = newLogicTypes(
    typesBefore,
    await probe.listLogicTypes(anchor),
  );
  // get_native_change reads logic.types again and may map the type now.
  const product = await hub.get(changeRef);
  row(
    `${step} LOGIC type while on`,
    "logic.types{aId,sId}",
    "record the new type, all its fields and how it names the scenario",
    `${entries.length === 0 ? "no new type on the anchor" : entries.map((entry) => typeRelation(entry, scenario, index)).join("; ")}; product ${mappingText(product)}`,
    "observed",
    { new_types: entries, scenario_index: index },
  );
  return entries;
}

// Renames the LOGIC while it is on and reads logic.types again: does the
// type's name follow? The product's BLOCK path (window_option Name on the
// scenario ref) first, then the LOGIC's own window, then info.name.
async function renameLogic(
  ctx,
  { ref, anchor, typesBefore, name, markerComment, createEntry },
) {
  const { hub, probe, prefix } = ctx;
  const renamed = `${prefix}-logic-renamed`;
  const refused = [];
  let rename;
  let path;
  const attempt = async (label, input) => {
    if (rename?.applied) return;
    rename = await prepareAndApply(hub, input);
    path = label;
    if (!rename.applied) refused.push(`${label}: ${describe(rename)}`);
  };
  await attempt("window_option Name on the scenario ref", {
    operation: "window_option",
    target_ref: ref,
    option_key: "Name",
    value: renamed,
  });
  const windowRef = rename.applied ? null : await hub.registerLogicWindow(ref);
  if (windowRef) {
    await attempt("window_option Name on the LOGIC's window", {
      operation: "window_option",
      target_ref: windowRef,
      option_key: "Name",
      value: renamed,
    });
  }
  await attempt("logic_source_update of info.name", {
    operation: "logic_source_update",
    target_ref: ref,
    source: `${logicSource(renamed, "1.0")}\n\n${markerComment}`,
  });
  row(
    "4i LOGIC rename paths",
    "prepare_native_change",
    "record which product path renames a LOGIC",
    `${rename.applied ? `renamed by ${path}` : "none renamed it"}${refused.length ? `; refused: ${refused.join("; ")}` : ""}`,
    "observed",
  );
  if (!rename.applied) return;
  const entry = pushCleanup(ctx, {
    label: "LOGIC rename",
    parent: createEntry,
    changeRef: rename.changeRef,
    verify: async () =>
      (await probe.getScenario(scenarioIndex(ref)))?.name === name,
  });
  const scenario = await probe.getScenario(scenarioIndex(ref));
  const entries = newLogicTypes(
    typesBefore,
    await probe.listLogicTypes(anchor),
  );
  row(
    "4i LOGIC rename",
    path,
    "scenario renamed; record whether the type's name follows",
    `${rename.applied.status}; scenario name ${scenario?.name === renamed ? "renamed" : scenario?.name === name ? "unchanged" : JSON.stringify(scenario?.name ?? null)}; type name ${
      entries
        .map((item) =>
          item.name === renamed
            ? "follows"
            : item.name === name
              ? "stays"
              : JSON.stringify(item.name ?? null),
        )
        .join(", ") || "no new type"
    }`,
    rename.applied.status === "applied" ? "observed" : "mismatch",
    { new_types: entries },
  );
  const back = await runRestore(hub, entry);
  row(
    "4i restore rename",
    "restore_native_change",
    "former name back",
    back.observed,
    back.verified ? "match" : "mismatch",
  );
  if (!back.verified) abort("the LOGIC rename was not restored");
}

// Assigns the turned-off LOGIC to the run's virtual accessory, reads
// logic.list and removes the assignment.
async function assignmentWhileOff(ctx, { ref, anchor, createEntry }) {
  const { hub, probe, virtual } = ctx;
  const step = "4k assignment while off";
  const expected = "listed on the virtual accessory while the LOGIC is off";
  const type = hub.created.get(ref)?.type;
  if (!type) {
    row(
      step,
      "logic.create",
      expected,
      "not run: the product has no type for it",
      "skipped",
    );
    return;
  }
  const listed = (await probe.listLogicTypes(anchor)).some(
    (entry) => entry.type === type,
  );
  if (!listed) {
    row(
      step,
      "logic.create",
      expected,
      `not run: the anchor does not list ${type} while the LOGIC is off`,
      "skipped",
    );
    return;
  }
  const assign = await prepareAndApply(hub, {
    operation: "logic_assignment",
    target_ref: `${virtual.serviceRef}/logic/${encodeURIComponent(type)}`,
  });
  if (!assign.applied) {
    row(step, "logic.create", expected, describe(assign), "rejected");
    return;
  }
  const entry = pushCleanup(ctx, {
    label: "LOGIC assignment",
    parent: createEntry,
    changeRef: assign.changeRef,
    verify: async () =>
      !(await probe.listLogics(anchor)).some((item) => item.type === type),
  });
  const found = (await probe.listLogics(anchor)).find(
    (item) => item.type === type,
  );
  row(
    step,
    "logic.create{aId,sId,type}, logic.list",
    expected,
    `${assign.applied.status}; logic.list ${found ? `lists it, active ${found.active}` : "does not list it"}`,
    found ? "match" : "mismatch",
  );
  const removed = await runRestore(hub, entry);
  row(
    "4k restore assignment",
    "logic.delete{aId,sId,type}",
    "assignment absent",
    removed.observed,
    removed.verified ? "match" : "mismatch",
  );
  if (!removed.verified) abort("the LOGIC assignment was not removed");
}

// A run object that its restore cannot remove and that cannot act (off,
// unassigned, marked): the final sweep deletes it, and that is planned.
function leaveForSweep(ctx, entry, ref, reason) {
  entry.done = true;
  entry.outcome = {
    verified: false,
    status: "left_for_sweep",
    observed: `left for the sweep: ${reason}`,
  };
  ctx.hub.sweepExpected.set(ref, reason);
  report.cleanup.push({
    label: entry.label,
    change_ref: entry.changeRef,
    status: "left_for_sweep",
    reason,
  });
}

// --- step 6: manual run of a turned-off and a turned-on BLOCK ----------------

// Does scenario.run execute a turned-off BLOCK? The product refuses that run
// (scenario_inactive); this step sends it directly for this run's own BLOCKs,
// whose only target is the virtual accessory, and watches that accessory.
async function stepManualRun(ctx) {
  const { hub, probe, virtual: v, prefix } = ctx;
  if (!v) {
    row(
      "6 manual run",
      "scenario.run{index}",
      "the virtual accessory as the only target",
      "not run: no virtual accessory",
      "blocked",
    );
    return;
  }
  // SprutHub keeps a lamp at brightness 0 off, so the lamp turned on needs
  // a brightness above 0 (step 6 on 2026-09-24 stayed off at 0).
  const base = { on: true, brightness: v.initial.brightness || 30 };
  const marker = base.brightness === 42 ? 43 : 42;

  // The brief asked for an action-only On=true BLOCK; prepare never writes.
  const onOnly = await hub.prepare({
    operation: "block_create",
    target_ref: hub.homeRef,
    name: `${prefix}-prepare-only-run-on`,
    description: PROBE_DESCRIPTION,
    active: false,
    on_start: false,
    sync: false,
    data: { targets: [setLamp(v, true)] },
  });
  row(
    "6a action-only On=true",
    "prepare only",
    "record whether the product accepts it",
    onOnly.status === "prepared"
      ? "prepared (not applied)"
      : `product rejected: ${onOnly.error?.code}: ${onOnly.error?.message}`,
    "observed",
  );

  // R1: the action-only form the product accepts, turned off. The product
  // creates it only turned on, so it is created directly.
  const r1Data = { targets: [setLamp(v, false)] };
  const r1Product = await hub.prepare({
    operation: "block_create",
    target_ref: hub.homeRef,
    name: `${prefix}-prepare-only-run-off`,
    description: PROBE_DESCRIPTION,
    active: false,
    on_start: false,
    sync: false,
    data: r1Data,
  });
  const r1Ref = await probe.createTurnedOffBlock(
    `${prefix}-run-action-only`,
    r1Data,
  );
  pushDirectBlockCleanup(ctx, r1Ref, "run-action-only");
  const r1Stored = await readScenario(hub, r1Ref);
  const r1Diff = structuralDiff(r1Data, r1Stored.data).filter(
    (entry) => !isHubAssigned(entry),
  );
  row(
    "6b action-only BLOCK, turned off",
    "scenario.create{BLOCK} (direct)",
    "product refuses it turned off; created directly, stored as sent",
    `product: ${r1Product.status === "prepared" ? "prepared" : r1Product.error?.code}; direct: active ${r1Stored.active}, data differences ${r1Diff.length}`,
    r1Stored.active === false && r1Diff.length === 0 ? "match" : "mismatch",
    r1Product.error ? { product_error: r1Product.error.message } : undefined,
  );
  const r1 = { scenarioRef: r1Ref };
  const refused = await hub.prepare({
    operation: "scenario_run",
    target_ref: r1.scenarioRef,
  });
  row(
    "6c product run, turned off",
    "prepare scenario_run",
    "refused with scenario_inactive, nothing sent",
    refused.status === "prepared"
      ? "prepared"
      : `${refused.error?.code}: ${refused.error?.message}`,
    refused.error?.code === "scenario_inactive" ? "match" : "mismatch",
  );
  await directRun(ctx, "6d direct run, action-only, turned off", r1, base);

  // R2: the same action plus an if on the far-future cron, so that it may be
  // turned on. The if's Brightness shows whether a run enters that branch.
  const r2 = await createBlock(ctx, {
    label: "run-with-trigger",
    data: {
      targets: [
        setLamp(v, false),
        ifNode("EVERY", cronCondition("NONE", ONE_DATE_CRON, 0), [
          setVirtualBrightness(v, marker),
        ]),
      ],
    },
  });
  blockRow("6e BLOCK with far-future if create", r2, "stored as sent");
  if (!r2.scenarioRef || abortReason) return;
  if (!hub.created.get(r2.scenarioRef)?.activatable) {
    throw new GuardError("the run BLOCK is not activatable");
  }
  await directRun(ctx, "6f direct run, far-future if, turned off", r2, base);

  await setVirtual(probe, v, base);
  const on = await prepareAndApply(hub, {
    operation: "scenario_active",
    target_ref: r2.scenarioRef,
    value: true,
  });
  if (on.applied) {
    pushCleanup(ctx, {
      label: "6 turn on",
      parent: r2.cleanupEntry,
      changeRef: on.changeRef,
      restoreOptional: true,
    });
  }
  const afterOn = await watchVirtual(probe, v, undefined, base);
  row(
    "6g turn on",
    "window.update{windowKey,options:[Active=true]}",
    "applied; record whether turning on writes",
    `${describe(on)}; ${virtualChange(base, afterOn)}`,
    on.applied?.status === "applied" ? "observed" : "rejected",
  );
  if (on.applied?.status !== "applied") return;

  await setVirtual(probe, v, base);
  const run = await prepareAndApply(hub, {
    operation: "scenario_run",
    target_ref: r2.scenarioRef,
  });
  const afterRun = await watchVirtual(probe, v, undefined, base);
  const observations = run.applied?.target_observations;
  row(
    "6h product run, turned on",
    "scenario.run{index}",
    "applied; record the effect",
    `${describe(run)}; ${virtualChange(base, afterRun)}`,
    run.applied?.status === "applied" ? "observed" : "rejected",
    {
      product_effect: run.applied?.effect ?? run.prepared?.effect ?? null,
      product_observations: Array.isArray(observations)
        ? observations.map((item) => ({
            ref: relativeRef(item.characteristic_ref ?? item.ref ?? ""),
            status: item.status ?? null,
            value: item.observed_value ?? item.value ?? null,
          }))
        : (observations ?? null),
    },
  );

  // The web client's and scenario_active's path to turning it off: the
  // window's Active option, sent directly here to see what else it changes.
  const windowRef = r2.stored.options_window_ref;
  const offer = await hub.prepare({
    operation: "window_option",
    target_ref: windowRef,
    option_key: "Active",
    value: false,
  });
  row(
    "6i product window_option Active",
    "prepare only",
    "record whether the product offers the web client's path",
    offer.status === "prepared"
      ? "prepared (not applied)"
      : `product rejected: ${offer.error?.code}: ${offer.error?.message}`,
    "observed",
  );
  const beforeOff = await readScenario(hub, r2.scenarioRef);
  let windowAck = "acknowledged";
  try {
    await probe.setBlockActiveByWindow(r2.scenarioRef, false);
  } catch (error) {
    if (error instanceof GuardError) throw error;
    windowAck = `${error.code ?? error.message}${error.hubError ? ` ${JSON.stringify(error.hubError)}` : ""}`;
  }
  const afterOff = await readScenario(hub, r2.scenarioRef);
  const changed = SCENARIO_FIELDS.filter(
    (field) => !isDeepStrictEqual(beforeOff[field], afterOff[field]),
  );
  row(
    "6j window Active=false",
    "window.update{windowKey,options:[Active]}",
    "only active changes, to false",
    `${windowAck}; active ${afterOff.active}; changed [${changed.join(", ")}]`,
    afterOff.active === false && isDeepStrictEqual(changed, ["active"])
      ? "match"
      : "mismatch",
    {
      before: pick(beforeOff, SCENARIO_FIELDS),
      after: pick(afterOff, SCENARIO_FIELDS),
    },
  );
  if (afterOff.active !== false) {
    const off = await prepareAndApply(hub, {
      operation: "scenario_active",
      target_ref: r2.scenarioRef,
      value: false,
    });
    row(
      "6j fallback turn off",
      "window.update{windowKey,options:[Active=false]}",
      "applied",
      describe(off),
      off.applied?.status === "applied" ? "match" : "mismatch",
    );
  }

  // Only On goes back: SprutHub kept brightness 30 when 0 was written to
  // the lamp turned off (2026-09-24); the accessory is deleted afterwards.
  await probe.setVirtualValue(v.on.ids, { boolValue: v.initial.on });
  const restored = await watchVirtual(
    probe,
    v,
    (current) => current.on === v.initial.on,
  );
  row(
    "6k virtual accessory back",
    "characteristic.update{On}",
    `On ${v.initial.on}`,
    JSON.stringify(restored.state),
    restored.reached ? "match" : "mismatch",
  );
}

function pushDirectBlockCleanup(ctx, scenarioRef, label) {
  pushCleanup(ctx, {
    label: `BLOCK ${label} (direct)`,
    scenario: true,
    run: async () => {
      const { failure, gone } = await ctx.probe.deleteDirectBlock(scenarioRef);
      return {
        verified: gone,
        status: gone ? "deleted" : "left",
        observed: `${failure ? `delete error ${failure.code ?? failure.message}` : "scenario.delete acknowledged"}; verified ${gone}`,
      };
    },
  });
}

// Sets the virtual accessory to `base`, sends scenario.run directly and
// watches the accessory for WATCH_MS.
async function directRun(ctx, step, block, base) {
  const { hub, probe, virtual } = ctx;
  await setVirtual(probe, virtual, base);
  let ack = "acknowledged";
  try {
    await probe.runBlock(block.scenarioRef);
  } catch (error) {
    if (error instanceof GuardError) throw error;
    ack = `${error.code ?? error.message}${error.hubError ? ` ${JSON.stringify(error.hubError)}` : ""}`;
  }
  const seen = await watchVirtual(probe, virtual, undefined, base);
  const after = await readScenario(hub, block.scenarioRef);
  row(
    step,
    "scenario.run{index}",
    "record whether the hub runs it",
    `${ack}; ${virtualChange(base, seen)}; active ${after.active}, execution_error ${after.execution_error}`,
    "observed",
  );
}

// --- step 6t: a daily time trigger fires once ---------------------------------

// Does the hub add fields such as nextRun to a time trigger of a turned-on
// BLOCK, before or after it fires, that the product's canonical BLOCK form
// keeps (a false manual_change)? The BLOCK sets the run's virtual accessory
// On at the first whole minute at least FIRE_LEAD_MS ahead of the hub clock
// (home settings window), and that change is the firing evidence.
async function stepTimeTrigger(ctx) {
  const { hub, probe, virtual: v } = ctx;
  if (!v) {
    row(
      "6t time trigger",
      "scenario.create{BLOCK}",
      "the virtual accessory as the only target",
      "not run: no virtual accessory",
      "blocked",
    );
    return;
  }
  const clock = await readHubClock(ctx);
  if (clock.error) {
    row(
      "6t hub clock",
      'window.get{""} Time',
      "hub local time from the home settings window",
      `not run: ${clock.error}`,
      "blocked",
    );
    return;
  }
  const target = Math.ceil((clock.local + FIRE_LEAD_MS) / 60_000) * 60_000;
  const at = new Date(target);
  const hhmm = at.toISOString().slice(11, 16);
  const cron = `0 ${at.getUTCMinutes()} ${at.getUTCHours()} ? * * *`;
  const fireAt = clock.readAt + (target - clock.local);
  row(
    "6t hub clock",
    'window.get{""} Time, TimeZone',
    "hub local time and zone",
    `hub ${clock.text}${clock.zone ? ` ${clock.zone}` : ""}; hub UTC ${Math.round((clock.utc - clock.readAt) / 1000)} s from this machine; trigger ${hhmm} hub time in ${Math.round((fireAt - Date.now()) / 1000)} s`,
    "observed",
  );
  // Brightness stays as it is: SprutHub kept 30 when 0 was written to the
  // lamp turned off (2026-09-24).
  const base = {
    on: false,
    brightness: (await virtualState(probe, v)).brightness,
  };
  await setVirtual(probe, v, base);
  const block = await createBlock(ctx, {
    label: "fire",
    data: {
      targets: [
        ifNode("EVERY", cronCondition("NONE", cron, 0), [setLamp(v, true)]),
      ],
    },
  });
  blockRow("6t BLOCK create", block, `stored as sent; cron "${cron}"`);
  if (!block.scenarioRef || abortReason) return;
  const ref = block.scenarioRef;
  const atCreate = (await probe.storedBlockData(ref)).data;
  if (Date.now() > fireAt - 15_000) {
    row(
      "6t turn on",
      "-",
      "-",
      "not run: too close to the trigger time after create",
      "skipped",
    );
    return;
  }
  // The create restore deletes the BLOCK whether it is on or off.
  const on = await prepareAndApply(hub, {
    operation: "scenario_active",
    target_ref: ref,
    value: true,
  });
  if (on.applied) {
    pushCleanup(ctx, {
      label: "6t turn on",
      parent: block.cleanupEntry,
      changeRef: on.changeRef,
      restoreOptional: true,
    });
  }
  row(
    "6t turn on",
    "window.update{windowKey,options:[Active=true]}",
    "applied",
    describe(on),
    on.applied?.status === "applied" ? "match" : "rejected",
  );
  await activeAgreement(ctx, "6t agreement on", ref, true);
  if (!on.applied) return;
  const afterOn = (await probe.storedBlockData(ref)).data;
  storedChangeRow("6t stored after turn on", atCreate, afterOn);
  await productViewRow(ctx, "6t product view after turn on", block, on);

  const deadline = Math.min(
    fireAt + FIRE_MARGIN_MS,
    Date.now() + FIRE_WAIT_MAX_MS,
  );
  const seen = await watchUntil(
    probe,
    v,
    (state) => state.on === true,
    deadline,
  );
  row(
    "6t fire",
    "cron trigger (hub runtime)",
    `On false→true at ${hhmm} hub time`,
    seen.reached
      ? `On true ${((seen.at - fireAt) / 1000).toFixed(1)} s after the trigger time`
      : `no change by ${Math.round((seen.at - fireAt) / 1000)} s after the trigger time: ${JSON.stringify(seen.state)}`,
    seen.reached ? "match" : "mismatch",
  );
  // A field the hub adds after a run may come a moment later.
  if (seen.reached) await sleep(3_000);
  const afterFire = (await probe.storedBlockData(ref)).data;
  storedChangeRow("6t stored after fire", afterOn, afterFire);
  storedChangeRow("6t stored after fire vs create", atCreate, afterFire);
  await productViewRow(ctx, "6t product view after fire", block, on);

  // Restoring the off change would turn the BLOCK on again.
  const off = await prepareAndApply(hub, {
    operation: "scenario_active",
    target_ref: ref,
    value: false,
  });
  if (off.applied) {
    pushCleanup(ctx, {
      label: "6t turn off",
      parent: block.cleanupEntry,
      changeRef: off.changeRef,
      restoreOptional: true,
    });
  }
  row(
    "6t turn off",
    "window.update{windowKey,options:[Active=false]}",
    "applied",
    describe(off),
    off.applied?.status === "applied" ? "match" : "mismatch",
  );
  const agreement = await activeAgreement(ctx, "6t agreement off", ref, false);
  if (agreement.view?.active !== false) {
    await probe.setBlockActiveByWindow(ref, false);
    const again = await probe.activeView(ref);
    row(
      "6t fallback turn off",
      "window.update{windowKey,options:[Active=false]} (direct)",
      "active=false",
      `active ${again?.active}`,
      again?.active === false ? "match" : "mismatch",
    );
  }
  // A hub field the product takes for a manual change also stops this
  // restore; the turned-off BLOCK is then left to the sweep.
  const deleted = await runRestore(hub, block.cleanupEntry);
  row(
    "6t restore create",
    "scenario.delete{index}",
    "BLOCK deleted",
    deleted.observed,
    deleted.verified ? "match" : "mismatch",
  );
  if (!deleted.verified) {
    if ((await probe.activeView(ref))?.active === false) {
      leaveForSweep(
        ctx,
        block.cleanupEntry,
        ref,
        "restore did not delete the fired BLOCK, turned off since",
      );
    } else {
      abort("the fired BLOCK is neither off nor deleted");
    }
  }
  await setVirtual(probe, v, { ...base, on: v.initial.on });
}

// The home settings window's Time status, e.g.
// "2026-09-16 - 09:17:28 (GMT+03:00)" (2026-09-16-home-settings-window.md).
// `local` is the hub's wall clock as a UTC timestamp, `readAt` this
// machine's time of the read; only their difference schedules the wait.
async function readHubClock(ctx) {
  const ref = ctx.hub.settingsWindowRef;
  if (typeof ref !== "string") {
    return { error: "home_overview gave no options_window_ref" };
  }
  const window = await readWindow(ctx.hub, ref);
  const readAt = Date.now();
  const text = window.value("Time");
  const match =
    /^(\d{4})-(\d{2})-(\d{2}) - (\d{2}):(\d{2}):(\d{2}) \(GMT([+-])(\d{2}):(\d{2})\)$/.exec(
      typeof text === "string" ? text : "",
    );
  if (!match) {
    return {
      error: `Time ${text === undefined ? "absent" : "not in the observed form"}`,
    };
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset =
    (match[7] === "-" ? -1 : 1) *
    (Number(match[8]) * 60 + Number(match[9])) *
    60_000;
  const zone = window.value("TimeZone");
  return {
    text,
    zone: typeof zone === "string" ? zone : null,
    local,
    utc: local - offset,
    readAt,
  };
}

async function watchUntil(probe, virtual, done, deadline) {
  for (;;) {
    const state = await virtualState(probe, virtual);
    if (done(state)) return { reached: true, state, at: Date.now() };
    if (Date.now() >= deadline)
      return { reached: false, state, at: Date.now() };
    await sleep(Math.min(FIRE_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

// What changed in the stored data between two reads, and whether the
// product's canonical BLOCK form sees it.
function storedChangeRow(step, from, to) {
  const diff = structuralDiff(from, to);
  const canonicalSame = isDeepStrictEqual(
    canonicalBlock(from),
    canonicalBlock(to),
  );
  row(
    step,
    "scenario.get{index}",
    "record fields the hub adds or changes",
    diff.length === 0
      ? "no difference"
      : `${diff.length} difference(s): ${diff
          .slice(0, 4)
          .map((entry) => `${entry.kind} ${entry.path}`)
          .join(
            "; ",
          )}; canonical form ${canonicalSame ? "unchanged" : "changed"}`,
    diff.length === 0 ? "match" : canonicalSame ? "hub-normalized" : "mismatch",
    diff.length > 0 ? { differences: diff } : undefined,
  );
}

// The product's own view of the create and the turn-on: a hub field the
// canonical form keeps would show up here as a manual change.
async function productViewRow(ctx, step, block, on) {
  const created = await ctx.hub.get(block.changeRef);
  const switched = on.changeRef ? await ctx.hub.get(on.changeRef) : null;
  row(
    step,
    "get_native_change",
    "create applied with configuration_matches; turn on applied",
    `create ${created.status}${created.conflict_reason ? ` (${created.conflict_reason})` : ""}, configuration_matches ${created.configuration_matches}; turn on ${switched?.status ?? "-"}${switched?.conflict_reason ? ` (${switched.conflict_reason})` : ""}`,
    created.status === "applied" &&
      created.configuration_matches !== false &&
      switched?.status === "applied"
      ? "match"
      : "mismatch",
  );
}

// --- step 7: history.list (read-only) ----------------------------------------

// The product has no history read. Counts and field names only, no values.
async function stepHistory(ctx) {
  const { hub, probe, targets } = ctx;
  const chosen = [];
  const temperature = await firstCharacteristic(
    hub,
    "TemperatureSensor",
    "CurrentTemperature",
    "number",
  );
  if (temperature) chosen.push({ label: "temperature", ...temperature });
  chosen.push({ label: "light On", ...targets.lamp.on });
  const motion = await firstCharacteristic(
    hub,
    "MotionSensor",
    "MotionDetected",
    "boolean",
  );
  if (motion) chosen.push({ label: "motion", ...motion });
  // Changed by this run a minute ago (step 6): a recorded history shows it.
  if (ctx.virtual) {
    chosen.push({
      label: "virtual On",
      ids: ctx.virtual.on.ids,
      ref: `accessory/${ctx.virtual.on.ids.aId}/service/${ctx.virtual.on.ids.sId}/characteristic/${ctx.virtual.on.ids.cId}`,
    });
  }

  const before = Date.now();
  const after = before - DAY_MS;
  const window = { afterTimestamp: after, beforeTimestamp: before };
  const variants = (ids) => [
    ["24h", { filter: { accessories: [ids] }, ...window, limit: 100 }],
    [
      "24h includeContexts",
      {
        filter: { accessories: [ids] },
        ...window,
        limit: 100,
        includeContexts: true,
      },
    ],
    [
      "24h group HOUR",
      { filter: { accessories: [ids] }, ...window, group: "HOUR" },
    ],
    ["24h filters[]", { filters: [ids], ...window, limit: 100 }],
    [
      "24h in seconds",
      {
        filter: { accessories: [ids] },
        afterTimestamp: Math.floor(after / 1000),
        beforeTimestamp: Math.floor(before / 1000),
        limit: 100,
      },
    ],
    ["latest 50", { filter: { accessories: [ids] }, limit: 50 }],
    [
      "accessory latest 50",
      { filter: { accessories: [{ aId: ids.aId }] }, limit: 50 },
    ],
  ];
  const all = [];
  for (const { label, ids, ref } of chosen) {
    const results = [];
    for (const [name, request] of variants(pick(ids, ["aId", "sId", "cId"]))) {
      results.push({ variant: name, ...(await historyShape(probe, request)) });
    }
    all.push(...results);
    row(
      `7 history ${label}`,
      "history.list",
      "entries or an explicit empty list",
      results
        .map((result) =>
          result.error
            ? `${result.variant}: ${result.error}`
            : `${result.variant}: ${result.count}`,
        )
        .join("; "),
      "observed",
      { ref: relativeRef(ref), results },
    );
  }
  const home = await historyShape(probe, { limit: 5 });
  all.push(home);
  row(
    "7 history home",
    "history.list{limit:5}",
    "entries or an explicit empty list",
    home.error ?? `${home.count} entr(ies); list fields [${home.list_fields}]`,
    "observed",
    home,
  );
  // Whether the hub checks the request at all: an unknown accessory and an
  // unknown group value.
  const controls = [];
  for (const [variant, request] of [
    ["unknown accessory", { filter: { accessories: [{ aId: 999_999 }] } }],
    ["unknown group", { group: "NOT_A_GROUP", limit: 5 }],
  ]) {
    controls.push({ variant, ...(await historyShape(probe, request)) });
  }
  row(
    "7 history controls",
    "history.list",
    "record how invalid requests are answered",
    controls
      .map(({ variant, error, count }) => `${variant}: ${error ?? count}`)
      .join("; "),
    "observed",
    { controls },
  );
  report.history = {
    requested_at: new Date(before).toISOString(),
    non_empty: all.filter((result) => result.count > 0).length,
    errors: all.filter((result) => result.error).length,
  };
}

async function historyShape(probe, request) {
  let message;
  try {
    message = await probe.historyList(request);
  } catch (error) {
    return { error: error.message };
  }
  if (message.error) {
    return { error: `hub error ${message.error.code}` };
  }
  const list = message.result?.history?.list;
  if (!isRecord(list)) {
    return {
      error: "no history.list object",
      result_fields: Object.keys(message.result ?? {}),
    };
  }
  const entries = Array.isArray(list.histories) ? list.histories : [];
  return {
    list_fields: Object.keys(list).sort(),
    histories_present: Object.hasOwn(list, "histories"),
    count: entries.length,
    entry_fields: [...new Set(entries.flatMap(Object.keys))].sort(),
    value_kinds: [
      ...new Set(entries.flatMap((entry) => Object.keys(entry.value ?? {}))),
    ].sort(),
    with_contexts: entries.filter((entry) => entry.contexts?.length > 0).length,
    context_types: [
      ...new Set(
        entries.flatMap((entry) =>
          (entry.contexts ?? []).map(({ type }) => type),
        ),
      ),
    ].sort(),
  };
}

// --- step 8: time and size of the first reads (read-only) --------------------

// The first calls an agent makes, at this home's scale: time and the bytes
// of the text an agent reads.
async function stepTiming(ctx) {
  for (const [label, tool, args] of [
    ["home_overview", "home_overview", {}],
    ["find_devices", "find_devices", {}],
    ["find_devices light on", "find_devices", { kind: "light", state: "on" }],
  ]) {
    const result = await ctx.hub.read(tool, args);
    const call = ctx.hub.calls.at(-1);
    row(
      `8 ${label}`,
      `${tool} ${JSON.stringify(args)}`,
      "record time and size at this home's scale",
      `${result?.status ?? "no status"}${result?.error ? ` ${result.error.code}` : ""}; ${call.ms} ms; ${call.bytes} bytes${result?.next ? "; next page offered" : ""}`,
      result?.status === "ok" ? "observed" : "rejected",
      { ms: call.ms, bytes: call.bytes },
    );
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
  // An object created outside the product (the virtual accessory).
  if (entry.run) {
    const outcome = await entry.run();
    entry.done = outcome.verified;
    entry.outcome = outcome;
    report.cleanup.push({
      label: entry.label,
      status: outcome.status,
      verified: outcome.verified,
    });
    return outcome;
  }
  const result = await hub.restore(entry.changeRef);
  const restored = result.status === "restored";
  const verified = restored && (entry.verify ? await entry.verify() : true);
  entry.done = verified;
  entry.outcome = {
    verified,
    observed: `${result.status ?? "error"}${result.conflict_reason ? ` (${result.conflict_reason})` : ""}${result.error ? ` ${result.error.code}: ${result.error.message}` : ""}; verified ${verified}`,
    result,
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
    // left to restore; one left to the sweep still has.
    if (entry.restoreOptional || entry.parent?.outcome?.verified === true) {
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
      entry.run ? "direct delete" : "restore_native_change",
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
  const inspect = await hub.lists();
  const leftovers = [...inspect.rooms, ...inspect.scenarios].filter(
    ({ name }) => isProbeName(name, report.prefix),
  );
  row(
    "5 no probe objects",
    "room.list, scenario.list",
    "no room or scenario with the run prefix or short name",
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
      "room.list, scenario.list, accessory.list, get_entity",
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
// `expected` names the run objects that a step left to the sweep on purpose.
async function runSweep({
  prefix,
  stateDirectory,
  homeRef,
  sweptIsFailure,
  expected = new Map(),
}) {
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
        accessoryIds: await readProbeIds(stateDirectory, PROBE_ACCESSORIES),
        roomIds: await readProbeIds(stateDirectory, PROBE_ROOMS),
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
    row(
      "5 sweep",
      "scenario, accessory and room lists",
      "nothing left",
      "none",
      "match",
    );
  }
  for (const entry of entries) {
    const deleted = entry.outcome === "deleted";
    const planned = expected.get(entry.ref);
    row(
      `5 sweep ${relativeRef(entry.ref)}`,
      `${entry.kind}.delete`,
      "nothing left",
      !deleted
        ? `left: ${entry.reason}`
        : planned
          ? `deleted by the sweep, as step planned: ${planned}`
          : "deleted by the sweep; restore had left it",
      deleted && (!sweptIsFailure || planned) ? "match" : "mismatch",
    );
  }
  return entries;
}

// The run's proof that it created a virtual accessory or a room directly:
// its id, written to the state directory right after the hub acknowledged
// the create.
const PROBE_ACCESSORIES = {
  file: "probe-accessories.json",
  key: "accessory_ids",
};
const PROBE_ROOMS = { file: "probe-rooms.json", key: "room_ids" };

async function readProbeIds(stateDirectory, { file, key }) {
  if (!stateDirectory) return null;
  try {
    const record = JSON.parse(
      await readFile(path.join(stateDirectory, file), "utf8"),
    );
    return Array.isArray(record[key]) ? record[key] : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function recordProbeId(stateDirectory, record, id) {
  const ids = (await readProbeIds(stateDirectory, record)) ?? [];
  await writeFile(
    path.join(stateDirectory, record.file),
    `${JSON.stringify({ [record.key]: [...ids, id] })}\n`,
    { mode: 0o600 },
  );
}

// The hub cuts accessory names (2026-09-11) and room names (2026-09-24) to
// 30 characters, so accessories and rooms carry this short run name.
function probeShortName(prefix) {
  return `zz-probe-${prefix.slice("zz-sprut-agent-probe-".length)}`;
}

// Scenarios keep the full prefix; rooms and the accessory the short name.
function isProbeName(name, prefix) {
  return (
    String(name).startsWith(prefix) ||
    String(name).startsWith(probeShortName(prefix))
  );
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
// the run (name starts with prefix) that the run provably created and that
// cannot act: a scenario with the product's marker and active=false, a room
// with no accessories from the run's room_create or with its id in
// `roomIds`. It also deletes the run's virtual accessory (probeShortName)
// when its id is in `accessoryIds` and none of its characteristics has a
// link. Everything else with those names is left and reported. `changes` is
// the run's change journal, `accessoryIds` and `roomIds` the run's records of
// objects it created directly; each is null when it is not available. The
// product's restore is not used: the sweep exists for objects that restore
// could not remove.
export async function sweepProbeObjects({
  client,
  prefix,
  changes,
  accessoryIds = null,
  roomIds = null,
}) {
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
  // After the scenarios that act on it and before the room that holds it.
  const accessoryName = probeShortName(prefix);
  for (const accessory of await client.listAccessories()) {
    if (accessory.name !== accessoryName) continue;
    entries.push({
      kind: "accessory",
      ref: `${homeRef}/accessory/${accessory.id}`,
      name: accessory.name,
      ...(await settle(() =>
        sweepAccessory(client, accessory.id, accessoryIds),
      )),
    });
  }
  for (const room of (await client.listRooms()).rooms) {
    if (!isProbeName(room.name, prefix)) continue;
    entries.push({
      kind: "room",
      ref: room.ref,
      name: room.name,
      ...(await settle(() =>
        sweepRoom(client, Number(room.ref.split("/").at(-1)), changes, roomIds),
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

// accessory.list on SprutHub 3.0.0 has no `virtual` field; accessory.get
// has it. A link would tie the accessory to a real device.
async function sweepAccessory(client, id, accessoryIds) {
  if (accessoryIds === null) return left("record_unavailable");
  if (!accessoryIds.includes(id)) return left("no_ownership_marker");
  const accessory = await client.getAccessoryOrNull(id);
  if (accessory === null) return { outcome: "gone" };
  if (accessory.virtual !== true) return left("not_virtual");
  for (const service of accessory.services ?? []) {
    for (const { cId } of service.characteristics ?? []) {
      const links = await client.listLinks({ aId: id, sId: service.sId, cId });
      if (links.length > 0) return left("has_links");
    }
  }
  return deleteAndVerify(
    () => client.deleteAccessory(id),
    () => client.getAccessoryOrNull(id),
  );
}

async function sweepRoom(client, id, changes, roomIds) {
  if (changes === null && roomIds === null) {
    return left("journal_unavailable");
  }
  const created =
    roomIds?.includes(id) ||
    changes?.some(
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
  const { failure, gone } = await deleteChecked(remove, read);
  if (gone) return { outcome: "deleted" };
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
  // A readback that failed, e.g. scenario_active_mismatch.
  const unread = failed.verification?.error?.code;
  return `${failed.status}${failed.conflict_reason ? ` (${failed.conflict_reason})` : ""}${unread ? ` [readback ${unread}]` : ""}`;
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
