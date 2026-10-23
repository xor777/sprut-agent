import { isDeepStrictEqual } from "node:util";
import { AutomationStore } from "./automation-store.mjs";
import { normalizeBlockRequest } from "./block-model.mjs";
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
  groupValuesEqual,
  logicAssignmentContract,
  logicSourceContract,
  requiredNativeName,
  roomCreateContract,
  scenarioRunContract,
  typedNativeValue,
  validateCharacteristicValue,
  valuesEqual,
  virtualLightGroupContract,
} from "./change-contracts.mjs";
import {
  changeSummary,
  compareApplication,
  compareChangeSummaries,
  encodeHistoryCursor,
  historyNext,
  historySelection,
  nativeAffectedRefs,
} from "./change-history.mjs";
import {
  publicNativeChange,
  publicStoredNativeChange,
  removedUnwritableLimitation,
} from "./change-presentation.mjs";
import {
  activeInsteadOfValue,
  configuredHomeRef,
  groupRef,
  inactiveScenarioRun,
  isRecord,
  isUncertainWriteError,
  isUnreadError,
  isVerifiedRunType,
  nativeChangeNext,
  nativeTargetKey,
  parseAccessoryRef,
  parseConfiguredHomeRef,
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
  unsupportedBlockFlags,
  unsupportedBlockMetadata,
  unsupportedHomeWrite,
  unsupportedNativeOperation,
  unsupportedScenarioType,
  unverifiedScenarioRunType,
  writeRejection,
} from "./change-refs.mjs";
import {
  restoreChangesResult,
  restoreFailureItem,
  restoreIntentTime,
  restoreItem,
} from "./change-restore.mjs";
import {
  characteristicRefOf,
  commandCharacteristic,
  commandDevice,
  DEVICE_COMMAND_CONCURRENCY,
  deviceCommandFailure,
  deviceCommandName,
  deviceCommandOutcome,
  deviceCommandRuns,
  deviceCommandsResult,
  inspectedCommandValue,
  invalidDeviceCommand,
  invalidDeviceCommands,
  isLampLevelZero,
  LAMP_KEPT_OFF_NOTE,
  LAMP_LEVEL_ZERO_NOTE,
  LAMP_SWITCHED_ON_NOTE,
  lampOnState,
  latestSentValueCommand,
  mapWithConcurrency,
  parseDeviceCommandTargets,
  resendDeviceCommandNext,
} from "./device-commands.mjs";
import {
  currentLinkIndex,
  currentMembers,
  expectedAppliedKeys,
  foreignDifferences,
  incomingLinks,
  isHomeRef,
  LIGHT_GROUP_MEMBERS,
  lampControls,
  lampGroupContract,
  lampGroupService,
  lampService,
  lampServiceRef,
  linkedTypes,
  linkKeys,
  notALampGroup,
  outOfStepLamps,
  parseLampRef,
  planGroupMembers,
  publicLampGroupMember,
  restoreSteps,
  sameKeys,
  stepInEffect,
} from "./light-group-members.mjs";
import {
  createdLogicType,
  createdLogicUnmappedRefusal,
  LOGIC_SOURCE_METADATA_INPUTS,
  logicAssignmentConfigurationObservation,
  logicAssignmentSnapshot,
  logicCodeInfoEffects,
  logicScenarioSnapshot,
  logicSourceCarriesOwnershipMarker,
  logicSourceCreateRequest,
  logicSourceMetadataInput,
  logicSourceWithOwnershipMarker,
  recordLogicTypeCheck,
  requiredLogicSource,
  scenarioFieldsOwned,
  sdkNext,
  sourceFingerprint,
} from "./logic-changes.mjs";
import {
  BUTTON_PRESS_NOTE,
  BUTTON_PRESS_TYPE,
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
  lightLevelOnTarget,
  manualValueChangeObserved,
  nativeIntentDirection,
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
  savedVerification,
  valueRestoreGoesOn,
  valueTargetKey,
  withoutLaterChange,
  withRestoreAgainNext,
  writeOutcomeUnknown,
} from "./native-values.mjs";
import {
  accessoryPlacementMatches,
  accessoryPlacementSnapshot,
  placementOwnedSinceApply,
  publicAccessoryPlacement,
  publicRoom,
  roomCreationOutcomeUnknown,
  roomSnapshot,
} from "./placement-rooms.mjs";
import {
  blockCreateRequest,
  blockMatchesRequested,
  blockRuleEffects,
  blockStillAtBaseline,
  blockUpdateWritesData,
  classifyScenarioRunDelivery,
  existingRuleRelation,
  isBlockChange,
  isLogicSourceChange,
  pauseHasNoProvenHubEffect,
  runnableScenarioSnapshot,
  runSnapshotsEqual,
  SCENARIO_CREATE_KINDS,
  scenarioChainIndex,
  scenarioChangeObservation,
  scenarioChangeSnapshot,
  scenarioEditHolds,
  scenarioFieldsDiffering,
  scenarioLacksProvenApply,
  scenarioRequestedSnapshot,
  scenarioRunObservationResult,
  scenarioSnapshot,
  scenarioUnprovenApplyFields,
  scenarioUpdateFields,
} from "./scenario-changes.mjs";
import { SprutHubError, sanitizeNativeData } from "./spruthub-client.mjs";
import {
  dependenciesWithin,
  hasDependencies,
  notAVirtualDevice,
  ownServices,
  recreateServices,
  sameCreatedDevice,
  VIRTUAL_DEVICE,
  VIRTUAL_DEVICE_DELETE,
  VIRTUAL_DEVICE_DEPENDENCIES_NOTE,
  VIRTUAL_DEVICE_DUPLICATE_NOTE,
  virtualDeviceContract,
  virtualDeviceName,
  virtualDeviceSnapshot,
  virtualDeviceType,
} from "./virtual-device.mjs";
import {
  characteristicTypeName,
  completeVirtualLightConfiguration,
  expectedTargetsForType,
  findNativeCharacteristic,
  hasVirtualLightShape,
  nativeEmptyPhysicalLinkResidue,
  normalizePhysicalLinks,
  normalizeVirtualLinks,
  physicalLinkArtifact,
  physicalLinkBaseline,
  physicalLinkContains,
  physicalLinksPreservedAcrossOwnRemoval,
  safeOwnedVirtualLightConfiguration,
  safeRestoringVirtualLightConfiguration,
  selectCreatedVirtualLight,
  selectVirtualLightMember,
  unexpectedVirtualLinks,
  validateVirtualLightCharacteristicTypes,
  validateVirtualLightServiceType,
  virtualAccessoryStructure,
  virtualLightAllWritesAcknowledged,
  virtualLightGroupPartlyWritten,
  virtualLightProgressLink,
  virtualLightSettingsSnapshot,
  virtualLinkRelation,
  virtualLinkSettingsMatch,
  virtualLinkTarget,
} from "./virtual-light-group.mjs";

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
// A new BLOCK that a scenario of the home already does, wholly or in part.
const EXISTING_RULE_NOTE =
  "A scenario in existing_rules already does this on the same trigger. Tell the owner and do not apply unless they asked for a second scenario; to change that one, edit it with block_data_update.";
