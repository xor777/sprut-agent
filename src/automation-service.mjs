import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AutomationStore } from "./automation-store.mjs";
import {
  blockAffectedRefs,
  canonicalBlock,
  normalizeBlockRequest,
  withHiddenHttpUrls,
} from "./block-model.mjs";
import {
  buildPauseRequestedSnapshot,
  inspectPauseOwnership,
  mergePauseOutcomes,
  nativePauseOutcomes,
  replaceBlockValueAtPointer,
  selectBlockAction,
} from "./block-pause.mjs";
import {
  blockActionPreview,
  prepareBlockUpdateSource,
  prepareBlockWriteSource,
  requireActionOnlyRuntime,
  restoreHiddenBlockStrings,
  scenarioRunPlan,
  scenarioTargetReferences,
  storedScenarioRunPlan,
  validateBlockData,
  withKeptSubtreesAsStored,
} from "./block-validation.mjs";
import {
  accessoryPlacementContract,
  blockActionPauseContract,
  blockContract,
  characteristicContract,
  groupValuesEqual,
  logicAssignmentContract,
  logicSourceContract,
  ROOM_NAME_LIMIT_NOTE,
  requiredNativeName,
  roomCreateContract,
  scenarioRunContract,
  typedNativeValue,
  validateCharacteristicValue,
  valuesEqual,
  virtualLightGroupContract,
} from "./change-contracts.mjs";
import {
  activeInsteadOfValue,
  changeRef,
  configuredHomeRef,
  decodeReferenceSegment,
  groupRef,
  inactiveScenarioRun,
  isRecord,
  isUncertainWriteError,
  isUnreadError,
  isVerifiedRunType,
  nativeChangeNext,
  nativeTargetKey,
  parseAccessoryRef,
  parseCharacteristicRef,
  parseConfiguredHomeRef,
  parseInspectedChangeRef,
  parseLogicRef,
  parseNativeChangeRef,
  parseRestoreRef,
  parseRoomRef,
  parseScenarioRef,
  parseServiceRef,
  refuseRedactedChangeTexts,
  refuseRedactionMark,
  requireEntityHome,
  scenarioNotFound,
  serviceKey,
  stableJson,
  stableNativeId,
  unsupportedBlockFlags,
  unsupportedBlockMetadata,
  unsupportedHomeWrite,
  unsupportedNativeOperation,
  unsupportedScenarioType,
  unverifiedScenarioRunType,
  writeRejection,
} from "./change-refs.mjs";
import { readLogicInfo } from "./logic-info.mjs";
import {
  changeStillInEffect,
  characteristicValueDraft,
  characteristicValueState,
  failedVerification,
  freshVerification,
  hasKnownSettingSemantics,
  isDeviceCommandRejection,
  isNativeChange,
  isNativeValueChange,
  isRetryableNativeValueChange,
  LAMP_LEVEL_LIMITATION,
  LAMP_LEVEL_RESTORATION,
  lightLevelOnTarget,
  logicActiveValue,
  manualValueChangeObserved,
  nativeIntentDirection,
  nativeScenarioDescription,
  nativeValueAlreadyDesired,
  nativeValueContractFields,
  nativeValueDraft,
  nativeValueIntentEvidence,
  nativeValueKind,
  nativeValueLifecycle,
  nativeValueProvenApply,
  nativeValueRestoration,
  prepareCharacteristicValue,
  readTargetAccessory,
  restoreGoesOn,
  roomNameWithinLimit,
  SCENARIO_METADATA_OPTIONS,
  savedVerification,
  scenarioOptionValue,
  valueRestoreGoesOn,
  valueTargetKey,
  withoutLaterChange,
  withRestoreAgainNext,
  writeOutcomeUnknown,
} from "./native-values.mjs";
import {
  characteristicRef,
  isSensitiveNativeNode,
  SprutHubError,
  sanitizeNativeData,
} from "./spruthub-client.mjs";

// Accessories read one by one to learn whether they are virtual.
const VIRTUAL_CANDIDATE_LIMIT = 10;
// Changes one restore_native_change call undoes: two full device-command
// groups.
const RESTORE_BATCH_LIMIT = 100;
// Changes that make the hub act by itself from now on. An applied one
// tells the agent to say what it will overwrite.
const AUTOMATION_CHANGE_KINDS = new Set([
  "block_create",
  "block_data_update",
  "logic_source_create",
  "logic_source_update",
]);
const AUTOMATION_OVERWRITE_NOTE =
  "Say in the answer what this automation will overwrite: manual settings at each run, or the behaviour it replaces. This informs; it does not ask.";
export class AutomationService {
  #writeSequence = Promise.resolve();

  constructor({ client, stateDirectory, hubUrl, hubSerial }) {
    this.client = client;
    this.hubSerial = hubSerial;
    this.store = new AutomationStore({
      directory: stateDirectory,
      hubUrl,
      hubSerial,
    });
  }

  async getNativeChangeContract(input) {
    const valueKind = nativeValueKind(input.operation);
    if (valueKind) {
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        ...(valueKind.contract
          ? await valueKind.contract(this, input)
          : await nativeValueContractFields(this, valueKind, input)),
      };
    }
    if (input.operation === "logic_assignment") {
      const target = parseLogicRef(input.target_ref, this.hubSerial);
      const { assigned, type } = await this.#readLogicSelection(target);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: logicAssignmentContract(target, type, assigned !== null),
      };
    }
    if (input.operation === "accessory_placement") {
      const target = parseAccessoryRef(input.target_ref, this.hubSerial);
      const accessory = await this.client.getAccessory(target.id);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: accessoryPlacementContract(accessory),
      };
    }
    if (input.operation === "room_create") {
      if (input.target_ref !== undefined) {
        parseConfiguredHomeRef(input.target_ref, this.hubSerial);
      }
      return {
        status: "ok",
        operation: input.operation,
        ...(input.target_ref === undefined
          ? {}
          : { target_ref: input.target_ref }),
        contract: roomCreateContract(),
      };
    }
    if (input.operation === "virtual_light_group") {
      if (input.target_ref !== undefined) {
        parseConfiguredHomeRef(input.target_ref, this.hubSerial);
      }
      return {
        status: "ok",
        operation: input.operation,
        ...(input.target_ref === undefined
          ? {}
          : { target_ref: input.target_ref }),
        contract: virtualLightGroupContract(),
      };
    }
    if (input.operation === "scenario_run") {
      await this.#readRunnableScenario(input.target_ref);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: scenarioRunContract(),
      };
    }
    if (["block_create", "block_data_update"].includes(input.operation)) {
      return {
        status: "ok",
        operation: input.operation,
        contract: blockContract(),
      };
    }
    if (input.operation === "block_action_pause") {
      const target = parseScenarioRef(input.target_ref, this.hubSerial);
      const scenario = await this.client.getScenario(target.index);
      if (!scenario) throw scenarioNotFound();
      if (scenarioSnapshot(scenario).type !== "BLOCK")
        throw unsupportedScenarioType();
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: blockActionPauseContract(),
      };
    }
    if (input.operation === "logic_source_create") {
      const target = parseServiceRef(input.target_ref, this.hubSerial);
      await this.#readLogicTypeCatalog(target);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: logicSourceContract("create"),
        next: sdkNext(this.hubSerial),
      };
    }
    if (input.operation === "logic_source_update") {
      const target = parseScenarioRef(input.target_ref, this.hubSerial);
      const scenario = await this.client.getScenario(target.index);
      if (!scenario) throw scenarioNotFound();
      logicScenarioSnapshot(scenario);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: logicSourceContract("update"),
        next: sdkNext(this.hubSerial),
      };
    }
    throw unsupportedNativeOperation();
  }

  async prepareNativeChange(input) {
    // Text with the redaction mark is refused here; a value carrying it, with
    // the value's contract (validateCharacteristicValue).
    for (const field of ["name", "description", "source"]) {
      refuseRedactionMark(input[field], field);
    }
    const valueKind = nativeValueKind(input.operation);
    if (valueKind) {
      return this.#prepareValueChange(valueKind, input);
    }
    if (input.operation === "block_create") {
      return this.#prepareBlockCreate(input);
    }
    if (input.operation === "block_data_update") {
      return this.#prepareBlockUpdate(input);
    }
    if (input.operation === "block_action_pause") {
      return this.#prepareBlockActionPause(input);
    }
    if (input.operation === "scenario_run") {
      return this.#prepareScenarioRun(input);
    }
    if (input.operation === "logic_source_create") {
      return this.#prepareLogicSourceCreate(input);
    }
    if (input.operation === "logic_source_update") {
      return this.#prepareLogicSourceUpdate(input);
    }
    if (input.operation === "logic_assignment") {
      return this.#prepareLogicAssignment(input);
    }
    if (input.operation === "accessory_placement") {
      return this.#prepareAccessoryPlacement(input);
    }
    if (input.operation === "room_create") {
      return this.#prepareRoomCreate(input);
    }
    if (input.operation === "virtual_light_group") {
      return this.#prepareVirtualLightGroup(input);
    }
    throw unsupportedNativeOperation();
  }

  async #prepareValueChange(kind, input) {
    if (
      ["scenario_active", "logic_active"].includes(input.operation) &&
      input.value === undefined &&
      typeof input.active === "boolean"
    ) {
      throw activeInsteadOfValue(input);
    }
    const draft = kind.prepare
      ? await kind.prepare(this, input)
      : await nativeValueDraft(this, kind, input);
    if (nativeValueAlreadyDesired(draft)) {
      return {
        status: "already_desired",
        operation: input.operation,
        target_ref: input.target_ref,
        ...(kind.optionKey ? { option_key: input.option_key } : {}),
        observed_value: draft.value,
        native_write_sent: false,
        // The characteristic command no-op has never reported ownership.
        ...(kind.command ? {} : { owned_change_created: false }),
        ...(kind.notes ? kind.notes(draft) : {}),
      };
    }
    return publicNativeChange(
      await this.#recordValueChange(
        input,
        draft,
        draft.fields.target_name === undefined
          ? await this.#deviceJournal(kind, draft)
          : {},
      ),
    );
  }

  // The device and channel a setting belongs to, saved so that history
  // names it as the owner knows it, and whether a command sets a lamp's
  // level (lamp_level), as send_device_commands records it. Both are
  // optional: only a transport failure stops the prepare.
  async #deviceJournal(kind, { fields: { target }, contract }) {
    if (!Number.isInteger(target?.aId)) return {};
    const accessory = await readTargetAccessory(this, target.aId);
    const name = deviceCommandName(accessory, target);
    return {
      ...(name ? { target_name: name } : {}),
      ...(kind.command && lightLevelOnTarget(accessory, target, contract.type)
        ? { lamp_level: true }
        : {}),
    };
  }

  async #recordValueChange(input, draft, journal = {}) {
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: input.operation,
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      ...draft.fields,
      contract: draft.contract,
      baseline_value: draft.value,
      requested_value: draft.requested,
      ...draft.extra,
      ...journal,
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.#saveBeforeWrite(change);
    return change;
  }

  async #prepareLogicAssignment(input) {
    const target = parseLogicRef(input.target_ref, this.hubSerial);
    const { assigned, type } = await this.#readLogicSelection(target);
    if (assigned) {
      return {
        status: "already_desired",
        operation: "logic_assignment",
        target_ref: input.target_ref,
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "logic_assignment",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      target,
      native_type: { type: type.type },
      ...(typeof type.name === "string"
        ? { target_name: sanitizeNativeData(type.name) }
        : {}),
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline_absent"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #prepareAccessoryPlacement(input) {
    const target = parseAccessoryRef(input.target_ref, this.hubSerial);
    const roomId = parseRoomRef(input.room_ref, this.hubSerial);
    const name = requiredNativeName(input.name, "accessory placement");
    const [accessory, room] = await Promise.all([
      this.client.getAccessory(target.id),
      this.client.getRoom(roomId),
    ]);
    if (!room) {
      throw new SprutHubError(
        "room_not_found",
        "The selected destination room was not found.",
        "home_overview",
      );
    }
    const baselineRoom = await this.client.getRoom(accessory.roomId);
    if (!baselineRoom) {
      throw new SprutHubError(
        "incompatible_response",
        "The accessory references a room that SprutHub did not return.",
      );
    }
    const baseline = accessoryPlacementSnapshot(accessory, baselineRoom);
    const requested = {
      name,
      room_id: room.id,
      room_name: room.name,
      binding: structuredClone(baseline.binding),
    };
    if (accessoryPlacementMatches(baseline, requested)) {
      return {
        status: "already_desired",
        operation: input.operation,
        target_ref: input.target_ref,
        observed: publicAccessoryPlacement(baseline, this.hubSerial),
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "accessory_placement",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      target,
      baseline_snapshot: baseline,
      requested_snapshot: requested,
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #prepareRoomCreate(input) {
    parseConfiguredHomeRef(input.target_ref, this.hubSerial);
    const name = roomNameWithinLimit(
      requiredNativeName(input.name, "room creation").trim(),
    );
    const rooms = await this.#listRoomRecords();
    const matching = rooms.filter((room) => room.name === name);
    if (matching.length > 0) {
      return {
        status: "already_desired",
        operation: input.operation,
        target_ref: input.target_ref,
        matching_rooms: matching.map((room) =>
          publicRoom(room, this.hubSerial),
        ),
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "room_create",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      requested_name: name,
      baseline_room_ids: rooms.map(({ id: roomId }) => roomId),
      native_write_sent: false,
      native_acknowledged: false,
      room_creation_owned: false,
      last_verification: freshVerification("baseline_absent"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #prepareVirtualLightGroup(input) {
    parseConfiguredHomeRef(input.target_ref, this.hubSerial);
    const name = requiredNativeName(input.name, "virtual light group").trim();
    const roomId = parseRoomRef(input.room_ref, this.hubSerial);
    const room = await this.client.getRoom(roomId);
    if (!room) {
      throw new SprutHubError(
        "room_not_found",
        "The selected room was not found.",
        "home_overview",
      );
    }
    const characteristicTypes = validateVirtualLightCharacteristicTypes(
      input.characteristic_types,
    );
    if (
      !Array.isArray(input.member_service_refs) ||
      input.member_service_refs.length < 2
    ) {
      throw new SprutHubError(
        "group_members_required",
        "Select at least two Lightbulb services for the virtual light group.",
        "get_entity",
      );
    }
    if (
      new Set(input.member_service_refs).size !==
      input.member_service_refs.length
    ) {
      throw new SprutHubError(
        "duplicate_group_member",
        "Virtual light group members must be unique services.",
        "get_entity",
      );
    }
    const memberTargets = input.member_service_refs.map((ref) => ({
      ref,
      target: parseServiceRef(ref, this.hubSerial),
    }));
    const [serviceTypes, accessories] = await Promise.all([
      this.client.listServiceTypes(),
      Promise.all(
        memberTargets.map(({ target }) => this.client.getAccessory(target.aId)),
      ),
    ]);
    const lightbulbType = serviceTypes.find(({ type }) => type === "Lightbulb");
    validateVirtualLightServiceType(lightbulbType, characteristicTypes);
    const members = memberTargets.map(({ ref, target }, index) =>
      selectVirtualLightMember(
        ref,
        target,
        accessories[index],
        characteristicTypes,
      ),
    );
    const allAccessories = await this.client.listAccessories();
    const matching = await this.#virtualAccessories(
      allAccessories.filter(
        (accessory) => accessory.roomId === roomId && accessory.name === name,
      ),
    );
    if (matching.length > 0) {
      return {
        status: "conflict",
        operation: input.operation,
        target_ref: input.target_ref,
        matching_accessories: matching.map(({ id, name: matchingName }) => ({
          ref: `${configuredHomeRef(this.hubSerial)}/accessory/${id}`,
          name: matchingName,
        })),
        native_write_sent: false,
        owned_change_created: false,
        conflict_reason: "matching_virtual_accessory_exists",
      };
    }
    const physicalLinkBaselines = await Promise.all(
      characteristicTypes.flatMap((type) =>
        members.map(async (member) => ({
          type,
          member_ref: member.ref,
          target: structuredClone(member.characteristics[type]),
          links: normalizePhysicalLinks(
            await this.client.listLinks(member.characteristics[type]),
          ),
        })),
      ),
    );
    const requiredTypes = new Set(
      lightbulbType.required.map(characteristicTypeName),
    );
    const optional = characteristicTypes.filter(
      (type) => !requiredTypes.has(type),
    );
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "virtual_light_group",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      room_ref: input.room_ref,
      room_id: roomId,
      room_name: room.name,
      requested_name: name,
      reason: input.reason,
      characteristic_types: characteristicTypes,
      member_service_refs: [...input.member_service_refs],
      members,
      create_request: {
        name,
        roomId,
        services: [{ name, type: "Lightbulb", optional }],
      },
      baseline_accessory_ids: allAccessories.map(
        ({ id: accessoryId }) => accessoryId,
      ),
      physical_link_baselines: physicalLinkBaselines,
      progress: {
        creation: { sent: false, acknowledged: false },
        links: characteristicTypes.flatMap((type) =>
          members.map((member) => ({
            type,
            member_ref: member.ref,
            target: member.characteristics[type],
            sent: false,
            acknowledged: false,
            completed: false,
          })),
        ),
        settings: characteristicTypes.map((type) => ({
          type,
          sent: false,
          acknowledged: false,
          completed: false,
        })),
      },
      native_write_sent: false,
      native_acknowledged: false,
      virtual_accessory_creation_owned: false,
      last_verification: freshVerification("baseline_absent"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #prepareBlockCreate(input) {
    if (
      typeof input.name !== "string" ||
      typeof input.description !== "string" ||
      typeof input.active !== "boolean" ||
      typeof input.on_start !== "boolean" ||
      typeof input.sync !== "boolean" ||
      !isRecord(input.data)
    ) {
      throw new SprutHubError(
        "invalid_native_change",
        "BLOCK creation requires name, description, explicit active/on_start/sync flags, and complete data.",
        "get_native_change_contract",
      );
    }
    parseConfiguredHomeRef(input.target_ref, this.hubSerial);
    const data = structuredClone(input.data);
    normalizeBlockRequest(data);
    const validation = await validateBlockData(data, this.client, {
      allowUnknownFrom: null,
      allowActionOnly: true,
    });
    requireActionOnlyRuntime(
      {
        active: input.active,
        onStart: input.on_start,
        sync: input.sync,
      },
      validation,
    );
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "block_create",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      reason: input.reason,
      marker: `sprut-agent:native:${id}`,
      requested_snapshot: {
        name: input.name,
        desc: input.description,
        active: input.active,
        onStart: input.on_start,
        sync: input.sync,
        type: "BLOCK",
        data,
      },
      block_action_preview: blockActionPreview(
        validation,
        data,
        configuredHomeRef(this.hubSerial),
        now,
      ),
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change, undefined, {
      blockActionSnapshotFresh: true,
    });
  }

  async #prepareBlockUpdate(input) {
    if (
      typeof input.name === "string" ||
      typeof input.description === "string"
    ) {
      throw unsupportedBlockMetadata(input);
    }
    if (
      input.active !== undefined ||
      input.on_start !== undefined ||
      input.sync !== undefined
    ) {
      throw unsupportedBlockFlags(input);
    }
    if (!isRecord(input.data)) {
      throw new SprutHubError(
        "invalid_native_change",
        "BLOCK update requires data. Change Name or Desc with window_option using the scenario ref.",
        "get_native_change_contract",
        {
          next: {
            tool: "get_native_change_contract",
            arguments: {
              operation: "window_option",
              target_ref: input.target_ref,
              option_key: "Name",
            },
          },
        },
      );
    }
    const target = parseScenarioRef(input.target_ref, this.hubSerial);
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) throw scenarioNotFound();
    const baseline = scenarioSnapshot(scenario);
    if (baseline.type !== "BLOCK") throw unsupportedScenarioType();
    const pauseChanges = await this.#knownBlockPauses(input.target_ref);
    const prepared = prepareBlockUpdateSource(
      baseline.data,
      input.data,
      pauseChanges,
      Date.now(),
    );
    restoreHiddenBlockStrings(prepared.data, baseline.data);
    normalizeBlockRequest(prepared.data);
    const data = withKeptSubtreesAsStored(prepared.data, baseline.data);
    // Runtime flags belong to the owner here: this operation never writes
    // them, so a BLOCK without a trigger keeps whatever it had.
    const validation = await validateBlockData(data, this.client, {
      editedFrom: baseline.data,
      allowedPauses: pauseChanges,
      scenarioIndex: target.index,
    });
    const requested = {
      ...structuredClone(baseline),
      data,
    };
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "block_data_update",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      target,
      reason: input.reason,
      update_fields: ["data"],
      baseline_snapshot: baseline,
      requested_snapshot: requested,
      block_action_preview: blockActionPreview(
        validation,
        data,
        configuredHomeRef(this.hubSerial),
        now,
      ),
      ...(prepared.pauseOutcomes.length > 0
        ? { pause_outcomes: prepared.pauseOutcomes }
        : {}),
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change, undefined, {
      blockActionSnapshotFresh: true,
    });
  }

  async #prepareBlockActionPause(input) {
    if (
      typeof input.action_pointer !== "string" ||
      !Number.isSafeInteger(input.duration_seconds) ||
      input.duration_seconds <= 0 ||
      input.duration_seconds > 31_536_000
    ) {
      throw new SprutHubError(
        "invalid_native_change",
        "BLOCK action pause requires one action_pointer and a positive duration_seconds not exceeding one year.",
        "get_native_change_contract",
      );
    }
    const target = parseScenarioRef(input.target_ref, this.hubSerial);
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) throw scenarioNotFound();
    const baseline = scenarioSnapshot(scenario);
    if (baseline.type !== "BLOCK") throw unsupportedScenarioType();
    const pauseChanges = await this.#knownBlockPauses(input.target_ref);
    await validateBlockData(baseline.data, this.client, {
      allowUnknownFrom: baseline.data,
      allowedPauses: pauseChanges,
    });
    const selected = selectBlockAction(
      baseline.data,
      input.action_pointer,
      pauseChanges,
    );
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "block_action_pause",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      target,
      reason: input.reason,
      action_pointer: selected.pointer,
      selected_action_type: selected.action.type,
      selected_action_snapshot: structuredClone(selected.action),
      duration_seconds: input.duration_seconds,
      baseline_snapshot: baseline,
      ...(selected.replacesChangeId
        ? { replaces_pause_change_id: selected.replacesChangeId }
        : {}),
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #readRunnableScenario(targetRef) {
    const target = parseScenarioRef(targetRef, this.hubSerial);
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) throw scenarioNotFound();
    const snapshot = runnableScenarioSnapshot(scenario);
    // Turning it on would not make it runnable, so this is checked first.
    if (!isVerifiedRunType(snapshot)) {
      throw unverifiedScenarioRunType(snapshot);
    }
    if (!snapshot.active) throw inactiveScenarioRun(targetRef);
    return { target, snapshot };
  }

  async #prepareScenarioRun(input) {
    const { target, snapshot } = await this.#readRunnableScenario(
      input.target_ref,
    );
    const plan = await scenarioRunPlan(
      snapshot,
      this.client,
      configuredHomeRef(this.hubSerial),
    );
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "scenario_run",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      target,
      reason: input.reason,
      baseline_snapshot: snapshot,
      ...plan,
      native_write_sent: false,
      native_acknowledged: false,
      run_delivery: { status: "not_sent" },
      last_verification: freshVerification("scenario_and_targets_validated"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #knownBlockPauses(targetRef) {
    try {
      parseConfiguredHomeRef(targetRef, this.hubSerial);
      return [];
    } catch (error) {
      if (
        !(error instanceof SprutHubError) ||
        error.code !== "invalid_home_ref"
      ) {
        throw error;
      }
    }
    return (await this.#knownScenarioChanges(targetRef)).filter(
      (change) =>
        change.kind === "block_action_pause" &&
        typeof change.action_pointer === "string",
    );
  }

  async #knownScenarioChanges(targetRef) {
    const target = parseScenarioRef(targetRef, this.hubSerial);
    const homeRef = configuredHomeRef(this.hubSerial);
    return (await this.store.list()).filter(
      (change) =>
        change.home_ref === homeRef && change.target?.index === target.index,
    );
  }

  async #prepareLogicSourceCreate(input) {
    const source = requiredLogicSource(input.source);
    if (
      typeof input.name !== "string" ||
      typeof input.description !== "string" ||
      typeof input.active !== "boolean" ||
      typeof input.on_start !== "boolean" ||
      typeof input.sync !== "boolean"
    ) {
      throw new SprutHubError(
        "invalid_native_change",
        "LOGIC source creation requires name, description, explicit active/on_start/sync flags, and source.",
        "get_native_change_contract",
      );
    }
    const target = parseServiceRef(input.target_ref, this.hubSerial);
    // Checks the anchor service and its catalog; the created LOGIC's type is
    // its scenario index (createdLogicMapping), so no baseline is kept.
    await this.#readLogicTypeCatalog(target);
    const id = this.store.newId();
    const now = new Date().toISOString();
    const marker = `sprut-agent:native:${id}`;
    const change = {
      id,
      kind: "logic_source_create",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      target,
      reason: input.reason,
      marker,
      requested_snapshot: {
        name: input.name,
        desc: input.description,
        active: input.active,
        onStart: input.on_start,
        sync: input.sync,
        type: "LOGIC",
        data: logicSourceWithOwnershipMarker(source, marker),
      },
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #prepareLogicSourceUpdate(input) {
    const metadataField = Object.keys(LOGIC_SOURCE_METADATA_INPUTS).find(
      (field) => input[field] !== undefined,
    );
    if (metadataField) {
      throw logicSourceMetadataInput(input.target_ref, metadataField);
    }
    const source = requiredLogicSource(input.source);
    const target = parseScenarioRef(input.target_ref, this.hubSerial);
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) throw scenarioNotFound();
    const baseline = logicScenarioSnapshot(scenario);
    if (baseline.predefined === true) {
      throw new SprutHubError(
        "predefined_logic_read_only",
        "Clone a predefined LOGIC into a new owned scenario instead of changing its source.",
        "prepare_native_change",
      );
    }
    if (baseline.data === source) {
      return {
        status: "already_desired",
        operation: input.operation,
        target_ref: input.target_ref,
        source_sha256: sourceFingerprint(source),
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const effects = logicCodeInfoEffects(baseline, source);
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "logic_source_update",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      target_ref: input.target_ref,
      target,
      reason: input.reason,
      baseline_snapshot: baseline,
      requested_snapshot: {
        ...structuredClone(baseline),
        ...effects.snapshot,
        data: source,
      },
      ...(effects.codeSets.length > 0 ? { code_sets: effects.codeSets } : {}),
      ...(effects.restoreCodeSets.length > 0
        ? { restore_code_sets: effects.restoreCodeSets }
        : {}),
      ...(effects.warnings.length > 0 ? { warnings: effects.warnings } : {}),
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  // With anchorMayBeGone, a removed anchor accessory or service reads as
  // null instead of an error: a created LOGIC outlives its anchor, which
  // only lists its type for assignment.
  async #readLogicTypeCatalog(target, { anchorMayBeGone = false } = {}) {
    const [accessory, types] = await Promise.allSettled([
      anchorMayBeGone
        ? this.client.getAccessoryOrNull(target.aId)
        : this.client.getAccessory(target.aId),
      this.client.listLogicTypes(target),
    ]);
    if (accessory.status === "rejected") throw accessory.reason;
    if (!accessory.value?.services?.some(({ sId }) => sId === target.sId)) {
      if (anchorMayBeGone) return null;
      throw new SprutHubError(
        "service_not_found",
        "The selected service was not found on its accessory.",
        "get_entity",
      );
    }
    if (types.status === "rejected") throw types.reason;
    const entries = types.value.map((entry) => {
      if (!isRecord(entry) || typeof entry.type !== "string") {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub returned incomplete logic type data.",
        );
      }
      return { type: entry.type, name: entry.name };
    });
    if (new Set(entries.map(({ type }) => type)).size !== entries.length) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned the same logic type more than once.",
      );
    }
    return entries;
  }

  async applyNativeChange(changeReference) {
    const id = parseNativeChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireNativeChange(id);
      const result = await this.#applyNative(change);
      return AUTOMATION_CHANGE_KINDS.has(change.kind) &&
        result.status === "applied"
        ? { ...result, tell_owner: AUTOMATION_OVERWRITE_NOTE }
        : result;
    });
  }

  async #applyNative(change) {
    if (change.kind === "accessory_placement") {
      return this.#applyAccessoryPlacement(change);
    }
    if (change.kind === "room_create") {
      return this.#applyRoomCreate(change);
    }
    if (change.kind === "virtual_light_group") {
      return this.#applyVirtualLightGroup(change);
    }
    if (change.kind === "logic_assignment") {
      return this.#applyLogicAssignment(change);
    }
    if (change.kind === "scenario_run") {
      return this.#applyScenarioRun(change);
    }
    if (isLogicSourceChange(change)) {
      return this.#applyScenarioChange(change);
    }
    return isNativeValueChange(change)
      ? this.#applyValueChange(change)
      : this.#applyScenarioChange(change);
  }

  // Several characteristic_value changes in one call. One read of each
  // device, sent together, gives every command's contract and value, the
  // device's name and a lamp's On; every command is validated before any is
  // recorded or sent. The devices then run at once: a device's own commands
  // one after another, each sent after the hub answered the one before,
  // since two writes to one lamp in flight together are applied in either
  // order (2026-10-13-parallel-writes); after them one read of the device
  // decides each of its commands. Each command goes through the same journal
  // record and apply lifecycle as prepare → apply. The call is one group:
  // its changes share group_id, so one restore puts back the whole request,
  // each value as it was before the call.
  async sendDeviceCommands({ home_ref: homeRef, commands, reason }) {
    parseConfiguredHomeRef(homeRef, this.hubSerial);
    const targets = parseDeviceCommandTargets(commands, this.hubSerial);
    return this.#exclusiveWrite(async () => {
      const devices = await this.#readCommandDevices([
        ...new Set(targets.map(({ aId }) => aId)),
      ]);
      const changes = await this.#readJournalBeforeWrite();
      const items = await this.#validateDeviceCommands(
        commands,
        targets,
        devices,
        changes,
      );
      const run = {
        changes,
        homeRef,
        reason,
        groupId: this.store.newId(),
        results: [],
        readbacks: new Map(),
      };
      await mapWithConcurrency(
        deviceCommandRuns(items.filter(({ sameWriteAs }) => !sameWriteAs)),
        DEVICE_COMMAND_CONCURRENCY,
        (device) => this.#runDeviceCommands(device, run),
      );
      for (const { index, sameWriteAs, shown, note } of items) {
        if (!sameWriteAs) continue;
        run.results[index] = {
          ...run.results[sameWriteAs.index],
          ...shown,
          note,
        };
      }
      await this.#settleLamps(items, devices, run);
      return deviceCommandsResult(
        homeRef,
        run.results,
        run.results.some(({ change_ref: ref }) => typeof ref === "string")
          ? groupRef(run.groupId)
          : null,
      );
    });
  }

  // One accessory.get per device of the call, sent together. A home
  // snapshot kept current by hub events could answer this read instead;
  // the read back after the writes stays.
  async #readCommandDevices(aIds) {
    const reads = await mapWithConcurrency(
      aIds,
      DEVICE_COMMAND_CONCURRENCY,
      (aId) => this.#readCommandDevice(aId),
    );
    return new Map(aIds.map((aId, index) => [aId, reads[index]]));
  }

  async #readCommandDevice(aId) {
    try {
      return { accessory: await this.client.getAccessory(aId) };
    } catch (error) {
      return { error };
    }
  }

  async #validateDeviceCommands(commands, targets, devices, changes) {
    const items = [];
    const invalid = [];
    for (const [index, command] of commands.entries()) {
      const target = targets[index];
      const input = {
        operation: "characteristic_value",
        target_ref: command.target_ref,
        value: command.value,
      };
      let inspected;
      try {
        const accessory = commandDevice(devices.get(target.aId));
        inspected = inspectedCommandValue(accessory, target);
        const draft = await characteristicValueDraft(
          this,
          input,
          inspected,
          changes,
        );
        const name = deviceCommandName(accessory, target);
        const onTarget = lightLevelOnTarget(
          accessory,
          target,
          draft.contract.type,
        );
        const shown = {
          target_ref: command.target_ref,
          name,
          type: draft.contract.type,
          requested: draft.requested.value,
        };
        if (onTarget && isLampLevelZero(draft)) {
          // On the hub's lamps brightness 0 switches the lamp off and is not
          // stored, the level stays (2026-10-13-lamp-logic-undo, 4): the
          // command is the lamp's off, recorded and undone as one.
          const off = {
            ...input,
            target_ref: characteristicRefOf(this.hubSerial, onTarget),
            value: false,
          };
          items.push({
            index,
            command,
            input: off,
            draft: await characteristicValueDraft(
              this,
              off,
              inspectedCommandValue(accessory, onTarget),
              changes,
            ),
            name,
            onTarget: null,
            shown: {
              ...shown,
              sent_as: { target_ref: off.target_ref, type: "On", value: false },
            },
            note: LAMP_LEVEL_ZERO_NOTE,
          });
          continue;
        }
        items.push({ index, command, input, draft, name, onTarget, shown });
      } catch (error) {
        if (!isDeviceCommandRejection(error)) throw error;
        invalid.push(
          invalidDeviceCommand(index, command, error, inspected?.contract),
        );
      }
    }
    // A brightness 0 sent as a lamp's off beside the same lamp's off is
    // that off's write, reported for both (sameWriteAs); beside its on it
    // is refused.
    const byTarget = new Map();
    for (const item of items) {
      const key = nativeTargetKey(item.draft.fields.target);
      const other = byTarget.get(key);
      if (!other) {
        byTarget.set(key, item);
        continue;
      }
      if (!valuesEqual(other.draft.requested, item.draft.requested)) {
        invalid.push({
          index: item.index,
          target_ref: item.command.target_ref,
          code: "duplicate_target",
          message: `Command ${other.index} and this one set this lamp's On to different values (brightness 0 is sent as the lamp's off, On=false); send one of them.`,
        });
        continue;
      }
      const [zero, off] = item.shown.sent_as ? [item, other] : [other, item];
      zero.sameWriteAs = off;
      byTarget.set(key, off);
    }
    if (invalid.length > 0) {
      throw invalidDeviceCommands(
        invalid.sort((left, right) => left.index - right.index),
      );
    }
    // A level write switches an off lamp on, so a level sent before this
    // call's off of a lamp that is already off would light it for a moment
    // (2026-10-13-lamp-logic-undo, 1 and F9): that level is not sent.
    for (const item of items) {
      if (!item.onTarget) continue;
      const off = items.find(
        ({ draft }) =>
          nativeTargetKey(draft.fields.target) ===
          nativeTargetKey(item.onTarget),
      );
      item.lampKeptOff =
        off?.draft.requested.value === false &&
        lampOnState(devices.get(item.onTarget.aId), item.onTarget)?.value
          .value === false;
    }
    return items;
  }

  // One device's commands one after another, each sent after the hub
  // answered the one before; then one read of the device decides each
  // command sent.
  async #runDeviceCommands({ aId, items }, run) {
    const pending = [];
    let written = false;
    for (const item of items) {
      const outcome = await this.#sendDeviceCommand(item, run, written);
      written ||= outcome.sent;
      if (outcome.pending) pending.push(outcome.pending);
      else run.results[item.index] = outcome.result;
    }
    if (pending.length === 0) return;
    const readback = await this.#readCommandDevice(aId);
    run.readbacks.set(aId, readback);
    for (const { item, change, acknowledged, shown } of pending) {
      try {
        run.results[item.index] = {
          ...shown,
          ...deviceCommandOutcome(
            await this.#reconcileValueAfterWrite(
              change,
              "apply",
              acknowledged,
              async () =>
                characteristicValueState(
                  change,
                  commandCharacteristic(commandDevice(readback), change.target)
                    .control,
                ),
            ),
          ),
          ...item.earlierContext,
        };
      } catch (error) {
        run.results[item.index] = {
          ...shown,
          ...deviceCommandFailure(change, error),
          ...item.earlierContext,
        };
      }
    }
  }

  // Each lamp a level command went to, read back after its device's
  // commands. A level applied to a lamp still off is only stored, so an
  // agent must not report the lamp as lit at that level. A lamp the call
  // switched without an On command (a level above 0 with «Связь включения
  // и уровня») says so, and that switch is journaled in the call's group,
  // so undo puts it back too. The results are already final: a lamp whose
  // On was not read back gets no warning, note or journal entry.
  async #settleLamps(items, devices, { results, readbacks, ...run }) {
    const switched = new Set();
    for (const { index, onTarget, name } of items) {
      const result = results[index];
      const delivered = result.sent === true && result.status !== "rejected";
      if (!onTarget || (result.status !== "applied" && !delivered)) continue;
      const on = lampOnState(readbacks.get(onTarget.aId), onTarget);
      if (result.status === "applied" && on?.value.value === false) {
        result.warning = {
          code: "device_off_level_stored",
          message:
            "The lamp is off after this call, so this level shows once the lamp is turned on.",
        };
      }
      const before = lampOnState(devices.get(onTarget.aId), onTarget)?.value;
      if (
        !delivered ||
        on === undefined ||
        before === undefined ||
        valuesEqual(on.value, before) ||
        switched.has(serviceKey(onTarget)) ||
        items.some(
          ({ draft }) =>
            nativeTargetKey(draft.fields.target) === nativeTargetKey(onTarget),
        )
      ) {
        continue;
      }
      switched.add(serviceKey(onTarget));
      if (on.value.value === true) result.note = LAMP_SWITCHED_ON_NOTE;
      try {
        const change = await this.#recordValueChange(
          {
            operation: "characteristic_value",
            target_ref: characteristicRefOf(this.hubSerial, onTarget),
            reason: run.reason,
          },
          {
            fields: { target: onTarget },
            contract: on.contract,
            value: before,
            requested: on.value,
            extra: {},
          },
          {
            group_id: run.groupId,
            group_index: items.length + switched.size - 1,
            ...(name ? { target_name: name } : {}),
            caused_by_change_id: parseNativeChangeRef(result.change_ref),
          },
        );
        await this.#finishNative(change, "applied", on.value, {
          applied_value_observed: true,
          last_verification: freshVerification("requested_value_observed"),
        });
      } catch {
        result.local_state = {
          saved: false,
          action: "restore_state_storage_then_get_native_change",
        };
      }
    }
  }

  // Records and sends one command. The result is final unless the write
  // went out; then the read back after its device's commands decides it
  // (pending). written: an earlier command of this call went to the device.
  async #sendDeviceCommand(
    item,
    { changes, homeRef, reason, groupId },
    written,
  ) {
    const { command, input, draft, name, onTarget, index } = item;
    const shown = { ...item.shown, ...(item.note ? { note: item.note } : {}) };
    item.earlierContext = {};
    if (item.lampKeptOff) {
      return {
        sent: false,
        result: valuesEqual(draft.value, draft.requested)
          ? {
              ...shown,
              status: "already_desired",
              sent: false,
              observed_value: draft.value.value,
              change_ref: null,
              restore_supported: false,
            }
          : {
              ...shown,
              status: "not_sent",
              sent: false,
              change_ref: null,
              restore_supported: false,
              note: LAMP_KEPT_OFF_NOTE,
            },
      };
    }
    let change;
    let previous = {};
    try {
      // A failure here still yields this item's result, so the results of
      // commands already sent in this call are never lost.
      const earlier =
        command.resend_unconfirmed === true
          ? null
          : await this.#uncertainEarlierCommand(changes, draft);
      if (earlier?.held) {
        return {
          sent: false,
          result: {
            ...shown,
            status: "uncertain",
            sent: false,
            ...(earlier.current
              ? { observed_value: earlier.current.value }
              : {}),
            change_ref: earlier.result.change_ref,
            restore_supported: earlier.result.restore_supported === true,
            reason: "earlier_command_unresolved",
            next: resendDeviceCommandNext(homeRef, command, reason),
          },
        };
      }
      if (earlier) {
        item.earlierContext = {
          earlier_command: {
            change_ref: earlier.result.change_ref,
            status: earlier.result.status,
            ...(earlier.result.conflict_reason
              ? { conflict_reason: earlier.result.conflict_reason }
              : {}),
          },
        };
      }
      // No preview was shown for this call, so a link or scenario that
      // changed this value since the call read the device is not a
      // conflict: the command is decided by that read, which is also the
      // change's baseline. Once an earlier command of this call went to the
      // device, a known setting (whose equal value is not resent) is decided
      // by a read right before its write; its baseline stays the value
      // before the call: what the call changed there is the agent's.
      const current =
        written && !draft.alwaysSend
          ? await prepareCharacteristicValue(this, input)
          : draft;
      if (nativeValueAlreadyDesired(current)) {
        return {
          sent: false,
          result: {
            ...shown,
            status: "already_desired",
            sent: false,
            observed_value: current.value.value,
            change_ref: null,
            restore_supported: false,
          },
        };
      }
      previous = { previous_value: draft.value.value };
      change = await this.#recordValueChange({ ...input, reason }, draft, {
        group_id: groupId,
        group_index: index,
        ...(onTarget ? { lamp_level: true } : {}),
        ...(name ? { target_name: name } : {}),
      });
      const acknowledged = await this.#writeRecordedValue(change, draft.value);
      return {
        sent: true,
        pending: {
          item,
          change,
          acknowledged,
          shown: { ...shown, ...previous },
        },
      };
    } catch (error) {
      return {
        sent: change?.native_write_sent === true,
        result: {
          ...shown,
          ...previous,
          ...deviceCommandFailure(change, error),
          ...item.earlierContext,
        },
      };
    }
  }

  // A repeated command is a new intent, but it must not blindly resend a
  // value whose earlier send to the same characteristic is still unknown:
  // that earlier change is reconciled by readback first, as get_native_change
  // does. Only a send the hub never acknowledged may still be on its way, so
  // only that one holds a new send of the same value until the agent asks to
  // resend it. An acknowledged send the device did not carry out is a device
  // problem: the new request is sent and the earlier change is reported.
  async #uncertainEarlierCommand(changes, draft) {
    const earlier = latestSentValueCommand(
      changes,
      configuredHomeRef(this.hubSerial),
      draft.fields.target,
    );
    if (
      !earlier ||
      nativeValueLifecycle(earlier).phase !== "unresolved_intent"
    ) {
      return null;
    }
    const pending = await this.#reconcilePendingValueChange(earlier);
    if (!pending || earlier.status !== "uncertain") return null;
    const sentValue =
      pending.direction === "restore"
        ? earlier.baseline_value
        : earlier.requested_value;
    if (!valuesEqual(sentValue, draft.requested)) return null;
    return {
      held: earlier.native_acknowledged !== true,
      current: pending.current,
      result: pending.result,
    };
  }

  // readState is a read the caller made right before this apply; it is used
  // instead of a second read only for a change recorded from that same read.
  async #applyValueChange(change, readState) {
    const lifecycle = nativeValueLifecycle(change);
    if (lifecycle.phase === "restore_completed") {
      return publicStoredNativeChange(change);
    }
    let currentState = readState;
    if (lifecycle.phase === "unresolved_intent") {
      const pending = await this.#reconcilePendingValueChange(change, {
        requireWrite: true,
      });
      if (pending) {
        const retryableApply =
          pending.direction === "apply" &&
          pending.outcome === "expected_missing" &&
          isRetryableNativeValueChange(change) &&
          valuesEqual(pending.current, change.baseline_value);
        if (!retryableApply) return pending.result;
        currentState = { value: pending.current, contract: pending.contract };
      }
    }
    const phase = nativeValueLifecycle(change).phase;
    if (phase === "right_lost" || phase === "apply_proven") {
      const current =
        currentState?.value ?? (await this.#readNativeValue(change));
      const provenOwnershipLoss = await this.#finishObservedValueOwnershipLoss(
        change,
        current,
      );
      if (provenOwnershipLoss) return provenOwnershipLoss;
      const provenSentWithoutOwnership =
        await this.#finishSentValueOwnershipLoss(change, current);
      if (provenSentWithoutOwnership) return provenSentWithoutOwnership;
      if (phase === "right_lost") return publicStoredNativeChange(change);
      return this.#observeProvenNativeValue(change, current);
    }
    nativeValueKind(change.kind).recheck?.(change);
    const { value: current, contract } =
      currentState ??
      (await this.#readNativeValueState(change, {
        requireWrite: true,
      }));
    const ownershipLoss = await this.#finishObservedValueOwnershipLoss(
      change,
      current,
    );
    if (ownershipLoss) return ownershipLoss;
    const sentWithoutOwnership = await this.#finishSentValueOwnershipLoss(
      change,
      current,
    );
    if (sentWithoutOwnership) return sentWithoutOwnership;
    validateCharacteristicValue(change.requested_value.value, contract);
    if (!valuesEqual(current, change.baseline_value)) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "baseline_changed",
        last_verification: freshVerification("conflict"),
      });
    }
    const ownerConflict = await this.#finishValueOwnerConflict(change, current);
    if (ownerConflict) return ownerConflict;

    const acknowledged = await this.#writeRecordedValue(change, current);
    return this.#reconcileValueAfterWrite(change, "apply", acknowledged);
  }

  // The apply write of a change that holds its right: its intent saved
  // first, then the write. A refusal by the hub ends the change not_applied
  // with current as observed and is thrown; true when the hub acknowledged
  // the write, false when its outcome is left to the read back.
  async #writeRecordedValue(change, current) {
    await this.#beforeNativeValueWrite(change);
    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      await this.#writeNativeValue(change, change.requested_value);
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(
          change,
          "not_applied",
          error,
          current,
        );
      }
      return false;
    }
    change.native_acknowledged = true;
    change.write_intent.acknowledged = true;
    return true;
  }

  // read, when given, is the read back instead of the change's own read.
  async #reconcileValueAfterWrite(
    change,
    direction,
    acknowledged = false,
    read = undefined,
  ) {
    const pending = await this.#reconcilePendingValueChange(change, {
      acknowledged,
      read,
    });
    if (!pending || pending.direction !== direction) {
      throw new Error("Native write intent changed before readback.");
    }
    return pending.result;
  }

  async #reconcilePendingValueChange(
    change,
    { requireWrite = false, acknowledged = false, read } = {},
  ) {
    if (!nativeValueIntentEvidence(change).unresolved) {
      return undefined;
    }
    const direction = nativeIntentDirection(change);
    let ownerConflict;
    let state;
    let groupMemberObservations;
    try {
      // The owner check reads the hub too: after a write, its failure leaves
      // the outcome unknown, as the value read's does.
      ownerConflict = await this.#finishValueOwnerConflict(
        change,
        change.observed_value,
      );
      if (!ownerConflict) {
        state = read
          ? await read()
          : await this.#readNativeValueState(change, { requireWrite });
        if (
          direction === "apply" &&
          change.group_member_targets &&
          valuesEqual(state.value, change.requested_value)
        ) {
          groupMemberObservations = await this.#readVirtualGroupMembers(change);
        }
      }
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        error.code === "sensitive_native_data"
      ) {
        throw error;
      }
      return this.#finishUnread(change, error);
    }
    if (ownerConflict) {
      return {
        direction,
        outcome: "owner_binding_lost",
        result: ownerConflict,
      };
    }
    const { value: current, contract } = state;
    const ownershipLoss = await this.#finishObservedValueOwnershipLoss(
      change,
      current,
    );
    if (ownershipLoss) {
      return {
        direction,
        outcome: valuesEqual(current, change.baseline_value)
          ? "baseline_observed_after_ownership_loss"
          : "ownership_lost",
        current,
        contract,
        result: ownershipLoss,
      };
    }
    const expected =
      direction === "restore" ? change.baseline_value : change.requested_value;
    const groupDeliveryConfirmed = groupMemberObservations
      ? groupMemberObservations.every(({ value }) =>
          groupValuesEqual(value, change.requested_value),
        )
      : undefined;
    if (valuesEqual(current, expected) && groupDeliveryConfirmed !== false) {
      const completedStatus = direction === "restore" ? "restored" : "applied";
      const verificationResult =
        direction === "restore"
          ? "baseline_value_observed"
          : "requested_value_observed";
      return {
        direction,
        outcome: "expected_observed",
        current,
        contract,
        result: await this.#finishNative(change, completedStatus, current, {
          ...(direction === "apply" ? { applied_value_observed: true } : {}),
          ...(groupMemberObservations
            ? {
                group_member_observations: groupMemberObservations,
                group_delivery_confirmed: true,
              }
            : {}),
          last_verification: freshVerification(verificationResult),
          ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
        }),
      };
    }
    if (
      !valuesEqual(current, change.baseline_value) &&
      !valuesEqual(current, change.requested_value)
    ) {
      // A value the agent's own later change of this setting set is no
      // change by hand, as for a settled change (laterOwnedValueChange).
      const later = await this.#laterOwnedValueChange(change, current);
      if (later) {
        return {
          direction,
          outcome: "later_owned_change",
          current,
          contract,
          result: await this.#finishHiddenByLaterChange(change, later, current),
        };
      }
      if (hasKnownSettingSemantics(change)) {
        return {
          direction,
          outcome: "conflict",
          current,
          contract,
          result: await this.#finishNative(change, "conflict", current, {
            conflict_reason: "manual_change",
            manual_change_observed: true,
            last_verification: freshVerification("conflict"),
          }),
        };
      }
    }
    const verificationResult =
      direction === "restore"
        ? "baseline_value_missing"
        : "requested_value_missing";
    // expected_missing: the read still shows what the write would replace
    // (restoreGoesOn); anything else is left unexplained.
    const unchanged =
      direction === "restore" ? change.requested_value : change.baseline_value;
    const outcome = valuesEqual(current, unchanged)
      ? "expected_missing"
      : "unexplained";
    const result = await this.#finishNative(change, "uncertain", current, {
      ...(groupMemberObservations
        ? {
            group_member_observations: groupMemberObservations,
            group_delivery_confirmed: false,
          }
        : {}),
      last_verification: freshVerification(verificationResult),
      ...withoutLaterChange(change),
      ...(groupDeliveryConfirmed === false
        ? { conflict_reason: "group_members_not_converged" }
        : acknowledged
          ? {
              conflict_reason:
                direction === "restore"
                  ? "ack_without_baseline_result"
                  : "ack_without_requested_result",
            }
          : {}),
    });
    const restoreAgain =
      direction === "restore" &&
      valueRestoreGoesOn(change, { direction, outcome });
    return {
      direction,
      outcome,
      current,
      contract,
      result: restoreAgain ? withRestoreAgainNext(result, change) : result,
    };
  }

  async #readVirtualGroupMembers(change) {
    return Promise.all(
      change.group_member_targets.map(
        async ({ member_ref: memberRef, target }) => {
          const characteristic = await this.client.getCharacteristic(target);
          return {
            member_ref: memberRef,
            characteristic_ref: `${memberRef}/characteristic/${target.cId}`,
            value: typedNativeValue(characteristic.control.value),
          };
        },
      ),
    );
  }

  async getNativeChange(changeReference) {
    const { type, id } = parseInspectedChangeRef(changeReference);
    if (type === "automation") return this.#getAutomationChange(id);
    const change = await this.#requireNativeChange(id);
    if (change.kind === "accessory_placement") {
      return this.#getAccessoryPlacement(change);
    }
    if (change.kind === "room_create") {
      return this.#getRoomCreate(change);
    }
    if (change.kind === "virtual_light_group") {
      return this.#getVirtualLightGroup(change);
    }
    if (change.kind === "logic_assignment") {
      return this.#getLogicAssignment(change);
    }
    if (change.kind === "scenario_run") {
      return this.#getScenarioRun(change);
    }
    if (isLogicSourceChange(change)) {
      return this.#getScenarioChange(change);
    }
    if (change.kind === "block_action_pause") {
      return this.#getBlockActionPause(change);
    }
    if (!isNativeValueChange(change)) {
      return this.#getScenarioChange(change);
    }
    const lifecycle = nativeValueLifecycle(change);
    if (lifecycle.phase === "unresolved_intent") {
      const pending = await this.#reconcilePendingValueChange(change);
      if (pending) return pending.result;
    }
    let current;
    try {
      current = await this.#readNativeValue(change);
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        error.code === "sensitive_native_data"
      ) {
        throw error;
      }
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    const phase = nativeValueLifecycle(change).phase;
    if (phase === "restore_completed") {
      return this.#recordNativeObservation(
        change,
        current,
        valuesEqual(current, change.baseline_value)
          ? "baseline_value_observed"
          : valuesEqual(current, change.requested_value)
            ? "requested_value_observed"
            : "current_value_observed",
      );
    }
    const ownershipLoss = await this.#finishObservedValueOwnershipLoss(
      change,
      current,
    );
    if (ownershipLoss) return ownershipLoss;
    const sentWithoutOwnership = await this.#finishSentValueOwnershipLoss(
      change,
      current,
    );
    if (sentWithoutOwnership) return sentWithoutOwnership;
    if (phase === "apply_proven" || nativeValueProvenApply(change)) {
      return this.#observeProvenNativeValue(change, current);
    }
    return this.#recordNativeObservation(
      change,
      current,
      valuesEqual(current, change.requested_value)
        ? "requested_value_observed"
        : "current_value_observed",
    );
  }

  // One native change keeps its full record as the answer; a group ref is
  // undone as a group; an earlier boolean automation is rolled back.
  async restoreNativeChange(changeReference) {
    const { type, id } = parseRestoreRef(changeReference);
    if (type === "automation") {
      return this.#exclusiveWrite(async () =>
        this.#rollbackAutomation(await this.#requireAutomationChange(id)),
      );
    }
    if (type === "group") return this.restoreChanges([changeReference]);
    return this.#exclusiveWrite(async () =>
      this.#restoreNative(await this.#requireNativeChange(id)),
    );
  }

  // «Верни как было»: the agent's own changes of one request, undone
  // newest first so a later change of the same target goes before the one
  // it built on. Each item is decided by the home right before its own
  // write and answers for itself; nothing is undone as all-or-nothing.
  async restoreChanges(references) {
    const parsed = references.map(parseRestoreRef);
    return this.#exclusiveWrite(async () => {
      const ordered = (await this.#restoreEntries(parsed)).sort((left, right) =>
        compareApplication(right.change, left.change),
      );
      const results = [];
      for (const entry of ordered) {
        results.push(await this.#restoreEntry(entry));
      }
      return restoreChangesResult(configuredHomeRef(this.hubSerial), results);
    });
  }

  async #restoreEntries(parsed) {
    const entries = new Map();
    let stored;
    for (const { type, id } of parsed) {
      if (type === "group") {
        stored ??= await this.store.list();
        const members = stored.filter(
          (change) => change.group_id === id && isNativeChange(change),
        );
        if (members.length === 0) {
          throw new SprutHubError(
            "change_not_found",
            "No change of this group was found for this configured hub.",
            "get_native_change",
          );
        }
        for (const member of members) {
          if (member.home_ref !== configuredHomeRef(this.hubSerial)) {
            throw unsupportedHomeWrite();
          }
          entries.set(member.id, { change: member, automation: false });
        }
      } else if (type === "automation") {
        entries.set(id, {
          change: await this.#requireAutomationChange(id),
          automation: true,
        });
      } else {
        entries.set(id, {
          change: await this.#requireNativeChange(id),
          automation: false,
        });
      }
    }
    if (entries.size > RESTORE_BATCH_LIMIT) {
      throw new SprutHubError(
        "too_many_changes",
        `One restore takes at most ${RESTORE_BATCH_LIMIT} changes. Restore the newest ones first, then the rest in another call.`,
        "get_native_change",
      );
    }
    return [...entries.values()];
  }

  async #restoreEntry({ change: listed, automation }) {
    let change;
    try {
      // Read again: restoring an earlier item may have updated this record.
      change = automation
        ? await this.#requireAutomationChange(listed.id)
        : await this.#requireNativeChange(listed.id);
    } catch (error) {
      return restoreFailureItem(listed, automation, error);
    }
    const before = {
      status: change.status,
      restoreIntentAt: restoreIntentTime(change),
    };
    try {
      const result = automation
        ? await this.#rollbackAutomation(change)
        : await this.#restoreNative(change);
      return restoreItem(change, automation, result, before);
    } catch (error) {
      return restoreFailureItem(change, automation, error);
    }
  }

  async #restoreNative(change) {
    if (change.kind === "accessory_placement") {
      return this.#restoreAccessoryPlacement(change);
    }
    if (change.kind === "room_create") {
      return this.#restoreRoomCreate(change);
    }
    if (change.kind === "virtual_light_group") {
      return this.#restoreVirtualLightGroup(change);
    }
    const valueKind = nativeValueKind(change.kind);
    if (valueKind) {
      // A command's restorability follows only its saved type and baseline.
      const restoration = nativeValueRestoration(change);
      if (valueKind.command && !restoration.supported) {
        throw new SprutHubError(
          "restore_unsupported",
          restoration.limitation?.message ??
            "This characteristic is not a supported restorable setting.",
          "get_native_change",
        );
      }
      return this.#undoOrUnknown(change, () =>
        this.#restoreValueChange(change),
      );
    }
    if (change.kind === "logic_assignment") {
      return this.#restoreLogicAssignment(change);
    }
    if (change.kind === "scenario_run") {
      throw new SprutHubError(
        "restore_unsupported",
        "A scenario run is a physical command; restoring its journal entry cannot undo that effect.",
        "get_native_change",
      );
    }
    return this.#undoOrUnknown(change, () =>
      change.kind === "block_action_pause"
        ? this.#restoreBlockActionPause(change)
        : this.#restoreScenarioChange(change),
    );
  }

  // The one rule for a read that fails in an undo of a setting or a
  // scenario change (PLAN.md, «Неудачное чтение не ведёт ни к записи, ни к
  // окончательному выводу»): nothing is written and nothing concluded, the
  // undo's outcome is unknown, and next is the undo again, which reads
  // first. Every read the undo depends on ends here when it fails: a read
  // before its write throws (the later changes it settles pass their
  // failed check on as that error), and a check of an unknown write of its
  // own leaves the change uncertain with the failure as its last
  // verification.
  async #undoOrUnknown(change, undo) {
    try {
      const result = await undo();
      return result.status === "uncertain" &&
        result.verification?.fresh === false
        ? withRestoreAgainNext(result, change)
        : result;
    } catch (error) {
      if (!isUnreadError(error)) throw error;
      return withRestoreAgainNext(
        {
          ...publicNativeChange(change, undefined, {
            verification: failedVerification(error),
          }),
          restore_outcome: {
            status: "uncertain",
            reason: "read_failed",
            message:
              "A read this undo depends on failed, so nothing was written and nothing is concluded. Restore it again: it reads first.",
          },
        },
        change,
      );
    }
  }

  async #applyAccessoryPlacement(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    let current;
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      if (nativeIntentDirection(change) === "restore") {
        return (await this.#reconcileAccessoryRestore(change, false)).result;
      }
      const pending = await this.#reconcileAccessoryApply(change, false);
      const retryableApply =
        pending.outcome === "expected_missing" &&
        accessoryPlacementMatches(pending.current, change.baseline_snapshot);
      if (!retryableApply) return pending.result;
      current = pending.current;
    }
    current ??= await this.#observeAccessoryPlacement(change);
    if (placementOwnedSinceApply(change)) {
      return this.#observeAppliedPlacement(change, current);
    }
    if (!accessoryPlacementMatches(current, change.baseline_snapshot)) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "baseline_changed",
        last_verification: freshVerification("conflict"),
      });
    }
    const destination = await this.client.getRoom(
      change.requested_snapshot.room_id,
    );
    if (!destination) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "destination_room_missing",
        last_verification: freshVerification("conflict"),
      });
    }
    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      await this.client.updateAccessory({
        id: change.target.id,
        name: change.requested_snapshot.name,
        roomId: change.requested_snapshot.room_id,
      });
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(
          change,
          "not_applied",
          error,
          undefined,
          { observed_snapshot: current },
        );
      }
      return (await this.#reconcileAccessoryApply(change, false)).result;
    }
    return (await this.#reconcileAccessoryApply(change, true)).result;
  }

  async #reconcileAccessoryApply(change, acknowledged) {
    let current;
    try {
      current = await this.#observeAccessoryPlacement(change);
    } catch (error) {
      return this.#finishAccessoryReconciliation(
        change,
        "read_failed",
        undefined,
        "uncertain",
        {
          configuration_matches: undefined,
          last_verification: failedVerification(error),
        },
      );
    }
    if (change.applied_snapshot !== undefined) {
      if (accessoryPlacementMatches(current, change.applied_snapshot)) {
        return this.#finishAccessoryReconciliation(
          change,
          "expected_observed",
          current,
          "applied",
          {
            observed_snapshot: current,
            last_verification: freshVerification("applied_snapshot_observed"),
            ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
          },
        );
      }
      return this.#finishAccessoryReconciliation(
        change,
        "conflict",
        current,
        "conflict",
        {
          observed_snapshot: current,
          conflict_reason: "manual_change",
          last_verification: freshVerification("conflict"),
        },
      );
    }
    if (!isDeepStrictEqual(current.binding, change.baseline_snapshot.binding)) {
      return this.#finishAccessoryReconciliation(
        change,
        "conflict",
        current,
        "conflict",
        {
          observed_snapshot: current,
          conflict_reason: "binding_changed",
          last_verification: freshVerification("conflict"),
        },
      );
    }
    const requestedExactly = accessoryPlacementMatches(
      current,
      change.requested_snapshot,
    );
    const requestedRoomObserved =
      current.room_id === change.requested_snapshot.room_id;
    if (acknowledged && requestedRoomObserved) {
      change.applied_snapshot = structuredClone(current);
      return this.#finishAccessoryReconciliation(
        change,
        "expected_observed",
        current,
        "applied",
        {
          observed_snapshot: current,
          applied_snapshot: structuredClone(current),
          last_verification: freshVerification("requested_room_observed"),
        },
      );
    }
    if (requestedExactly) {
      change.applied_snapshot = structuredClone(current);
      return this.#finishAccessoryReconciliation(
        change,
        "expected_observed",
        current,
        "applied",
        {
          observed_snapshot: current,
          applied_snapshot: structuredClone(current),
          recovered_after_uncertain_write: true,
          last_verification: freshVerification("requested_values_observed"),
        },
      );
    }
    const possibleNormalization =
      requestedRoomObserved &&
      !accessoryPlacementMatches(current, change.baseline_snapshot);
    return this.#finishAccessoryReconciliation(
      change,
      "expected_missing",
      current,
      "uncertain",
      {
        observed_snapshot: current,
        configuration_matches: undefined,
        conflict_reason: possibleNormalization
          ? "possible_name_normalization_after_lost_response"
          : undefined,
        last_verification: freshVerification(
          possibleNormalization
            ? "requested_room_observed_name_unknown"
            : "requested_values_missing",
        ),
      },
    );
  }

  async #getAccessoryPlacement(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      const pending =
        nativeIntentDirection(change) === "restore"
          ? await this.#reconcileAccessoryRestore(change, false)
          : await this.#reconcileAccessoryApply(change, false);
      return pending.result;
    }
    let current;
    try {
      current = await this.#observeAccessoryPlacement(change);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    if (placementOwnedSinceApply(change)) {
      return this.#observeAppliedPlacement(change, current);
    }
    return this.#finishNative(change, change.status, undefined, {
      observed_snapshot: current,
      last_verification: freshVerification("current_configuration_observed"),
    });
  }

  // An applied placement, or one held by the agent's own later move: the
  // applied snapshot seen again makes it applied, a later move of the
  // agent names that move, anything else is a manual change.
  async #observeAppliedPlacement(change, current) {
    if (accessoryPlacementMatches(current, change.applied_snapshot)) {
      return this.#finishNative(change, "applied", undefined, {
        observed_snapshot: current,
        last_verification: freshVerification("applied_snapshot_observed"),
      });
    }
    const later = await this.#laterOwnedPlacement(change, current);
    if (later) return this.#finishLaterOwnedPlacement(change, later, current);
    return this.#finishNative(change, "conflict", undefined, {
      observed_snapshot: current,
      conflict_reason: "manual_change",
      last_verification: freshVerification("conflict"),
    });
  }

  // The agent's own later move or rename of the same accessory that left
  // it as it is now.
  async #laterOwnedPlacement(change, current) {
    let latest;
    for (const candidate of await this.store.list()) {
      if (
        candidate.id === change.id ||
        candidate.kind !== "accessory_placement" ||
        candidate.home_ref !== change.home_ref ||
        candidate.target?.id !== change.target.id ||
        !changeStillInEffect(candidate) ||
        candidate.applied_snapshot === undefined ||
        compareApplication(candidate, change) <= 0 ||
        !accessoryPlacementMatches(current, candidate.applied_snapshot)
      ) {
        continue;
      }
      if (!latest || compareApplication(candidate, latest) > 0) {
        latest = candidate;
      }
    }
    return latest;
  }

  async #finishLaterOwnedPlacement(change, later, current) {
    return this.#finishNative(change, "conflict", undefined, {
      observed_snapshot: current,
      conflict_reason: "later_owned_change",
      restore_first_change_id: later.id,
      last_verification: freshVerification("conflict"),
    });
  }

  async #restoreAccessoryPlacement(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    let current;
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      const direction = nativeIntentDirection(change);
      const pending =
        direction === "restore"
          ? await this.#reconcileAccessoryRestore(change, false)
          : await this.#reconcileAccessoryApply(change, false);
      if (!restoreGoesOn({ direction, outcome: pending.outcome })) {
        return pending.result;
      }
      current = pending.current;
    }
    if (change.applied_snapshot === undefined) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "change_was_not_applied",
        last_verification: savedVerification(change.last_verification),
      });
    }
    current ??= await this.#observeAccessoryPlacement(change);
    const later = await this.#laterOwnedPlacement(change, current);
    if (later) return this.#finishLaterOwnedPlacement(change, later, current);
    if (accessoryPlacementMatches(current, change.baseline_snapshot)) {
      return this.#finishNative(change, "restored", undefined, {
        observed_snapshot: current,
        last_verification: freshVerification("baseline_snapshot_observed"),
      });
    }
    if (!accessoryPlacementMatches(current, change.applied_snapshot)) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
    }
    const baselineRoom = await this.client.getRoom(
      change.baseline_snapshot.room_id,
    );
    if (!baselineRoom) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "baseline_room_missing",
        last_verification: freshVerification("conflict"),
      });
    }
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      await this.client.updateAccessory({
        id: change.target.id,
        name: change.baseline_snapshot.name,
        roomId: change.baseline_snapshot.room_id,
      });
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(
          change,
          "applied",
          error,
          undefined,
          { observed_snapshot: current },
        );
      }
      return (await this.#reconcileAccessoryRestore(change, false)).result;
    }
    return (await this.#reconcileAccessoryRestore(change, true)).result;
  }

  async #reconcileAccessoryRestore(change, acknowledged) {
    let current;
    try {
      current = await this.#observeAccessoryPlacement(change);
    } catch (error) {
      return this.#finishAccessoryReconciliation(
        change,
        "read_failed",
        undefined,
        "uncertain",
        {
          configuration_matches: undefined,
          last_verification: failedVerification(error),
        },
      );
    }
    if (accessoryPlacementMatches(current, change.baseline_snapshot)) {
      return this.#finishAccessoryReconciliation(
        change,
        "expected_observed",
        current,
        "restored",
        {
          observed_snapshot: current,
          last_verification: freshVerification("baseline_snapshot_observed"),
          ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
        },
      );
    }
    if (accessoryPlacementMatches(current, change.applied_snapshot)) {
      return this.#finishAccessoryReconciliation(
        change,
        "expected_missing",
        current,
        "uncertain",
        {
          observed_snapshot: current,
          configuration_matches: undefined,
          conflict_reason: acknowledged
            ? "ack_without_baseline_result"
            : undefined,
          last_verification: freshVerification("baseline_snapshot_missing"),
        },
      );
    }
    const possibleNormalization =
      current.room_id === change.baseline_snapshot.room_id &&
      isDeepStrictEqual(current.binding, change.baseline_snapshot.binding);
    if (possibleNormalization) {
      return this.#finishAccessoryReconciliation(
        change,
        "possible_normalization",
        current,
        "uncertain",
        {
          observed_snapshot: current,
          configuration_matches: undefined,
          conflict_reason: "possible_name_normalization_after_restore",
          last_verification: freshVerification(
            "baseline_room_observed_name_unknown",
          ),
        },
      );
    }
    return this.#finishAccessoryReconciliation(
      change,
      "conflict",
      current,
      "conflict",
      {
        observed_snapshot: current,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      },
    );
  }

  async #finishAccessoryReconciliation(
    change,
    outcome,
    current,
    status,
    extra,
  ) {
    return {
      outcome,
      ...(current === undefined ? {} : { current }),
      result: await this.#finishNative(change, status, undefined, extra),
    };
  }

  async #observeAccessoryPlacement(change) {
    const accessory = await this.client.getAccessory(change.target.id);
    const room = await this.client.getRoom(accessory.roomId);
    return accessoryPlacementSnapshot(accessory, room);
  }

  async #applyRoomCreate(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.created_room_id !== undefined) {
      return this.#observeOwnedRoom(change);
    }
    if (roomCreationOutcomeUnknown(change)) {
      return this.#recordUnownedRoomCandidates(change);
    }
    // A change prepared by an earlier version may carry a name the hub
    // would not keep.
    roomNameWithinLimit(change.requested_name);
    const candidates = await this.#matchingRooms(change);
    if (candidates.length > 0) {
      return this.#finishNative(change, "conflict", undefined, {
        candidate_rooms: candidates,
        conflict_reason: "matching_room_appeared",
        last_verification: freshVerification("baseline_absent_missing"),
      });
    }
    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      const room = await this.client.createRoom(change.requested_name);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
      change.created_room_id = room.id;
      change.applied_snapshot = roomSnapshot(room);
      change.room_creation_owned = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, "not_applied", error);
      }
      return this.#recordUnownedRoomCandidates(change);
    }
    return this.#observeOwnedRoom(change);
  }

  async #getRoomCreate(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.created_room_id !== undefined) {
      return this.#observeOwnedRoom(change);
    }
    if (roomCreationOutcomeUnknown(change)) {
      return this.#recordUnownedRoomCandidates(change);
    }
    const candidates = await this.#matchingRooms(change);
    if (candidates.length > 0) {
      return this.#finishNative(change, "conflict", undefined, {
        candidate_rooms: candidates,
        conflict_reason: "matching_room_appeared",
        last_verification: freshVerification("baseline_absent_missing"),
      });
    }
    return this.#finishNative(change, change.status, undefined, {
      candidate_rooms: [],
      last_verification: freshVerification("baseline_absent"),
    });
  }

  async #observeOwnedRoom(change) {
    let room;
    try {
      room = await this.client.getRoom(change.created_room_id);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    if (room === null) {
      if (
        ["restoring", "uncertain"].includes(change.status) &&
        nativeIntentDirection(change) === "restore"
      ) {
        return this.#finishNative(change, "restored", undefined, {
          last_verification: freshVerification("created_room_absent"),
        });
      }
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "created_room_missing",
        last_verification: freshVerification("created_room_missing"),
      });
    }
    const snapshot = roomSnapshot(room);
    if (!isDeepStrictEqual(snapshot, change.applied_snapshot)) {
      return this.#finishChangedRoom(change, snapshot);
    }
    return this.#finishNative(change, "applied", undefined, {
      observed_room: snapshot,
      last_verification: freshVerification("created_room_observed"),
    });
  }

  async #finishChangedRoom(change, snapshot) {
    const rename = await this.#appliedRoomRename(change, snapshot);
    return this.#finishNative(change, "conflict", undefined, {
      observed_room: snapshot,
      conflict_reason: rename ? "later_owned_change" : "manual_change",
      restore_first_change_id: rename?.id,
      last_verification: freshVerification("conflict"),
    });
  }

  // The agent's own later room_name change explains a new name of the
  // created room; restoring it first lets this change delete the room.
  async #appliedRoomRename(change, snapshot) {
    const { name, ...rest } = snapshot;
    const { name: _createdName, ...created } = change.applied_snapshot;
    if (!isDeepStrictEqual(rest, created)) return undefined;
    return (await this.store.list()).find(
      (candidate) =>
        candidate.kind === "room_name" &&
        candidate.home_ref === change.home_ref &&
        candidate.target?.id === change.created_room_id &&
        candidate.status === "applied" &&
        candidate.requested_value?.value === name,
    );
  }

  async #recordUnownedRoomCandidates(change) {
    let candidates;
    try {
      candidates = await this.#newMatchingRooms(change);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        room_creation_owned: false,
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      candidate_rooms: candidates,
      room_creation_owned: false,
      configuration_matches: undefined,
      conflict_reason: "room_creation_outcome_unknown",
      last_verification: freshVerification(
        candidates.length > 0
          ? "unowned_matching_room_observed"
          : "matching_room_missing",
      ),
    });
  }

  async #restoreRoomCreate(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (
      change.room_creation_owned !== true ||
      change.created_room_id === undefined ||
      change.applied_snapshot === undefined
    ) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "room_creation_not_confirmed",
        last_verification: savedVerification(change.last_verification),
      });
    }
    let room = await this.client.getRoom(change.created_room_id);
    if (room === null) {
      return this.#finishNative(change, "restored", undefined, {
        last_verification: freshVerification("created_room_absent"),
      });
    }
    const snapshot = roomSnapshot(room);
    if (!isDeepStrictEqual(snapshot, change.applied_snapshot)) {
      return this.#finishChangedRoom(change, snapshot);
    }
    const contents = await this.client.listAccessoriesInRoom(
      change.created_room_id,
    );
    if (contents.length > 0) {
      // An accessory the agent itself moved here names that move, which is
      // undone first.
      const placements = (await this.store.list()).filter(
        (candidate) =>
          candidate.kind === "accessory_placement" &&
          candidate.home_ref === change.home_ref &&
          candidate.requested_snapshot?.room_id === change.created_room_id &&
          changeStillInEffect(candidate),
      );
      return this.#finishNative(change, "conflict", undefined, {
        observed_room: snapshot,
        room_contents: contents.map(({ id, name }) => {
          const moved = placements.find(
            (candidate) => candidate.target?.id === id,
          );
          return {
            ref: `${change.home_ref}/accessory/${id}`,
            name,
            ...(moved
              ? { change_ref: `spruthub-change://native/${moved.id}` }
              : {}),
          };
        }),
        conflict_reason: "room_not_empty",
        last_verification: freshVerification("room_not_empty"),
      });
    }
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      await this.client.deleteRoom(change.created_room_id);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(
          change,
          "applied",
          error,
          undefined,
          { observed_room: snapshot },
        );
      }
    }
    try {
      room = await this.client.getRoom(change.created_room_id);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    if (room === null) {
      return this.#finishNative(change, "restored", undefined, {
        last_verification: freshVerification("created_room_absent"),
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      observed_room: roomSnapshot(room),
      conflict_reason: change.native_acknowledged
        ? "ack_without_room_deletion"
        : undefined,
      last_verification: freshVerification("created_room_still_present"),
    });
  }

  async #newMatchingRooms(change) {
    const baseline = new Set(change.baseline_room_ids);
    return (await this.#matchingRooms(change)).filter(
      (room) => !baseline.has(room.id),
    );
  }

  async #matchingRooms(change) {
    return (await this.#listRoomRecords()).filter(
      (room) => room.name === change.requested_name,
    );
  }

  async #listRoomRecords() {
    const result = await this.client.listRooms();
    return result.rooms.map((room) => ({
      id: parseRoomRef(room.ref, this.hubSerial),
      name: room.name,
    }));
  }

  async #applyVirtualLightGroup(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.created_accessory_id === undefined) {
      if (change.progress.creation.sent) {
        return this.#recordUnownedVirtualLightCandidates(change);
      }
      const candidates = await this.#matchingVirtualLightCandidates(change);
      if (candidates.length > 0) {
        return this.#finishNative(change, "conflict", undefined, {
          candidate_accessories: candidates,
          conflict_reason: "matching_virtual_accessory_appeared",
          last_verification: freshVerification("baseline_absent_missing"),
        });
      }
      refuseRedactedChangeTexts(change);
      await this.#validateVirtualLightPreparation(change);
      await this.#validatePhysicalLinkBaselines(change);
      await this.#persistVirtualLightStep(change, "creating_accessory");
      change.progress.creation.sent = true;
      await this.#saveBeforeWrite(change);
      let created;
      try {
        created = await this.client.createAccessory(change.create_request);
        change.progress.creation.acknowledged = true;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          change.progress.creation.sent = false;
          throw await this.#finishRefusedGroupStep(change, "apply", error);
        }
        return this.#recordUnownedVirtualLightCandidates(change);
      }
      change.created_accessory_id = created.id;
      change.virtual_accessory_creation_owned = true;
      await this.#saveBeforeWrite(change);
    }

    if (!change.virtual_target) {
      let created;
      try {
        created = await this.client.getAccessory(change.created_accessory_id);
      } catch (error) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: "created_accessory_readback_failed",
          last_verification: failedVerification(error),
        });
      }
      let selected;
      try {
        selected = selectCreatedVirtualLight(created, change);
      } catch {
        return this.#finishNative(change, "conflict", undefined, {
          observed_snapshot: {
            accessory: virtualAccessoryStructure(created),
          },
          conflict_reason: "incompatible_created_accessory",
          configuration_matches: false,
          last_verification: freshVerification(
            "created_accessory_incompatible",
          ),
        });
      }
      change.virtual_target = selected.target;
      change.created_accessory_snapshot = virtualAccessoryStructure(created);
      change.created_link_settings = virtualLightSettingsSnapshot(
        created,
        selected.target,
        change.characteristic_types,
      );
      await this.#saveBeforeWrite(change);
    }

    const current = await this.#observeVirtualLightGroup(change);
    if (current.absent) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "created_virtual_accessory_missing",
        last_verification: freshVerification("created_accessory_missing"),
      });
    }
    if (
      !isDeepStrictEqual(current.accessory, change.created_accessory_snapshot)
    ) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
    }
    if (change.status === "applied" && change.applied_snapshot) {
      return isDeepStrictEqual(current, change.applied_snapshot)
        ? this.#finishNative(change, "applied", undefined, {
            observed_snapshot: current,
            configuration_matches: true,
            last_verification: freshVerification(
              "group_configuration_observed",
            ),
          })
        : this.#finishNative(change, "conflict", undefined, {
            observed_snapshot: current,
            conflict_reason: "manual_change",
            configuration_matches: false,
            last_verification: freshVerification("conflict"),
          });
    }
    await this.#validateVirtualLightPreparation(change);

    for (const link of change.progress.links) {
      const source = change.virtual_target.characteristics[link.type];
      const links = await this.client.listLinks(source);
      const relation = virtualLinkRelation(links, link.target);
      const unexpected = unexpectedVirtualLinks(
        links,
        expectedTargetsForType(change, link.type),
      );
      if (unexpected.length > 0) {
        return this.#finishNative(change, "conflict", undefined, {
          observed_snapshot: await this.#observeVirtualLightGroup(change),
          conflict_reason: "manual_change",
          configuration_matches: false,
          last_verification: freshVerification("unexpected_links_observed"),
        });
      }
      if (relation.present) {
        if (!link.sent) {
          return this.#finishNative(change, "conflict", undefined, {
            conflict_reason: "manual_change",
            configuration_matches: false,
            last_verification: freshVerification("unowned_link_observed"),
          });
        }
        link.completed = true;
        link.link_id = relation.linkId;
        if (
          !(await this.#capturePhysicalVirtualLinkArtifact(
            change,
            link,
            source,
          ))
        ) {
          return this.#finishNative(change, "uncertain", undefined, {
            configuration_matches: undefined,
            conflict_reason: "physical_link_counterpart_missing",
            last_verification: freshVerification(
              "group_configuration_incomplete",
            ),
          });
        }
        if (!link.acknowledged) change.recovered_after_uncertain_write = true;
        await this.#saveBeforeWrite(change);
        continue;
      }
      if (link.sent) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: "link_write_outcome_unknown",
          last_verification: freshVerification("sent_link_missing"),
        });
      }
      await this.#persistVirtualLightStep(change, "adding_link", {
        characteristic_type: link.type,
        member_ref: link.member_ref,
      });
      link.sent = true;
      await this.#saveBeforeWrite(change);
      try {
        await this.client.addVirtualLink({
          ...source,
          ...virtualLinkTarget(link.target),
        });
        link.acknowledged = true;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          link.sent = false;
          throw await this.#finishRefusedGroupStep(change, "apply", error);
        }
      }
      const after = await this.client.listLinks(source);
      const observed = virtualLinkRelation(after, link.target);
      if (!observed.present) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: link.acknowledged
            ? "ack_without_link_result"
            : "link_write_outcome_unknown",
          last_verification: freshVerification("sent_link_missing"),
        });
      }
      link.completed = true;
      link.link_id = observed.linkId;
      if (
        !(await this.#capturePhysicalVirtualLinkArtifact(change, link, source))
      ) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: "physical_link_counterpart_missing",
          last_verification: freshVerification(
            "group_configuration_incomplete",
          ),
        });
      }
      if (!link.acknowledged) change.recovered_after_uncertain_write = true;
      await this.#saveBeforeWrite(change);
    }

    for (const setting of change.progress.settings) {
      const target = change.virtual_target.characteristics[setting.type];
      const accessory = await this.client.getAccessory(
        change.created_accessory_id,
      );
      const characteristic = findNativeCharacteristic(accessory, target);
      const expected = virtualLinkSettingsMatch(characteristic);
      if (setting.sent) {
        if (!expected) {
          return this.#finishNative(change, "uncertain", undefined, {
            configuration_matches: undefined,
            conflict_reason: "link_settings_write_outcome_unknown",
            last_verification: freshVerification("link_settings_missing"),
          });
        }
        setting.completed = true;
        if (!setting.acknowledged)
          change.recovered_after_uncertain_write = true;
        await this.#saveBeforeWrite(change);
        continue;
      }
      await this.#persistVirtualLightStep(change, "configuring_links", {
        characteristic_type: setting.type,
      });
      setting.sent = true;
      await this.#saveBeforeWrite(change);
      try {
        await this.client.updateCharacteristicLinks({
          ...target,
          hasLinks: true,
        });
        setting.acknowledged = true;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          setting.sent = false;
          throw await this.#finishRefusedGroupStep(change, "apply", error);
        }
      }
      const after = await this.client.getAccessory(change.created_accessory_id);
      if (!virtualLinkSettingsMatch(findNativeCharacteristic(after, target))) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: setting.acknowledged
            ? "ack_without_link_settings_result"
            : "link_settings_write_outcome_unknown",
          last_verification: freshVerification("link_settings_missing"),
        });
      }
      setting.completed = true;
      if (!setting.acknowledged) change.recovered_after_uncertain_write = true;
      await this.#saveBeforeWrite(change);
    }

    const applied = await this.#observeVirtualLightGroup(change);
    if (!completeVirtualLightConfiguration(change, applied)) {
      return this.#finishNative(change, "uncertain", undefined, {
        observed_snapshot: applied,
        configuration_matches: undefined,
        last_verification: freshVerification("group_configuration_incomplete"),
      });
    }
    const physicalLinks = await this.#observePhysicalVirtualLinks(change);
    if (!physicalLinks.complete) {
      return this.#finishNative(change, "uncertain", undefined, {
        observed_snapshot: applied,
        configuration_matches: undefined,
        conflict_reason: "physical_link_counterpart_missing",
        last_verification: freshVerification("group_configuration_incomplete"),
      });
    }
    change.physical_link_artifacts = physicalLinks.artifacts;
    change.applied_snapshot = structuredClone(applied);
    change.native_acknowledged = virtualLightAllWritesAcknowledged(change);
    return this.#finishNative(change, "applied", undefined, {
      observed_snapshot: applied,
      configuration_matches: true,
      last_verification: freshVerification("group_configuration_observed"),
    });
  }

  async #getVirtualLightGroup(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.created_accessory_id === undefined) {
      return change.progress.creation.sent
        ? this.#recordUnownedVirtualLightCandidates(change)
        : publicNativeChange(change);
    }
    let current;
    try {
      current = await this.#observeVirtualLightGroup(change);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    return this.#recordVirtualLightGroupState(change, current);
  }

  // Records what an observed group means for this change: restored when its
  // accessory is gone after a restore, applied when it matches the applied
  // configuration, uncertain while it holds only part of this change, and a
  // conflict for anything else.
  async #recordVirtualLightGroupState(change, current) {
    if (current.absent) {
      if (change.write_intent?.direction === "restore") {
        const cleanupFailure = await this.#verifyPhysicalLinkCleanup(change, {
          fresh: true,
        });
        if (cleanupFailure) return cleanupFailure;
        return this.#finishNative(change, "restored", undefined, {
          last_verification: freshVerification("created_accessory_absent"),
        });
      }
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "created_virtual_accessory_missing",
        last_verification: freshVerification("created_accessory_missing"),
      });
    }
    if (
      change.applied_snapshot &&
      isDeepStrictEqual(current, change.applied_snapshot)
    ) {
      return this.#finishNative(change, "applied", undefined, {
        observed_snapshot: current,
        configuration_matches: true,
        last_verification: freshVerification("group_configuration_observed"),
      });
    }
    if (
      safeOwnedVirtualLightConfiguration(change, current) ||
      safeRestoringVirtualLightConfiguration(change, current)
    ) {
      return this.#finishNative(change, "uncertain", undefined, {
        observed_snapshot: current,
        configuration_matches: undefined,
        last_verification: freshVerification("owned_partial_group_observed"),
      });
    }
    return this.#finishNative(change, "conflict", undefined, {
      observed_snapshot: current,
      conflict_reason: "manual_change",
      configuration_matches: false,
      last_verification: freshVerification("conflict"),
    });
  }

  async #restoreVirtualLightGroup(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (
      change.virtual_accessory_creation_owned !== true ||
      change.created_accessory_id === undefined
    ) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "virtual_accessory_creation_not_confirmed",
        last_verification: savedVerification(change.last_verification),
      });
    }
    const current = await this.#observeVirtualLightGroup(change);
    if (current.absent) {
      const cleanupFailure = await this.#verifyPhysicalLinkCleanup(change, {
        fresh: true,
      });
      if (cleanupFailure) return cleanupFailure;
      return this.#finishNative(change, "restored", undefined, {
        last_verification: freshVerification("created_accessory_absent"),
      });
    }
    const matchesApplied =
      change.applied_snapshot &&
      isDeepStrictEqual(current, change.applied_snapshot);
    if (
      !matchesApplied &&
      !safeOwnedVirtualLightConfiguration(change, current) &&
      !safeRestoringVirtualLightConfiguration(change, current)
    ) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "manual_change",
        configuration_matches: false,
        last_verification: freshVerification("conflict"),
      });
    }
    if (!change.progress.cleanup) {
      change.progress.cleanup = {
        links: change.progress.links.map((link) => {
          const relation = virtualLinkRelation(
            current.links[link.type],
            link.target,
          );
          return {
            type: link.type,
            member_ref: link.member_ref,
            link_id: relation.linkId ?? link.link_id,
            sent: false,
            acknowledged: false,
            completed: false,
          };
        }),
        settings: change.characteristic_types.map((type) => ({
          type,
          sent: false,
          acknowledged: false,
          completed: false,
        })),
      };
      await this.#saveBeforeWrite(change);
    }
    for (const removal of change.progress.cleanup.links) {
      const source = change.virtual_target.characteristics[removal.type];
      const progress = virtualLightProgressLink(change, removal);
      const links = await this.client.listLinks(source);
      const relation = virtualLinkRelation(links, progress.target);
      if (!relation.present) {
        if (
          removal.physical_links_after === undefined &&
          removal.sent !== true
        ) {
          removal.physical_links_after = normalizePhysicalLinks(
            await this.client.listLinks(progress.target),
          );
        }
        removal.completed = true;
        if (removal.sent && !removal.acknowledged) {
          change.recovered_after_uncertain_write = true;
        }
        await this.#saveBeforeWrite(change);
        continue;
      }
      // A lost send may not have reached the hub. Only the exact persisted IN
      // is safe to retry; a target match alone does not preserve ownership.
      const retryingUncertainRemoval =
        removal.sent === true &&
        removal.acknowledged !== true &&
        removal.completed !== true &&
        removal.link_id === relation.linkId;
      if (removal.sent && !retryingUncertainRemoval) {
        return this.#finishNative(change, "uncertain", undefined, {
          observed_snapshot: current,
          configuration_matches: undefined,
          conflict_reason: "link_remove_outcome_unknown",
          last_verification: freshVerification("owned_link_still_present"),
        });
      }
      removal.link_id = relation.linkId;
      removal.physical_links_before = normalizePhysicalLinks(
        await this.client.listLinks(progress.target),
      );
      removal.physical_links_after = undefined;
      removal.acknowledged = false;
      removal.uncertain_retry_sent = retryingUncertainRemoval
        ? true
        : undefined;
      await this.#persistVirtualLightStep(
        change,
        "removing_link",
        {
          characteristic_type: removal.type,
          link_id: removal.link_id,
          ...(retryingUncertainRemoval ? { uncertain_retry: true } : {}),
        },
        "restore",
      );
      removal.sent = true;
      await this.#saveBeforeWrite(change);
      try {
        await this.client.removeLink({ ...source, linkId: removal.link_id });
        removal.acknowledged = true;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          removal.sent = false;
          removal.acknowledged = false;
          removal.uncertain_retry_sent = undefined;
          removal.physical_links_before = undefined;
          removal.physical_links_after = undefined;
          throw await this.#finishRefusedGroupStep(
            change,
            "restore",
            error,
            current,
          );
        }
      }
      const after = await this.client.listLinks(source);
      if (virtualLinkRelation(after, progress.target).present) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: removal.acknowledged
            ? "ack_without_link_removal"
            : "link_remove_outcome_unknown",
          last_verification: freshVerification("owned_link_still_present"),
        });
      }
      removal.physical_links_after = normalizePhysicalLinks(
        await this.client.listLinks(progress.target),
      );
      removal.completed = true;
      if (!removal.acknowledged) change.recovered_after_uncertain_write = true;
      await this.#saveBeforeWrite(change);
      const cleanupFailure = await this.#verifyPhysicalLinkCleanup(change, {
        onlyCleanup: removal,
        deferOwnedResidues: true,
      });
      if (cleanupFailure) return cleanupFailure;
    }
    for (const setting of change.progress.cleanup.settings) {
      const target = change.virtual_target.characteristics[setting.type];
      const accessory = await this.client.getAccessory(
        change.created_accessory_id,
      );
      const characteristic = findNativeCharacteristic(accessory, target);
      if (
        characteristic?.hasLinks !== true &&
        (characteristic?.linkProcessing ?? 0) === 0
      ) {
        setting.completed = true;
        if (setting.sent && !setting.acknowledged) {
          change.recovered_after_uncertain_write = true;
        }
        await this.#saveBeforeWrite(change);
        continue;
      }
      if (setting.sent) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: "link_settings_restore_outcome_unknown",
          last_verification: freshVerification("link_settings_still_enabled"),
        });
      }
      await this.#persistVirtualLightStep(
        change,
        "disabling_links",
        { characteristic_type: setting.type },
        "restore",
      );
      setting.sent = true;
      await this.#saveBeforeWrite(change);
      try {
        await this.client.updateCharacteristicLinks({
          ...target,
          hasLinks: false,
        });
        setting.acknowledged = true;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          setting.sent = false;
          throw await this.#finishRefusedGroupStep(
            change,
            "restore",
            error,
            current,
          );
        }
      }
      const after = await this.client.getAccessory(change.created_accessory_id);
      if (findNativeCharacteristic(after, target)?.hasLinks === true) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: setting.acknowledged
            ? "ack_without_link_settings_restore"
            : "link_settings_restore_outcome_unknown",
          last_verification: freshVerification("link_settings_still_enabled"),
        });
      }
      setting.completed = true;
      if (!setting.acknowledged) change.recovered_after_uncertain_write = true;
      await this.#saveBeforeWrite(change);
    }
    const cleanupFailure = await this.#verifyPhysicalLinkCleanup(change);
    if (cleanupFailure) return cleanupFailure;
    if (change.progress.deletion?.sent === true) {
      return this.#finishNative(change, "uncertain", undefined, {
        observed_snapshot: current,
        configuration_matches: undefined,
        conflict_reason: "accessory_delete_outcome_unknown",
        last_verification: freshVerification("created_accessory_still_present"),
      });
    }
    change.progress.deletion = { sent: true, acknowledged: false };
    await this.#persistVirtualLightStep(
      change,
      "deleting_accessory",
      {},
      "restore",
    );
    try {
      await this.client.deleteAccessory(change.created_accessory_id);
      change.progress.deletion.acknowledged = true;
      change.native_acknowledged = virtualLightAllWritesAcknowledged(change);
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        // The hub did not delete it, so a later restore sends the delete again.
        change.progress.deletion = undefined;
        throw await this.#finishRefusedGroupStep(
          change,
          "restore",
          error,
          current,
        );
      }
    }
    change.native_acknowledged = virtualLightAllWritesAcknowledged(change);
    const after = await this.client.getAccessoryOrNull(
      change.created_accessory_id,
    );
    if (after === null) {
      const cleanupFailure = await this.#verifyPhysicalLinkCleanup(change, {
        fresh: true,
      });
      if (cleanupFailure) return cleanupFailure;
      if (change.progress.deletion.acknowledged !== true) {
        change.recovered_after_uncertain_write = true;
      }
      return this.#finishNative(change, "restored", undefined, {
        last_verification: freshVerification("created_accessory_absent"),
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      observed_snapshot: await this.#observeVirtualLightGroup(change),
      configuration_matches: undefined,
      conflict_reason: change.progress.deletion.acknowledged
        ? "ack_without_accessory_deletion"
        : "accessory_delete_outcome_unknown",
      last_verification: freshVerification("created_accessory_still_present"),
    });
  }

  async #observeVirtualLightGroup(change) {
    const accessory = await this.client.getAccessoryOrNull(
      change.created_accessory_id,
    );
    if (accessory === null) return { absent: true };
    const links = {};
    for (const type of change.characteristic_types) {
      const target = change.virtual_target.characteristics[type];
      links[type] = normalizeVirtualLinks(await this.client.listLinks(target));
    }
    return {
      absent: false,
      accessory: virtualAccessoryStructure(accessory),
      links,
      link_settings: virtualLightSettingsSnapshot(
        accessory,
        change.virtual_target,
        change.characteristic_types,
      ),
    };
  }

  async #observePhysicalVirtualLinks(change) {
    const artifacts = [];
    for (const link of change.progress.links) {
      const source = change.virtual_target.characteristics[link.type];
      const links = normalizeVirtualLinks(
        await this.client.listLinks(link.target),
      );
      const matching = links.filter(
        (candidate) =>
          candidate.type === "OUT" &&
          candidate.characteristics.some(
            (characteristic) =>
              nativeTargetKey(characteristic) === nativeTargetKey(source),
          ),
      );
      if (matching.length !== 1) return { complete: false, artifacts };
      artifacts.push({
        type: link.type,
        member_ref: link.member_ref,
        target: structuredClone(link.target),
        source: structuredClone(source),
        index: matching[0].index,
      });
    }
    return { complete: true, artifacts };
  }

  async #capturePhysicalVirtualLinkArtifact(change, link, source) {
    const links = normalizeVirtualLinks(
      await this.client.listLinks(link.target),
    );
    const matching = links.filter(
      (candidate) =>
        candidate.type === "OUT" &&
        candidate.index === link.link_id &&
        candidate.characteristics.some(
          (characteristic) =>
            nativeTargetKey(characteristic) === nativeTargetKey(source),
        ),
    );
    if (matching.length !== 1) return false;
    const artifact = {
      type: link.type,
      member_ref: link.member_ref,
      target: structuredClone(link.target),
      source: structuredClone(source),
      index: matching[0].index,
    };
    change.physical_link_artifacts = [
      ...(change.physical_link_artifacts ?? []).filter(
        (candidate) =>
          !(
            candidate.type === artifact.type &&
            candidate.member_ref === artifact.member_ref
          ),
      ),
      artifact,
    ];
    return true;
  }

  async #observePhysicalVirtualLinkCleanup(
    change,
    { fresh = false, onlyCleanup } = {},
  ) {
    const ownedResidues = [];
    const preservationFailures = [];
    const preservationUnverified = [];
    const nativeResidues = [];
    for (const progress of change.progress.links) {
      if (
        onlyCleanup &&
        (onlyCleanup.type !== progress.type ||
          onlyCleanup.member_ref !== progress.member_ref)
      ) {
        continue;
      }
      const cleanup = change.progress.cleanup?.links.find(
        (candidate) =>
          candidate.type === progress.type &&
          candidate.member_ref === progress.member_ref,
      );
      const artifact = physicalLinkArtifact(change, progress, cleanup);
      const observedLinks =
        !fresh && cleanup?.physical_links_after
          ? cleanup.physical_links_after
          : normalizePhysicalLinks(
              await this.client.listLinks(artifact.target),
            );
      const baseline = physicalLinkBaseline(change, artifact);
      for (const link of observedLinks) {
        if (
          link.type === "OUT" &&
          link.characteristics.some(
            (characteristic) =>
              nativeTargetKey(characteristic) ===
              nativeTargetKey(artifact.source),
          )
        ) {
          ownedResidues.push({
            member_ref: artifact.member_ref,
            characteristic_type: artifact.type,
            link: structuredClone(link),
          });
        }
      }
      if (cleanup?.sent) {
        if (cleanup.physical_links_before === undefined) {
          preservationUnverified.push({
            member_ref: artifact.member_ref,
            characteristic_type: artifact.type,
          });
        } else {
          const expectedPreserved = physicalLinksPreservedAcrossOwnRemoval(
            cleanup.physical_links_before,
            baseline.links,
            artifact.source,
          );
          const preservationEvidence =
            cleanup.physical_links_after ?? observedLinks;
          const missingPreserved = expectedPreserved.filter(
            (expected) =>
              !preservationEvidence.some((observed) =>
                physicalLinkContains(observed, expected),
              ),
          );
          if (
            cleanup.physical_links_after === undefined &&
            missingPreserved.length > 0
          ) {
            // Late presence is sufficient to finish safely. Late absence cannot
            // establish that this change removed a foreign link.
            preservationUnverified.push({
              member_ref: artifact.member_ref,
              characteristic_type: artifact.type,
            });
          } else if (missingPreserved.length > 0) {
            preservationFailures.push({
              member_ref: artifact.member_ref,
              characteristic_type: artifact.type,
              missing_links: structuredClone(missingPreserved),
            });
          }
        }
      }
      for (const link of observedLinks) {
        const residue = nativeEmptyPhysicalLinkResidue(
          link,
          baseline.links,
          artifact.index,
        );
        if (residue) {
          nativeResidues.push({
            member_ref: artifact.member_ref,
            characteristic_type: artifact.type,
            link: residue,
          });
        }
      }
    }
    return {
      ownedResidues,
      preservationFailures,
      preservationUnverified,
      nativeResidues,
    };
  }

  async #verifyPhysicalLinkCleanup(change, options = {}) {
    const physicalLinks = await this.#observePhysicalVirtualLinkCleanup(
      change,
      options,
    );
    if (!options.deferOwnedResidues && physicalLinks.ownedResidues.length > 0) {
      return this.#finishNative(change, "uncertain", undefined, {
        physical_link_residues: physicalLinks.ownedResidues,
        configuration_matches: undefined,
        conflict_reason: "link_cleanup_incomplete",
        last_verification: freshVerification("physical_link_residue_observed"),
      });
    }
    if (physicalLinks.preservationFailures.length > 0) {
      return this.#finishNative(change, "uncertain", undefined, {
        physical_link_preservation_failures: physicalLinks.preservationFailures,
        configuration_matches: undefined,
        conflict_reason: "foreign_link_changed_during_cleanup",
        last_verification: freshVerification(
          "foreign_link_change_observed_after_own_removal",
        ),
      });
    }
    if (physicalLinks.preservationUnverified.length > 0) {
      return this.#finishNative(change, "uncertain", undefined, {
        physical_link_preservation_unverified:
          physicalLinks.preservationUnverified,
        configuration_matches: undefined,
        conflict_reason: "link_remove_preservation_outcome_unknown",
        last_verification: freshVerification(
          "physical_link_preservation_not_observed_after_own_removal",
        ),
      });
    }
    change.physical_link_residues = undefined;
    change.physical_link_baseline_changes = undefined;
    change.physical_link_preservation_failures = undefined;
    change.physical_link_preservation_unverified = undefined;
    change.native_link_residues = physicalLinks.nativeResidues;
    return null;
  }

  async #recordUnownedVirtualLightCandidates(change) {
    let candidates;
    try {
      candidates = await this.#matchingVirtualLightCandidates(change, true);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        virtual_accessory_creation_owned: false,
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      candidate_accessories: candidates,
      virtual_accessory_creation_owned: false,
      configuration_matches: undefined,
      conflict_reason: "virtual_accessory_creation_outcome_unknown",
      last_verification: freshVerification(
        candidates.length > 0
          ? "unowned_matching_accessory_observed"
          : "matching_accessory_missing",
      ),
    });
  }

  async #matchingVirtualLightCandidates(change, onlyNew = false) {
    const baseline = new Set(change.baseline_accessory_ids);
    const options = { allowNormalizedName: onlyNew };
    const listed = (await this.client.listAccessories()).filter(
      (accessory) =>
        (!onlyNew || !baseline.has(accessory.id)) &&
        hasVirtualLightShape(accessory, change, options),
    );
    return (await this.#virtualAccessories(listed))
      .filter((accessory) => hasVirtualLightShape(accessory, change, options))
      .map(({ id, name }) => ({
        ref: `${change.home_ref}/accessory/${id}`,
        name,
      }));
  }

  // SprutHub 3.0.0 lists accessories without virtual; only accessory.get
  // reports it (owner hub, 2026-09-24). Accessories picked from the list by
  // room, name or services are therefore read one by one, and a bound keeps
  // that to a few reads.
  async #virtualAccessories(listed) {
    if (listed.length > VIRTUAL_CANDIDATE_LIMIT) {
      throw new SprutHubError(
        "too_many_matching_accessories",
        `More than ${VIRTUAL_CANDIDATE_LIMIT} accessories in this room match the virtual light by name or services, and SprutHub tells which are virtual only one accessory at a time. Nothing was written; find them with find_devices and the room_ref, then rename or remove some of them first.`,
        "find_devices",
      );
    }
    const virtual = [];
    for (const { id } of listed) {
      const accessory = await this.client.getAccessoryOrNull(id);
      if (accessory?.virtual === true) virtual.push(accessory);
    }
    return virtual;
  }

  async #validateVirtualLightPreparation(change) {
    const [serviceTypes, accessories] = await Promise.all([
      this.client.listServiceTypes(),
      Promise.all(
        change.members.map(({ target }) =>
          this.client.getAccessory(target.aId),
        ),
      ),
    ]);
    validateVirtualLightServiceType(
      serviceTypes.find(({ type }) => type === "Lightbulb"),
      change.characteristic_types,
    );
    const current = change.members.map((member, index) =>
      selectVirtualLightMember(
        member.ref,
        member.target,
        accessories[index],
        change.characteristic_types,
      ),
    );
    if (
      !current.every((member, index) =>
        isDeepStrictEqual(
          {
            target: member.target,
            characteristics: member.characteristics,
          },
          {
            target: change.members[index].target,
            characteristics: change.members[index].characteristics,
          },
        ),
      )
    ) {
      throw new SprutHubError(
        "binding_changed",
        "A selected virtual light member changed after preparation.",
        "prepare_native_change",
      );
    }
  }

  async #validatePhysicalLinkBaselines(change) {
    for (const baseline of change.physical_link_baselines) {
      const current = normalizePhysicalLinks(
        await this.client.listLinks(baseline.target),
      );
      if (!isDeepStrictEqual(current, baseline.links)) {
        throw new SprutHubError(
          "binding_changed",
          "A selected virtual light member link changed after preparation.",
          "prepare_native_change",
        );
      }
    }
  }

  async #persistVirtualLightStep(
    change,
    phase,
    detail = {},
    direction = "apply",
  ) {
    const now = new Date().toISOString();
    Object.assign(change, {
      status: direction === "restore" ? "restoring" : "applying",
      native_write_sent: true,
      configuration_matches: undefined,
      conflict_reason: undefined,
      write_intent: {
        direction,
        phase,
        acknowledged: false,
        at: now,
        ...detail,
      },
      updated_at: now,
    });
    change.history.push({ status: change.status, at: now });
    await this.#saveBeforeWrite(change);
  }

  async listNativeChanges({
    home_ref: requestedHomeRef,
    entity_ref: entityRef,
    limit = 10,
    cursor,
  }) {
    const homeRef = requestedHomeRef ?? configuredHomeRef(this.hubSerial);
    parseConfiguredHomeRef(homeRef, this.hubSerial);
    if (entityRef !== undefined) requireEntityHome(entityRef, this.hubSerial);
    const selection = historySelection(homeRef, entityRef, limit, cursor);
    const storedChanges = await this.store.list();
    await this.#reconcileHistoryScenario(storedChanges, entityRef);
    const all = storedChanges
      .filter(
        (change) =>
          (change.home_ref === undefined || change.home_ref === homeRef) &&
          (entityRef === undefined ||
            changeAffectedRefs(change, homeRef).includes(entityRef)),
      )
      .map((change) => changeSummary(change, homeRef))
      .sort(compareChangeSummaries);
    const remaining =
      selection.after === null
        ? all
        : all.filter(
            (change) => compareChangeSummaries(change, selection.after) > 0,
          );
    const changes = remaining.slice(0, limit);
    const nextCursor =
      changes.length < remaining.length
        ? encodeHistoryCursor(changes.at(-1), selection.scope)
        : null;
    return {
      status: "ok",
      home_ref: homeRef,
      ...(entityRef ? { entity_ref: entityRef } : {}),
      changes,
      page: {
        limit,
        returned_changes: changes.length,
        remaining_changes: remaining.length - changes.length,
        snapshot: false,
        next_cursor: nextCursor,
      },
      next: nextCursor ? historyNext(selection, nextCursor) : null,
      truncated: nextCursor !== null,
    };
  }

  async #reconcileHistoryScenario(changes, entityRef) {
    if (entityRef === undefined) return;
    let target;
    try {
      target = parseScenarioRef(entityRef, this.hubSerial);
    } catch {
      return;
    }
    const candidates = changes.filter(
      (change) =>
        ["block_create", "logic_source_create"].includes(change.kind) &&
        !change.scenario_index &&
        ["applying", "uncertain"].includes(change.status) &&
        nativeIntentDirection(change) === "apply",
    );
    if (candidates.length === 0) return;
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) return;
    for (const change of candidates) {
      const carriesMarker =
        change.kind === "logic_source_create"
          ? logicSourceCarriesOwnershipMarker(change, scenario)
          : typeof scenario.desc === "string" &&
            scenario.desc.includes(`[${change.marker}]`);
      if (carriesMarker) {
        change.scenario_index = target.index;
        await this.#reconcileScenarioApply(change, false);
      }
    }
  }

  async #readLogicSelection(target) {
    const [types, logics] = await Promise.all([
      this.client.listLogicTypes(target),
      this.client.listLogics(target),
    ]);
    const typeMatches = types.filter(({ type }) => type === target.type);
    const assignedMatches = logics.filter(({ type }) => type === target.type);
    if (typeMatches.length > 1 || assignedMatches.length > 1) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned the selected logic type more than once.",
      );
    }
    if (assignedMatches.length === 0 && typeMatches.length === 0) {
      throw new SprutHubError(
        "logic_type_unavailable",
        "The selected native logic type is not available for this service.",
        "get_entity",
      );
    }
    return {
      type: typeMatches[0] ?? { type: target.type },
      assigned: assignedMatches[0] ?? null,
    };
  }

  async #requireAvailableLogicType(target) {
    const types = await this.client.listLogicTypes(target);
    const matches = types.filter(({ type }) => type === target.type);
    if (matches.length !== 1) {
      throw new SprutHubError(
        matches.length === 0
          ? "logic_type_unavailable"
          : "incompatible_response",
        matches.length === 0
          ? "The selected native logic type is no longer available for this service."
          : "SprutHub returned the selected logic type more than once.",
        "get_entity",
      );
    }
    return matches[0];
  }

  async #observeLogicAssignment(change) {
    const logics = await this.client.listLogics(change.target);
    const matches = logics.filter(({ type }) => type === change.target.type);
    if (matches.length > 1) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned the selected logic assignment more than once.",
      );
    }
    if (matches.length === 0) return null;
    const logic = await this.client.getLogic(change.target);
    if (!logic) {
      throw new SprutHubError(
        "incompatible_response",
        "The selected logic disappeared between scoped reads.",
        "get_native_change",
      );
    }
    const options = await this.client.getLogicOptions(change.target);
    return logicAssignmentSnapshot(logic, options);
  }

  async #applyLogicAssignment(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      const direction = nativeIntentDirection(change);
      if (direction === "restore") {
        return this.#reconcileLogicAssignmentRestore(change, false);
      }
      const pending = await this.#reconcileLogicAssignmentApply(change, false);
      if (pending.status !== "uncertain") return pending;
      const current = await this.#observeLogicAssignment(change);
      if (current !== null) return pending;
    }
    if (change.applied_snapshot !== undefined) {
      const current = await this.#observeLogicAssignment(change);
      return this.#recordOwnedLogicAssignment(change, current);
    }
    const current = await this.#observeLogicAssignment(change);
    if (current !== null) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "baseline_changed",
        configuration_matches: false,
        last_verification: freshVerification("baseline_absent_missing"),
      });
    }
    await this.#requireAvailableLogicType(change.target);
    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      await this.client.createLogic(change.target);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(
          change,
          "not_applied",
          error,
          undefined,
          { configuration_matches: true },
        );
      }
      return this.#reconcileLogicAssignmentApply(change, false);
    }
    return this.#reconcileLogicAssignmentApply(change, true);
  }

  async #reconcileLogicAssignmentApply(change, acknowledged) {
    let current;
    try {
      current = await this.#observeLogicAssignment(change);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    if (change.applied_snapshot !== undefined) {
      return this.#recordOwnedLogicAssignment(change, current, {
        recoveredAfterUncertainWrite: !acknowledged,
      });
    }
    if (current === null) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: false,
        last_verification: freshVerification("requested_assignment_missing"),
        ...(acknowledged
          ? { conflict_reason: "ack_without_requested_result" }
          : {}),
      });
    }
    return this.#finishNative(change, "applied", undefined, {
      applied_snapshot: current,
      configuration_matches: true,
      configuration_differences: undefined,
      last_verification: freshVerification("created_configuration"),
      ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
    });
  }

  async #getLogicAssignment(change) {
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      return nativeIntentDirection(change) === "restore"
        ? this.#reconcileLogicAssignmentRestore(change, false)
        : this.#reconcileLogicAssignmentApply(change, false);
    }
    let current;
    try {
      current = await this.#observeLogicAssignment(change);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
        configurationMatches: undefined,
      });
    }
    if (change.status === "restored") {
      return this.#recordLogicAssignmentObservation(
        change,
        current,
        current === null ? "baseline_absent" : "baseline_absent_missing",
      );
    }
    if (change.applied_snapshot !== undefined) {
      return this.#recordOwnedLogicAssignment(change, current);
    }
    return this.#recordLogicAssignmentObservation(
      change,
      current,
      current === null ? "baseline_absent" : "baseline_absent_missing",
    );
  }

  async #restoreLogicAssignment(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      const direction = nativeIntentDirection(change);
      if (direction === "apply") {
        const reconciled = await this.#reconcileLogicAssignmentApply(
          change,
          false,
        );
        if (reconciled.status === "uncertain") {
          const current = await this.#observeLogicAssignment(change);
          if (current === null) {
            return this.#finishNative(change, "restored", undefined, {
              configuration_matches: true,
              last_verification: freshVerification("baseline_absent"),
            });
          }
          return reconciled;
        }
      } else {
        const reconciled = await this.#reconcileLogicAssignmentRestore(
          change,
          false,
        );
        if (reconciled.status !== "uncertain") return reconciled;
      }
    }
    const current = await this.#observeLogicAssignment(change);
    if (change.applied_snapshot === undefined) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "change_was_not_applied",
        configuration_matches: current === null,
        last_verification: freshVerification(
          current === null ? "baseline_absent" : "baseline_absent_missing",
        ),
      });
    }
    const ownership = this.#logicAssignmentOwnership(change, current);
    if (ownership === "lost" && current !== null) {
      return this.#finishLostLogicAssignmentOwnership(change, current);
    }
    if (current === null) {
      return this.#finishNative(change, "restored", undefined, {
        configuration_matches: true,
        configuration_differences: undefined,
        last_verification: freshVerification("baseline_absent"),
      });
    }
    const observation = logicAssignmentConfigurationObservation(
      change.applied_snapshot,
      current,
    );
    if (!observation.matches) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "configuration_changed_after_creation",
        ...observation.fields,
      });
    }
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      await this.client.deleteLogic(change.target);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(
          change,
          "applied",
          error,
          undefined,
          { configuration_matches: true },
        );
      }
      return this.#reconcileLogicAssignmentRestore(change, false);
    }
    return this.#reconcileLogicAssignmentRestore(change, true);
  }

  async #reconcileLogicAssignmentRestore(change, acknowledged) {
    let current;
    try {
      current = await this.#observeLogicAssignment(change);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    if (current === null) {
      return this.#finishNative(change, "restored", undefined, {
        configuration_matches: true,
        configuration_differences: undefined,
        last_verification: freshVerification("baseline_absent"),
        ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
      });
    }
    const observation = logicAssignmentConfigurationObservation(
      change.applied_snapshot,
      current,
    );
    if (!observation.matches) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "configuration_changed_after_creation",
        ...observation.fields,
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      configuration_matches: true,
      last_verification: freshVerification("baseline_absent_missing"),
      ...(acknowledged
        ? { conflict_reason: "ack_without_requested_result" }
        : {}),
    });
  }

  async #recordLogicAssignmentObservation(change, _current, result) {
    change.configuration_matches =
      result === "applied_configuration" || result === "baseline_absent";
    change.last_verification = freshVerification(result);
    change.updated_at = new Date().toISOString();
    const saved = await this.#trySave(change);
    return withLocalState(
      publicNativeChange(change),
      saved,
      "restore_state_storage_then_get_native_change",
    );
  }

  async #recordOwnedLogicAssignment(
    change,
    current,
    { recoveredAfterUncertainWrite = false } = {},
  ) {
    if (this.#logicAssignmentOwnership(change, current) === "lost") {
      return this.#finishLostLogicAssignmentOwnership(change, current);
    }
    const observation = logicAssignmentConfigurationObservation(
      change.applied_snapshot,
      current,
    );
    Object.assign(change, observation.fields, {
      status: "applied",
      conflict_reason: undefined,
      recovered_after_uncertain_write:
        recoveredAfterUncertainWrite ||
        change.recovered_after_uncertain_write === true
          ? true
          : undefined,
      updated_at: new Date().toISOString(),
    });
    const saved = await this.#trySave(change);
    return withLocalState(
      publicNativeChange(change),
      saved,
      "restore_state_storage_then_get_native_change",
    );
  }

  #logicAssignmentOwnership(change, current) {
    if (change.applied_snapshot === undefined) return "unconfirmed";
    if (current === null) change.assignment_ownership_lost = true;
    return change.assignment_ownership_lost === true ? "lost" : "owned";
  }

  #finishLostLogicAssignmentOwnership(change, current) {
    const missing = current === null;
    return this.#finishNative(change, "conflict", undefined, {
      conflict_reason: missing
        ? "assignment_missing_after_creation"
        : "assignment_reappeared_after_ownership_loss",
      configuration_matches: false,
      configuration_differences: {
        assignment: missing ? "missing" : "present_after_ownership_loss",
      },
      last_verification: freshVerification(
        missing
          ? "created_assignment_missing"
          : "assignment_reappeared_after_ownership_loss",
      ),
    });
  }

  async #requireNativeChange(id) {
    const change = await this.store.get(id);
    if (!isNativeChange(change)) {
      throw new SprutHubError(
        "change_not_found",
        "The native change was not found for this configured hub.",
        "prepare_native_change",
      );
    }
    if (change.home_ref !== configuredHomeRef(this.hubSerial)) {
      throw unsupportedHomeWrite();
    }
    return change;
  }

  async #finishValueOwnerConflict(change, current) {
    const reason = await nativeValueKind(change.kind).ownerConflict?.(
      this,
      change,
    );
    if (!reason) return null;
    return this.#finishNative(change, "conflict", current, {
      conflict_reason: reason,
      last_verification: freshVerification("conflict"),
    });
  }

  async #readNativeValueState(change, options = {}) {
    return nativeValueKind(change.kind).read(this, change, options);
  }

  async #readNativeValue(change, options = {}) {
    return (await this.#readNativeValueState(change, options)).value;
  }

  // A refusal here comes before the intent is saved, so the record stays as
  // it was and nothing counts as sent.
  async #beforeNativeValueWrite(change) {
    await nativeValueKind(change.kind).beforeWrite?.(this, change);
  }

  async #writeNativeValue(change, value) {
    return nativeValueKind(change.kind).write(this, change, value);
  }

  async #restoreValueChange(change) {
    const lifecycle = nativeValueLifecycle(change);
    if (lifecycle.phase === "restore_completed") {
      return publicStoredNativeChange(change);
    }
    let currentState;
    if (lifecycle.phase === "unresolved_intent") {
      const pending = await this.#reconcilePendingValueChange(change, {
        requireWrite: true,
      });
      if (pending) {
        if (!valueRestoreGoesOn(change, pending)) return pending.result;
        currentState = { value: pending.current, contract: pending.contract };
      }
    }
    const { value: current, contract } =
      currentState ??
      (await this.#readNativeValueState(change, {
        requireWrite: true,
      }));
    const restoration = nativeValueRestoration({ ...change, contract });
    if (!restoration.supported) {
      throw new SprutHubError(
        "restore_unsupported",
        restoration.limitation?.message ??
          "This native value cannot be restored automatically.",
        "get_native_change",
      );
    }
    const accessory = nativeValueKind(change.kind).command
      ? await this.client.getAccessory(change.target.aId)
      : undefined;
    // A lamp's level is never written back, nor offered for resend
    // (LAMP_LEVEL_LIMITATION); a record without lamp_level (from before it,
    // or whose device read the hub refused when it was made) is judged by
    // the accessory now.
    if (
      change.lamp_level === true ||
      lightLevelOnTarget(accessory, change.target, change.contract?.type)
    ) {
      return {
        ...publicNativeChange(change, current),
        restore_outcome: {
          status: "skipped",
          reason: LAMP_LEVEL_LIMITATION.code,
          message: `Nothing was written. ${LAMP_LEVEL_LIMITATION.message} Tell the owner, who can set it again.`,
        },
      };
    }
    const ownershipLoss = await this.#finishObservedValueOwnershipLoss(
      change,
      current,
    );
    if (ownershipLoss) return ownershipLoss;
    const sentWithoutOwnership = await this.#finishSentValueOwnershipLoss(
      change,
      current,
    );
    if (sentWithoutOwnership) return sentWithoutOwnership;
    if (!nativeValueProvenApply(change)) {
      return this.#finishNative(change, "not_owned", current, {
        conflict_reason: "change_was_not_applied",
        last_verification: freshVerification("current_value_observed"),
      });
    }
    // An offline device shows its last known values, which say nothing of
    // its state now: nothing is decided or written for it.
    if (accessory?.online === false) {
      return {
        ...publicNativeChange(change, current),
        restore_outcome: {
          status: "skipped",
          reason: "device_unavailable",
          message:
            "The hub shows this device offline, so its values are the last known ones; nothing was written. Restore it again once the device is back online.",
        },
      };
    }
    const later = await this.#laterOwnedValueChange(change, current);
    if (later) return this.#finishLaterOwnedValueChange(change, later, current);
    if (valuesEqual(current, change.baseline_value)) {
      return this.#finishNative(change, "restored", current, {
        last_verification: freshVerification("baseline_value_observed"),
        ...(nativeIntentDirection(change) === "restore"
          ? { recovered_after_uncertain_write: true }
          : {}),
      });
    }
    if (!valuesEqual(current, change.requested_value)) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "manual_change",
        manual_change_observed: true,
        last_verification: freshVerification("conflict"),
      });
    }
    const ownerConflict = await this.#finishValueOwnerConflict(change, current);
    if (ownerConflict) return ownerConflict;
    await this.#settleLaterUnknownWrites(change);
    await this.#beforeNativeValueWrite(change);
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      await this.#writeNativeValue(change, change.baseline_value);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, "applied", error, current);
      }
      return this.#reconcileValueAfterWrite(change, "restore");
    }
    return this.#reconcileValueAfterWrite(change, "restore", true);
  }

  async #observeProvenNativeValue(change, current) {
    if (!valuesEqual(current, change.requested_value)) {
      const later = await this.#laterOwnedValueChange(change, current);
      if (later) {
        return this.#finishLaterOwnedValueChange(change, later, current);
      }
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "value_changed_after_apply",
        manual_change_observed: true,
        last_verification: freshVerification("conflict"),
      });
    }
    const ownerConflict = await this.#finishValueOwnerConflict(change, current);
    if (ownerConflict) return ownerConflict;
    if (change.status === "applied") {
      return this.#recordNativeObservation(
        change,
        current,
        "requested_value_observed",
      );
    }
    return this.#finishNative(change, "applied", current, {
      last_verification: freshVerification("requested_value_observed"),
    });
  }

  // The agent's own later change of the same setting that set the value
  // seen now: this change is governed by it, which is no manual change and
  // costs this change no restore right. The newest such change is named.
  async #laterOwnedValueChange(change, current) {
    const key = valueTargetKey(change);
    let latest;
    for (const candidate of await this.store.list()) {
      if (
        candidate.id === change.id ||
        candidate.home_ref !== change.home_ref ||
        !isNativeValueChange(candidate) ||
        valueTargetKey(candidate) !== key ||
        !changeStillInEffect(candidate) ||
        compareApplication(candidate, change) <= 0 ||
        !valuesEqual(current, candidate.requested_value)
      ) {
        continue;
      }
      if (!latest || compareApplication(candidate, latest) > 0) {
        latest = candidate;
      }
    }
    return latest;
  }

  async #finishLaterOwnedValueChange(change, later, current) {
    return this.#finishNative(change, "conflict", current, {
      conflict_reason: "later_owned_change",
      restore_first_change_id: later.id,
      last_verification: freshVerification("conflict"),
    });
  }

  // Right before an undo writes, the agent's later changes whose own write
  // is still unknown and which set what this undo rewrites (undoRewrites)
  // are settled, each by its own read (reconcilePendingValueChange,
  // reconcileScenarioWrite). This undo goes on only while the hub shows its
  // change in place, so a later undo that the read shows took effect is
  // restored now, and a later apply that it shows did not take effect (its
  // baseline is there) is not applied: this is the last read that can tell.
  // Once this write lands, that later change's baseline is gone and no read
  // of it could tell this undo from a change by hand. So this undo depends
  // on these reads: one that fails stops it before its write
  // (undoOrUnknown).
  async #settleLaterUnknownWrites(change) {
    for (const later of await this.store.list()) {
      if (
        later.id === change.id ||
        later.home_ref !== change.home_ref ||
        !undoRewrites(change, later) ||
        compareApplication(later, change) <= 0 ||
        !writeOutcomeUnknown(later)
      ) {
        continue;
      }
      const pending = isNativeValueChange(later)
        ? await this.#reconcilePendingValueChange(later)
        : await this.#reconcileScenarioWrite(later);
      if (pending?.outcome === "read_failed") throw pending.error;
      if (
        pending?.direction === "apply" &&
        pending.outcome === "expected_missing"
      ) {
        // A pause is not applied, as one the hub refused
        // (INACTIVE_PAUSE_STATUSES); another change is no longer the
        // agent's, as a sent change's record reads.
        await this.#finishNative(
          later,
          later.kind === "block_action_pause" ? "not_applied" : "not_owned",
          pending.current,
          {
            conflict_reason: "change_was_not_applied",
            last_verification: freshVerification(
              "baseline_observed_before_earlier_undo",
            ),
          },
        );
      }
    }
  }

  // The check of an unknown write whose read failed concludes nothing: the
  // write stays unknown, with the failure as its last verification and the
  // error passed on (undoOrUnknown).
  async #finishUnread(change, error) {
    return {
      direction: nativeIntentDirection(change),
      outcome: "read_failed",
      error,
      result: await this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        ...withoutLaterChange(change),
        last_verification: failedVerification(error),
      }),
    };
  }

  // A write whose outcome is unknown, read while the agent's own later
  // change of the same setting or scenario holds what is there: what this
  // write did shows only once that change is undone, so it stays unknown
  // (and is settled by the next read) and names that change first. Not a
  // change by hand.
  async #finishHiddenByLaterChange(change, later, observedValue, fields = {}) {
    return this.#finishNative(change, "uncertain", observedValue, {
      ...fields,
      conflict_reason: "later_owned_change",
      restore_first_change_id: later.id,
      last_verification: freshVerification("later_owned_change"),
    });
  }

  async #finishObservedValueOwnershipLoss(change, current) {
    if (!manualValueChangeObserved(change)) return undefined;
    if (
      nativeValueRestoration(change).supported &&
      valuesEqual(current, change.baseline_value)
    ) {
      return this.#finishNative(change, "restored", current, {
        manual_change_observed: true,
        last_verification: freshVerification("baseline_value_observed"),
      });
    }
    return this.#finishNative(change, "conflict", current, {
      conflict_reason: "manual_change",
      manual_change_observed: true,
      last_verification: freshVerification(
        valuesEqual(current, change.baseline_value)
          ? "baseline_value_observed"
          : valuesEqual(current, change.requested_value)
            ? "requested_value_observed"
            : "conflict",
      ),
    });
  }

  async #finishSentValueOwnershipLoss(change, current) {
    if (change.status !== "not_owned" || change.native_write_sent !== true) {
      return undefined;
    }
    return this.#finishNative(change, "not_owned", current, {
      conflict_reason: undefined,
      last_verification: freshVerification(
        valuesEqual(current, change.baseline_value)
          ? "baseline_value_observed"
          : valuesEqual(current, change.requested_value)
            ? "requested_value_observed"
            : "current_value_observed",
      ),
    });
  }

  async #finishNative(change, status, observedValue, extra = {}) {
    const now = new Date().toISOString();
    const unresolvedIntent = nativeValueIntentEvidence(change).unresolved;
    if (
      ["applied", "restored"].includes(status) &&
      !Object.hasOwn(extra, "conflict_reason")
    ) {
      change.conflict_reason = undefined;
    }
    Object.assign(change, extra, {
      status,
      ...(observedValue ? { observed_value: observedValue } : {}),
      updated_at: now,
    });
    change.write_intent = change.write_intent
      ? {
          ...change.write_intent,
          phase:
            status === "uncertain" ||
            (status === "conflict" && unresolvedIntent)
              ? "needs_reconciliation"
              : "reconciled",
        }
      : change.write_intent;
    if (status === "conflict") change.configuration_matches = false;
    if (
      status === "uncertain" &&
      !Object.hasOwn(extra, "configuration_matches")
    )
      change.configuration_matches = undefined;
    change.history.push({ status, at: now });
    const saved = await this.#trySave(change);
    return withLocalState(
      publicNativeChange(change, observedValue),
      saved,
      "restore_state_storage_then_get_native_change",
    );
  }

  // A write that did not reach an uncertain outcome ends in the definite
  // status of its direction. When the hub itself refused it, the refusal is
  // kept on the write intent and returned with the error, so the agent sees
  // why instead of an unknown outcome to reconcile.
  async #finishRefusedWrite(change, status, error, observedValue, extra = {}) {
    const rejection = writeRejection(error);
    await this.#finishNative(change, status, observedValue, {
      ...extra,
      ...(rejection && change.write_intent
        ? { write_intent: { ...change.write_intent, rejection } }
        : {}),
    });
    if (rejection) {
      error.details = {
        ...error.details,
        change_ref: `spruthub-change://native/${change.id}`,
        hub_effect: "not_applied",
        rejection,
      };
    }
    return error;
  }

  // A virtual light group is written step by step. A refused step before any
  // other took effect is an ordinary refusal: nothing was created on apply,
  // and on restore the applied group is still complete. Once the hub has
  // acknowledged earlier steps, the home holds part of this change, so it is
  // recorded as get_native_change observes that group, and the error says
  // the effect is partial: restore removes a partly created group, and after
  // a refused restore get shows what is left.
  async #finishRefusedGroupStep(change, direction, error, current) {
    if (!virtualLightGroupPartlyWritten(change, direction)) {
      return this.#finishRefusedWrite(
        change,
        direction === "apply" ? "not_applied" : "applied",
        error,
        undefined,
        current ? { observed_snapshot: current } : {},
      );
    }
    const rejection = writeRejection(error);
    if (rejection) change.write_intent = { ...change.write_intent, rejection };
    let recorded;
    try {
      recorded = await this.#recordVirtualLightGroupState(
        change,
        await this.#observeVirtualLightGroup(change),
      );
    } catch (readError) {
      recorded = await this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(readError),
      });
    }
    const changeRef = `spruthub-change://native/${change.id}`;
    error.details = {
      ...error.details,
      change_ref: changeRef,
      hub_effect: "partial",
      ...(rejection ? { rejection } : {}),
      change: recorded,
      next:
        direction === "apply"
          ? {
              tool: "restore_native_change",
              arguments: { change_ref: changeRef },
            }
          : nativeChangeNext(changeRef),
    };
    return error;
  }

  async #recordNativeObservation(change, observedValue, result) {
    change.observed_value = observedValue;
    change.last_verification = freshVerification(result);
    change.updated_at = new Date().toISOString();
    const saved = await this.#trySave(change);
    return withLocalState(
      publicNativeChange(change, observedValue),
      saved,
      "restore_state_storage_then_get_native_change",
    );
  }

  async #persistNativeIntent(change, status, direction) {
    // Every apply write but a virtual light group's records its intent here
    // first; a change prepared by an earlier version may carry the mark.
    if (direction === "apply") refuseRedactedChangeTexts(change);
    const now = new Date().toISOString();
    Object.assign(change, {
      status,
      native_write_sent: true,
      native_acknowledged: false,
      configuration_matches: undefined,
      configuration_differences: undefined,
      conflict_reason: undefined,
      recovered_after_uncertain_write: undefined,
      write_intent: {
        direction,
        phase: "sending",
        acknowledged: false,
        at: now,
      },
      updated_at: now,
    });
    change.history.push({ status, at: now });
    await this.#saveBeforeWrite(change);
  }

  async #applyScenarioRun(change) {
    if (
      change.status === "applying" &&
      change.run_delivery?.status === "unknown"
    ) {
      const observations = await this.#readScenarioRunTargets(change);
      return this.#finishNative(change, "uncertain", undefined, {
        target_observations: observations,
        last_verification: freshVerification("run_outcome_unknown"),
      });
    }
    if (change.status !== "prepared") return publicStoredNativeChange(change);
    // Earlier versions prepared runs of any type.
    if (!isVerifiedRunType(change.baseline_snapshot)) {
      const error = unverifiedScenarioRunType(change.baseline_snapshot);
      await this.#finishNative(change, "not_applied", undefined, {
        last_verification: failedVerification(error),
      });
      throw error;
    }
    const scenario = await this.client.getScenario(change.target.index);
    const current =
      scenario === null ? null : runnableScenarioSnapshot(scenario);
    if (
      current === null ||
      !runSnapshotsEqual(current, change.baseline_snapshot)
    ) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "scenario_changed",
        configuration_matches: false,
        last_verification: freshVerification("scenario_changed"),
      });
    }
    const plan = await scenarioRunPlan(
      current,
      this.client,
      configuredHomeRef(this.hubSerial),
    );
    if (!isDeepStrictEqual(plan, storedScenarioRunPlan(change))) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "scenario_changed",
        configuration_matches: false,
        last_verification: freshVerification("scenario_changed"),
      });
    }

    change.run_delivery = { status: "unknown" };
    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      await this.client.runScenario(change.target.index);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
      change.run_delivery = { status: "acknowledged" };
    } catch (error) {
      const delivery = classifyScenarioRunDelivery(error);
      change.run_delivery = delivery;
      if (delivery.status !== "unknown") {
        // A refused or unsent run is terminal: apply never sends it again.
        change.native_write_sent = delivery.status !== "not_sent";
        throw await this.#finishRefusedWrite(
          change,
          "not_applied",
          error,
          undefined,
          { last_verification: failedVerification(error) },
        );
      }
      const observations = await this.#readScenarioRunTargets(change);
      return this.#finishNative(change, "uncertain", undefined, {
        target_observations: observations,
        configuration_matches: true,
        last_verification: failedVerification(error),
      });
    }
    const observations = await this.#readScenarioRunTargets(change);
    return this.#finishNative(change, "applied", undefined, {
      target_observations: observations,
      configuration_matches: true,
      last_verification: freshVerification(
        scenarioRunObservationResult(change, observations),
      ),
    });
  }

  async #getScenarioRun(change) {
    if (
      change.status === "applying" &&
      change.run_delivery?.status === "unknown"
    ) {
      change.status = "uncertain";
      change.write_intent = change.write_intent
        ? { ...change.write_intent, phase: "needs_reconciliation" }
        : change.write_intent;
      change.history.push({
        status: "uncertain",
        at: new Date().toISOString(),
      });
    }
    let configurationMatches;
    let verification;
    try {
      const scenario = await this.client.getScenario(change.target.index);
      configurationMatches =
        scenario !== null &&
        runSnapshotsEqual(
          runnableScenarioSnapshot(scenario),
          change.baseline_snapshot,
        );
      verification = freshVerification(
        configurationMatches
          ? "scenario_unchanged"
          : "scenario_changed_after_preparation",
      );
    } catch (error) {
      verification = failedVerification(error);
    }
    const targetObservations = await this.#readScenarioRunTargets(change);
    Object.assign(change, {
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      target_observations: targetObservations,
      last_verification: verification,
      updated_at: new Date().toISOString(),
    });
    const saved = await this.#trySave(change);
    return withLocalState(
      publicNativeChange(change),
      saved,
      "restore_state_storage_then_get_native_change",
    );
  }

  async #readScenarioRunTargets(change) {
    return Promise.all(
      change.targets.map(async (target) => {
        try {
          const characteristic = await this.client.getCharacteristic(
            target.target,
          );
          const observed = typedNativeValue(characteristic.control.value);
          return {
            characteristic_ref: target.characteristic_ref,
            expected_value: structuredClone(target.expected_value),
            observed_value: observed,
            matches: valuesEqual(observed, target.expected_value),
          };
        } catch (error) {
          return {
            characteristic_ref: target.characteristic_ref,
            expected_value: structuredClone(target.expected_value),
            observed_value: null,
            matches: null,
            error: {
              code: error instanceof SprutHubError ? error.code : "read_failed",
            },
          };
        }
      }),
    );
  }

  async #observeProvenScenarioChange(change, current) {
    if (change.owned_target_absent_observed === true) {
      const observation = scenarioChangeObservation(change, current, "applied");
      return this.#recordScenarioObservation(change, {
        matches: false,
        fields: {
          ...observation.fields,
          configuration_matches: false,
          conflict_reason: "manual_change",
          owned_target_absent_observed: true,
        },
      });
    }
    const observation = scenarioChangeObservation(change, current, "applied");
    if (observation.matches) {
      return change.status === "applied"
        ? this.#recordScenarioObservation(change, observation)
        : this.#finishNative(change, "applied", undefined, {
            ...observation.fields,
            logic_assignments: undefined,
          });
    }
    const ownedTargetAbsent =
      ["block_create", "logic_source_create"].includes(change.kind) &&
      current.scenario === null &&
      change.applied_snapshot !== undefined;
    const later = ownedTargetAbsent
      ? undefined
      : await this.#laterOwnedScenarioEdit(change, current.scenario);
    return this.#finishNative(change, "conflict", undefined, {
      ...observation.fields,
      conflict_reason: later ? "later_owned_change" : "manual_change",
      restore_first_change_id: later?.id,
      logic_assignments: undefined,
      ...(ownedTargetAbsent ? { owned_target_absent_observed: true } : {}),
    });
  }

  // The agent's changes of one scenario form one chain: the agent's own
  // later changes of it that still hold (its data or code, a pause, its
  // Name, Desc, OnStart or Sync) account for every field this change set
  // and the scenario no longer holds as it left them. That is no change by
  // hand and costs this change no restore right: the newest of them that
  // changed such a field is undone first. expected is what this change
  // left, its applied snapshot unless its apply is not settled yet.
  async #laterOwnedScenarioEdit(change, scenario, expected) {
    const index = scenarioChainIndex(change);
    const differing = scenarioFieldsDiffering(change, scenario, expected);
    if (index === undefined || !differing?.length) return undefined;
    const later = (await this.store.list()).filter(
      (candidate) =>
        candidate.id !== change.id &&
        candidate.home_ref === change.home_ref &&
        !SCENARIO_CREATE_KINDS.has(candidate.kind) &&
        scenarioChainIndex(candidate) === index &&
        changeStillInEffect(candidate) &&
        compareApplication(candidate, change) > 0 &&
        scenarioEditHolds(candidate, scenario),
    );
    const covered = new Set(later.flatMap(scenarioFieldsOwned));
    if (!differing.every((field) => covered.has(field))) return undefined;
    return later
      .filter((candidate) =>
        scenarioFieldsOwned(candidate).some((field) =>
          differing.includes(field),
        ),
      )
      .sort(compareApplication)
      .at(-1);
  }

  async #applyScenarioChange(change) {
    if (["restored", "superseded", "completed"].includes(change.status))
      return publicStoredNativeChange(change);
    if (
      change.kind === "block_action_pause" &&
      change.status === "not_applied" &&
      Number.isSafeInteger(change.pause_expires_at_ms) &&
      change.pause_expires_at_ms <= Date.now()
    ) {
      return publicStoredNativeChange(change);
    }
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      return (await this.#reconcileScenarioWrite(change)).result;
    }
    const current = await this.#observeScenarioChange(change);
    if (scenarioLacksProvenApply(change)) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: change.conflict_reason ?? "manual_change",
        ...scenarioUnprovenApplyFields(change, current),
      });
    }
    // Proven apply of this change is not resent; observed conflict is not a new write grant.
    if (change.status === "applied" || change.applied_snapshot !== undefined) {
      return this.#observeProvenScenarioChange(change, current);
    }
    const baseline = scenarioChangeObservation(change, current, "baseline");
    if (!baseline.matches) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "baseline_changed",
        ...baseline.fields,
      });
    }

    if (
      change.kind === "block_action_pause" &&
      change.pause_expires_at_ms === undefined
    ) {
      const startedAt = Date.now();
      change.pause_started_at = new Date(startedAt).toISOString();
      change.pause_expires_at_ms = startedAt + change.duration_seconds * 1_000;
      change.pause_expires_at = new Date(
        change.pause_expires_at_ms,
      ).toISOString();
      change.requested_snapshot = buildPauseRequestedSnapshot(change);
    }

    if (isBlockChange(change) && blockUpdateWritesData(change)) {
      const pauseChanges = await this.#knownBlockPauses(change.target_ref);
      const stored =
        change.kind === "block_create"
          ? null
          : scenarioSnapshot(current.scenario).data;
      await validateBlockData(change.requested_snapshot.data, this.client, {
        ...(change.kind === "block_data_update"
          ? { editedFrom: stored }
          : { allowUnknownFrom: stored }),
        allowedPauses: [...pauseChanges, change],
        allowedPauseIntentId:
          change.kind === "block_action_pause" ? change.id : undefined,
        allowActionOnly: change.kind === "block_create",
        scenarioIndex:
          change.kind === "block_data_update" ? change.target.index : undefined,
      });
    }

    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      if (["block_create", "logic_source_create"].includes(change.kind)) {
        const created = await this.client.createScenario(
          change.kind === "block_create"
            ? blockCreateRequest(change)
            : logicSourceCreateRequest(change),
        );
        change.scenario_index = created.index;
      } else if (change.kind === "block_data_update") {
        await this.client.updateScenario(
          change.target.index,
          scenarioUpdateFields(change, change.requested_snapshot),
        );
      } else if (change.kind === "block_action_pause") {
        await this.client.updateScenarioData(
          change.target.index,
          JSON.stringify(change.requested_snapshot.data),
        );
      } else {
        await this.client.updateScenarioData(
          change.target.index,
          change.requested_snapshot.data,
        );
      }
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, "not_applied", error);
      }
      return (await this.#reconcileScenarioApply(change, false)).result;
    }
    return (await this.#reconcileScenarioApply(change, true)).result;
  }

  // A scenario write the journal holds as unknown (applying, restoring or
  // uncertain), settled by a fresh read in its direction.
  async #reconcileScenarioWrite(change) {
    return nativeIntentDirection(change) === "restore"
      ? this.#reconcileScenarioRestore(change, false)
      : this.#reconcileScenarioApply(change, false);
  }

  async #reconcileScenarioApply(change, acknowledged) {
    const settled = (outcome, result) => ({
      direction: "apply",
      outcome,
      result,
    });
    let current;
    try {
      current = await this.#observeScenarioChange(change);
    } catch (error) {
      return this.#finishUnread(change, error);
    }
    const requested = scenarioChangeObservation(change, current, "requested");
    if (requested.matches) {
      this.#adoptRequestedLogicSource(change, current, requested);
      if (change.kind === "block_action_pause") {
        await this.#markReplacedPauseSuperseded(change);
      } else if (change.kind === "block_data_update") {
        await this.#markPauseOutcomes(change, "apply");
      }
      return settled(
        "expected_observed",
        await this.#finishNative(change, "applied", undefined, {
          scenario_index: current.scenario.index,
          applied_snapshot:
            change.applied_snapshot ??
            scenarioChangeSnapshot(change, current.scenario),
          logic_assignments: undefined,
          conflict_reason: undefined,
          ...requested.fields,
          last_verification: freshVerification(
            isLogicSourceChange(change)
              ? "applied_logic_source"
              : "applied_configuration",
          ),
          ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
        }),
      );
    }
    const baseline = scenarioChangeObservation(change, current, "baseline");
    if (baseline.matches) {
      return settled(
        "expected_missing",
        await this.#finishNative(change, "uncertain", undefined, {
          ...requested.fields,
          ...withoutLaterChange(change),
          ...(acknowledged
            ? { conflict_reason: "ack_without_requested_result" }
            : {}),
        }),
      );
    }
    const later = await this.#laterOwnedScenarioEdit(
      change,
      current.scenario,
      scenarioRequestedSnapshot(change),
    );
    if (later) {
      return settled(
        "later_owned_change",
        await this.#finishHiddenByLaterChange(
          change,
          later,
          undefined,
          requested.fields,
        ),
      );
    }
    return settled(
      "conflict",
      await this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "manual_change",
        ...requested.fields,
      }),
    );
  }

  #adoptRequestedLogicSource(change, current, requested) {
    if (
      !isLogicSourceChange(change) ||
      change.applied_snapshot !== undefined ||
      change.native_write_sent !== true ||
      // not_owned after a rejected send still has native_write_sent; a later
      // requested match is coincidence, not ownership of that source.
      ["prepared", "not_applied", "not_owned", "restored", "conflict"].includes(
        change.status,
      ) ||
      !requested.matches
    ) {
      return false;
    }
    if (change.kind === "logic_source_create") {
      change.scenario_index = current.scenario.index;
      recordLogicTypeCheck(change, current);
    }
    change.applied_snapshot = scenarioChangeSnapshot(change, current.scenario);
    change.logic_assignments = undefined;
    change.conflict_reason = undefined;
    return true;
  }

  async #getScenarioChange(change) {
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      return (await this.#reconcileScenarioWrite(change)).result;
    }
    let current;
    try {
      current = await this.#observeScenarioChange(change);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
        configurationMatches: undefined,
      });
    }
    if (change.status === "restored") {
      return this.#recordScenarioObservation(
        change,
        scenarioChangeObservation(change, current, "restored"),
      );
    }
    if (change.applied_snapshot !== undefined) {
      return this.#observeProvenScenarioChange(change, current);
    }
    const requested = scenarioChangeObservation(change, current, "requested");
    if (this.#adoptRequestedLogicSource(change, current, requested)) {
      return this.#finishNative(change, "applied", undefined, {
        ...requested.fields,
      });
    }
    if (change.status === "conflict") {
      return this.#recordScenarioObservation(change, {
        matches: false,
        fields: scenarioUnprovenApplyFields(change, current),
      });
    }
    return this.#recordScenarioObservation(
      change,
      scenarioChangeObservation(change, current, "requested"),
    );
  }

  async #getBlockActionPause(change) {
    if (
      !Number.isSafeInteger(change.pause_expires_at_ms) ||
      ["restored", "not_applied"].includes(change.status)
    ) {
      return this.#getScenarioChange(change);
    }
    if (["superseded", "completed"].includes(change.status)) {
      return publicStoredNativeChange(change);
    }
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      return (await this.#reconcileScenarioWrite(change)).result;
    }
    let current;
    try {
      current = await this.#observeScenarioChange(change);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
        configurationMatches: undefined,
      });
    }
    if (current.scenario === null) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "pause_controller_changed",
        last_verification: freshVerification("scenario_missing"),
      });
    }
    const currentSnapshot = scenarioSnapshot(current.scenario);
    const pauseChanges = await this.#knownBlockPauses(change.target_ref);
    const ownership = inspectPauseOwnership(currentSnapshot.data, pauseChanges);
    const owned = ownership.get(change.id);
    if (owned?.state === "owned") {
      change.current_action_pointer = owned.pointer;
      const observation = scenarioChangeObservation(change, current, "applied");
      return change.status === "applied"
        ? this.#recordScenarioObservation(change, observation)
        : this.#finishNative(change, "applied", undefined, observation.fields);
    }
    const disposition = await this.#knownPauseDisposition(
      change,
      current.scenario,
      pauseChanges,
      ownership,
    );
    if (disposition)
      return this.#finishNative(
        change,
        disposition.status,
        undefined,
        disposition.fields,
      );
    return this.#finishNative(change, "conflict", undefined, {
      conflict_reason: "pause_controller_changed",
      last_verification: freshVerification("pause_controller_changed"),
    });
  }

  async #restoreBlockActionPause(change) {
    if (
      ["restored", "superseded", "completed", "not_applied"].includes(
        change.status,
      )
    )
      return publicStoredNativeChange(change);
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      const pending = await this.#reconcileScenarioWrite(change);
      if (!restoreGoesOn(pending)) return pending.result;
    }
    if (pauseHasNoProvenHubEffect(change)) {
      // Proven non-send: there is no controller to remove. Missing wrapper is
      // not a manual edit, and a coincidental match is not this draft's own.
      const current = await this.#observeScenarioChange(change);
      if (scenarioLacksProvenApply(change)) {
        // Saved unproven conflict stays closed; a later baseline match is not
        // a new apply grant. Legacy pause_controller_changed is not healed.
        return this.#finishNative(change, "conflict", undefined, {
          ...scenarioUnprovenApplyFields(change, current),
          conflict_reason: change.conflict_reason ?? "manual_change",
        });
      }
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "change_was_not_applied",
        ...scenarioChangeObservation(change, current, "baseline").fields,
      });
    }
    const current = await this.#observeScenarioChange(change);
    if (current.scenario === null) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "pause_controller_changed",
        last_verification: freshVerification("scenario_missing"),
      });
    }
    const currentSnapshot = scenarioSnapshot(current.scenario);
    const pauseChanges = await this.#knownBlockPauses(change.target_ref);
    const ownership = inspectPauseOwnership(currentSnapshot.data, pauseChanges);
    const owned = ownership.get(change.id);
    if (owned?.state !== "owned") {
      const disposition = await this.#knownPauseDisposition(
        change,
        current.scenario,
        pauseChanges,
        ownership,
      );
      if (disposition) {
        return this.#finishNative(
          change,
          disposition.status,
          undefined,
          disposition.fields,
        );
      }
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "pause_controller_changed",
        last_verification: freshVerification("pause_controller_missing"),
      });
    }

    change.current_action_pointer = owned.pointer;
    const restoreSnapshot = structuredClone(currentSnapshot);
    replaceBlockValueAtPointer(
      restoreSnapshot.data,
      owned.pointer,
      structuredClone(owned.node.then[0]),
    );
    await validateBlockData(restoreSnapshot.data, this.client, {
      allowUnknownFrom: currentSnapshot.data,
      allowedPauses: pauseChanges.filter(({ id }) => id !== change.id),
    });
    change.restore_snapshot = restoreSnapshot;
    await this.#settleLaterUnknownWrites(change);
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      await this.client.updateScenarioData(
        change.target.index,
        JSON.stringify(restoreSnapshot.data),
      );
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, "applied", error);
      }
      return (await this.#reconcileScenarioRestore(change, false)).result;
    }
    return (await this.#reconcileScenarioRestore(change, true)).result;
  }

  async #markReplacedPauseSuperseded(change) {
    if (typeof change.replaces_pause_change_id !== "string") return;
    let previous;
    try {
      previous = (await this.store.list()).find(
        ({ id }) => id === change.replaces_pause_change_id,
      );
    } catch {
      return;
    }
    if (!previous || previous.status === "superseded") return;
    await this.#finishNative(previous, "superseded", undefined, {
      configuration_matches: true,
      conflict_reason: undefined,
      superseded_by_change_ref: `spruthub-change://native/${change.id}`,
      last_verification: freshVerification("replacement_pause_observed"),
    });
  }

  async #markPauseOutcomes(change, direction) {
    for (const outcome of nativePauseOutcomes(change).filter(
      (candidate) => candidate.direction === direction,
    )) {
      let pause;
      try {
        pause = (await this.store.list()).find(
          (candidate) => candidate.id === outcome.change_id,
        );
      } catch {
        return;
      }
      if (
        !pause ||
        ["completed", "restored", "superseded"].includes(pause.status)
      )
        continue;
      await this.#finishNative(pause, outcome.status, undefined, {
        configuration_matches: true,
        conflict_reason: undefined,
        ...(outcome.status === "completed"
          ? {
              completed_by_change_ref: `spruthub-change://native/${change.id}`,
            }
          : {
              restored_by_change_ref: `spruthub-change://native/${change.id}`,
            }),
        last_verification: freshVerification(
          outcome.status === "completed"
            ? "owned_pause_cleanup_observed"
            : "owned_pause_removal_observed",
        ),
      });
    }
  }

  async #knownPauseDisposition(change, scenario, pauseChanges, ownership) {
    const newer = pauseChanges.find(
      (candidate) =>
        candidate.replaces_pause_change_id === change.id &&
        ([
          "applied",
          "restoring",
          "restored",
          "superseded",
          "completed",
        ].includes(candidate.status) ||
          ownership.get(candidate.id)?.state === "owned"),
    );
    if (newer) {
      return {
        status: "superseded",
        fields: {
          configuration_matches: true,
          conflict_reason: undefined,
          superseded_by_change_ref: `spruthub-change://native/${newer.id}`,
          last_verification: freshVerification("replacement_pause_observed"),
        },
      };
    }
    const settlement = (await this.#knownScenarioChanges(change.target_ref))
      .filter((candidate) => candidate.kind === "block_data_update")
      .flatMap((candidate) =>
        nativePauseOutcomes(candidate).map((outcome) => ({
          candidate,
          outcome,
        })),
      )
      .find(
        ({ candidate, outcome }) =>
          outcome.change_id === change.id &&
          (outcome.direction === "apply"
            ? candidate.applied_snapshot !== undefined ||
              (["applying", "uncertain"].includes(candidate.status) &&
                nativeIntentDirection(candidate) === "apply" &&
                blockMatchesRequested(candidate, scenario))
            : candidate.status === "restored" ||
              (["restoring", "uncertain"].includes(candidate.status) &&
                nativeIntentDirection(candidate) === "restore" &&
                blockStillAtBaseline(candidate, scenario))),
      );
    if (!settlement) return null;
    return {
      status: settlement.outcome.status,
      fields: {
        configuration_matches: true,
        conflict_reason: undefined,
        ...(settlement.outcome.status === "completed"
          ? {
              completed_by_change_ref: `spruthub-change://native/${settlement.candidate.id}`,
            }
          : {
              restored_by_change_ref: `spruthub-change://native/${settlement.candidate.id}`,
            }),
        last_verification: freshVerification(
          settlement.outcome.status === "completed"
            ? "owned_pause_cleanup_observed"
            : "owned_pause_removal_observed",
        ),
      },
    };
  }

  async #restoreScenarioChange(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    let resending = false;
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      const pending = await this.#reconcileScenarioWrite(change);
      if (!restoreGoesOn(pending)) return pending.result;
      resending = pending.direction === "restore";
    }
    // On the way to sending an undo again, a read that no longer shows the
    // change in place may be the first undo arriving late: it is settled
    // as that undo's outcome, restored when the hub is back as before.
    const notInPlace = async (read) =>
      resending
        ? (await this.#reconcileScenarioRestore(change, false)).result
        : this.#observeProvenScenarioChange(change, read);
    const current = await this.#observeScenarioChange(change);
    this.#adoptRequestedLogicSource(
      change,
      current,
      scenarioChangeObservation(change, current, "requested"),
    );
    const applied = scenarioChangeObservation(change, current, "applied");
    if (
      change.applied_snapshot !== undefined &&
      (change.owned_target_absent_observed === true || !applied.matches)
    ) {
      return notInPlace(current);
    }
    if (
      change.applied_snapshot === undefined &&
      !scenarioLacksProvenApply(change)
    ) {
      // A draft was never written; missing applied snapshot is not an owner edit.
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "change_was_not_applied",
        ...scenarioChangeObservation(change, current, "baseline").fields,
      });
    }
    if (scenarioLacksProvenApply(change)) {
      // Keep unproven baseline_changed; a later requested match is not restore
      // rights, and next remains a new prepare.
      return this.#finishNative(change, "conflict", undefined, {
        ...scenarioUnprovenApplyFields(change, current),
        conflict_reason: change.conflict_reason ?? "manual_change",
      });
    }
    if (change.kind === "block_data_update") {
      if (blockUpdateWritesData(change)) {
        const pauseChanges = await this.#knownBlockPauses(change.target_ref);
        let prepared = prepareBlockWriteSource(
          change.baseline_snapshot.data,
          pauseChanges,
          Date.now(),
        );
        // Restore writes the stored original back, so what it keeps from that
        // original passes as stored, like the nodes an edit keeps; bindings,
        // pause controllers and scenario runs are still checked.
        await validateBlockData(prepared.data, this.client, {
          editedFrom: change.baseline_snapshot.data,
          allowedPauses: pauseChanges,
          scenarioIndex: change.target.index,
        });
        // Validation reads current records and can outlast a short pause. Rebuild
        // from the immutable baseline immediately afterwards so that such a pause
        // is not revived by the restore write.
        prepared = prepareBlockWriteSource(
          change.baseline_snapshot.data,
          pauseChanges,
          Date.now(),
        );
        change.restore_snapshot = {
          ...structuredClone(change.baseline_snapshot),
          data: prepared.data,
        };
        change.pause_outcomes = mergePauseOutcomes(
          nativePauseOutcomes(change),
          prepared.pauseOutcomes.map((outcome) => ({
            ...outcome,
            direction: "restore",
          })),
        );
      } else {
        change.restore_snapshot = structuredClone(change.baseline_snapshot);
      }
    }
    if (change.kind === "logic_source_create") {
      const refusal = createdLogicUnmappedRefusal(change);
      if (refusal) throw refusal;
      // SprutHub 3.0.0 (owner hub, 2026-09-24, research/protocol/
      // 2026-09-24-live-conformance-3.md): an assignment made while the
      // LOGIC is on is still listed by logic.list and logic.get once it is
      // off, and a turned-off LOGIC cannot be newly assigned (Not found). So
      // this scan finds every device that uses the LOGIC whether it is on or
      // off, and with none found a turned-off LOGIC is deleted without being
      // turned on.
      const type = createdLogicType(change);
      const assignments = await this.client.findLogicAssignments(type);
      if (assignments.length > 0) {
        return this.#finishNative(change, "conflict", undefined, {
          conflict_reason: "logic_assignments_present",
          logic_assignments: assignments.map(({ aId, sId, active }) => ({
            ref: `${change.home_ref}/accessory/${aId}/service/${sId}/logic/${encodeURIComponent(type)}`,
            active,
          })),
          ...applied.fields,
        });
      }
    }
    if (["block_create", "logic_source_create"].includes(change.kind)) {
      const references = await scenarioTargetReferences(
        this.client,
        change.home_ref,
        change.scenario_index,
      );
      if (references.length > 0) {
        return this.#finishNative(change, "conflict", undefined, {
          conflict_reason: "scenario_targets_present",
          referencing_scenario_targets: references,
          ...applied.fields,
        });
      }
    }
    await this.#settleLaterUnknownWrites(change);
    if (["block_create", "logic_source_create"].includes(change.kind)) {
      // The scans above read every service or BLOCK one after another. The
      // delete goes by index, so the scenario is read again right before the
      // intent is saved: anything changed since the first read, including
      // another scenario at the index, stops it.
      const fresh = await this.#observeScenarioChange(change);
      if (!scenarioChangeObservation(change, fresh, "applied").matches) {
        return notInPlace(fresh);
      }
      if (change.kind === "logic_source_create") {
        // The fresh read checked the type again.
        const refusal = createdLogicUnmappedRefusal(change);
        if (refusal) throw refusal;
        // Saved with the restore intent: which type's assignments this
        // delete was checked against (logicDeleteAssignmentCheckUnproven).
        change.logic_delete_checked_type = createdLogicType(change);
      }
    }
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      if (["block_create", "logic_source_create"].includes(change.kind)) {
        await this.client.deleteScenario(change.scenario_index);
      } else if (change.kind === "block_data_update") {
        await this.client.updateScenario(
          change.target.index,
          scenarioUpdateFields(
            change,
            change.restore_snapshot ?? change.baseline_snapshot,
          ),
        );
      } else {
        await this.client.updateScenarioData(
          change.target.index,
          change.baseline_snapshot.data,
        );
      }
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        // A refused resend may meet what its late first undo did (a delete
        // of what it deleted): it stands only when the read shows the
        // change still in place.
        if (resending) {
          const settled = await this.#reconcileScenarioRestore(change, false);
          if (settled.outcome !== "expected_missing") return settled.result;
        }
        throw await this.#finishRefusedWrite(change, "applied", error);
      }
      return (await this.#reconcileScenarioRestore(change, false)).result;
    }
    return (await this.#reconcileScenarioRestore(change, true)).result;
  }

  // A restore of a scenario change whose outcome was unknown, as a setting's
  // is (reconcilePendingValueChange): back as before is restored; the
  // agent's change still in place did not take effect and is sent again by
  // the next restore (restoreGoesOn); anything else changed since, by the
  // agent's own later change of the scenario or by hand.
  async #reconcileScenarioRestore(change, acknowledged) {
    const settled = (outcome, result) => ({
      direction: "restore",
      outcome,
      result,
    });
    let current;
    try {
      current = await this.#observeScenarioChange(change);
    } catch (error) {
      return this.#finishUnread(change, error);
    }
    const baseline = scenarioChangeObservation(change, current, "restored");
    if (baseline.matches) {
      if (change.kind === "block_data_update") {
        await this.#markPauseOutcomes(change, "restore");
      }
      return settled(
        "expected_observed",
        await this.#finishNative(change, "restored", undefined, {
          logic_assignments: undefined,
          referencing_scenario_targets: undefined,
          ...baseline.fields,
          ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
        }),
      );
    }
    const unconfirmed = async () =>
      this.#finishNative(change, "uncertain", undefined, {
        ...baseline.fields,
        ...withoutLaterChange(change),
        ...(acknowledged
          ? { conflict_reason: "ack_without_requested_result" }
          : {}),
      });
    if (scenarioChangeObservation(change, current, "applied").matches) {
      return settled(
        "expected_missing",
        withRestoreAgainNext(await unconfirmed(), change),
      );
    }
    // A created LOGIC gone while its type is still listed: nothing tells
    // what happened.
    if (current.scenario === null && SCENARIO_CREATE_KINDS.has(change.kind)) {
      return settled("unexplained", await unconfirmed());
    }
    const later = await this.#laterOwnedScenarioEdit(change, current.scenario);
    if (later) {
      return settled(
        "later_owned_change",
        await this.#finishHiddenByLaterChange(
          change,
          later,
          undefined,
          baseline.fields,
        ),
      );
    }
    return settled(
      "conflict",
      await this.#finishNative(change, "conflict", undefined, {
        ...baseline.fields,
        conflict_reason: "manual_change",
        restore_first_change_id: undefined,
      }),
    );
  }

  async #recordScenarioObservation(change, observation) {
    Object.assign(change, observation.fields);
    change.updated_at = new Date().toISOString();
    const saved = await this.#trySave(change);
    return withLocalState(
      publicNativeChange(change),
      saved,
      "restore_state_storage_then_get_native_change",
    );
  }

  async #observeScenarioChange(change) {
    if (isBlockChange(change)) {
      return { scenario: await this.#observeBlock(change), logicTypes: [] };
    }
    let scenario;
    if (change.kind === "logic_source_update") {
      scenario = await this.client.getScenario(change.target.index);
    } else if (change.scenario_index) {
      scenario = await this.client.getScenario(change.scenario_index);
    } else {
      const scenarios = await this.client.listScenarioDetails();
      const matches = scenarios.filter((candidate) =>
        logicSourceCarriesOwnershipMarker(change, candidate),
      );
      if (matches.length > 1) {
        throw new SprutHubError(
          "ambiguous_owned_scenario",
          "More than one LOGIC source carries this native change marker.",
          "home_overview",
        );
      }
      scenario = matches[0] ?? null;
    }
    if (change.kind !== "logic_source_create") {
      return { scenario, logicTypes: [] };
    }
    // A create not sent yet still needs its anchor; once sent, the LOGIC is
    // read, adopted and restored without it (logicTypes null).
    const current = {
      scenario,
      logicTypes: await this.#readLogicTypeCatalog(change.target, {
        anchorMayBeGone: change.native_write_sent === true,
      }),
    };
    // Every read of a created LOGIC at its recorded index checks its type;
    // an adopting read records the index first (adoptRequestedLogicSource).
    if (change.scenario_index !== undefined) {
      recordLogicTypeCheck(change, current);
    }
    return current;
  }

  async #observeBlock(change) {
    if (["block_data_update", "block_action_pause"].includes(change.kind)) {
      return this.client.getScenario(change.target.index);
    }
    if (change.scenario_index) {
      const scenario = await this.client.getScenario(change.scenario_index);
      // Proven create is bound to the recorded index; a marker copy elsewhere
      // must not replace a confirmed absence.
      if (scenario || change.applied_snapshot !== undefined) {
        return scenario ?? null;
      }
    }
    const scenarios = await this.client.listScenarioDetails({
      descriptionIncludes: `[${change.marker}]`,
    });
    const matches = scenarios.filter(
      ({ desc }) =>
        typeof desc === "string" && desc.includes(`[${change.marker}]`),
    );
    if (matches.length > 1) {
      throw new SprutHubError(
        "ambiguous_owned_scenario",
        "More than one scenario carries this native change marker.",
        "home_overview",
      );
    }
    return matches[0] ?? null;
  }

  // A spruthub-change://automation ref names a rule that the boolean
  // automation tools of 0.4.0 and earlier created. They are gone; their
  // records stay readable (get_native_change) and undoable
  // (restore_native_change), and nothing new is written under such a ref.
  async #getAutomationChange(id) {
    const change = await this.#requireAutomationChange(id);
    const reconciliation = await this.#reconcile(change);
    const observation = observeReconciliation(change, reconciliation);
    if (observation.kind !== "absent") {
      return observationResult(change, observation);
    }
    if (["deleting", "rollback_uncertain"].includes(change.status)) {
      return rolledBackResult(change, false);
    }
    if (["prepared", "rolled_back"].includes(change.status)) {
      return publicChange(change);
    }
    return uncertainResult(change);
  }

  async #rollbackAutomation(change) {
    const changeReference = changeRef(change.id);
    if (
      change.status === "prepared" ||
      (change.status === "already_present" && change.owned === false)
    ) {
      return {
        ...publicChange(change),
        status: "not_owned",
        action: "leave_existing_scenario_unchanged",
      };
    }
    const reconciliation = await this.#reconcile(change);
    const observation = observeReconciliation(change, reconciliation);
    if (observation.kind === "absent") {
      if (["creating", "uncertain"].includes(change.status)) {
        return this.#finish(change, { status: "uncertain" }, uncertainResult);
      }
      return this.#finish(change, { status: "rolled_back" }, (current) =>
        rolledBackResult(current, false),
      );
    }
    if (observation.kind !== "owned_match") {
      return this.#finishObservation(change, observation);
    }
    change.status = "deleting";
    change.updated_at = new Date().toISOString();
    await this.#saveBeforeWrite(change);
    try {
      await this.client.deleteScenario(observation.scenario.index);
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        error.details = await this.#finishKnownNoEffect(
          change,
          changeReference,
          "applied",
          error,
        );
        throw error;
      }
      try {
        const afterUncertainDelete = await this.#reconcile(change);
        return this.#finishDeleteReadback(change, afterUncertainDelete, true);
      } catch {
        return this.#finish(
          change,
          { status: "rollback_uncertain" },
          uncertainResult,
        );
      }
    }
    let afterDelete;
    try {
      afterDelete = await this.#reconcile(change);
    } catch {
      return this.#finish(
        change,
        { status: "rollback_uncertain" },
        uncertainResult,
      );
    }
    return this.#finishDeleteReadback(change, afterDelete, false);
  }

  // An automation ref names only such an earlier record, never a native
  // change of the same journal. A record without home_ref is from before
  // home-qualified refs.
  async #requireAutomationChange(id) {
    const change = await this.store.get(id);
    if (!change || isNativeChange(change)) {
      throw new SprutHubError(
        "change_not_found",
        "The automation change was not found for this configured hub.",
        "get_native_change",
        { next: { tool: "get_native_change", arguments: {} } },
      );
    }
    if (
      change.home_ref !== undefined &&
      change.home_ref !== configuredHomeRef(this.hubSerial)
    ) {
      throw unsupportedHomeWrite();
    }
    return change;
  }

  async #reconcile(change) {
    const scenarios = await this.client.listScenarioDetails();
    const ownedCandidates = scenarios.filter(
      ({ desc }) =>
        typeof desc === "string" && desc.includes(`[${change.marker}]`),
    );
    if (ownedCandidates.length > 1) {
      throw new SprutHubError(
        "ambiguous_owned_scenario",
        "More than one scenario carries this change marker.",
        "inspect_hub",
      );
    }
    const scenario =
      scenarios.find(({ index }) => index === change.scenario_index) ??
      ownedCandidates[0];
    const owned = scenario !== undefined && ownedCandidates.includes(scenario);
    const related = relatedRules(
      scenarios.filter((candidate) => !ownedCandidates.includes(candidate)),
      change,
      configuredHomeRef(this.hubSerial),
    );
    const equivalents = related
      .filter(({ relation }) => relation === "equivalent")
      .map((candidate) => candidate.scenario);
    return {
      scenario,
      owned,
      matches: owned && matchesExpected(scenario, change),
      equivalent: equivalents.find(matchesRequiredRuntime),
      runtimeConflict: equivalents.find(
        (candidate) => !matchesRequiredRuntime(candidate),
      ),
      superset: related.find(({ relation }) => relation === "superset"),
    };
  }

  async #finishDeleteReadback(change, reconciliation, recovered) {
    const observation = observeReconciliation(change, reconciliation);
    if (observation.kind === "absent") {
      return this.#finish(change, { status: "rolled_back" }, (current) => ({
        ...rolledBackResult(current, true),
        ...(recovered ? { recovered_after_uncertain_write: true } : {}),
      }));
    }
    if (observation.kind !== "owned_match") {
      return this.#finishObservation(change, observation);
    }
    return this.#finish(
      change,
      { status: "rollback_uncertain" },
      uncertainResult,
    );
  }

  async #finishObservation(change, observation, extra = {}) {
    return this.#finish(change, observationState(observation), (current) => ({
      ...observationResult(current, observation),
      ...extra,
    }));
  }

  async #finishKnownNoEffect(change, changeReference, status, error) {
    const rejection = writeRejection(error);
    return this.#finish(change, { status }, () => ({
      ...error.details,
      change_ref: changeReference,
      hub_effect: "not_applied",
      ...(rejection ? { rejection } : {}),
    }));
  }

  async #finish(change, state, makeResult) {
    Object.assign(change, state, { updated_at: new Date().toISOString() });
    const localStateSaved = await this.#trySave(change);
    return withLocalState(makeResult(change), localStateSaved);
  }

  async #trySave(change) {
    try {
      await this.store.save(change);
      return true;
    } catch {
      return false;
    }
  }

  async #saveBeforeWrite(change) {
    try {
      await this.store.save(change);
    } catch {
      throw new SprutHubError(
        "state_storage_unavailable",
        "Could not save the recovery state required before writing to SprutHub.",
        "restore_state_storage_then_retry",
      );
    }
  }

  async #readJournalBeforeWrite() {
    try {
      return await this.store.list();
    } catch {
      throw new SprutHubError(
        "state_storage_unavailable",
        "Could not read the recovery state required before writing to SprutHub, so nothing was sent.",
        "restore_state_storage_then_retry",
      );
    }
  }

  async #exclusiveWrite(operation) {
    const current = this.#writeSequence.catch(() => {}).then(operation);
    this.#writeSequence = current;
    return current;
  }
}