const PARTIAL_RULE_NOTE =
  "A scenario in existing_rules already does part of this on the same trigger. Tell the owner which part before applying.";
// A room ref selects only changes of the room itself.
const ROOM_HISTORY_HINT =
  "A room ref lists only changes of the room itself (its name, its creation). Changes of devices in it are under each device's accessory ref, or in the history without entity_ref.";
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
    if (
      input.operation === VIRTUAL_DEVICE ||
      input.operation === VIRTUAL_DEVICE_DELETE
    ) {
      return {
        status: "ok",
        operation: input.operation,
        contract: virtualDeviceContract(input.operation),
      };
    }
    if (input.operation === "virtual_light_group") {
      if (input.target_ref !== undefined && !isHomeRef(input.target_ref)) {
        const group = await this.#readLampGroup(input.target_ref);
        return {
          status: "ok",
          operation: input.operation,
          target_ref: group.ref,
          contract: lampGroupContract(group),
        };
      }
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
    const result = await this.#prepareOperation(input);
    // A prepared change the request asks for is applied without asking the
    // owner again; one the owner must hear of first (tell_owner) is not.
    return result.status === "prepared" && result.tell_owner === undefined
      ? {
          ...result,
          next: {
            tool: "apply_native_change",
            arguments: { change_ref: result.change_ref },
            when: "the request asks for this change, not only to prepare or propose it",
          },
        }
      : result;
  }

  async #prepareOperation(input) {
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
    if (input.operation === VIRTUAL_DEVICE) {
      return this.#prepareVirtualDevice(input);
    }
    if (input.operation === VIRTUAL_DEVICE_DELETE) {
      return this.#prepareVirtualDeviceDelete(input);
    }
    if (input.operation === "virtual_light_group") {
      return isHomeRef(input.target_ref)
        ? this.#prepareVirtualLightGroup(input)
        : this.#prepareLampGroupMembers(input);
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

  // «Сделай виртуальный выключатель „Режим гостей“ в гостиной».
  async #prepareVirtualDevice(input) {
    parseConfiguredHomeRef(input.target_ref, this.hubSerial);
    const name = virtualDeviceName(
      requiredNativeName(input.name, "a virtual device").trim(),
    );
    const type = virtualDeviceType(input.value);
    const room = await this.#requireRoom(input.room_ref);
    const accessories = await this.client.listAccessories();
    const matching = await this.#virtualAccessories(
      accessories.filter(
        (accessory) => accessory.roomId === room.id && accessory.name === name,
      ),
    );
    const now = new Date().toISOString();
    const change = {
      id: this.store.newId(),
      kind: VIRTUAL_DEVICE,
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      room_id: room.id,
      room_name: room.name,
      requested_name: name,
      service_type: type,
      create_request: {
        name,
        roomId: room.id,
        services: [{ type, name, optional: [] }],
      },
      baseline_accessory_ids: accessories.map(({ id }) => id),
      ...(matching.length > 0
        ? {
            matching: matching.map(({ id, name: found }) => ({
              id,
              name: found,
            })),
          }
        : {}),
      native_write_sent: false,
      native_acknowledged: false,
      creation_owned: false,
      last_verification: freshVerification("baseline_absent"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return {
      ...publicNativeChange(change),
      ...(matching.length > 0
        ? { tell_owner: VIRTUAL_DEVICE_DUPLICATE_NOTE }
        : {}),
    };
  }

  async #requireRoom(roomRef) {
    const roomId = parseRoomRef(roomRef, this.hubSerial);
    const room = await this.client.getRoom(roomId);
    if (!room) {
      throw new SprutHubError(
        "room_not_found",
        "The selected room was not found.",
        "home_overview",
      );
    }
    return { id: roomId, name: room.name };
  }

  // New accessories of the requested name in the requested room, not in
  // the home before the write: after a lost create answer they may be the
  // device, but nothing proves it.
  async #newVirtualDeviceCandidates({ name, roomId }, baseline) {
    const known = new Set(baseline);
    return (await this.client.listAccessories())
      .filter(
        (accessory) =>
          !known.has(accessory.id) &&
          accessory.name === name &&
          accessory.roomId === roomId,
      )
      .map(({ id, name: found }) => ({ id, name: found }));
  }

  async #recordUnknownVirtualCreation(change, status, request, baseline) {
    let candidates;
    try {
      candidates = await this.#newVirtualDeviceCandidates(request, baseline);
    } catch (error) {
      return this.#finishNative(change, status, undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    return this.#finishNative(change, status, undefined, {
      candidates,
      configuration_matches: undefined,
      conflict_reason: "virtual_device_creation_outcome_unknown",
      last_verification: freshVerification(
        candidates.length > 0
          ? "unowned_matching_device_observed"
          : "matching_device_missing",
      ),
    });
  }

  async #applyVirtualDevice(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.created_id !== undefined) {
      return this.#observeVirtualDevice(change);
    }
    if (change.native_write_sent === true && change.status !== "not_applied") {
      return this.#recordUnknownVirtualCreation(
        change,
        "uncertain",
        change.create_request,
        change.baseline_accessory_ids,
      );
    }
    if (!(await this.client.getRoom(change.room_id))) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "room_missing",
        last_verification: freshVerification("room_missing"),
      });
    }
    const appeared = await this.#newVirtualDeviceCandidates(
      change.create_request,
      change.baseline_accessory_ids,
    );
    if (appeared.length > 0) {
      return this.#finishNative(change, "conflict", undefined, {
        candidates: appeared,
        conflict_reason: "matching_device_appeared",
        last_verification: freshVerification("matching_device_appeared"),
      });
    }
    await this.#persistNativeIntent(change, "applying", "apply");
    let created;
    try {
      created = await this.client.createAccessory(change.create_request);
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, "not_applied", error);
      }
      return this.#recordUnknownVirtualCreation(
        change,
        "uncertain",
        change.create_request,
        change.baseline_accessory_ids,
      );
    }
    change.native_acknowledged = true;
    change.write_intent.acknowledged = true;
    change.created_id = created.id;
    change.created_snapshot = virtualDeviceSnapshot(created);
    change.creation_owned = true;
    await this.#saveBeforeWrite(change);
    return this.#observeVirtualDevice(change);
  }

  async #observeVirtualDevice(change) {
    let accessory;
    try {
      accessory = await this.client.getAccessoryOrNull(change.created_id);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    if (accessory === null) {
      if (nativeIntentDirection(change) === "restore") {
        return this.#finishNative(change, "restored", undefined, {
          last_verification: freshVerification("created_device_absent"),
        });
      }
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "created_device_missing",
        last_verification: freshVerification("created_device_missing"),
      });
    }
    const changed = await this.#changedCreatedDevice(change, accessory);
    if (changed) return changed;
    return this.#finishNative(change, "applied", undefined, {
      last_verification: freshVerification("created_device_observed"),
    });
  }

  // The saved id holds another device than the one created: a physical
  // one, or the created one renamed, moved or rebuilt since. It is not this
  // change's to delete.
  async #changedCreatedDevice(change, accessory) {
    if (sameCreatedDevice(accessory, change.created_snapshot)) return null;
    return this.#finishNative(change, "conflict", undefined, {
      observed_device: {
        name: accessory.name,
        room_id: accessory.roomId,
        virtual: accessory.virtual === true,
      },
      conflict_reason: "manual_change",
      last_verification: freshVerification("conflict"),
    });
  }

  async #getVirtualDevice(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.created_id !== undefined) {
      return this.#observeVirtualDevice(change);
    }
    if (change.native_write_sent === true && change.status !== "not_applied") {
      return this.#recordUnknownVirtualCreation(
        change,
        "uncertain",
        change.create_request,
        change.baseline_accessory_ids,
      );
    }
    return publicStoredNativeChange(change);
  }

  // Undo of a creation: the created device is deleted by its id, unless
  // scenarios, links or logic now refer to it.
  async #restoreVirtualDevice(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.creation_owned !== true || change.created_id === undefined) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "virtual_device_creation_not_confirmed",
        last_verification: savedVerification(change.last_verification),
      });
    }
    const accessory = await this.client.getAccessoryOrNull(change.created_id);
    if (accessory === null) {
      return this.#finishNative(change, "restored", undefined, {
        last_verification: freshVerification("created_device_absent"),
      });
    }
    const changed = await this.#changedCreatedDevice(change, accessory);
    if (changed) return changed;
    const dependencies = await this.#virtualDeviceDependencies(accessory);
    if (hasDependencies(dependencies)) {
      return this.#finishNative(change, "conflict", undefined, {
        dependencies,
        conflict_reason: "virtual_device_in_use",
        last_verification: freshVerification("virtual_device_in_use"),
      });
    }
    await this.#persistNativeIntent(change, "restoring", "restore");
    return this.#deleteVirtualDevice(change, change.created_id, "applied");
  }

  // Deletes the accessory and reads it back: gone is done; still there or
  // unread is unknown, decided by the next read.
  async #deleteVirtualDevice(change, id, refusedStatus) {
    try {
      await this.client.deleteAccessory(id);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, refusedStatus, error);
      }
    }
    let after;
    try {
      after = await this.client.getAccessoryOrNull(id);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    if (after === null) {
      return this.#finishNative(
        change,
        change.kind === VIRTUAL_DEVICE ? "restored" : "applied",
        undefined,
        { last_verification: freshVerification("device_absent") },
      );
    }
    return this.#finishNative(change, "uncertain", undefined, {
      configuration_matches: undefined,
      conflict_reason: change.native_acknowledged
        ? "ack_without_device_deletion"
        : "device_delete_outcome_unknown",
      last_verification: freshVerification("device_still_present"),
    });
  }

  // What refers to a virtual device: the scenarios the hub lists for it,
  // the devices its characteristics are linked with, the bridges that
  // export it and the logic assigned to its services.
  async #virtualDeviceDependencies(accessory) {
    const homeRef = configuredHomeRef(this.hubSerial);
    const services = ownServices(accessory);
    const scenarios = (
      await this.client.listAccessoryScenarios(accessory.id)
    ).map(({ index, name }) => ({
      ref: `${homeRef}/scenario/${encodeURIComponent(index)}`,
      name,
    }));
    const linked = [];
    for (const service of services) {
      for (const characteristic of service.characteristics ?? []) {
        if (characteristic.control?.type === "Name") continue;
        const target = {
          aId: accessory.id,
          sId: service.sId,
          cId: characteristic.cId,
        };
        const others = (await this.client.listLinks(target))
          .filter(({ type }) => type === "IN" || type === "OUT")
          .flatMap(({ characteristics }) => characteristics)
          .filter(({ aId }) => aId !== accessory.id);
        if (others.length > 0) {
          linked.push({ type: characteristic.control?.type, others });
        }
      }
    }
    let names = new Map();
    if (linked.length > 0) {
      names = new Map(
        (await this.client.listAccessories()).map(({ id, name }) => [id, name]),
      );
    }
    const links = linked.map(({ type, others }) => ({
      characteristic: type,
      with: [...new Set(others.map(({ aId }) => aId))].map((aId) => ({
        ref: `${homeRef}/accessory/${aId}`,
        name: names.get(aId) ?? null,
      })),
    }));
    const logics = [];
    for (const service of services) {
      for (const logic of await this.client.listLogics({
        aId: accessory.id,
        sId: service.sId,
      })) {
        logics.push({
          name:
            typeof logic.name === "string" ? logic.name : String(logic.type),
        });
      }
    }
    const bridges = await this.client.accessoryBridgeExports(accessory.id);
    return { scenarios, links, bridges, logics };
  }

  // «Удали кнопку Десерт».
  async #prepareVirtualDeviceDelete(input) {
    const { id } = parseAccessoryRef(input.target_ref, this.hubSerial);
    const accessory = await this.client.getAccessory(id);
    if (accessory.virtual !== true) throw notAVirtualDevice();
    const [room, dependencies] = await Promise.all([
      this.client.getRoom(accessory.roomId),
      this.#virtualDeviceDependencies(accessory),
    ]);
    const now = new Date().toISOString();
    const change = {
      id: this.store.newId(),
      kind: VIRTUAL_DEVICE_DELETE,
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      room_id: accessory.roomId,
      room_name: room?.name ?? null,
      target_name: accessory.name,
      baseline_snapshot: virtualDeviceSnapshot(accessory),
      dependencies,
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("device_observed"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return {
      ...publicNativeChange(change),
      ...(hasDependencies(dependencies)
        ? { tell_owner: VIRTUAL_DEVICE_DEPENDENCIES_NOTE }
        : {}),
    };
  }

  async #applyVirtualDeviceDelete(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (nativeIntentDirection(change) === "restore") {
      return this.#getVirtualDeviceDelete(change);
    }
    const id = change.baseline_snapshot.id;
    const accessory = await this.client.getAccessoryOrNull(id);
    if (accessory === null) {
      if (change.native_write_sent === true) {
        return this.#finishNative(change, "applied", undefined, {
          last_verification: freshVerification("device_absent"),
        });
      }
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "virtual_device_missing",
        last_verification: freshVerification("device_missing"),
      });
    }
    if (
      !isDeepStrictEqual(
        virtualDeviceSnapshot(accessory),
        change.baseline_snapshot,
      )
    ) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
    }
    // The owner confirmed what prepare named; something new since then is
    // theirs to hear of first.
    const dependencies = await this.#virtualDeviceDependencies(accessory);
    if (!dependenciesWithin(dependencies, change.dependencies)) {
      return this.#finishNative(change, "conflict", undefined, {
        dependencies,
        conflict_reason: "dependencies_changed",
        last_verification: freshVerification("dependencies_changed"),
      });
    }
    await this.#persistNativeIntent(change, "applying", "apply");
    return this.#deleteVirtualDevice(change, id, "not_applied");
  }

  async #getVirtualDeviceDelete(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (change.native_write_sent !== true) {
      return publicStoredNativeChange(change);
    }
    if (nativeIntentDirection(change) === "restore") {
      return this.#restoreVirtualDeviceDelete(change, { readOnly: true });
    }
    let accessory;
    try {
      accessory = await this.client.getAccessoryOrNull(
        change.baseline_snapshot.id,
      );
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    return this.#finishNative(
      change,
      accessory === null ? "applied" : "uncertain",
      undefined,
      {
        last_verification: freshVerification(
          accessory === null ? "device_absent" : "device_still_present",
        ),
      },
    );
  }

  // Undo of a deletion creates the device again with its name, room and
  // service types. It is a new device: what referred to the old one is not
  // put back on it.
  async #restoreVirtualDeviceDelete(change, { readOnly = false } = {}) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    const snapshot = change.baseline_snapshot;
    const request = {
      name: snapshot.name,
      roomId: snapshot.room_id,
    };
    if (change.recreated_id !== undefined) {
      const accessory = await this.client.getAccessoryOrNull(
        change.recreated_id,
      );
      return accessory === null
        ? this.#finishNative(change, "conflict", undefined, {
            conflict_reason: "recreated_device_missing",
            last_verification: freshVerification("recreated_device_missing"),
          })
        : this.#finishNative(change, "restored", undefined, {
            recreated_snapshot: virtualDeviceSnapshot(accessory),
            last_verification: freshVerification("recreated_device_observed"),
          });
    }
    if (
      nativeIntentDirection(change) === "restore" &&
      change.native_write_sent
    ) {
      return this.#recordUnknownVirtualCreation(
        change,
        "uncertain",
        request,
        change.restore_baseline_ids,
      );
    }
    if (readOnly) return publicStoredNativeChange(change);
    if (change.status !== "applied") {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "virtual_device_deletion_not_confirmed",
        last_verification: savedVerification(change.last_verification),
      });
    }
    if (!(await this.client.getRoom(snapshot.room_id))) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "room_missing",
        last_verification: freshVerification("room_missing"),
      });
    }
    const [serviceTypes, accessories] = await Promise.all([
      this.client.listServiceTypes(),
      this.client.listAccessories(),
    ]);
    change.restore_baseline_ids = accessories.map(({ id }) => id);
    await this.#persistNativeIntent(change, "restoring", "restore");
    let created;
    try {
      created = await this.client.createAccessory({
        ...request,
        services: recreateServices(snapshot, serviceTypes),
      });
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        throw await this.#finishRefusedWrite(change, "applied", error);
      }
      return this.#recordUnknownVirtualCreation(
        change,
        "uncertain",
        request,
        change.restore_baseline_ids,
      );
    }
    change.native_acknowledged = true;
    change.write_intent.acknowledged = true;
    change.recreated_id = created.id;
    await this.#saveBeforeWrite(change);
    return this.#restoreVirtualDeviceDelete(change);
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
    const existingRules = await this.#existingBlockRules(data);
    await this.store.save(change);
    return {
      ...publicNativeChange(change, undefined, {
        blockActionSnapshotFresh: true,
      }),
      ...(existingRules.length > 0
        ? {
            existing_rules: existingRules,
            tell_owner: existingRules.some(({ relation }) =>
              ["same", "superset"].includes(relation),
            )
              ? EXISTING_RULE_NOTE
              : PARTIAL_RULE_NOTE,
          }
        : {}),
    };
  }

  // BLOCK scenarios that already set what a new BLOCK would set on the same
  // triggers. They are found through the hub's index of the accessories the
  // new BLOCK writes, as relations find them.
  async #existingBlockRules(data) {
    const requested = blockRuleEffects(data);
    const accessoryIds = new Set([...requested.values()].map(({ aId }) => aId));
    const listed = new Map();
    for (const aId of accessoryIds) {
      for (const summary of await this.client.listAccessoryScenarios(aId)) {
        if (summary?.type === "BLOCK") listed.set(summary.index, summary);
      }
    }
    const rules = [];
    for (const index of listed.keys()) {
      const scenario = await this.client.getScenario(index);
      if (scenario?.type !== "BLOCK" || typeof scenario.data !== "string") {
        continue;
      }
      let stored;
      try {
        stored = JSON.parse(scenario.data);
      } catch {
        continue;
      }
      const relation = existingRuleRelation(stored, data, requested);
      if (!relation) continue;
      rules.push({
        ref: `${configuredHomeRef(this.hubSerial)}/scenario/${encodeURIComponent(index)}`,
        name: scenario.name,
        active: scenario.active === true,
        relation,
      });
    }
    return rules;
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
    // Deleted nodes the agent cannot write back are the owner's to hear of
    // before apply.
    const [lostNodes] = removedUnwritableLimitation(change);
    return {
      ...publicNativeChange(change, undefined, {
        blockActionSnapshotFresh: true,
      }),
      ...(lostNodes ? { tell_owner: lostNodes } : {}),
    };
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
      return withOverwriteNote(change, await this.#applyNative(change));
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
    if (change.kind === VIRTUAL_DEVICE) {
      return this.#applyVirtualDevice(change);
    }
    if (change.kind === VIRTUAL_DEVICE_DELETE) {
      return this.#applyVirtualDeviceDelete(change);
    }
    if (change.kind === LIGHT_GROUP_MEMBERS) {
      return this.#applyLampGroupMembers(change);
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
        items.push({
          index,
          command,
          input,
          draft,
          name,
          onTarget,
          shown,
          ...(draft.fields.virtual_write &&
          draft.contract.type === BUTTON_PRESS_TYPE
            ? { note: BUTTON_PRESS_NOTE }
            : {}),
        });
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
    const id = parseNativeChangeRef(changeReference);
    const change = await this.#requireNativeChange(id);
    return withOverwriteNote(change, await this.#getNative(change));
  }

  async #getNative(change) {
    if (change.kind === "accessory_placement") {
      return this.#getAccessoryPlacement(change);
    }
    if (change.kind === "room_create") {
      return this.#getRoomCreate(change);
    }
    if (change.kind === "virtual_light_group") {
      return this.#getVirtualLightGroup(change);
    }
    if (change.kind === VIRTUAL_DEVICE) {
      return this.#getVirtualDevice(change);
    }
    if (change.kind === VIRTUAL_DEVICE_DELETE) {
      return this.#getVirtualDeviceDelete(change);
    }
    if (change.kind === LIGHT_GROUP_MEMBERS) {
      return this.#getLampGroupMembers(change);
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
  // undone as a group.
  async restoreNativeChange(changeReference) {
    const { type, id } = parseRestoreRef(changeReference);
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
        compareApplication(right, left),
      );
      const results = [];
      for (const change of ordered) {
        results.push(await this.#restoreEntry(change));
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
          entries.set(member.id, member);
        }
      } else {
        entries.set(id, await this.#requireNativeChange(id));
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

  async #restoreEntry(listed) {
    let change;
    try {
      // Read again: restoring an earlier item may have updated this record.
      change = await this.#requireNativeChange(listed.id);
    } catch (error) {
      return restoreFailureItem(listed, error);
    }
    const before = {
      status: change.status,
      restoreIntentAt: restoreIntentTime(change),
    };
    try {
      const result = await this.#restoreNative(change);
      return restoreItem(change, result, before);
    } catch (error) {
      return restoreFailureItem(change, error);
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
    if (change.kind === VIRTUAL_DEVICE) {
      return this.#restoreVirtualDevice(change);
    }
    if (change.kind === VIRTUAL_DEVICE_DELETE) {
      return this.#restoreVirtualDeviceDelete(change);
    }
    if (change.kind === LIGHT_GROUP_MEMBERS) {
      return this.#undoOrUnknown(change, () =>
        this.#restoreLampGroupMembers(change),
      );
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

  // An existing virtual lamp group as the owner knows it: its lamp service,
  // name and room, the characteristics it links, the IN links of each and
  // the lamps they reach, with names, rooms and whether they are online.
  async #readLampGroup(ref) {
    const parsed = parseLampRef(ref, this.hubSerial);
    const accessory = await this.client.getAccessoryOrNull(parsed.aId);
    if (!accessory) throw notALampGroup(ref);
    const service = lampGroupService(accessory, parsed.sId, ref);
    const controls = lampControls(accessory, service);
    const links = Object.fromEntries(
      await Promise.all(
        Object.entries(controls).map(async ([type, target]) => [
          type,
          incomingLinks(await this.client.listLinks(target)),
        ]),
      ),
    );
    const types = linkedTypes(controls, links);
    const rooms = new Map(
      (await this.#listRoomRecords()).map(({ id, name }) => [id, name]),
    );
    const accessories = new Map([[accessory.id, accessory]]);
    const members = [];
    for (const member of currentMembers(types, links)) {
      const lamp = await this.#lampAccessory(accessories, member.target.aId);
      members.push({
        service_ref: lampServiceRef(
          configuredHomeRef(this.hubSerial),
          member.target,
        ),
        target: member.target,
        ...(lamp
          ? {
              name: lamp.name,
              room: rooms.get(lamp.roomId) ?? null,
              online: lamp.online === true,
            }
          : { exists: false }),
        types: member.types,
      });
    }
    return {
      ref: lampServiceRef(configuredHomeRef(this.hubSerial), {
        aId: accessory.id,
        sId: service.sId,
      }),
      target: { aId: accessory.id, sId: service.sId },
      name: accessory.name,
      room: rooms.get(accessory.roomId) ?? null,
      controls,
      links,
      types,
      members,
      rooms,
      accessories,
    };
  }

  async #lampAccessory(accessories, aId) {
    if (!accessories.has(aId)) {
      accessories.set(aId, await this.client.getAccessoryOrNull(aId));
    }
    return accessories.get(aId);
  }

  // «Перевяжи группу»: one change that gives the group exactly the named
  // lamps. Lamps it keeps are not touched; a joining one is linked on each
  // characteristic the group links that it has; links to a lamp left out
  // are removed.
  async #prepareLampGroupMembers(input) {
    const group = await this.#readLampGroup(input.target_ref);
    if (
      !Array.isArray(input.member_service_refs) ||
      input.member_service_refs.length === 0
    ) {
      throw new SprutHubError(
        "group_members_required",
        "Name in member_service_refs every lamp the group should hold, the ones it keeps included.",
        "get_native_change_contract",
      );
    }
    const homeRef = configuredHomeRef(this.hubSerial);
    const desired = [];
    for (const ref of input.member_service_refs) {
      const parsed = parseLampRef(ref, this.hubSerial);
      const accessory = await this.#lampAccessory(
        group.accessories,
        parsed.aId,
      );
      if (!accessory) {
        throw new SprutHubError(
          "group_member_not_found",
          `${ref} is not in the home. Find the lamp with find_devices.`,
          "find_devices",
        );
      }
      const service = lampService(accessory, parsed.sId, ref);
      const target = { aId: accessory.id, sId: service.sId };
      if (serviceKey(target) === serviceKey(group.target)) {
        throw new SprutHubError(
          "group_member_is_group",
          "The group cannot be one of its own lamps.",
          "get_native_change_contract",
        );
      }
      if (
        desired.some(
          (member) => serviceKey(member.target) === serviceKey(target),
        )
      ) {
        throw new SprutHubError(
          "duplicate_group_member",
          `${ref} is named twice.`,
          "get_native_change_contract",
        );
      }
      desired.push({
        ref: lampServiceRef(homeRef, target),
        target,
        accessory,
        controls: lampControls(accessory, service),
      });
    }
    const { steps, changes } = planGroupMembers({
      homeRef,
      types: group.types,
      links: group.links,
      desired,
    });
    const linked = new Set(
      group.members.map((member) => serviceKey(member.target)),
    );
    const kept = new Set(desired.map((member) => serviceKey(member.target)));
    const members = [
      ...desired.map((member) => {
        const planned = changes.get(serviceKey(member.target));
        const stays = linked.has(serviceKey(member.target));
        return {
          service_ref: member.ref,
          name: member.accessory.name,
          room: group.rooms.get(member.accessory.roomId) ?? null,
          online: member.accessory.online === true,
          change: stays ? "stays" : "joins",
          links_added: planned.added,
          lacks: !stays || planned.added.length > 0 ? planned.lacks : [],
        };
      }),
      ...group.members
        .filter((member) => !kept.has(serviceKey(member.target)))
        .map((member) => ({
          service_ref: member.service_ref,
          ...(member.exists === false
            ? { exists: false }
            : { name: member.name, room: member.room, online: member.online }),
          change: "leaves",
          links_removed: member.types,
        })),
    ];
    const lampGroup = { ref: group.ref, name: group.name, room: group.room };
    if (steps.length === 0) {
      return {
        status: "already_desired",
        operation: input.operation,
        target_ref: group.ref,
        lamp_group: lampGroup,
        characteristics: [...group.types],
        members: members.map(publicLampGroupMember),
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const outOfStep = outOfStepLamps(steps, desired);
    const pick = (record) =>
      Object.fromEntries(group.types.map((type) => [type, record[type]]));
    const now = new Date().toISOString();
    const change = {
      id: this.store.newId(),
      kind: LIGHT_GROUP_MEMBERS,
      status: "prepared",
      home_ref: homeRef,
      target_ref: group.ref,
      reason: input.reason,
      group: { ...group.target, name: group.name, room: group.room },
      linked_types: [...group.types],
      group_controls: pick(group.controls),
      baseline_links: pick(group.links),
      member_service_refs: desired.map(({ ref }) => ref),
      members,
      ...(outOfStep ? { out_of_step: outOfStep } : {}),
      steps,
      native_write_sent: false,
      native_acknowledged: false,
      last_verification: freshVerification("baseline_links_observed"),
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #observeLampGroup(change) {
    const accessory = await this.client.getAccessoryOrNull(change.group.aId);
    if (!accessory) return { absent: true };
    const links = {};
    for (const type of change.linked_types) {
      links[type] = incomingLinks(
        await this.client.listLinks(change.group_controls[type]),
      );
    }
    return { absent: false, links };
  }

  // A group gone, or links that differ where this change sent nothing: the
  // change stops there and names what it saw.
  async #lampGroupObstacle(change, observed) {
    if (observed.absent) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "lamp_group_missing",
        last_verification: freshVerification("lamp_group_missing"),
      });
    }
    const differences = foreignDifferences(change, observed, change.home_ref);
    if (differences.length === 0) return null;
    return this.#finishNative(change, "conflict", undefined, {
      conflict_reason: "manual_change",
      observed_differences: differences,
      last_verification: freshVerification("conflict"),
    });
  }

  // What the group's links now mean for this change.
  async #recordLampGroupState(change, observed) {
    const obstacle = await this.#lampGroupObstacle(change, observed);
    if (obstacle) return obstacle;
    const keys = linkKeys(observed.links);
    const settled = { observed_differences: undefined };
    if (sameKeys(keys, expectedAppliedKeys(change))) {
      return this.#finishNative(change, "applied", undefined, {
        ...settled,
        configuration_matches: true,
        last_verification: freshVerification("group_links_observed"),
      });
    }
    if (sameKeys(keys, linkKeys(change.baseline_links))) {
      if (nativeIntentDirection(change) === "restore") {
        return this.#finishNative(change, "restored", undefined, {
          ...settled,
          last_verification: freshVerification("baseline_links_observed"),
        });
      }
      if (!change.steps.some(({ sent }) => sent)) {
        return publicNativeChange(change, undefined, {
          verification: freshVerification("baseline_links_observed"),
        });
      }
      return this.#finishNative(change, "uncertain", undefined, {
        ...settled,
        conflict_reason: "link_write_outcome_unknown",
        last_verification: freshVerification("sent_link_not_observed"),
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      ...settled,
      conflict_reason: "partial_lamp_group_change",
      last_verification: freshVerification("owned_partial_group_observed"),
    });
  }

  async #getLampGroupMembers(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    let observed;
    try {
      observed = await this.#observeLampGroup(change);
    } catch (error) {
      return publicNativeChange(change, undefined, {
        verification: failedVerification(error),
      });
    }
    return this.#recordLampGroupState(change, observed);
  }

  async #applyLampGroupMembers(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    const observed = await this.#observeLampGroup(change);
    const obstacle = await this.#lampGroupObstacle(change, observed);
    if (obstacle) return obstacle;
    if (!change.steps.some(({ sent }) => sent)) {
      await this.#validateLampGroupJoiners(change);
    }
    const stopped = await this.#writeLampGroupSteps(
      change,
      change.steps,
      "apply",
      observed,
    );
    if (stopped) return stopped;
    change.native_acknowledged = change.steps.every(
      ({ acknowledged }) => acknowledged,
    );
    return this.#recordLampGroupState(
      change,
      await this.#observeLampGroup(change),
    );
  }

  async #restoreLampGroupMembers(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    if (!change.steps.some(({ sent }) => sent)) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "change_was_not_applied",
        last_verification: savedVerification(change.last_verification),
      });
    }
    const observed = await this.#observeLampGroup(change);
    const obstacle = await this.#lampGroupObstacle(change, observed);
    if (obstacle) return obstacle;
    // Derived again each time from what apply sent: a step already undone
    // is seen in the links and not written again.
    change.restore_steps = restoreSteps(change);
    await this.#saveBeforeWrite(change);
    const stopped = await this.#writeLampGroupSteps(
      change,
      change.restore_steps,
      "restore",
      observed,
    );
    if (stopped) return stopped;
    // The previous links seen after an undo are its result, whether or not
    // it had to write anything for them.
    const after = await this.#observeLampGroup(change);
    if (
      !after.absent &&
      sameKeys(linkKeys(after.links), linkKeys(change.baseline_links))
    ) {
      return this.#finishNative(change, "restored", undefined, {
        observed_differences: undefined,
        last_verification: freshVerification("baseline_links_observed"),
      });
    }
    return this.#recordLampGroupState(change, after);
  }

  // The lamps an apply links have not changed since prepare.
  async #validateLampGroupJoiners(change) {
    const accessories = new Map();
    for (const step of change.steps) {
      if (step.action !== "add") continue;
      const accessory = await this.#lampAccessory(accessories, step.target.aId);
      const characteristic =
        accessory && findNativeCharacteristic(accessory, step.target);
      if (
        characteristic?.control?.type !== step.type ||
        characteristic.control.read !== true ||
        characteristic.control.write !== true
      ) {
        throw new SprutHubError(
          "binding_changed",
          "A lamp to join changed after preparation. Nothing was written; prepare again.",
          "prepare_native_change",
        );
      }
    }
  }

  // Each step not yet seen in the group's links is written, recorded
  // before and checked after by reading that characteristic's links again.
  // Adding a link that exists and removing one that is gone change nothing
  // on the hub (2026-10-14-light-group-relink, 8 and 10), so a step whose
  // earlier send is unknown is sent again once the read shows it missing.
  // Returns a finished result when a write is not confirmed.
  async #writeLampGroupSteps(change, steps, direction, observed) {
    for (const step of steps) {
      if (stepInEffect(step, linkKeys(observed.links))) {
        if (!step.completed) {
          step.completed = true;
          if (step.sent && !step.acknowledged) {
            change.recovered_after_uncertain_write = true;
          }
          await this.#saveBeforeWrite(change);
        }
        continue;
      }
      const source = change.group_controls[step.type];
      const linkId =
        step.action === "remove"
          ? currentLinkIndex(observed.links, step)
          : undefined;
      await this.#persistVirtualLightStep(
        change,
        step.action === "add" ? "adding_link" : "removing_link",
        { characteristic_type: step.type, member_ref: step.member_ref },
        direction,
      );
      Object.assign(step, {
        sent: true,
        acknowledged: false,
        completed: false,
      });
      await this.#saveBeforeWrite(change);
      try {
        if (step.action === "add") {
          await this.client.addVirtualLink({
            ...source,
            ...virtualLinkTarget(step.target),
          });
        } else {
          await this.client.removeLink({ ...source, linkId });
        }
        step.acknowledged = true;
        change.write_intent.acknowledged = true;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          step.sent = false;
          throw await this.#finishRefusedLampGroupStep(
            change,
            direction,
            error,
          );
        }
      }
      observed.links[step.type] = incomingLinks(
        await this.client.listLinks(source),
      );
      if (!stepInEffect(step, linkKeys(observed.links))) {
        return this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          conflict_reason: step.acknowledged
            ? "ack_without_link_result"
            : "link_write_outcome_unknown",
          last_verification: freshVerification("sent_link_not_observed"),
        });
      }
      step.completed = true;
      if (!step.acknowledged) change.recovered_after_uncertain_write = true;
      await this.#saveBeforeWrite(change);
    }
    return null;
  }

  // A link write the hub refused. Before anything of this change took
  // effect on apply, nothing changed; otherwise the group holds part of it,
  // recorded as get_native_change sees it, and the error says so.
  async #finishRefusedLampGroupStep(change, direction, error) {
    const steps =
      direction === "apply" ? change.steps : (change.restore_steps ?? []);
    const partial = steps.some(({ completed }) => completed);
    if (direction === "apply" && !partial) {
      return this.#finishRefusedWrite(change, "not_applied", error);
    }
    const rejection = writeRejection(error);
    if (rejection) change.write_intent = { ...change.write_intent, rejection };
    let recorded;
    try {
      recorded = await this.#recordLampGroupState(
        change,
        await this.#observeLampGroup(change),
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
      hub_effect: partial ? "partial" : "not_applied",
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
          isNativeChange(change) &&
          change.home_ref === homeRef &&
          (entityRef === undefined ||
            nativeAffectedRefs(change, homeRef).includes(entityRef)),
      )
      .map(changeSummary)
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
      ...(entityRef !== undefined && /\/room\/[^/]+$/.test(entityRef)
        ? { hint: ROOM_HISTORY_HINT }
        : {}),
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

// A result whose journal record could not be saved says so and how to
// recover.
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

// An applied BLOCK or LOGIC change tells the agent to say what it will
// overwrite, whether the apply or a later check found it applied.
function withOverwriteNote(change, result) {
  return AUTOMATION_CHANGE_KINDS.has(change.kind) && result.status === "applied"
    ? { ...result, tell_owner: AUTOMATION_OVERWRITE_NOTE }
    : result;
}