function accessoryPlacementSnapshot(accessory, room) {
  return {
    name: accessory.name,
    room_id: accessory.roomId,
    room_name: room?.name ?? null,
    binding: {
      id: accessory.id,
      endpoint: accessory.endpoint ?? null,
      extension_key: accessory.extensionKey ?? null,
      controller_index: accessory.controllerIndex ?? null,
      device_id: accessory.deviceId ?? null,
      device_window: accessory.deviceWindow ?? null,
      services: (accessory.services ?? [])
        .map(({ sId, type }) => ({ id: sId, type }))
        .sort((left, right) => left.id - right.id),
    },
  };
}

function accessoryPlacementMatches(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.name === right.name &&
    left.room_id === right.room_id &&
    isDeepStrictEqual(left.binding, right.binding)
  );
}

function validateVirtualLightCharacteristicTypes(types) {
  const required = ["On", "Brightness"];
  if (
    !Array.isArray(types) ||
    types.length !== required.length ||
    new Set(types).size !== types.length ||
    !required.every((type) => types.includes(type))
  ) {
    throw new SprutHubError(
      "unsupported_group_characteristics",
      "This virtual light path requires exactly the common On and Brightness controls.",
      "get_entity",
    );
  }
  return required;
}

function characteristicTypeName(type) {
  return type?.type ?? type?.shortId ?? null;
}

function validateVirtualLightServiceType(serviceType, characteristicTypes) {
  if (!serviceType) {
    throw new SprutHubError(
      "unsupported_virtual_light",
      "SprutHub did not advertise the native Lightbulb service type.",
      "get_native_change_contract",
    );
  }
  const required = new Set(serviceType.required.map(characteristicTypeName));
  const optional = new Set(serviceType.optional.map(characteristicTypeName));
  if (
    !required.has("On") ||
    !characteristicTypes.every(
      (type) => required.has(type) || optional.has(type),
    )
  ) {
    throw new SprutHubError(
      "unsupported_virtual_light",
      "The current native Lightbulb catalog cannot create the requested On and Brightness controls.",
      "get_native_change_contract",
    );
  }
}

function selectVirtualLightMember(ref, target, accessory, characteristicTypes) {
  if (accessory.id !== target.aId) {
    throw new SprutHubError(
      "binding_changed",
      "SprutHub returned a different group member than requested.",
      "get_entity",
    );
  }
  if (accessory.online !== true) {
    throw new SprutHubError(
      "device_unavailable",
      "A selected virtual light member is currently unavailable.",
      "retry",
    );
  }
  const service = accessory.services?.find(({ sId }) => sId === target.sId);
  if (service?.type !== "Lightbulb") {
    throw new SprutHubError(
      "unsupported_group_member",
      "Every virtual light member must reference a native Lightbulb service.",
      "get_entity",
    );
  }
  const characteristics = Object.fromEntries(
    characteristicTypes.map((type) => {
      const matches = (service.characteristics ?? []).filter(
        (characteristic) =>
          (characteristic.control?.type ?? characteristic.control?.key) ===
          type,
      );
      if (
        matches.length !== 1 ||
        matches[0].control?.read !== true ||
        matches[0].control?.write !== true
      ) {
        throw new SprutHubError(
          "unsupported_group_characteristics",
          `A selected member does not expose one readable and writable ${type} characteristic.`,
          "get_entity",
        );
      }
      const contract = characteristicContract(matches[0].control, {
        requireWrite: true,
      });
      if (
        (type === "On" && contract.kind !== "boolValue") ||
        (type === "Brightness" &&
          !["intValue", "longValue", "doubleValue"].includes(contract.kind))
      ) {
        throw new SprutHubError(
          "unsupported_group_characteristics",
          `The ${type} characteristic has an incompatible native value type.`,
          "get_entity",
        );
      }
      return [
        type,
        {
          aId: accessory.id,
          sId: service.sId,
          cId: matches[0].cId,
        },
      ];
    }),
  );
  return {
    ref,
    accessory_ref: ref.replace(/\/service\/\d+$/, ""),
    name: service.name,
    target,
    characteristics,
  };
}

function selectCreatedVirtualLight(accessory, change) {
  if (accessory.virtual !== true || accessory.roomId !== change.room_id) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub created an accessory outside the requested virtual-light scope.",
      "get_native_change",
      { requestSent: true },
    );
  }
  return createdVirtualLightTarget(accessory, change);
}

function createdVirtualLightTarget(accessory, change) {
  const services = (accessory.services ?? []).filter(
    ({ type }) => type === "Lightbulb",
  );
  if (services.length !== 1) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub did not return exactly one created Lightbulb service.",
      "get_native_change",
      { requestSent: true },
    );
  }
  const service = services[0];
  const characteristics = Object.fromEntries(
    change.characteristic_types.map((type) => {
      const matches = (service.characteristics ?? []).filter(
        (characteristic) =>
          (characteristic.control?.type ?? characteristic.control?.key) ===
          type,
      );
      if (matches.length !== 1) {
        throw new SprutHubError(
          "incompatible_response",
          `SprutHub did not return exactly one created ${type} characteristic.`,
          "get_native_change",
          { requestSent: true },
        );
      }
      if ((matches[0].linkProcessing ?? 0) !== 0) {
        throw new SprutHubError(
          "unsupported_virtual_light",
          `The created ${type} characteristic does not use last-value feedback by default.`,
          "get_native_change",
          { requestSent: true },
        );
      }
      const contract = characteristicContract(matches[0].control, {
        requireWrite: true,
      });
      if (
        (type === "On" && contract.kind !== "boolValue") ||
        (type === "Brightness" &&
          !["intValue", "longValue", "doubleValue"].includes(contract.kind))
      ) {
        throw new SprutHubError(
          "incompatible_response",
          `SprutHub returned an incompatible created ${type} characteristic.`,
          "get_native_change",
          { requestSent: true },
        );
      }
      return [
        type,
        { aId: accessory.id, sId: service.sId, cId: matches[0].cId },
      ];
    }),
  );
  return {
    target: { aId: accessory.id, sId: service.sId, characteristics },
  };
}

function virtualAccessoryStructure(accessory) {
  return {
    id: accessory.id,
    name: accessory.name,
    room_id: accessory.roomId,
    virtual: accessory.virtual === true,
    services: (accessory.services ?? [])
      .map((service) => ({
        id: service.sId,
        name: service.name,
        type: service.type,
        characteristics: (service.characteristics ?? [])
          .map((characteristic) => ({
            id: characteristic.cId,
            name: characteristic.control?.name ?? null,
            type:
              characteristic.control?.type ??
              characteristic.control?.key ??
              null,
            read: characteristic.control?.read === true,
            write: characteristic.control?.write === true,
          }))
          .sort((left, right) => left.id - right.id),
      }))
      .sort((left, right) => left.id - right.id),
  };
}

function findNativeCharacteristic(accessory, { sId, cId }) {
  return accessory.services
    ?.find((service) => service.sId === sId)
    ?.characteristics?.find((characteristic) => characteristic.cId === cId);
}

function virtualLightSettingsSnapshot(accessory, target, types) {
  return Object.fromEntries(
    types.map((type) => {
      const characteristic = findNativeCharacteristic(
        accessory,
        target.characteristics[type],
      );
      return [
        type,
        {
          has_links: characteristic?.hasLinks === true,
          link_processing: characteristic?.linkProcessing ?? 0,
        },
      ];
    }),
  );
}

function virtualLinkTarget({ aId, sId, cId }) {
  return { tAId: aId, tSId: sId, tCId: cId };
}

function normalizeVirtualLinks(links) {
  return links
    .map((link) => ({
      index: link.index,
      type: link.type,
      characteristics: link.characteristics
        .map(({ aId, sId, cId }) => ({ aId, sId, cId }))
        .sort((left, right) =>
          nativeTargetKey(left).localeCompare(nativeTargetKey(right)),
        ),
    }))
    .sort((left, right) =>
      `${left.type}:${left.index}`.localeCompare(
        `${right.type}:${right.index}`,
      ),
    );
}

function normalizePhysicalLinks(links) {
  return links
    .map((link) => ({
      index: link.index,
      type: link.type,
      ...(link.controller !== undefined ? { controller: link.controller } : {}),
      characteristics: link.characteristics
        .map(({ aId, sId, cId }) => ({ aId, sId, cId }))
        .sort((left, right) =>
          nativeTargetKey(left).localeCompare(nativeTargetKey(right)),
        ),
    }))
    .sort((left, right) =>
      `${left.type}:${left.index}`.localeCompare(
        `${right.type}:${right.index}`,
      ),
    );
}

function physicalLinkBaseline(change, artifact) {
  return change.physical_link_baselines.find(
    (baseline) =>
      baseline.type === artifact.type &&
      baseline.member_ref === artifact.member_ref &&
      nativeTargetKey(baseline.target) === nativeTargetKey(artifact.target),
  );
}

function virtualLightProgressLink(change, cleanup) {
  return change.progress.links.find(
    (link) =>
      link.type === cleanup.type && link.member_ref === cleanup.member_ref,
  );
}

function physicalLinkArtifact(change, progress, cleanup) {
  const recordedArtifact = change.physical_link_artifacts?.find(
    (candidate) =>
      candidate.type === progress.type &&
      candidate.member_ref === progress.member_ref,
  );
  return {
    type: progress.type,
    member_ref: progress.member_ref,
    target: progress.target,
    source: change.virtual_target.characteristics[progress.type],
    index: cleanup?.link_id ?? progress.link_id ?? recordedArtifact?.index,
  };
}

function samePhysicalLink(left, right) {
  return (
    left.type === right.type &&
    left.index === right.index &&
    left.controller === right.controller
  );
}

function physicalLinkContains(observed, expected) {
  if (
    observed.type !== expected.type ||
    observed.index !== expected.index ||
    observed.controller !== expected.controller
  ) {
    return false;
  }
  const observedCharacteristics = new Set(
    observed.characteristics.map(nativeTargetKey),
  );
  return expected.characteristics.every((characteristic) =>
    observedCharacteristics.has(nativeTargetKey(characteristic)),
  );
}

function physicalLinksPreservedAcrossOwnRemoval(
  beforeLinks,
  baselineLinks,
  source,
) {
  const sourceKey = nativeTargetKey(source);
  return beforeLinks.flatMap((link) => {
    if (
      link.type !== "OUT" ||
      !link.characteristics.some(
        (characteristic) => nativeTargetKey(characteristic) === sourceKey,
      )
    ) {
      return [structuredClone(link)];
    }
    const withoutOwnedSource = {
      ...structuredClone(link),
      characteristics: link.characteristics.filter(
        (characteristic) => nativeTargetKey(characteristic) !== sourceKey,
      ),
    };
    if (withoutOwnedSource.characteristics.length > 0) {
      return [withoutOwnedSource];
    }
    const preExistingEmptyLink = baselineLinks.some(
      (candidate) =>
        samePhysicalLink(candidate, link) &&
        candidate.characteristics.length === 0,
    );
    return preExistingEmptyLink ? [withoutOwnedSource] : [];
  });
}

function nativeEmptyPhysicalLinkResidue(link, baselineLinks, index) {
  if (
    link.type !== "OUT" ||
    link.index !== index ||
    link.characteristics.length > 0
  ) {
    return null;
  }
  return baselineLinks.some((candidate) => samePhysicalLink(candidate, link))
    ? null
    : structuredClone(link);
}

function virtualLinkRelation(links, target) {
  const key = nativeTargetKey(target);
  for (const link of links) {
    if (
      link.type === "IN" &&
      link.characteristics.some(
        (characteristic) => nativeTargetKey(characteristic) === key,
      )
    ) {
      return { present: true, linkId: link.index };
    }
  }
  return { present: false, linkId: null };
}

function expectedTargetsForType(change, type) {
  return change.progress.links
    .filter((link) => link.type === type)
    .map((link) => link.target);
}

function unexpectedVirtualLinks(links, expectedTargets) {
  const expected = new Set(expectedTargets.map(nativeTargetKey));
  const seen = new Set();
  const unexpected = [];
  for (const link of links) {
    if (link.type !== "IN") {
      unexpected.push({ type: link.type, index: link.index });
      continue;
    }
    if (link.characteristics.length !== 1) {
      unexpected.push({
        type: "invalid_incoming_link_cardinality",
        index: link.index,
      });
    }
    for (const target of link.characteristics) {
      const key = nativeTargetKey(target);
      if (!expected.has(key) || seen.has(key)) unexpected.push(target);
      seen.add(key);
    }
  }
  return unexpected;
}

function virtualLinkSettingsMatch(characteristic) {
  return (
    characteristic?.hasLinks === true &&
    (characteristic.linkProcessing ?? 0) === 0
  );
}

function completeVirtualLightConfiguration(change, observation) {
  if (observation.absent) return false;
  if (
    !isDeepStrictEqual(observation.accessory, change.created_accessory_snapshot)
  ) {
    return false;
  }
  for (const type of change.characteristic_types) {
    const links = observation.links[type];
    if (
      unexpectedVirtualLinks(links, expectedTargetsForType(change, type))
        .length > 0 ||
      !expectedTargetsForType(change, type).every(
        (target) => virtualLinkRelation(links, target).present,
      ) ||
      observation.link_settings[type]?.has_links !== true ||
      observation.link_settings[type]?.link_processing !== 0
    ) {
      return false;
    }
  }
  return true;
}

function safeOwnedVirtualLightConfiguration(change, observation) {
  if (
    observation.absent ||
    !isDeepStrictEqual(observation.accessory, change.created_accessory_snapshot)
  ) {
    return false;
  }
  for (const type of change.characteristic_types) {
    const links = observation.links[type];
    if (
      unexpectedVirtualLinks(links, expectedTargetsForType(change, type))
        .length > 0
    ) {
      return false;
    }
    for (const target of expectedTargetsForType(change, type)) {
      const progress = change.progress.links.find(
        (link) =>
          link.type === type &&
          nativeTargetKey(link.target) === nativeTargetKey(target),
      );
      if (
        virtualLinkRelation(links, target).present &&
        progress?.sent !== true
      ) {
        return false;
      }
    }
    const setting = change.progress.settings.find(
      (candidate) => candidate.type === type,
    );
    const observedSetting = observation.link_settings[type];
    const matchesConfigured =
      observedSetting?.has_links === true &&
      observedSetting?.link_processing === 0;
    const matchesCreated = isDeepStrictEqual(
      observedSetting,
      change.created_link_settings[type],
    );
    if (
      setting?.sent === true
        ? !matchesConfigured
        : !matchesCreated && !matchesConfigured
    ) {
      return false;
    }
  }
  return true;
}

function safeRestoringVirtualLightConfiguration(change, observation) {
  if (
    !change.progress.cleanup ||
    observation.absent ||
    !isDeepStrictEqual(observation.accessory, change.created_accessory_snapshot)
  ) {
    return false;
  }
  for (const type of change.characteristic_types) {
    if (
      unexpectedVirtualLinks(
        observation.links[type],
        expectedTargetsForType(change, type),
      ).length > 0
    ) {
      return false;
    }
    const cleanupSetting = change.progress.cleanup.settings.find(
      (candidate) => candidate.type === type,
    );
    const observedSetting = observation.link_settings[type];
    const expectedHasLinks = cleanupSetting?.sent !== true;
    if (
      observedSetting?.has_links !== expectedHasLinks ||
      observedSetting?.link_processing !== 0
    ) {
      return false;
    }
  }
  return true;
}

// Room, name and services of the light a group change creates. Whether the
// accessory is virtual is read separately with accessory.get.
function hasVirtualLightShape(
  accessory,
  change,
  { allowNormalizedName = false } = {},
) {
  if (
    accessory.roomId !== change.room_id ||
    (!allowNormalizedName && accessory.name !== change.requested_name)
  ) {
    return false;
  }
  try {
    createdVirtualLightTarget(accessory, change);
    return true;
  } catch {
    return false;
  }
}

// Whether the home holds part of this group change: its accessory exists
// after apply created it; on restore, the applied group is incomplete once a
// cleanup step completed, or when it was never completely applied.
function virtualLightGroupPartlyWritten(change, direction) {
  if (change.created_accessory_id === undefined) return false;
  if (direction === "apply") return true;
  const cleanup = change.progress.cleanup;
  return (
    change.applied_snapshot === undefined ||
    [...(cleanup?.links ?? []), ...(cleanup?.settings ?? [])].some(
      ({ completed }) => completed === true,
    )
  );
}

function virtualLightAllWritesAcknowledged(change) {
  return (
    change.progress.creation.acknowledged === true &&
    change.progress.links.every(({ acknowledged }) => acknowledged === true) &&
    change.progress.settings.every(
      ({ acknowledged }) => acknowledged === true,
    ) &&
    (change.progress.cleanup === undefined ||
      (change.progress.cleanup.links.every(
        ({ sent, acknowledged }) => !sent || acknowledged === true,
      ) &&
        change.progress.cleanup.settings.every(
          ({ sent, acknowledged }) => !sent || acknowledged === true,
        ))) &&
    (change.progress.deletion === undefined ||
      change.progress.deletion.acknowledged === true)
  );
}

function roomSnapshot(room) {
  return {
    id: room.id,
    name: room.name,
    order: room.order ?? null,
    visible: room.visible ?? null,
  };
}

function publicRoom(room, serial) {
  return {
    ref: `${configuredHomeRef(serial)}/room/${room.id}`,
    name: room.name,
  };
}

function publicAccessoryPlacement(snapshot, serial) {
  return {
    name: snapshot.name,
    room_ref: `${configuredHomeRef(serial)}/room/${snapshot.room_id}`,
    room_name: snapshot.room_name,
  };
}

function parseDeviceCommandTargets(commands, configuredSerial) {
  const invalid = [];
  const firstIndexByTarget = new Map();
  const targets = commands.map((command, index) => {
    let target;
    try {
      target = parseCharacteristicRef(command.target_ref, configuredSerial);
    } catch (error) {
      if (!isDeviceCommandRejection(error)) throw error;
      invalid.push(invalidDeviceCommand(index, command, error));
      return null;
    }
    const key = nativeTargetKey(target);
    if (firstIndexByTarget.has(key)) {
      invalid.push({
        index,
        target_ref: command.target_ref,
        code: "duplicate_target",
        message: `Command ${firstIndexByTarget.get(key)} already targets this characteristic; send one value per characteristic.`,
      });
    } else {
      firstIndexByTarget.set(key, index);
    }
    return target;
  });
  if (invalid.length > 0) throw invalidDeviceCommands(invalid);
  return targets;
}

function invalidDeviceCommand(index, command, error, contract) {
  return {
    index,
    target_ref: command.target_ref,
    code: error.code,
    message: error.message,
    ...(error.action ? { action: error.action } : {}),
    ...(error.code === "invalid_native_value" && contract ? { contract } : {}),
  };
}

function invalidDeviceCommands(invalid) {
  return new SprutHubError(
    "invalid_device_commands",
    "No command was sent. Fix every command listed in invalid_commands and call send_device_commands again.",
    "send_device_commands",
    { invalid_commands: invalid },
  );
}

function latestSentValueCommand(changes, homeRef, target) {
  const key = nativeTargetKey(target);
  let latest;
  for (const change of changes) {
    if (
      change.kind !== "characteristic_value" ||
      change.home_ref !== homeRef ||
      change.native_write_sent !== true ||
      !change.target ||
      nativeTargetKey(change.target) !== key
    ) {
      continue;
    }
    if (
      latest === undefined ||
      (change.write_intent?.at ?? "") > (latest.write_intent?.at ?? "")
    ) {
      latest = change;
    }
  }
  return latest;
}

function deviceCommandName(accessory, { sId }) {
  if (typeof accessory?.name !== "string") return null;
  const service = accessory.services?.find((entry) => entry.sId === sId);
  return sanitizeNativeData(
    typeof service?.name === "string"
      ? `${accessory.name} / ${service.name}`
      : accessory.name,
  );
}

// Devices whose commands are under way at once in one send_device_commands
// call. The owner's hub took 48 writes in flight on one socket without an
// error or a wrong result (2026-10-13-parallel-writes); 32 stays below that
// and still covers the largest room of the owner's home (20 light services)
// in one round.
const DEVICE_COMMAND_CONCURRENCY = 32;

const LAMP_LEVEL_ZERO_NOTE = {
  code: "lamp_level_zero_is_off",
  message:
    "Sent as the lamp's off (sent_as), one write with any off of the same lamp in this call: previous_value and observed_value are its on/off, and its brightness stays as it was.",
};

const LAMP_KEPT_OFF_NOTE = {
  code: "lamp_level_not_sent",
  message:
    "Not sent: the lamp was off and this call keeps it off, and the on/level link the hub assigns to dimmable lamps switches an off lamp on at a brightness write (a color write is held back the same way). The lamp stays off; set this once it is on, or send it with the lamp's On=true.",
};

const LAMP_SWITCHED_ON_NOTE = {
  code: "lamp_switched_on",
  message:
    "The lamp was off before this call and is on now: on the hub's lamps a brightness write switches an off lamp on.",
};

// Calls operation for each item with at most limit under way, resolving to
// the results in the items' order.
async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// The commands of one call by device, each device's in the order they are
// sent. A lamp's off goes after the level and color commands of the same
// lamp: a level write switches a lamp with «Связь включения и уровня» on,
// so [On=false, Brightness=70] sent in that order ends on at 70
// (2026-10-13-lamp-logic-undo, U2 and U4). A lamp already off gets no level
// at all beside its off (lampKeptOff). Other commands keep the call's
// order.
function deviceCommandRuns(items) {
  const lampLevels = new Set(
    items
      .filter(({ onTarget }) => onTarget)
      .map(({ onTarget }) => serviceKey(onTarget)),
  );
  const lampOff = ({ draft }) =>
    draft.contract.type === "On" &&
    draft.requested.value === false &&
    lampLevels.has(serviceKey(draft.fields.target));
  const runs = new Map();
  for (const item of items) {
    const run = runs.get(item.draft.fields.target.aId) ?? [];
    run.push(item);
    runs.set(item.draft.fields.target.aId, run);
  }
  return [...runs].map(([aId, run]) => ({
    aId,
    items: [...run.filter((item) => !lampOff(item)), ...run.filter(lampOff)],
  }));
}

function isLampLevelZero(draft) {
  return draft.contract.type === "Brightness" && draft.requested.value === 0;
}

// The accessory of a device read, or the read's error.
function commandDevice(read) {
  if (read.error) throw read.error;
  return read.accessory;
}

function commandCharacteristic(accessory, { sId, cId }) {
  const characteristic = accessory.services
    ?.find((service) => service.sId === sId)
    ?.characteristics?.find((entry) => entry.cId === cId);
  if (!characteristic?.control || typeof characteristic.control !== "object") {
    throw new SprutHubError(
      "characteristic_not_found",
      "The characteristic was not found on its device.",
      "find_devices",
    );
  }
  return characteristic;
}

function inspectedCommandValue(accessory, target) {
  const { control } = commandCharacteristic(accessory, target);
  return {
    fields: { target },
    contract: characteristicContract(control),
    value: typedNativeValue(control.value),
  };
}

// A lamp's On in a device read, undefined when that read failed or holds no
// usable On.
function lampOnState(read, onTarget) {
  if (!read?.accessory) return undefined;
  try {
    const { control } = commandCharacteristic(read.accessory, onTarget);
    return {
      value: typedNativeValue(control.value),
      contract: characteristicContract(control),
    };
  } catch {
    return undefined;
  }
}

function characteristicRefOf(serial, { aId, sId, cId }) {
  return characteristicRef(serial, aId, sId, cId);
}

function resendDeviceCommandNext(homeRef, command, reason) {
  return {
    tool: "send_device_commands",
    arguments: {
      home_ref: homeRef,
      commands: [
        {
          target_ref: command.target_ref,
          value: command.value,
          resend_unconfirmed: true,
        },
      ],
      reason,
    },
  };
}

const DEVICE_COMMAND_STATUSES = {
  applied: "applied",
  uncertain: "uncertain",
  conflict: "conflict",
  not_applied: "rejected",
};

function deviceCommandOutcome(result) {
  const status = DEVICE_COMMAND_STATUSES[result.status] ?? "uncertain";
  return {
    status,
    sent: result.native_write_sent === true,
    ...(result.observed_value
      ? { observed_value: result.observed_value.value }
      : {}),
    change_ref: result.change_ref,
    restore_supported: result.restore_supported === true,
    ...(result.restore_limitation
      ? { restore_limitation: result.restore_limitation }
      : {}),
    ...(result.conflict_reason
      ? { conflict_reason: result.conflict_reason }
      : {}),
    ...(result.local_state ? { local_state: result.local_state } : {}),
    ...(status === "applied"
      ? {}
      : { next: nativeChangeNext(result.change_ref) }),
  };
}

function deviceCommandFailure(change, error) {
  const code = error instanceof SprutHubError ? error.code : "internal_error";
  let status = "uncertain";
  if (
    change === undefined ||
    change.status === "prepared" ||
    code === "state_storage_unavailable"
  ) {
    status = "not_sent";
  } else if (change.status === "not_applied") {
    status = error.requestSent === true ? "rejected" : "not_sent";
  }
  const changeRef = change ? `spruthub-change://native/${change.id}` : null;
  const rejection = status === "rejected" ? writeRejection(error) : undefined;
  return {
    status,
    sent: status === "rejected" || status === "uncertain",
    change_ref: changeRef,
    restore_supported: false,
    error: {
      code,
      message:
        error instanceof SprutHubError
          ? error.message
          : "The command failed inside sprut-agent.",
      ...(error instanceof SprutHubError && error.action
        ? { action: error.action }
        : {}),
    },
    ...(rejection ? { rejection } : {}),
    ...(status === "uncertain" ? { next: nativeChangeNext(changeRef) } : {}),
  };
}

function deviceCommandsResult(homeRef, results, groupReference) {
  const summary = {
    total: results.length,
    applied: 0,
    already_desired: 0,
    uncertain: 0,
    conflict: 0,
    rejected: 0,
    not_sent: 0,
  };
  for (const { status } of results) summary[status] += 1;
  return {
    status:
      summary.applied + summary.already_desired === summary.total
        ? "ok"
        : "incomplete",
    home_ref: homeRef,
    ...(groupReference ? { group_ref: groupReference } : {}),
    summary,
    results,
    limitations: [
      "observed_value is a read of the device after its commands; it cannot prove the command caused it.",
      "restore_native_change with group_ref puts back the previous values of this call's commands, each only while its device still shows the value sent; past physical effects are not undone.",
    ],
  };
}

// When a change was first applied: its first apply intent, else (a legacy
// automation or a draft) when it was recorded.
function applicationTime(change) {
  return changeAppliedAt(change) ?? change.created_at;
}

function compareApplication(left, right) {
  return (
    applicationTime(left).localeCompare(applicationTime(right)) ||
    (left.group_id !== undefined && left.group_id === right.group_id
      ? left.group_index - right.group_index
      : 0) ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}

function classifyScenarioRunDelivery(error) {
  if (error instanceof SprutHubError && error.requestSent === false) {
    error.action = "restore_connection_then_prepare_native_change";
    return { status: "not_sent", failure: scenarioRunFailure(error) };
  }
  if (writeRejection(error)) {
    return { status: "rejected", rejection: scenarioRunFailure(error) };
  }
  return { status: "unknown" };
}

function scenarioRunFailure(error) {
  return {
    code: error.code,
    ...(error.protocolErrorCode !== undefined
      ? { protocol_code: error.protocolErrorCode }
      : {}),
    ...(error.action ? { action: error.action } : {}),
  };
}

function scenarioRunObservationResult(change, observations) {
  if (!storedScenarioRunPlan(change).effect.predicted) {
    // Values that differ from a conditional or code action are not a failure.
    return "command_acknowledged_effect_not_predicted";
  }
  if (observations.every(({ matches }) => matches === true)) {
    return "command_acknowledged_and_target_values_observed";
  }
  const hasDifference = observations.some(({ matches }) => matches === false);
  const hasIncompleteReadback = observations.some(
    ({ matches }) => matches === null,
  );
  if (hasDifference && hasIncompleteReadback) {
    return "command_acknowledged_with_target_value_difference_and_incomplete_readback";
  }
  return hasDifference
    ? "command_acknowledged_with_target_value_difference"
    : "command_acknowledged_with_incomplete_target_readback";
}

// An undo of change rewrites what other set: the same setting, or a field
// both own of the same scenario (scenarioChainIndex, scenarioFieldsOwned).
function undoRewrites(change, other) {
  const index = scenarioChainIndex(change);
  if (index === undefined) {
    return (
      isNativeValueChange(other) &&
      valueTargetKey(other) === valueTargetKey(change)
    );
  }
  if (scenarioChainIndex(other) !== index) return false;
  const owned = scenarioFieldsOwned(other);
  return scenarioFieldsOwned(change).some((field) => owned.includes(field));
}

function scenarioSnapshot(scenario) {
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
  let data;
  try {
    data = JSON.parse(scenario.data);
  } catch {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned invalid BLOCK data.",
    );
  }
  return nativeScenarioConfiguration(scenario, data);
}

// BLOCK data is parsed so hub projections do not look like edits. Other types
// keep only a fingerprint of their source: a run needs equality alone, and
// LOGIC code often holds tokens that must not reach the local journal.
function runnableScenarioSnapshot(scenario) {
  if (isRecord(scenario) && scenario.type === "BLOCK") {
    return scenarioSnapshot(scenario);
  }
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.active !== "boolean" ||
    typeof scenario.type !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incomplete scenario configuration.",
    );
  }
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc ?? null,
    active: scenario.active,
    onStart: scenario.onStart ?? null,
    sync: scenario.sync ?? null,
    type: scenario.type,
    data_sha256: scenarioSourceFingerprint(scenario.data),
  };
}

function scenarioSourceFingerprint(data) {
  if (data === undefined || data === null) return null;
  return sourceFingerprint(
    typeof data === "string" ? data : JSON.stringify(data),
  );
}

// scenario_run compares the whole snapshot: a scenario turned off after
// preparation must not be run. Runs prepared by earlier versions saved the
// source of other types itself, so it is fingerprinted before comparing.
function runSnapshotsEqual(current, saved) {
  return isDeepStrictEqual(
    comparableRunSnapshot(current),
    comparableRunSnapshot(saved),
  );
}

function comparableRunSnapshot(snapshot) {
  if (snapshot.type === "BLOCK") {
    return comparableNativeScenarioConfiguration(snapshot);
  }
  const { data, data_sha256: fingerprint, ...configuration } = snapshot;
  return {
    ...configuration,
    data_sha256: Object.hasOwn(snapshot, "data")
      ? scenarioSourceFingerprint(data)
      : fingerprint,
  };
}

function nativeScenarioConfiguration(scenario, data) {
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc,
    active: scenario.active,
    onStart: scenario.onStart,
    sync: scenario.sync,
    type: scenario.type,
    data,
  };
}

function isLogicSourceChange(change) {
  return ["logic_source_create", "logic_source_update"].includes(change.kind);
}

function isBlockChange(change) {
  return ["block_create", "block_data_update", "block_action_pause"].includes(
    change.kind,
  );
}

const SCENARIO_CREATE_KINDS = new Set(["block_create", "logic_source_create"]);
const SCENARIO_OPTION_FIELDS = ["name", "desc", "onStart", "sync"];
const LOGIC_CODE_FIELDS = ["name", "desc", "onStart", "data"];

// The fields of a scenario a change sets, which are the ones it checks to
// know it still holds. A BLOCK's data and a LOGIC's code are written apart
// from the name, description, start on boot and sequential run, which the
// options window changes (research/protocol/2026-10-13-wave4-contracts.md
// 1.3, 1.10). A LOGIC's code sets its name, description and onStart from
// info on every code write (1.5), so its code owns those three too; its
// sync is not in the code. A create sets all of them. active belongs to
// scenario_active.
function scenarioFieldsOwned(change) {
  if (change.kind === "window_option") {
    return [SCENARIO_METADATA_OPTIONS[change.option_key].field];
  }
  if (change.kind === "logic_source_update") return LOGIC_CODE_FIELDS;
  if (change.kind === "block_data_update") {
    // A record from before the options window wrote name and desc too.
    return [...new Set([...blockUpdateFields(change), "data"])];
  }
  if (change.kind === "block_action_pause") return ["data"];
  return [...SCENARIO_OPTION_FIELDS, "data"];
}

// The scenario's name, description, start on boot and sequential run are
// compared only where the change sets them.
function withoutUnownedOptions(change, configuration) {
  const owned = scenarioFieldsOwned(change);
  return Object.fromEntries(
    Object.entries(configuration).filter(
      ([field]) =>
        !SCENARIO_OPTION_FIELDS.includes(field) || owned.includes(field),
    ),
  );
}

// The scenario a change belongs to in the agent's chain of changes of it.
function scenarioChainIndex(change) {
  let index;
  if (change.kind === "window_option") {
    index = change.owner_kind === "scenario" ? change.owner_index : undefined;
  } else if (SCENARIO_CREATE_KINDS.has(change.kind)) {
    index = change.scenario_index;
  } else if (
    ["block_data_update", "block_action_pause", "logic_source_update"].includes(
      change.kind,
    )
  ) {
    index = change.target?.index;
  }
  return index === undefined || index === null ? undefined : String(index);
}

// The fields this change set that the scenario no longer holds as the
// change left them (expected, its applied snapshot by default): a pause is
// read as a whole. undefined when the scenario is gone or of another type.
function scenarioFieldsDiffering(
  change,
  scenario,
  expected = change.applied_snapshot,
) {
  if (!isRecord(scenario)) return undefined;
  if (change.kind === "block_action_pause") return scenarioFieldsOwned(change);
  if (expected === undefined) return undefined;
  let now;
  let then;
  try {
    [now, then] = isBlockChange(change)
      ? [scenarioSnapshot(scenario), expected].map(
          comparableNativeScenarioConfiguration,
        )
      : [logicScenarioSnapshot(scenario), expected];
  } catch (error) {
    if (error instanceof SprutHubError) return undefined;
    throw error;
  }
  if (now.type !== then.type) return undefined;
  return scenarioFieldsOwned(change).filter(
    (field) => !isDeepStrictEqual(now[field], then[field]),
  );
}

// The scenario still holds what this change of it set.
function scenarioEditHolds(change, scenario) {
  try {
    if (change.kind === "window_option") {
      return (
        scenario.type === (change.owner_type ?? "BLOCK") &&
        valuesEqual(
          scenarioOptionValue(scenario, change.option_key),
          change.requested_value,
        )
      );
    }
    return scenarioChangeObservation(
      change,
      { scenario, logicTypes: [] },
      "applied",
    ).matches;
  } catch (error) {
    if (error instanceof SprutHubError) return false;
    throw error;
  }
}

function scenarioChangeObservation(change, current, snapshot) {
  const expectedSnapshot = snapshot === "restored" ? "baseline" : snapshot;
  return isLogicSourceChange(change)
    ? logicSourceObservation(change, current, snapshot)
    : blockSnapshotObservation(change, current.scenario, expectedSnapshot);
}

function scenarioChangeSnapshot(change, scenario) {
  return isLogicSourceChange(change)
    ? logicScenarioSnapshot(scenario)
    : scenarioSnapshot(scenario);
}

// What a write of this change leaves on the hub, field by field as an
// applied snapshot holds it: what an apply not yet seen would show.
function scenarioRequestedSnapshot(change) {
  if (isLogicSourceChange(change)) return logicSourceRequestedSnapshot(change);
  // A create the hub acknowledged has its index even when the read after
  // it failed; its Desc carries the ownership marker.
  if (change.kind === "block_create") {
    return {
      ...blockCreateRequest(change),
      data: change.requested_snapshot.data,
    };
  }
  return change.requested_snapshot;
}

// The hub's scenario SDK, read before LOGIC code is written.
function sdkNext(serial) {
  return {
    tool: "get_entity",
    arguments: { entity_ref: configuredHomeRef(serial), include: ["sdk"] },
  };
}

function requiredLogicSource(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SprutHubError(
      "invalid_native_change",
      "LOGIC source must be a non-empty string.",
      "get_entity",
    );
  }
  return value;
}

function logicSourceWithOwnershipMarker(source, marker) {
  return `${source}\n\n/* [${marker}] */`;
}

function logicSourceCarriesOwnershipMarker(change, scenario) {
  return (
    isRecord(scenario) &&
    scenario.type === "LOGIC" &&
    typeof scenario.data === "string" &&
    scenario.data.includes(`/* [${change.marker}] */`)
  );
}

function sourceFingerprint(source) {
  return createHash("sha256").update(source).digest("hex");
}

function logicScenarioSnapshot(scenario) {
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
    typeof scenario.name !== "string" ||
    typeof scenario.desc !== "string" ||
    typeof scenario.active !== "boolean" ||
    typeof scenario.onStart !== "boolean" ||
    typeof scenario.sync !== "boolean" ||
    scenario.type !== "LOGIC" ||
    typeof scenario.data !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned an incomplete LOGIC source configuration.",
    );
  }
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc,
    active: scenario.active,
    onStart: scenario.onStart,
    sync: scenario.sync,
    type: "LOGIC",
    data: scenario.data,
  };
}

function logicSourceCreateRequest(change) {
  return {
    name: change.requested_snapshot.name,
    desc: `${change.requested_snapshot.desc}\n\n[${change.marker}]`,
    active: change.requested_snapshot.active,
    onStart: change.requested_snapshot.onStart,
    sync: change.requested_snapshot.sync,
    type: "LOGIC",
    data: change.requested_snapshot.data,
    expand: "data",
  };
}

function logicSourceRequestedSnapshot(change) {
  if (change.kind === "logic_source_update") {
    return change.requested_snapshot;
  }
  const request = logicSourceCreateRequest(change);
  return {
    name: request.name,
    desc: request.desc,
    active: request.active,
    onStart: request.onStart,
    sync: request.sync,
    type: request.type,
    data: request.data,
  };
}

function logicEditableSnapshot(snapshot) {
  return {
    name: snapshot.name,
    desc: snapshot.desc,
    active: snapshot.active,
    onStart: snapshot.onStart,
    sync: snapshot.sync,
    type: snapshot.type,
    data: snapshot.data,
  };
}

function logicSnapshotMatches(change, scenario, expected) {
  const comparable = (snapshot) =>
    withoutUnownedOptions(
      change,
      withoutRuntimeActive(logicEditableSnapshot(snapshot)),
    );
  return (
    scenario !== null &&
    isDeepStrictEqual(
      comparable(logicScenarioSnapshot(scenario)),
      comparable(expected),
    )
  );
}

function logicSourceWriteMatches(scenario, expected) {
  if (scenario === null) return false;
  const snapshot = logicScenarioSnapshot(scenario);
  return snapshot.data === expected.data;
}

function logicEditableFlagsMatch(scenario, expected) {
  return (
    scenario !== null &&
    isDeepStrictEqual(
      publicLogicEditableFlags(logicScenarioSnapshot(scenario)),
      publicLogicEditableFlags(expected),
    )
  );
}

function logicSourceObservation(change, current, snapshot) {
  let matches;
  let expected;
  if (snapshot === "baseline") {
    if (change.kind === "logic_source_create") {
      const type = createdLogicType(change);
      matches =
        current.scenario === null &&
        !(type !== undefined && logicTypeListed(current.logicTypes, type));
    } else {
      expected = change.baseline_snapshot;
      matches = logicSnapshotMatches(change, current.scenario, expected);
    }
  } else if (snapshot === "requested") {
    expected = logicSourceRequestedSnapshot(change);
    matches = logicSourceWriteMatches(current.scenario, expected);
  } else if (snapshot === "applied") {
    expected = change.applied_snapshot;
    matches =
      expected !== undefined &&
      logicSnapshotMatches(change, current.scenario, expected);
  } else if (snapshot === "restored") {
    if (change.kind === "logic_source_create") {
      const type = createdLogicType(change);
      matches =
        current.scenario === null &&
        !(type !== undefined && logicTypeListed(current.logicTypes, type));
    } else {
      expected = change.baseline_snapshot;
      matches = logicSourceWriteMatches(current.scenario, expected);
    }
  } else {
    throw new TypeError(`Unknown LOGIC source snapshot ${snapshot}.`);
  }
  const observedSource =
    current.scenario && typeof current.scenario.data === "string"
      ? current.scenario.data
      : undefined;
  return {
    matches,
    fields: {
      configuration_matches: matches,
      ...(observedSource !== undefined
        ? {
            observed_source_sha256: sourceFingerprint(observedSource),
            source_exact_match:
              expected !== undefined && observedSource === expected.data,
          }
        : {}),
      ...(["requested", "restored"].includes(snapshot) &&
      current.scenario !== null
        ? {
            ...(expected !== undefined
              ? {
                  editable_flags_exact_match: logicEditableFlagsMatch(
                    current.scenario,
                    expected,
                  ),
                }
              : {}),
            observed_editable_flags: publicLogicEditableFlags(
              logicScenarioSnapshot(current.scenario),
            ),
          }
        : {}),
      last_verification: freshVerification(
        matches
          ? `${snapshot}_logic_source`
          : `${snapshot}_logic_source_missing`,
      ),
    },
  };
}

// SprutHub 3.0.0 (owner hub, 2026-09-24, research/protocol/
// 2026-09-24-live-conformance-3.md): a user LOGIC's native type is the string
// of its scenario index. While the LOGIC is on, its anchor's logic.types
// lists {type: index, name: scenario name, desc}, and the name follows a
// rename; a turned-off LOGIC is not listed there. So the type comes from the
// index, for records of earlier versions too, and each read with the LOGIC
// present checks it: an entry of that type named unlike the scenario means
// the identity does not hold here, and nothing is mapped (fail closed).
function createdLogicType(change) {
  return change.scenario_index === undefined
    ? undefined
    : String(change.scenario_index);
}

// entries is null when the anchor service is gone.
function logicTypeListed(entries, type) {
  return entries?.some((entry) => entry.type === type) === true;
}

// The latest read's view of the type on the anchor: listed with the
// scenario's name, not listed while the LOGIC is off or on, or listed with
// another name. A scenario at the index without this change's ownership
// marker is another one, or this one with the marker removed from its
// source; nothing shows which, so its type is not this change's. With no
// scenario at the index the type names nothing.
function recordLogicTypeCheck(change, current) {
  const type = createdLogicType(change);
  if (type === undefined) return;
  if (current.scenario === null) {
    change.logic_type_check = "absent";
    return;
  }
  if (!logicSourceCarriesOwnershipMarker(change, current.scenario)) {
    change.logic_type_check = "not_owned";
    return;
  }
  // The anchor is gone: nothing lists the type there. A name mismatch seen
  // before stays, since it was the only check of the identity.
  if (current.logicTypes === null) {
    if (change.logic_type_check !== "name_mismatch") {
      change.logic_type_check = "anchor_missing";
    }
    return;
  }
  const entry = current.logicTypes.find((item) => item.type === type);
  change.logic_type_check = entry
    ? entry.name === current.scenario.name
      ? "listed"
      : "name_mismatch"
    : current.scenario.active === true
      ? "not_listed"
      : "turned_off";
}

function createdLogicMapping(change) {
  const type = createdLogicType(change);
  // Once the created LOGIC was seen gone, a scenario at its index later,
  // even an exact copy with the marker, is another LOGIC.
  if (
    type === undefined ||
    change.logic_type_check === "absent" ||
    change.owned_target_absent_observed === true
  ) {
    return { status: "missing", reason: "logic_scenario_not_found" };
  }
  if (change.logic_type_check === "name_mismatch") {
    return { status: "missing", reason: "logic_type_name_mismatch" };
  }
  if (change.logic_type_check === "not_owned") {
    return { status: "missing", reason: "logic_scenario_not_owned" };
  }
  const assignmentReady = change.logic_type_check === "listed";
  return {
    status: "mapped",
    type,
    assignmentReady,
    reason: assignmentReady
      ? undefined
      : change.logic_type_check === "anchor_missing"
        ? "logic_target_service_not_found"
        : change.logic_type_check === "turned_off"
          ? "logic_turned_off"
          : "logic_type_not_available_on_target",
  };
}

function createdLogicRefusalDetails(change) {
  return {
    change_ref: `spruthub-change://native/${change.id}`,
    scenario_ref: `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`,
  };
}

// Why the assignments of this created LOGIC cannot be checked, or undefined.
function createdLogicUnmappedRefusal(change) {
  const mapping = createdLogicMapping(change);
  if (mapping.status === "mapped") return undefined;
  const details = createdLogicRefusalDetails(change);
  const evidence =
    mapping.reason === "logic_type_name_mismatch"
      ? `SprutHub lists type ${createdLogicType(change)} on ${change.target_ref} under a name other than this LOGIC's`
      : `the scenario at ${details.scenario_ref} does not carry this change's ownership marker (it is another LOGIC at a reused index, or this one with the marker removed from its source)`;
  return new SprutHubError(
    mapping.reason,
    `${evidence}, so the type of the created LOGIC cannot be proven and its assignments cannot be checked. Restore will not delete it. The owner can delete it in the SprutHub app after checking that no device uses it.`,
    "get_native_change",
    details,
  );
}

// A restored create whose delete was not checked against the LOGIC's own
// type (its index): assignments of that type may remain on devices. This
// version checks the index before it sends a delete. Earlier versions
// checked the one new type seen right after the create while the LOGIC read
// turned on, or a type mapped by a later read, which no record keeps.
function logicDeleteAssignmentCheckUnproven(change) {
  if (change.kind !== "logic_source_create" || change.status !== "restored") {
    return false;
  }
  const legacy = change.new_logic_types_after_create;
  const checked =
    change.logic_delete_checked_type ??
    (Array.isArray(legacy) &&
    legacy.length === 1 &&
    change.logic_active_after_create === true
      ? legacy[0]
      : undefined);
  return checked === undefined || checked !== createdLogicType(change);
}

// Inputs of logic_source_create that logic_source_update does not take,
// with where each is changed instead: the code's info, the options window
// or scenario_active.
const LOGIC_SOURCE_METADATA_INPUTS = {
  name: "info.name",
  description: "info.description",
  on_start: "info.onStart",
  sync: "Sync",
  active: null,
};

function logicSourceMetadataInput(targetRef, field) {
  const place = LOGIC_SOURCE_METADATA_INPUTS[field];
  const [message, next] = place?.startsWith("info.")
    ? [
        `logic_source_update writes only the code, and SprutHub ignores a scenario's ${field} sent with it; nothing was prepared. SprutHub sets the scenario's name, description and start on boot from info in the code on every code write: write ${place} in source as a plain value.`,
        { operation: "logic_source_update", target_ref: targetRef },
      ]
    : place
      ? [
          `logic_source_update writes only the code, and SprutHub ignores a scenario's ${field} sent with it; nothing was prepared. Sync is not in the code: prepare window_option Sync on the scenario ref.`,
          {
            operation: "window_option",
            target_ref: targetRef,
            option_key: place,
          },
        ]
      : [
          "logic_source_update writes only the code; nothing was prepared. Turn the scenario on or off with scenario_active.",
          { operation: "scenario_active", target_ref: targetRef },
        ];
  return new SprutHubError(
    "unsupported_logic_metadata",
    message,
    "get_native_change_contract",
    { next: { tool: "get_native_change_contract", arguments: next } },
  );
}

// SprutHub sets a LOGIC's name, description and start on boot from info in
// its code on every code write, even unchanged (research/protocol/
// 2026-10-13-wave4-contracts.md 1.5), so writing code, and writing the old
// code back on restore, may change them. They are read from info without
// running the code (readLogicInfo); a field info does not hold as a plain
// value is unknown.
const LOGIC_INFO_METADATA = [
  { info: "name", field: "name", shown: "name", label: "name" },
  {
    info: "description",
    field: "desc",
    shown: "description",
    label: "description",
  },
  {
    info: "onStart",
    field: "onStart",
    shown: "on_start",
    label: "start on boot",
  },
];

// Read-only facts for a code update, nothing is refused by them:
// code_sets, the values writing source sets that differ from the scenario
// now; restore_code_sets, the values writing back the code from before
// (restore) sets instead of those the scenario had before the change, as a
// name given in the app that the old code's info does not hold; warnings
// for a value set back from an unchanged info and for unknown values.
function logicCodeInfoEffects(baseline, source) {
  const written = readLogicInfo(source);
  const restored = readLogicInfo(baseline.data);
  const snapshot = {};
  const codeSets = [];
  const restoreCodeSets = [];
  const warnings = [];
  const unknown = { written: [], restored: [] };
  for (const { info, field, shown, label } of LOGIC_INFO_METADATA) {
    const before = baseline[field];
    if (Object.hasOwn(written.values, info)) {
      const to = written.values[info];
      snapshot[field] = to;
      if (to !== before) {
        codeSets.push({ field: shown, from: before, to });
        if (restored.values[info] === to) {
          warnings.push(
            `This code write sets the ${label} back to ${JSON.stringify(to)} from info.${info}, which the code keeps: the ${JSON.stringify(before)} it had when this change was prepared was set outside the code. To keep that, write it into info.${info}.`,
          );
        }
      }
    } else {
      snapshot[field] = null;
      codeSets.push({ field: shown, from: before, unknown: true });
      unknown.written.push({ info, label });
    }
    if (Object.hasOwn(restored.values, info)) {
      const to = restored.values[info];
      if (to !== before) {
        restoreCodeSets.push({ field: shown, before_change: before, to });
        warnings.push(
          `Restore writes back the code from before this change, whose info.${info} sets the ${label} to ${JSON.stringify(to)}, not the ${JSON.stringify(before)} it had before this change, which was set outside the code.`,
        );
      }
    } else {
      restoreCodeSets.push({
        field: shown,
        before_change: before,
        unknown: true,
      });
      unknown.restored.push({ info, label });
    }
  }
  for (const [fields, info, after] of [
    [unknown.written, written, "after this write"],
    [
      unknown.restored,
      restored,
      "after restore, which writes back the code from before this change,",
    ],
  ]) {
    if (fields.length === 0) continue;
    // Why: info itself unreadable, or each field's own reason.
    const why =
      info.problem ??
      fields.map(({ info: key }) => info.problems[key]).join(", and ");
    warnings.push(
      `SprutHub sets the scenario's ${fields.map(({ label }) => label).join(", ")} from info in the code on every code write, and ${why}, so ${after} ${fields.length === 1 ? "it is" : "they are"} not known.`,
    );
  }
  return { snapshot, codeSets, restoreCodeSets, warnings };
}

function logicAssignmentSnapshot(logic, options) {
  if (!isRecord(logic) || typeof logic.type !== "string") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic configuration.",
    );
  }
  if (!Array.isArray(options)) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic options.",
    );
  }
  const normalizedOptions = options
    .map((option) => logicOptionConfiguration(option))
    .sort((left, right) => left.key.localeCompare(right.key));
  if (
    normalizedOptions.some(
      (option, index) => option.key === normalizedOptions[index - 1]?.key,
    )
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned the same logic option key more than once.",
    );
  }
  return {
    logic: {
      type: logic.type,
      active: logicActiveValue(logic).value,
    },
    options: normalizedOptions,
  };
}

function logicOptionConfiguration(option) {
  if (
    !isRecord(option) ||
    typeof option.key !== "string" ||
    typeof option.type !== "string"
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned incomplete logic option configuration.",
    );
  }
  const hasValue = Object.hasOwn(option, "value");
  return {
    key: option.key,
    type: option.type,
    value_present: hasValue,
    ...(hasValue
      ? { value_fingerprint: nativeConfigurationFingerprint(option.value) }
      : {}),
  };
}

function logicAssignmentConfigurationObservation(created, current) {
  const differences = logicAssignmentConfigurationDifferences(created, current);
  const matches = differences === undefined;
  return {
    matches,
    fields: {
      configuration_matches: matches,
      configuration_differences: differences,
      last_verification: freshVerification(
        matches ? "created_configuration" : "created_configuration_changed",
      ),
    },
  };
}

function logicAssignmentConfigurationDifferences(created, current) {
  const differences = {};
  if (created.logic.active !== current.logic.active) {
    differences.active = {
      created: created.logic.active,
      current: current.logic.active,
    };
  }
  const createdOptions = new Map(
    created.options.map((option) => [option.key, option]),
  );
  const currentOptions = new Map(
    current.options.map((option) => [option.key, option]),
  );
  const optionKeys = [
    ...new Set([...createdOptions.keys(), ...currentOptions.keys()]),
  ]
    .filter(
      (key) =>
        !isDeepStrictEqual(createdOptions.get(key), currentOptions.get(key)),
    )
    .sort((left, right) => left.localeCompare(right));
  if (optionKeys.length > 0) differences.option_keys = optionKeys;
  return Object.keys(differences).length > 0 ? differences : undefined;
}

function nativeConfigurationFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function blockCreateRequest(change) {
  return {
    name: change.requested_snapshot.name,
    desc: nativeScenarioDescription(
      change.requested_snapshot.desc,
      change.marker,
    ),
    active: change.requested_snapshot.active,
    onStart: change.requested_snapshot.onStart,
    sync: change.requested_snapshot.sync,
    type: "BLOCK",
    data: JSON.stringify(change.requested_snapshot.data),
  };
}

function blockUpdateFields(change) {
  return change.update_fields ?? ["data"];
}

function blockUpdateWritesData(change) {
  if (change.kind === "block_data_update") {
    return blockUpdateFields(change).includes("data");
  }
  return isBlockChange(change);
}

function scenarioUpdateFields(change, snapshot) {
  const fields = {};
  for (const field of blockUpdateFields(change)) {
    if (field === "data") fields.data = JSON.stringify(snapshot.data);
    else fields[field] = snapshot[field];
  }
  return fields;
}

function blockDataUpdateDiff(change) {
  const diff = {};
  const written = blockUpdateFields(change);
  if (written.includes("name")) {
    diff.name = {
      changed: change.baseline_snapshot.name !== change.requested_snapshot.name,
      from: change.baseline_snapshot.name,
      to: change.requested_snapshot.name,
    };
  }
  if (written.includes("desc")) {
    diff.description = {
      changed: change.baseline_snapshot.desc !== change.requested_snapshot.desc,
      from: change.baseline_snapshot.desc,
      to: change.requested_snapshot.desc,
    };
  }
  if (written.includes("data")) {
    diff.data = {
      changed: !isDeepStrictEqual(
        canonicalBlock(change.baseline_snapshot.data),
        canonicalBlock(change.requested_snapshot.data),
      ),
      from: withHiddenHttpUrls(change.baseline_snapshot.data),
      to: withHiddenHttpUrls(change.requested_snapshot.data),
    };
  }
  return diff;
}

function blockCreateSnapshot(change) {
  const request = blockCreateRequest(change);
  return {
    ...request,
    data: withHiddenHttpUrls(change.requested_snapshot.data),
  };
}

// Flags of the first readback after create. active may differ from the
// request without costing ownership: it belongs to scenario_active.
function blockCreateObservedFlags(change) {
  const observed = change.applied_snapshot;
  if (!observed) return {};
  const requested = change.requested_snapshot;
  return {
    observed_at_create: {
      active: observed.active,
      onStart: observed.onStart,
      sync: observed.sync,
    },
    flags_exact_match:
      observed.active === requested.active &&
      observed.onStart === requested.onStart &&
      observed.sync === requested.sync,
  };
}

function blockMatchesRequested(change, scenario) {
  if (!scenario) return false;
  const current = scenarioSnapshot(scenario);
  if (["block_data_update", "block_action_pause"].includes(change.kind)) {
    if (!change.requested_snapshot) return false;
    return blockConfigurationsEqual(change, current, change.requested_snapshot);
  }
  const expected = blockCreateRequest(change);
  return (
    current.name === expected.name &&
    current.desc === expected.desc &&
    current.onStart === expected.onStart &&
    current.sync === expected.sync &&
    current.type === expected.type &&
    isDeepStrictEqual(
      canonicalBlock(current.data),
      canonicalBlock(change.requested_snapshot.data),
    )
  );
}

function blockStillAtBaseline(change, scenario) {
  if (change.kind === "block_create") return scenario === null;
  const baseline = change.restore_snapshot ?? change.baseline_snapshot;
  return (
    scenario !== null &&
    blockConfigurationsEqual(change, scenarioSnapshot(scenario), baseline)
  );
}

function blockMatchesApplied(change, scenario) {
  if (change.kind === "block_action_pause" && scenario !== null) {
    const current = scenarioSnapshot(scenario);
    return (
      inspectPauseOwnership(current.data, [change]).get(change.id)?.state ===
      "owned"
    );
  }
  return (
    scenario !== null &&
    change.applied_snapshot !== undefined &&
    blockConfigurationsEqual(
      change,
      scenarioSnapshot(scenario),
      change.applied_snapshot,
    )
  );
}

function blockMatchesBaseline(change, scenario) {
  if (change.kind === "block_create") return scenario === null;
  return blockStillAtBaseline(change, scenario);
}

function blockSnapshotObservation(change, scenario, snapshot) {
  let matches;
  if (snapshot === "baseline") {
    matches = blockMatchesBaseline(change, scenario);
  } else if (snapshot === "applied") {
    matches = blockMatchesApplied(change, scenario);
  } else if (snapshot === "requested") {
    matches = blockMatchesRequested(change, scenario);
  } else {
    throw new TypeError(`Unknown BLOCK snapshot ${snapshot}.`);
  }
  const result = `${snapshot}_configuration`;
  return {
    matches,
    fields: {
      configuration_matches: matches,
      last_verification: freshVerification(
        matches ? result : `${result}_missing`,
      ),
    },
  };
}

function pauseHasNoProvenHubEffect(change) {
  // Deadline and native_write_sent are stored before the hub RPC. Either is
  // evidence apply started; a missing wrapper is then not "never applied".
  return (
    change.native_write_sent !== true &&
    change.applied_snapshot === undefined &&
    !Number.isSafeInteger(change.pause_expires_at_ms)
  );
}

function scenarioLacksProvenApply(change) {
  // Lost write ownership: a later requested match is coincidence, not restore rights.
  return change.status === "conflict" && change.applied_snapshot === undefined;
}

function scenarioRestoreSupported(change) {
  if (scenarioLacksProvenApply(change)) return false;
  if (change.owned_target_absent_observed === true) return false;
  if (
    ["block_create", "logic_source_create"].includes(change.kind) &&
    change.status === "restored"
  ) {
    return false;
  }
  if (
    change.kind === "logic_source_create" &&
    createdLogicMapping(change).status !== "mapped"
  ) {
    return false;
  }
  return true;
}

function scenarioUnprovenApplyFields(change, current) {
  const requested = scenarioChangeObservation(change, current, "requested");
  return {
    ...requested.fields,
    configuration_matches: false,
  };
}

function unprovenApplyNext(change) {
  return {
    tool: "get_native_change_contract",
    arguments: {
      operation: change.kind,
      target_ref: change.target_ref,
    },
  };
}

function scenarioConflictAsksForNewPrepare(change) {
  // Conflict is a lifecycle status. Only these reasons mean "prepare a new
  // change"; assignment-blocked restore still needs the current dependency.
  return (
    change.status === "conflict" &&
    (scenarioLacksProvenApply(change) ||
      change.conflict_reason === "manual_change" ||
      change.conflict_reason === "baseline_changed")
  );
}

// Shown only while the restore is blocked by them; a later get or restore
// that finds none replaces the conflict.
function publicScenarioTargetReferences(change) {
  return change.status === "conflict" &&
    change.conflict_reason === "scenario_targets_present"
    ? {
        referencing_scenario_targets: structuredClone(
          change.referencing_scenario_targets,
        ),
      }
    : {};
}

function unprovenApplyLimitation() {
  return "This change has no proven applied snapshot, so apply will not be sent again and restore is not allowed. Prepare a new authorized change from the current hub configuration.";
}

function ownedTargetAbsentLimitation() {
  return "A saved absence of this created scenario at its recorded index ends restore for this change; a later copy is not deleted.";
}

function scenarioRepeatApplyLimitation() {
  return "This change was already applied, so apply will not be sent again. Prepare a new authorized change from the current hub configuration.";
}

function snapshotsEqual(left, right) {
  return isDeepStrictEqual(
    comparableNativeScenarioConfiguration(left),
    comparableNativeScenarioConfiguration(right),
  );
}

// active is a runtime flag owned by scenario_active and the SprutHub UI.
// Turning a scenario off or on is not an edit of the configuration that a
// BLOCK, LOGIC, or automation change owns, so their ownership checks leave it
// out on both sides; journals saved with active in their snapshots still match.
// The name, description, onStart and sync are left out the same way where
// the change does not set them (withoutUnownedOptions).
function withoutRuntimeActive({ active: _active, ...configuration }) {
  return configuration;
}

function blockConfigurationsEqual(change, left, right) {
  return snapshotsEqual(
    withoutUnownedOptions(change, withoutRuntimeActive(left)),
    withoutUnownedOptions(change, withoutRuntimeActive(right)),
  );
}

function comparableNativeScenarioConfiguration(snapshot) {
  // Compare identity plus ScenarioCreateRequest/ScenarioUpdateRequest fields.
  // ScenarioMessage rooms, iconsIf/iconsThen, error, order and bundleId are
  // hub projections or runtime diagnostics, not editable configuration.
  return nativeScenarioConfiguration(snapshot, canonicalBlock(snapshot.data));
}

function restoreIntentTime(change) {
  return change.write_intent?.direction === "restore"
    ? change.write_intent.at
    : undefined;
}

function restoreItemBase(change, automation) {
  const name = changeName(change);
  const value = isNativeValueChange(change) ? summaryValue(change) : undefined;
  return {
    change_ref: automation
      ? changeRef(change.id)
      : `spruthub-change://native/${change.id}`,
    operation: automation ? "legacy_boolean_automation" : change.kind,
    ...(name ? { name } : {}),
    ...(typeof change.target_ref === "string"
      ? { target_ref: change.target_ref }
      : {}),
    ...(change.kind === "characteristic_value" && change.contract?.type
      ? { type: change.contract.type }
      : {}),
    // From what the agent set back to what it was.
    ...(value ? { value: { from: value.to, to: value.from } } : {}),
  };
}

function restoreItem(change, automation, result, before) {
  const base = restoreItemBase(change, automation);
  if (automation) return automationRestoreItem(change, base, result, before);
  const observed =
    result.observed_value !== undefined &&
    result.observed_value !== null &&
    Object.hasOwn(result.observed_value, "value")
      ? { observed_value: result.observed_value.value }
      : {};
  if (result.restore_outcome) {
    const { status, ...outcome } = result.restore_outcome;
    return {
      ...base,
      status,
      sent: false,
      ...outcome,
      ...observed,
      ...(result.next ? { next: result.next } : {}),
    };
  }
  const intentAt = restoreIntentTime(change);
  const sent = intentAt !== undefined && intentAt !== before.restoreIntentAt;
  // Settled or still unknown underneath, a change the agent changed again
  // later is undone after that one.
  if (result.conflict_reason === "later_owned_change") {
    return {
      ...base,
      status: "skipped",
      reason: "later_change",
      sent,
      later_change_ref: result.restore_first_change_ref,
      ...observed,
    };
  }
  switch (result.status) {
    case "restored":
      if (before.status === "restored") {
        return {
          ...base,
          status: "restored",
          sent: false,
          note: "already_restored",
        };
      }
      if (intentAt !== undefined) {
        return { ...base, status: "restored", sent, ...observed };
      }
      if (
        isNativeValueChange(change) &&
        valuesEqual(change.baseline_value, change.requested_value)
      ) {
        return {
          ...base,
          status: "restored",
          sent: false,
          note: "nothing_to_restore",
          ...observed,
        };
      }
      // Back as it was without this restore: someone else undid it.
      return {
        ...base,
        status: "skipped",
        reason: "changed_since",
        sent: false,
        already_previous: true,
        ...observed,
      };
    case "conflict":
      if (
        ["manual_change", "value_changed_after_apply"].includes(
          result.conflict_reason,
        )
      ) {
        return {
          ...base,
          status: "skipped",
          reason: "changed_since",
          sent: false,
          already_previous: false,
          ...observed,
        };
      }
      return {
        ...base,
        status: "skipped",
        reason: result.conflict_reason ?? "conflict",
        sent: false,
        ...(result.room_contents
          ? { room_contents: result.room_contents }
          : {}),
        ...(result.referencing_scenario_targets
          ? {
              referencing_scenario_targets: result.referencing_scenario_targets,
            }
          : {}),
        ...(result.logic_assignments
          ? { logic_assignments: result.logic_assignments }
          : {}),
        ...observed,
      };
    case "not_owned":
      return {
        ...base,
        status: "skipped",
        reason: [
          "change_was_not_applied",
          "room_creation_not_confirmed",
        ].includes(result.conflict_reason)
          ? "not_applied"
          : "not_owned",
        sent: false,
        ...observed,
      };
    case "uncertain":
    case "applying":
    case "restoring": {
      const restoring = change.write_intent?.direction === "restore";
      return {
        ...base,
        status: "uncertain",
        reason: restoring ? "restore_unconfirmed" : "apply_unconfirmed",
        sent,
        ...observed,
        next:
          (restoring && restoreResendNext(change, result)) ||
          result.next ||
          nativeChangeNext(base.change_ref),
      };
    }
    case "applied":
      // An interrupted apply confirmed only now; the restore itself is
      // the next call.
      return {
        ...base,
        status: "skipped",
        reason: "apply_confirmed_now",
        sent: false,
        ...observed,
        next: {
          tool: "restore_native_change",
          arguments: { change_ref: base.change_ref },
        },
      };
    default:
      return {
        ...base,
        status: "skipped",
        reason: result.status,
        sent: false,
        ...observed,
      };
  }
}

// A device command's undo write with no confirmation while the device still
// shows the agent's value: undo does not resend a command by itself (the
// first write may still be on its way), so the item offers the explicit
// resend of the previous value, as a held send_device_commands item does.
function restoreResendNext(change, result) {
  if (
    change.kind !== "characteristic_value" ||
    !result.observed_value ||
    !valuesEqual(result.observed_value, change.requested_value)
  ) {
    return undefined;
  }
  return resendDeviceCommandNext(
    change.home_ref,
    { target_ref: change.target_ref, value: change.baseline_value.value },
    `Undo: ${change.reason}`,
  );
}

function automationRestoreItem(change, base, result, before) {
  switch (result.status) {
    case "rolled_back":
      if (before.status === "rolled_back") {
        return {
          ...base,
          status: "restored",
          sent: false,
          note: "already_restored",
        };
      }
      return result.removed === true
        ? { ...base, status: "restored", sent: true }
        : {
            ...base,
            status: "skipped",
            reason: "changed_since",
            sent: false,
            already_previous: true,
          };
    case "conflict":
      return {
        ...base,
        status: "skipped",
        reason: "changed_since",
        sent: false,
      };
    case "uncertain":
    case "rollback_uncertain": {
      // Only a delete of this call ends in rollback_uncertain; uncertain
      // alone is a creation still unknown, and nothing was sent for it.
      const deleteSent = change.status === "rollback_uncertain";
      return {
        ...base,
        status: "uncertain",
        reason: deleteSent ? "restore_unconfirmed" : "apply_unconfirmed",
        sent: deleteSent,
        next: nativeChangeNext(base.change_ref),
      };
    }
    default:
      return {
        ...base,
        status: "skipped",
        reason: result.status,
        sent: false,
      };
  }
}

function restoreFailureItem(change, automation, error) {
  const base = restoreItemBase(change, automation);
  if (error instanceof SprutHubError && error.code === "restore_unsupported") {
    return {
      ...base,
      status: "skipped",
      reason: "not_restorable",
      sent: false,
      message: error.message,
    };
  }
  const details = error instanceof SprutHubError ? (error.details ?? {}) : {};
  return {
    ...base,
    status: "failed",
    sent: details.rejection !== undefined || details.hub_effect === "partial",
    error: {
      code: error instanceof SprutHubError ? error.code : "internal_error",
      message:
        error instanceof SprutHubError
          ? error.message
          : "The restore failed inside sprut-agent.",
      ...(error instanceof SprutHubError && error.action
        ? { action: error.action }
        : {}),
    },
    ...(details.hub_effect ? { hub_effect: details.hub_effect } : {}),
    ...(details.rejection ? { rejection: details.rejection } : {}),
    next: details.next ?? nativeChangeNext(base.change_ref),
  };
}

function restoreChangesResult(homeRef, results) {
  const summary = {
    total: results.length,
    restored: 0,
    skipped: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const { status } of results) summary[status] += 1;
  return {
    status: summary.restored === summary.total ? "ok" : "incomplete",
    home_ref: homeRef,
    summary,
    results,
    limitations: [
      "Results are in the order the changes were undone: newest first. Each item was checked against the home right before its own write.",
      "skipped changed_since: the value or configuration changed after the agent's change (by hand, in the app or by a scenario) and was left as it is; already_previous=true means it is already as before. later_change: undo later_change_ref first, or together. device_unavailable: the device is offline; try again when it is back. lamp_level_not_restored: undo puts back only a lamp's on/off, never its brightness, hue, saturation or color temperature, as on the hub's lamps a brightness write switches an off lamp on; a lamp is any service with On and such a level.",
      "A device command is put back as a value; what happened meanwhile (light, movement, a scenario it triggered) is not undone. Scenario runs, sent notifications and HTTP requests cannot be undone.",
    ],
  };
}

function placementOwnedSinceApply(change) {
  return (
    change.status === "applied" ||
    (change.status === "conflict" &&
      change.conflict_reason === "later_owned_change")
  );
}

function laterChangeRef(change) {
  return change.conflict_reason === "later_owned_change" &&
    typeof change.restore_first_change_id === "string"
    ? {
        restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
      }
    : {};
}

function publicStoredNativeChange(change) {
  return publicNativeChange(change, undefined, {
    verification: savedVerification(change.last_verification),
  });
}

function publicBlockActionPreview(change, fresh) {
  const preview = change.block_action_preview;
  return {
    snapshot: { ...structuredClone(preview.snapshot), fresh },
    actions: structuredClone(preview.actions),
    // A change prepared before scenario modes held only FIRE targets.
    ...(preview.scenario_runs
      ? {
          scenario_runs: preview.scenario_runs.map((run) => ({
            configuration_pointer: run.configuration_pointer,
            mode: run.mode ?? "FIRE",
            scenario: structuredClone(run.scenario),
          })),
        }
      : {}),
    ...(preview.notifications
      ? { notifications: structuredClone(preview.notifications) }
      : {}),
    ...(preview.http_requests
      ? { http_requests: structuredClone(preview.http_requests) }
      : {}),
    ...(preview.unchecked_actions
      ? { unchecked_actions: structuredClone(preview.unchecked_actions) }
      : {}),
    ...(preview.triggers
      ? { triggers: structuredClone(preview.triggers) }
      : {}),
    ...(preview.warnings
      ? { warnings: structuredClone(preview.warnings) }
      : {}),
    // Stored nodes a block_data_update removes, pointers into diff.data.from.
    ...(preview.removed_nodes
      ? {
          removed_nodes: preview.removed_nodes.map(({ pointer, type }) => ({
            pointer,
            type,
          })),
        }
      : {}),
  };
}

// Names hub code and other nodes this contract cannot write that an update
// deletes, so that the owner hears of it before apply.
function removedUnwritableLimitation(change) {
  const unwritable = (change.block_action_preview?.removed_nodes ?? []).flatMap(
    (removed) => removed.unwritable ?? [],
  );
  if (unwritable.length === 0) return [];
  const listed = unwritable
    .map(({ pointer, type }) => `${type ?? "untyped node"} at ${pointer}`)
    .join(", ");
  return [
    `This edit deletes stored nodes this contract cannot write: ${listed}. Tell the owner before apply: block_data_update cannot add them back; only restore of this change or the SprutHub interface can.`,
  ];
}

function publicNativeChange(
  change,
  observedValue = change.observed_value,
  options = {},
) {
  const verification = Object.hasOwn(options, "verification")
    ? options.verification
    : change.last_verification;
  const configurationMatches = Object.hasOwn(options, "configurationMatches")
    ? options.configurationMatches
    : change.configuration_matches;
  if (change.kind === "accessory_placement") {
    const serial = decodeReferenceSegment(
      /^spruthub:\/\/hub\/([^/]+)$/.exec(change.home_ref)?.[1] ?? "",
    );
    const observed = change.observed_snapshot;
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      diff: {
        name: {
          from: change.baseline_snapshot.name,
          to: change.requested_snapshot.name,
        },
        room: {
          from: {
            ref: `${change.home_ref}/room/${change.baseline_snapshot.room_id}`,
            name: change.baseline_snapshot.room_name,
          },
          to: {
            ref: `${change.home_ref}/room/${change.requested_snapshot.room_id}`,
            name: change.requested_snapshot.room_name,
          },
        },
      },
      requested: publicAccessoryPlacement(change.requested_snapshot, serial),
      ...(observed
        ? { observed: publicAccessoryPlacement(observed, serial) }
        : {}),
      ...(change.applied_snapshot
        ? {
            applied: publicAccessoryPlacement(change.applied_snapshot, serial),
            name_normalized:
              change.applied_snapshot.name !== change.requested_snapshot.name,
          }
        : {}),
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      ...laterChangeRef(change),
      restore_supported: true,
      limitations: [
        "Only the selected accessory name and room are written; services and sibling accessories are not updated.",
        "The observed saved name can differ from the requested name because SprutHub may normalize it.",
        "Restoration is allowed only while the current accessory metadata and physical binding match the saved applied snapshot.",
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
      ],
    };
  }
  if (change.kind === "room_create") {
    const room = change.applied_snapshot
      ? publicRoom(
          change.applied_snapshot,
          decodeReferenceSegment(
            /^spruthub:\/\/hub\/([^/]+)$/.exec(change.home_ref)?.[1] ?? "",
          ),
        )
      : undefined;
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      diff: { room: { from: null, to: { name: change.requested_name } } },
      ...(room
        ? { room, name_normalized: room.name !== change.requested_name }
        : {}),
      room_creation_owned: change.room_creation_owned === true,
      ...(change.candidate_rooms
        ? {
            candidate_rooms: change.candidate_rooms.map((candidate) => ({
              ref: `${change.home_ref}/room/${candidate.id}`,
              name: candidate.name,
            })),
          }
        : {}),
      ...(change.room_contents
        ? { room_contents: structuredClone(change.room_contents) }
        : {}),
      ...(change.conflict_reason === "later_owned_change"
        ? {
            restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
          }
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
      restore_supported: change.room_creation_owned === true,
      limitations: [
        "A matching room observed after a lost create response is a usable candidate but is not owned by this change.",
        "Deletion is allowed only for a confirmed created room whose configuration is unchanged and which contains no accessories.",
        "A later applied room_name change of this room is named by restore_first_change_ref; restoring it first brings back the created name.",
        ROOM_NAME_LIMIT_NOTE,
        ...(room && room.name !== change.requested_name
          ? [
              "SprutHub stored the room under another name than requested (name_normalized): room.name is the stored one, diff.room.to.name the requested one. The room is this change's, and restore deletes it by what was stored.",
            ]
          : []),
      ],
    };
  }
  if (change.kind === "virtual_light_group") {
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      room: { ref: change.room_ref, name: change.room_name },
      requested_name: change.requested_name,
      ...(change.created_accessory_snapshot
        ? {
            observed_name: change.created_accessory_snapshot.name,
            name_normalized:
              change.created_accessory_snapshot.name !== change.requested_name,
          }
        : {}),
      characteristic_types: [...change.characteristic_types],
      member_service_refs: [...change.member_service_refs],
      ...(change.created_accessory_id !== undefined
        ? {
            virtual_accessory_ref: `${change.home_ref}/accessory/${change.created_accessory_id}`,
            characteristics: change.characteristic_types.map((type) => {
              const target = change.virtual_target.characteristics[type];
              return {
                type,
                ref: `${change.home_ref}/accessory/${target.aId}/service/${target.sId}/characteristic/${target.cId}`,
              };
            }),
          }
        : {}),
      ...(change.candidate_accessories
        ? {
            candidate_accessories: structuredClone(
              change.candidate_accessories,
            ),
          }
        : {}),
      virtual_accessory_creation_owned:
        change.virtual_accessory_creation_owned === true,
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      ...(change.physical_link_residues
        ? {
            physical_link_residues: structuredClone(
              change.physical_link_residues,
            ),
          }
        : {}),
      ...(change.physical_link_preservation_failures
        ? {
            physical_link_preservation_failures: structuredClone(
              change.physical_link_preservation_failures,
            ),
          }
        : {}),
      ...(change.physical_link_preservation_unverified
        ? {
            physical_link_preservation_unverified: structuredClone(
              change.physical_link_preservation_unverified,
            ),
          }
        : {}),
      ...(change.native_link_residues?.length > 0
        ? {
            native_link_residues: structuredClone(change.native_link_residues),
          }
        : {}),
      restore_supported: change.virtual_accessory_creation_owned === true,
      limitations: [
        "The group exposes only the explicitly validated common On and Brightness controls.",
        "Last-value feedback is configured; a manual member change is not synchronized to other members.",
        "Creation and link writes are sequential, and SprutHub exposes no native compare-and-set.",
        "Create and addVirtual were replayed on hub 3.0.0; removal first follows the current native UI path, preserves foreign links observed immediately before the owned removal, and reports only new empty native OUT descriptors as residues.",
        "A same-valued command can be acknowledged without reaching every member; characteristic commands through an owned group report each member readback instead of inferring delivery from the virtual value.",
      ],
    };
  }
  if (change.kind === "logic_assignment") {
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      diff: {
        assignment: {
          changed: true,
          from: "absent",
          to: "present_inactive",
        },
      },
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.assignment_ownership_lost === true
        ? { assignment_ownership_lost: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      ...(configurationMatches !== undefined && change.configuration_differences
        ? {
            configuration_differences: structuredClone(
              change.configuration_differences,
            ),
          }
        : {}),
      restore_supported: true,
      limitations: [
        "Assignment creation, option updates, and activation are separate native operations, not one atomic transaction.",
        "Deletion is allowed only after child changes restore the saved created active state and option values.",
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
        "An unobserved delete/recreate at the same address is indistinguishable; ownership history across restarts requires successful journal persistence.",
      ],
    };
  }
  if (isLogicSourceChange(change)) {
    const requested = logicSourceRequestedSnapshot(change);
    const mappingVisible =
      change.kind === "logic_source_create" &&
      change.applied_snapshot !== undefined &&
      change.status !== "restored";
    const mapping =
      change.kind === "logic_source_create"
        ? createdLogicMapping(change)
        : undefined;
    const scenarioRef = change.scenario_index
      ? `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`
      : change.kind === "logic_source_update"
        ? change.target_ref
        : undefined;
    const logicRef =
      mapping?.type !== undefined
        ? `${change.target_ref}/logic/${encodeURIComponent(mapping.type)}`
        : undefined;
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      ...(change.marker ? { ownership_marker: change.marker } : {}),
      diff: {
        source: {
          from_sha256:
            change.kind === "logic_source_update"
              ? sourceFingerprint(change.baseline_snapshot.data)
              : null,
          to_sha256: sourceFingerprint(requested.data),
          exact_match: change.source_exact_match === true,
        },
        editable_flags: {
          from:
            change.kind === "logic_source_update"
              ? publicLogicEditableFlags(change.baseline_snapshot)
              : null,
          to: publicLogicEditableFlags(requested),
          ...(typeof change.editable_flags_exact_match === "boolean"
            ? { exact_match: change.editable_flags_exact_match }
            : {}),
          ...(change.observed_editable_flags
            ? { observed: structuredClone(change.observed_editable_flags) }
            : {}),
        },
      },
      ...(change.code_sets
        ? { code_sets: structuredClone(change.code_sets) }
        : {}),
      ...(change.restore_code_sets
        ? { restore_code_sets: structuredClone(change.restore_code_sets) }
        : {}),
      ...(change.warnings
        ? { warnings: structuredClone(change.warnings) }
        : {}),
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(change.scenario_index
        ? { scenario_index: change.scenario_index }
        : {}),
      ...(scenarioRef ? { scenario_ref: scenarioRef } : {}),
      ...(mapping?.type !== undefined
        ? { native_logic_type: mapping.type }
        : {}),
      ...(mappingVisible
        ? {
            logic_mapping_status: mapping.status,
            logic_assignment_ready: mapping.assignmentReady === true,
          }
        : {}),
      ...(mappingVisible && mapping.reason
        ? { logic_mapping_reason: mapping.reason }
        : {}),
      ...(logicDeleteAssignmentCheckUnproven(change)
        ? { logic_assignments_may_remain: true }
        : {}),
      ...(logicRef ? { logic_ref: logicRef } : {}),
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      ...(change.observed_source_sha256
        ? { observed_source_sha256: change.observed_source_sha256 }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      ...(change.logic_assignments
        ? { logic_assignments: structuredClone(change.logic_assignments) }
        : {}),
      ...laterChangeRef(change),
      ...publicScenarioTargetReferences(change),
      restore_supported: scenarioRestoreSupported(change),
      ...(scenarioConflictAsksForNewPrepare(change)
        ? { next: unprovenApplyNext(change) }
        : {}),
      limitations: [
        "The source is compared exactly and represented by SHA-256 in change output so embedded native data is not echoed from the journal.",
        "LOGIC creation appends a unique JavaScript ownership comment to the source sent to SprutHub.",
        "Metadata returned after a source write is observed rather than attributed to either source derivation or a concurrent edit, and becomes the guard for a later restore.",
        "Source readback confirms stored configuration, not execution or physical behavior.",
        "Scenario creation, source updates, assignment, options, and activation are separate native operations.",
        "A created LOGIC's native type is its scenario index. Deletion scans the current assignments of that type across the home and the scenario targets of BLOCKs; what the scan finds blocks it, whether the LOGIC is on or off. SprutHub exposes no compare-and-set after that check.",
        ...(logicDeleteAssignmentCheckUnproven(change)
          ? [
              "An earlier version deleted this LOGIC after checking the assignments of a type other than its own (its scenario index), so assignments of its own type may remain on devices (logic_assignments_may_remain).",
            ]
          : []),
        ...(scenarioLacksProvenApply(change)
          ? [unprovenApplyLimitation()]
          : change.owned_target_absent_observed === true
            ? [ownedTargetAbsentLimitation()]
            : scenarioConflictAsksForNewPrepare(change) &&
                change.applied_snapshot !== undefined
              ? [scenarioRepeatApplyLimitation()]
              : []),
      ],
    };
  }
  if (change.kind === "block_action_pause") {
    const actionPointer =
      change.current_action_pointer ?? change.action_pointer;
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      action_pointer: actionPointer,
      diff: {
        action: {
          pointer: actionPointer,
          selected_type: change.selected_action_type,
          change: "paused_until_absolute_deadline",
        },
      },
      pause_effect: publicPauseEffect(change),
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      ...(change.replaces_pause_change_id
        ? {
            replaces_change_ref: `spruthub-change://native/${change.replaces_pause_change_id}`,
          }
        : {}),
      ...(change.superseded_by_change_ref
        ? { superseded_by_change_ref: change.superseded_by_change_ref }
        : {}),
      ...(change.completed_by_change_ref
        ? { completed_by_change_ref: change.completed_by_change_ref }
        : {}),
      ...(change.restored_by_change_ref
        ? { restored_by_change_ref: change.restored_by_change_ref }
        : {}),
      restore_supported: true,
      limitations: [
        "The hub evaluates an absolute deadline; no client, daemon, or delayed restore call is required.",
        "Expiration makes the action eligible only on a later ordinary trigger and does not replay missed events.",
        "Updating BLOCK data can cancel an already running native delay in this scenario.",
        "An unchanged inert controller is removed with the next planned write to this BLOCK; read-only calls do not write.",
        "Active/expired is estimated with the MCP host clock; SprutHub evaluates the deadline with the hub clock.",
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
      ],
    };
  }
  if (change.kind === "scenario_run") {
    const plan = storedScenarioRunPlan(change);
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      scenario: {
        ref: change.target_ref,
        name: change.baseline_snapshot.name,
        description: change.baseline_snapshot.desc,
        type: change.baseline_snapshot.type,
        active: change.baseline_snapshot.active,
        on_start: change.baseline_snapshot.onStart,
        sync: change.baseline_snapshot.sync,
      },
      targets: change.targets.map((target) => ({
        characteristic_ref: target.characteristic_ref,
        service_type: target.service_type,
        characteristic_type: target.characteristic_type,
        value: target.expected_value.value,
        kind: target.expected_value.kind,
      })),
      targets_known: plan.targets_known,
      effect: structuredClone(plan.effect),
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      command_delivery: {
        ...structuredClone(change.run_delivery),
        native_acknowledged: change.native_acknowledged === true,
        physical_delivery: "not_proven",
        atomic: false,
      },
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      ...(change.target_observations
        ? {
            target_observations: structuredClone(change.target_observations),
          }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      restore_supported: false,
      limitations: [
        "Preparation and read-only inspection do not run the scenario.",
        ...(plan.effect.predicted
          ? []
          : [
              "SprutHub decides during the run which conditions, delays, and code let actions execute, so the effect is not predicted. Listed targets are only literal actions it may write; read_hub_log watch on this scenario, active during the run, shows what it did.",
            ]),
        ...(plan.targets_known
          ? []
          : [
              "Characteristics changed by LOGIC or BLOCK code, or by uninterpreted BLOCK parts, are not listed as targets.",
            ]),
        "An acknowledged run means SprutHub accepted scenario.run; target values are observed separately and do not prove physical delivery or causality.",
        "The target actions are not atomic, and a race remains after the pre-run scenario comparison.",
        "An unknown run outcome is never resent; prepare a new change only for a new explicit user request.",
        "Removing or restoring scenario configuration does not undo a past command effect.",
      ],
    };
  }
  if (!isNativeValueChange(change)) {
    const createFlags =
      change.kind === "block_create" ? blockCreateObservedFlags(change) : {};
    const diff =
      change.kind === "block_create"
        ? {
            configuration: {
              changed: true,
              from: null,
              to: blockCreateSnapshot(change),
              ...createFlags,
            },
          }
        : blockDataUpdateDiff(change);
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      diff,
      ...(change.block_action_preview
        ? {
            block_action_preview: publicBlockActionPreview(
              change,
              options.blockActionSnapshotFresh === true,
            ),
          }
        : {}),
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(change.scenario_index
        ? {
            scenario_index: change.scenario_index,
            scenario_ref: `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`,
          }
        : {}),
      ...(configurationMatches !== undefined
        ? { configuration_matches: configurationMatches }
        : {}),
      ...(verification ? { verification } : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      ...laterChangeRef(change),
      ...publicScenarioTargetReferences(change),
      restore_supported: scenarioRestoreSupported(change),
      ...(scenarioConflictAsksForNewPrepare(change)
        ? { next: unprovenApplyNext(change) }
        : {}),
      limitations: [
        ...(change.block_action_preview
          ? [
              "Every listed service/set remains a write when its enclosing action runs; equality with the preparation observation is not a no-op or a manual-control guarantee.",
              "Action comparisons use the saved preparation observation. Later reads of this change do not refresh it or predict the value at a future branch execution.",
              "The preview's actions are the service actions of this BLOCK; notifications and http_requests list what it sends that the change adds or changes. A branch does not write omitted characteristics, but other automation can still affect them.",
              "scenario_runs names the scenario each scenario target runs, switches or resets (mode), as read at preparation; what that scenario writes is not listed.",
              "Known enum branch coverage is the condition's listed values at preparation, not a promise that the action will run, its order, a physical effect, or a trigger change. A condition with a hold time is left undisclosed (held_condition). Undisclosed coverage is not an empty domain. Later reads of this change do not refresh that domain.",
            ]
          : []),
        ...removedUnwritableLimitation(change),
        ...(createFlags.flags_exact_match === false
          ? [
              "SprutHub stored runtime flags other than requested at create (observed_at_create); this does not affect ownership or restore. Turning the scenario on or off is a separate scenario_active change.",
            ]
          : []),
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
        scenarioLacksProvenApply(change)
          ? unprovenApplyLimitation()
          : change.owned_target_absent_observed === true
            ? ownedTargetAbsentLimitation()
            : "Restoration is allowed only while the current configuration matches the saved applied snapshot.",
        ...(scenarioConflictAsksForNewPrepare(change) &&
        change.applied_snapshot !== undefined
          ? [scenarioRepeatApplyLimitation()]
          : []),
      ],
    };
  }
  const kind = nativeValueKind(change.kind);
  const optionChange = kind.optionKey === true;
  // A change saved before its option was hidden (a keypad passcode written
  // as a NUMBER) holds the option's values; they are shown hidden, as
  // get_entity shows the option now.
  const hidden = optionChange && optionValuesHidden(change, observedValue);
  const shownValue = (typed) => (hidden ? hiddenOptionValue(typed) : typed);
  const namedValue = (typed) =>
    hidden ? hiddenOptionValue(typed) : namedOptionValue(change, typed);
  const valueChoices = optionChange
    ? {
        baseline: namedValue(change.baseline_value),
        requested: namedValue(change.requested_value),
        ...(observedValue ? { observed: namedValue(observedValue) } : {}),
      }
    : undefined;
  const conflictResolution =
    optionChange &&
    change.status === "conflict" &&
    change.conflict_reason !== "later_owned_change" &&
    nativeValueProvenApply(change) &&
    observedValue
      ? {
          requires_user_decision: true,
          action_if_authorized: `prepare_new_${change.kind}_change`,
          effect: {
            replace: namedValue(observedValue),
            with: namedValue(change.baseline_value),
          },
        }
      : undefined;
  // A record without lamp_level (from before it, or whose device read was
  // refused) keeps the answer of its type and baseline: telling a lamp
  // needs the accessory, which is not read here.
  const restoration =
    change.lamp_level === true
      ? LAMP_LEVEL_RESTORATION
      : nativeValueRestoration(change);
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    ...(change.window_ref ? { window_ref: change.window_ref } : {}),
    diff: {
      value: {
        from: shownValue(change.baseline_value).value,
        to: shownValue(change.requested_value).value,
        kind: change.requested_value.kind,
      },
    },
    ...(change.warnings ? { warnings: structuredClone(change.warnings) } : {}),
    ...(change.notification_services
      ? {
          notification_services: structuredClone(change.notification_services),
        }
      : {}),
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.caused_by_change_id
      ? {
          caused_by_change_ref: `spruthub-change://native/${change.caused_by_change_id}`,
        }
      : {}),
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(observedValue ? { observed_value: shownValue(observedValue) } : {}),
    ...(valueChoices ? { value_choices: valueChoices } : {}),
    ...(verification ? { verification } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...laterChangeRef(change),
    ...(manualValueChangeObserved(change)
      ? { manual_change_observed: true }
      : {}),
    ...(change.recovered_after_uncertain_write
      ? { recovered_after_uncertain_write: true }
      : {}),
    ...(change.group_member_observations
      ? {
          virtual_group_change_ref: change.virtual_group_change_ref,
          group_characteristic_type: change.group_characteristic_type,
          group_member_observations: structuredClone(
            change.group_member_observations,
          ),
          group_delivery_confirmed: change.group_delivery_confirmed === true,
        }
      : {}),
    ...(optionChange
      ? {
          option_key: change.option_key,
          applied_value_observed: change.applied_value_observed === true,
        }
      : {}),
    ...(conflictResolution ? { conflict_resolution: conflictResolution } : {}),
    restore_supported: restoration.supported && change.status !== "restored",
    ...(restoration.limitation
      ? { restore_limitation: restoration.limitation }
      : {}),
    ...(kind.command ? { physical_effect_reversible: false } : {}),
    command_caused_observation: "unknown",
    limitations: [
      "Readback observes the value but cannot prove this command caused it.",
      "SprutHub exposes no native compare-and-set for this operation.",
      restoration.supported
        ? kind.command
          ? "Restore writes the previous value back only while the device still shows the value this change set and is online; past physical effects are not reversed."
          : "Restoration is allowed only while the current setting still matches this change."
        : (restoration.limitation?.message ??
          "A runtime command does not provide rollback of physical effects."),
      "A setting write other than characteristic_value (an option, active flag, room or service name, or service visibility) with an unknown outcome may be retried only while this change retains ownership; a characteristic-value write is not retried automatically. After ownership is lost, any further authorized write requires a newly prepared change.",
      ...(kind.limitations?.(change) ?? []),
      ...(change.group_member_targets
        ? [
            "Delivery is checked against every journal-known group member; a same-valued native virtual command may be suppressed by SprutHub.",
          ]
        : []),
      ...(change.caused_by_change_id
        ? [
            "No command was sent to this characteristic: the lamp switched itself when caused_by_change_ref set its level, and this change records that switch so undo puts it back.",
          ]
        : []),
    ],
  };
}

function optionValuesHidden(change, observedValue) {
  return [change.baseline_value, change.requested_value, observedValue].some(
    (typed) =>
      typed != null &&
      isSensitiveNativeNode({
        key: change.option_key,
        type: change.contract?.type,
        input_type: change.contract?.input_type,
        value: typed.value,
      }),
  );
}

function hiddenOptionValue(typed) {
  return {
    value: { redacted: true, reason: "sensitive_native_data" },
    kind: typed.kind,
  };
}

function namedOptionValue(change, value) {
  const candidate = change.contract?.valid_values?.find((validValue) =>
    valuesEqual(validValue, value),
  );
  return {
    ...structuredClone(value),
    ...(candidate &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0
      ? { name: candidate.name }
      : {}),
  };
}

function publicLogicEditableFlags(snapshot) {
  return {
    name: snapshot.name,
    description: snapshot.desc,
    active: snapshot.active,
    on_start: snapshot.onStart,
    sync: snapshot.sync,
    type: snapshot.type,
  };
}

function publicPauseEffect(change, now = Date.now()) {
  const shared = {
    action_pointer: change.current_action_pointer ?? change.action_pointer,
    duration_seconds: change.duration_seconds,
  };
  if (!Number.isSafeInteger(change.pause_expires_at_ms)) {
    return {
      status: "not_started",
      ...shared,
      starts_on_first_apply: true,
    };
  }
  let status;
  if (change.status === "restored") status = "restored";
  else if (change.status === "superseded") status = "superseded";
  else if (change.status === "not_applied") status = "not_applied";
  else if (change.status === "completed") status = "expired";
  else if (["conflict", "uncertain"].includes(change.status))
    status = "unknown";
  else status = now < change.pause_expires_at_ms ? "active" : "expired";
  return {
    status,
    ...shared,
    started_at: change.pause_started_at,
    expires_at: change.pause_expires_at,
    hub_condition:
      "the selected action runs when Date.now() is at or after expires_at",
  };
}

// What an owner recognises in a history line: what changed (name, value),
// why (the agent's reason), when, its status and the call it belongs to.
// Affected refs only select (entity_ref); they are not listed, so a line
// stays short however many devices a scenario touches.
function changeSummary(change, homeRef) {
  const name = changeName(change);
  const appliedAt = changeAppliedAt(change);
  const described = {
    ...(name ? { name } : {}),
    ...(typeof change.reason === "string" ? { reason: change.reason } : {}),
  };
  if (isNativeChange(change)) {
    const reference = `spruthub-change://native/${change.id}`;
    const value = summaryValue(change);
    return {
      change_ref: reference,
      operation: change.kind,
      ...described,
      target_ref: canonicalEntityRef(change.target_ref, homeRef),
      ...(value ? { value } : {}),
      recorded_status: change.status,
      ...(change.kind === "block_action_pause"
        ? {
            effect_status: publicPauseEffect(change).status,
            ...(change.replaces_pause_change_id
              ? {
                  replaces_change_ref: `spruthub-change://native/${change.replaces_pause_change_id}`,
                }
              : {}),
            ...(change.superseded_by_change_ref
              ? { superseded_by_change_ref: change.superseded_by_change_ref }
              : {}),
            ...(change.completed_by_change_ref
              ? { completed_by_change_ref: change.completed_by_change_ref }
              : {}),
            ...(change.restored_by_change_ref
              ? { restored_by_change_ref: change.restored_by_change_ref }
              : {}),
          }
        : {}),
      ...(change.group_id ? { group_ref: groupRef(change.group_id) } : {}),
      ...(appliedAt ? { applied_at: appliedAt } : {}),
      created_at: change.created_at,
      updated_at: change.updated_at,
      next: {
        tool: "get_native_change",
        arguments: { change_ref: reference },
      },
    };
  }
  const reference = changeRef(change.id);
  return {
    change_ref: reference,
    operation: "legacy_boolean_automation",
    ...described,
    ...(change.scenario_index
      ? {
          target_ref: `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
        }
      : {}),
    recorded_status: change.status,
    ...(appliedAt ? { applied_at: appliedAt } : {}),
    created_at: change.created_at,
    updated_at: change.updated_at,
    next: nativeChangeNext(reference),
  };
}

function changeAffectedRefs(change, homeRef) {
  if (isNativeChange(change)) return nativeAffectedRefs(change, homeRef);
  const characteristicRefs = [
    change.condition?.characteristic?.ref,
    change.action?.characteristic?.ref,
  ]
    .filter(Boolean)
    .map((ref) => canonicalEntityRef(ref, homeRef));
  const ancestorRefs = characteristicRefs.flatMap((ref) =>
    canonicalAncestors(ref),
  );
  return uniqueRefs([
    ...characteristicRefs,
    ...ancestorRefs,
    ...(change.scenario_index
      ? [`${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`]
      : []),
  ]);
}

// The name the owner knows the target by, as saved with the change: the
// device and channel of a command, the room, the scenario.
function changeName(change) {
  if (typeof change.target_name === "string" && change.target_name !== "") {
    return change.target_name;
  }
  if (!isNativeChange(change)) {
    return typeof change.name === "string" ? change.name : undefined;
  }
  switch (change.kind) {
    case "accessory_placement":
      return change.baseline_snapshot?.name;
    case "room_create":
      return change.applied_snapshot?.name ?? change.requested_name;
    case "room_name":
    case "service_name":
      return change.baseline_value?.value;
    case "virtual_light_group":
      return change.created_accessory_snapshot?.name ?? change.requested_name;
    case "block_create":
    case "logic_source_create":
      return change.requested_snapshot?.name;
    case "block_data_update":
    case "block_action_pause":
    case "scenario_run":
    case "logic_source_update":
      return change.baseline_snapshot?.name;
    default:
      return undefined;
  }
}

// Settings whose values are short and safe to show in a history line;
// options (which may hold codes) and long texts are read with
// get_native_change.
const SUMMARY_VALUE_KINDS = new Set([
  "characteristic_value",
  "characteristic_notify",
  "logic_active",
  "scenario_active",
  "service_visible",
  "room_name",
  "service_name",
]);

function summaryValue(change) {
  if (
    !SUMMARY_VALUE_KINDS.has(change.kind) ||
    !change.baseline_value ||
    !change.requested_value
  ) {
    return undefined;
  }
  return {
    from: change.baseline_value.value,
    to: change.requested_value.value,
  };
}

function changeAppliedAt(change) {
  return (
    change.history?.find(({ status }) => status === "applying")?.at ??
    change.apply_started_at
  );
}

function compareChangeSummaries(left, right) {
  const updated = right.updated_at.localeCompare(left.updated_at);
  return updated || left.change_ref.localeCompare(right.change_ref);
}

function historySelection(homeRef, entityRef, limit, cursor) {
  const scope = JSON.stringify({
    home_ref: homeRef,
    entity_ref: entityRef ?? null,
  });
  const selection = { homeRef, entityRef: entityRef ?? null, limit, scope };
  return {
    ...selection,
    after: decodeHistoryCursor(cursor, scope, selection),
  };
}

function decodeHistoryCursor(cursor, expectedScope, selection) {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed?.v !== 2 ||
      typeof parsed.after_ref !== "string" ||
      parsed.after_ref.length === 0 ||
      typeof parsed.after_updated_at !== "string" ||
      parsed.after_updated_at.length === 0 ||
      parsed.scope !== expectedScope
    ) {
      throw new Error("invalid cursor");
    }
    return {
      change_ref: parsed.after_ref,
      updated_at: parsed.after_updated_at,
    };
  } catch {
    throw invalidHistoryCursor(selection);
  }
}

function encodeHistoryCursor(after, scope) {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      after_ref: after.change_ref,
      after_updated_at: after.updated_at,
      scope,
    }),
  ).toString("base64url");
}

function historyNext(selection, cursor) {
  return {
    tool: "get_native_change",
    arguments: {
      home_ref: selection.homeRef,
      ...(selection.entityRef ? { entity_ref: selection.entityRef } : {}),
      limit: selection.limit,
      ...(cursor ? { cursor } : {}),
    },
  };
}

function invalidHistoryCursor(selection) {
  return new SprutHubError(
    "invalid_cursor",
    "Use the cursor returned by the history of get_native_change for the same home and entity filter.",
    "restart_history",
    { next: historyNext(selection, null) },
  );
}

function nativeAffectedRefs(change, homeRef) {
  const refs = [canonicalEntityRef(change.target_ref, homeRef)];
  if (isNativeValueChange(change)) {
    if (typeof change.window_ref === "string") refs.push(change.window_ref);
    refs.push(...canonicalAncestors(refs[0]));
  }
  if (change.kind === "accessory_placement") {
    refs.push(
      `${homeRef}/room/${change.baseline_snapshot.room_id}`,
      `${homeRef}/room/${change.requested_snapshot.room_id}`,
    );
  } else if (change.kind === "room_create") {
    if (change.created_room_id !== undefined) {
      refs.push(`${homeRef}/room/${change.created_room_id}`);
    }
    for (const candidate of change.candidate_rooms ?? []) {
      refs.push(`${homeRef}/room/${candidate.id}`);
    }
  } else if (change.kind === "virtual_light_group") {
    refs.push(change.room_ref, ...change.member_service_refs);
    if (change.created_accessory_id !== undefined) {
      refs.push(`${homeRef}/accessory/${change.created_accessory_id}`);
      for (const type of change.characteristic_types) {
        const target = change.virtual_target.characteristics[type];
        refs.push(...bindingRefs(homeRef, target.aId, target.sId, target.cId));
      }
    }
    for (const ref of change.member_service_refs) {
      refs.push(...canonicalAncestors(ref));
    }
  }
  if (change.kind === "logic_assignment") {
    refs.push(...canonicalAncestors(refs[0]));
  } else if (
    [
      "block_create",
      "block_data_update",
      "block_action_pause",
      "scenario_run",
    ].includes(change.kind)
  ) {
    if (change.scenario_index) {
      refs.push(
        `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
      );
    }
    const configurations =
      change.kind === "block_create"
        ? [change.requested_snapshot?.data]
        : change.kind === "scenario_run"
          ? [change.baseline_snapshot?.data]
          : [
              change.baseline_snapshot?.data,
              change.requested_snapshot?.data,
              change.restore_snapshot?.data,
            ];
    for (const data of configurations) {
      refs.push(...blockAffectedRefs(data, homeRef));
    }
  } else if (isLogicSourceChange(change)) {
    if (change.scenario_index) {
      refs.push(
        `${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`,
      );
    }
    const { type } =
      change.kind === "logic_source_create" ? createdLogicMapping(change) : {};
    if (type !== undefined) {
      refs.push(`${change.target_ref}/logic/${encodeURIComponent(type)}`);
    }
  }
  return uniqueRefs(refs);
}

function bindingRefs(homeRef, aId, sId, cId) {
  if (!stableNativeId(aId)) return [];
  const accessory = `${homeRef}/accessory/${aId}`;
  if (!stableNativeId(sId)) return [accessory];
  const service = `${accessory}/service/${sId}`;
  return stableNativeId(cId)
    ? [accessory, service, `${service}/characteristic/${cId}`]
    : [accessory, service];
}

function canonicalEntityRef(ref, homeRef) {
  if (typeof ref !== "string") return ref;
  if (ref.startsWith(`${homeRef}/`) || ref === homeRef) return ref;
  const legacy = /^spruthub:\/\/(room|accessory)\/(.+)$/.exec(ref);
  return legacy ? `${homeRef}/${legacy[1]}/${legacy[2]}` : ref;
}

function canonicalAncestors(ref) {
  const logic =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+\/service\/\d+)\/logic\/[^/]+$/.exec(
      ref,
    );
  if (logic) {
    const service = logic[1];
    return [service.replace(/\/service\/\d+$/, ""), service];
  }
  const characteristic =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+\/service\/\d+)\/characteristic\/\d+$/.exec(
      ref,
    );
  if (characteristic) {
    const service = characteristic[1];
    return [service.replace(/\/service\/\d+$/, ""), service];
  }
  const service =
    /^(spruthub:\/\/hub\/[^/]+\/accessory\/\d+)\/service\/\d+$/.exec(ref);
  return service ? [service[1]] : [];
}

function uniqueRefs(refs) {
  return [...new Set(refs.filter((ref) => typeof ref === "string"))];
}

function expectedScenario(change) {
  return {
    name: change.name,
    desc: `${change.reason}\n\n[${change.marker}]`,
    active: true,
    onStart: false,
    sync: false,
    type: "BLOCK",
    data: JSON.stringify(change.native_data),
  };
}

function matchesExpected(scenario, change) {
  const expected = withoutRuntimeActive(expectedScenario(change));
  const metadataMatches = Object.entries(expected).every(
    ([key, value]) => key === "data" || scenario[key] === value,
  );
  if (!metadataMatches || typeof scenario.data !== "string") return false;
  try {
    return isDeepStrictEqual(
      canonicalBlock(JSON.parse(scenario.data)),
      canonicalBlock(change.native_data),
    );
  } catch {
    return false;
  }
}

function matchesRequiredRuntime(scenario) {
  return (
    scenario.active === true &&
    scenario.onStart === false &&
    scenario.sync === false
  );
}

// The rule a BLOCK in canonicalBlock form expresses, or null when it is not
// one trigger condition setting one target (with an optional auto-off).
function ruleMeaning(data) {
  const target = data?.targets?.length === 1 ? data.targets[0] : null;
  const condition =
    target?.if?.conditions?.length === 1 ? target.if.conditions[0] : null;
  const actions = target?.then;
  const action =
    Array.isArray(actions) && (actions.length === 1 || actions.length === 2)
      ? actions[0]
      : null;
  const setting =
    action?.characteristics?.length === 1 ? action.characteristics[0] : null;
  const delay = actions?.length === 2 ? actions[1] : null;
  const delayedAction = delay?.targets?.length === 1 ? delay.targets[0] : null;
  const delayedSetting =
    delayedAction?.characteristics?.length === 1
      ? delayedAction.characteristics[0]
      : null;
  if (
    target?.type !== "if" ||
    target.if?.type !== "condition" ||
    target.if.mode !== "AND" ||
    condition?.type !== "characteristic" ||
    action?.type !== "service" ||
    setting?.type !== "set" ||
    !Array.isArray(target.else) ||
    target.else.length !== 0 ||
    target.then_delay !== 0 ||
    target.else_delay !== 0 ||
    target.mode !== "EVERY"
  ) {
    return null;
  }
  if (
    delay !== null &&
    (delay?.type !== "delay" ||
      delay.index !== 1 ||
      !["RESET", "CONTINUE"].includes(delay.mode) ||
      !Number.isSafeInteger(delay.time) ||
      delay.time <= 0 ||
      delayedAction?.type !== "service" ||
      delayedSetting?.type !== "set")
  ) {
    return null;
  }
  return {
    condition: ruleCondition(condition),
    action: {
      aId: action.aId,
      sId: action.sId,
      hs: action.hs,
      cId: setting.cId,
      hc: setting.hc,
      value: setting.value,
    },
    ...(delay
      ? {
          auto_off: {
            index: delay.index,
            mode: delay.mode,
            time: delay.time,
            action: {
              aId: delayedAction.aId,
              sId: delayedAction.sId,
              hs: delayedAction.hs,
              cId: delayedSetting.cId,
              hc: delayedSetting.hc,
              value: delayedSetting.value,
            },
          },
        }
      : {}),
  };
}

function ruleCondition(condition) {
  return {
    aId: condition.aId,
    sId: condition.sId,
    cId: condition.cId,
    value: condition.value,
    cond: condition.cond,
    trigger: condition.trigger,
    hs: condition.hs,
    hc: condition.hc,
    time: condition.time,
    timeCond: condition.timeCond,
  };
}

// Existing BLOCK scenarios that fire on the requested trigger and write the
// requested target, each with its relation to the requested rule.
function relatedRules(scenarios, change, homeReference) {
  return scenarios.flatMap((scenario) => {
    const comparison = existingRuleRelation(scenario, change);
    if (!comparison) return [];
    return [
      {
        scenario,
        relation: comparison.relation,
        rule: {
          ref: `${homeReference}/scenario/${encodeURIComponent(scenario.index)}`,
          name: scenario.name,
          relation: comparison.relation,
          differences: comparison.differences,
        },
      },
    ];
  });
}

// equivalent: the same rule (runtime flags are listed as differences).
// superset: it already sets the target to the requested value on this
// trigger, with the requested auto-off if any, and does more (for example
// turns the target off later); a new rule would duplicate it.
// inactive_superset: such a rule that is turned off; it does not block.
// conflict: the same trigger and target with other behavior.
function existingRuleRelation(scenario, change) {
  if (scenario.type !== "BLOCK" || typeof scenario.data !== "string") {
    return null;
  }
  // Both rules are read in canonicalBlock form, so a rule made in the web
  // client without mode, branch delays or else and with its OR group is the
  // rule it means.
  const requested = ruleMeaning(canonicalBlock(change.native_data));
  let data;
  try {
    data = canonicalBlock(JSON.parse(scenario.data));
  } catch {
    return null;
  }
  const existing = triggeredTargetRule(data, requested);
  if (!requested || !existing) return null;
  const runtime = runtimeDifferences(scenario);
  const candidate = ruleMeaning(data);
  if (
    candidate !== null &&
    JSON.stringify(candidate) === JSON.stringify(requested)
  ) {
    return { relation: "equivalent", differences: runtime };
  }
  const requestedAutoOff = requested.auto_off
    ? [
        autoOffDescription({
          ...requested.auto_off,
          value: requested.auto_off.action.value,
        }),
      ]
    : [];
  const existingAutoOff = existing.delayed.map(autoOffDescription);
  const immediateMatches =
    existing.immediate.length > 0 &&
    existing.immediate.every((value) => value === requested.action.value);
  const autoOffCovered = requestedAutoOff.every((wanted) =>
    existingAutoOff.some((present) => isDeepStrictEqual(present, wanted)),
  );
  const differences = [];
  if (!immediateMatches) {
    differences.push({
      field: "target_value",
      existing: existing.immediate.map(blockValue),
      requested: blockValue(requested.action.value),
    });
  }
  if (!isDeepStrictEqual(existingAutoOff, requestedAutoOff)) {
    differences.push({
      field: "auto_off",
      existing: existingAutoOff,
      requested: requestedAutoOff,
    });
  }
  differences.push(...existing.shape);
  for (const [field, count] of [
    ["other_actions", existing.otherActions],
    ["else_actions", existing.elseActions],
  ]) {
    if (count > 0) differences.push({ field, existing: count, requested: 0 });
  }
  differences.push(...runtime);
  const superset =
    immediateMatches && autoOffCovered && existing.shape.length === 0;
  if (!superset) return { relation: "conflict", differences };
  // A turned-off rule fires nothing, so a new rule would not duplicate it;
  // on start or sync it still fires on the trigger.
  return {
    relation: scenario.active === false ? "inactive_superset" : "superset",
    differences,
  };
}

// The first top-level `if` of a BLOCK in canonicalBlock form whose
// conditions include the requested trigger and whose actions write the
// requested target characteristic.
function triggeredTargetRule(data, requested) {
  if (!requested || !Array.isArray(data?.targets)) return null;
  const trigger = JSON.stringify(requested.condition);
  const target = requested.action;
  const rule = data.targets.find(
    (candidate) =>
      candidate?.type === "if" &&
      candidate.if?.type === "condition" &&
      Array.isArray(candidate.if.conditions) &&
      candidate.if.conditions.some(
        (condition) =>
          condition?.type === "characteristic" &&
          JSON.stringify(ruleCondition(condition)) === trigger,
      ),
  );
  if (!rule || !Array.isArray(rule.then)) return null;
  const immediate = [];
  const delayed = [];
  let otherActions = data.targets.length - 1;
  const targetSettings = (node, onSetting) => {
    if (
      node?.type !== "service" ||
      node.aId !== target.aId ||
      node.sId !== target.sId ||
      !Array.isArray(node.characteristics)
    ) {
      otherActions += 1;
      return;
    }
    for (const setting of node.characteristics) {
      if (setting?.type === "set" && setting.cId === target.cId) {
        onSetting(setting.value);
      } else {
        otherActions += 1;
      }
    }
  };
  for (const action of rule.then) {
    if (action?.type === "delay" && Array.isArray(action.targets)) {
      for (const node of action.targets) {
        targetSettings(node, (value) =>
          delayed.push({
            index: action.index,
            mode: action.mode,
            time: action.time,
            value,
          }),
        );
      }
    } else {
      targetSettings(action, (value) => immediate.push(value));
    }
  }
  if (immediate.length === 0 && delayed.length === 0) return null;
  const shape = [];
  if (rule.if.conditions.length !== 1) {
    shape.push({
      field: "conditions",
      existing: rule.if.conditions.length,
      requested: 1,
    });
  }
  if (rule.mode !== "EVERY") {
    shape.push({
      field: "mode",
      existing: rule.mode ?? null,
      requested: "EVERY",
    });
  }
  if ((rule.then_delay ?? 0) !== 0) {
    shape.push({
      field: "then_delay",
      existing: rule.then_delay,
      requested: 0,
    });
  }
  return {
    immediate,
    delayed,
    otherActions,
    elseActions: Array.isArray(rule.else) ? rule.else.length : 0,
    shape,
  };
}

function autoOffDescription({ index, mode, time, value }) {
  return {
    after_seconds: Number.isFinite(time) ? time / 1_000 : null,
    timer_mode: mode ?? null,
    target_value: blockValue(value),
    timer_index: index ?? null,
  };
}

function blockValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value ?? null;
}

function runtimeDifferences(scenario) {
  return [
    ["active", scenario.active, true],
    ["on_start", scenario.onStart, false],
    ["sync", scenario.sync, false],
  ]
    .filter(([, existing, required]) => existing !== required)
    .map(([field, existing, requested]) => ({
      field,
      existing: existing ?? null,
      requested,
    }));
}

function rolledBackResult(change, removed) {
  return {
    ...publicChange(change),
    status: "rolled_back",
    removed,
    physical_state_reverted: false,
  };
}

function withLocalState(
  result,
  saved,
  action = "restore_state_storage_then_get_native_change",
) {
  if (saved) return result;
  return {
    ...result,
    local_state: {
      saved: false,
      action,
    },
  };
}

function observeReconciliation(change, reconciliation) {
  if (reconciliation.owned) {
    return {
      kind: reconciliation.matches ? "owned_match" : "owned_conflict",
      scenario: reconciliation.scenario,
    };
  }
  if (change.owned === true) {
    return reconciliation.scenario
      ? { kind: "ownership_conflict", scenario: reconciliation.scenario }
      : { kind: "absent" };
  }
  if (reconciliation.equivalent) {
    return { kind: "equivalent", scenario: reconciliation.equivalent };
  }
  if (reconciliation.runtimeConflict) {
    return {
      kind: "runtime_conflict",
      scenario: reconciliation.runtimeConflict,
    };
  }
  if (reconciliation.superset) {
    return {
      kind: "superset_conflict",
      scenario: reconciliation.superset.scenario,
      existingRule: reconciliation.superset.rule,
    };
  }
  return reconciliation.scenario
    ? { kind: "ownership_conflict", scenario: reconciliation.scenario }
    : { kind: "absent" };
}

function observationState(observation) {
  const state = {
    scenario_index: observation.scenario.index,
    conflict_reason: undefined,
  };
  switch (observation.kind) {
    case "owned_match":
      return { ...state, status: "applied", owned: true };
    case "owned_conflict":
      return { ...state, status: "conflict", owned: true };
    case "equivalent":
      return { ...state, status: "already_present", owned: false };
    case "runtime_conflict":
      return {
        ...state,
        status: "conflict",
        owned: false,
        conflict_reason: "equivalent_rule_runtime_mismatch",
      };
    case "ownership_conflict":
      return { ...state, status: "conflict", owned: false };
    case "superset_conflict":
      return {
        ...state,
        status: "conflict",
        owned: false,
        conflict_reason: "existing_rule_superset",
      };
    default:
      throw new Error(`Cannot persist ${observation.kind} observation.`);
  }
}

function observationResult(change, observation) {
  switch (observation.kind) {
    case "owned_match":
      return {
        ...publicChange(change),
        status: "applied",
        scenario_index: observation.scenario.index,
        owned: true,
        configuration_matches: true,
      };
    case "owned_conflict":
      return conflictResult(change, observation.scenario.index);
    case "equivalent":
      return {
        ...publicChange(change),
        status: "already_present",
        scenario_index: observation.scenario.index,
        owned: false,
        configuration_matches: true,
      };
    case "runtime_conflict":
      return runtimeConflictResult(change, observation.scenario);
    case "ownership_conflict":
      return ownershipConflictResult(change, observation.scenario.index);
    case "superset_conflict":
      return {
        ...publicChange(change),
        status: "conflict",
        conflict_reason: "existing_rule_superset",
        scenario_index: observation.scenario.index,
        owned: false,
        configuration_matches: false,
        existing_rule: observation.existingRule,
        action: "reuse_or_adjust_existing_rule",
      };
    default:
      throw new Error(`Cannot describe ${observation.kind} observation.`);
  }
}

function publicChange(change) {
  return {
    status: change.status,
    change_ref: changeRef(change.id),
    name: change.name,
    reason: change.reason,
    condition: change.condition,
    action: change.action,
    ...(change.scenario_index ? { scenario_index: change.scenario_index } : {}),
  };
}

function conflictResult(change, scenarioIndex) {
  return {
    ...publicChange(change),
    status: "conflict",
    scenario_index: scenarioIndex,
    owned: true,
    configuration_matches: false,
    action: "review_manual_changes",
  };
}

function ownershipConflictResult(change, scenarioIndex) {
  return {
    ...publicChange(change),
    status: "conflict",
    scenario_index: scenarioIndex,
    owned: false,
    configuration_matches: false,
    action: "review_manual_changes",
  };
}

function runtimeConflictResult(change, scenario) {
  return {
    ...publicChange(change),
    status: "conflict",
    reason: "equivalent_rule_runtime_mismatch",
    scenario_index: scenario.index,
    owned: false,
    configuration_matches: false,
    current_runtime: {
      active: scenario.active,
      on_start: scenario.onStart,
      sync: scenario.sync,
    },
    required_runtime: { active: true, on_start: false, sync: false },
    action: "review_existing_scenario",
  };
}

function uncertainResult(change) {
  return {
    ...publicChange(change),
    status: "uncertain",
    action: "inspect_hub_before_retry",
  };
}

// A sent create is unknown until the room is identified, unless the hub
// refused the request (or it was never delivered): then no room was created.
function roomCreationOutcomeUnknown(change) {
  return change.native_write_sent === true && change.status !== "not_applied";
}
