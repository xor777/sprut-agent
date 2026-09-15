import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AutomationStore } from "./automation-store.mjs";
import {
  BLOCK_ALLOWED_KEYS,
  BLOCK_CHILD_FIELDS,
  blockAffectedRefs,
  publishedBlockNodes,
  visitKnownBlockNodes,
} from "./block-model.mjs";
import {
  inspectNativeOption,
  isSelectableNativeValidValue,
  nativeScalarContract,
  validateNativeScalarValue,
} from "./native-option-contract.mjs";
import {
  isSensitiveNativeNode,
  SprutHubError,
  sanitizeNativeData,
} from "./spruthub-client.mjs";

const STATEFUL_CHARACTERISTIC_SETTING_TYPES = new Set([
  "TargetTemperature",
  "TargetHeatingCoolingState",
  "C_FanSpeed",
]);

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

  async getScenarioSdk(homeReference) {
    parseConfiguredHomeRef(homeReference, this.hubSerial);
    const { sdk, responseReceivedAt } = await this.client.getScenarioSdk();
    return {
      status: "ok",
      home_ref: homeReference,
      sdk,
      bytes: Buffer.byteLength(sdk),
      sha256: createHash("sha256").update(sdk).digest("hex"),
      freshness: { hub_response_received_at: responseReceivedAt },
      content_origin: "spruthub_scenario_sdk",
      limitations: [
        "The declarations describe code executed by SprutHub; they are not a Node.js or browser API.",
        "The SDK does not prove callback ordering, repeated-value delivery, or runtime behavior on a particular service.",
      ],
    };
  }

  async getNativeChangeContract(input) {
    if (input.operation === "characteristic_value") {
      if (!input.target_ref) {
        throw new SprutHubError(
          "target_required",
          "Select one characteristic before reading its write contract.",
          "get_entity",
        );
      }
      const target = parseCharacteristicRef(input.target_ref, this.hubSerial);
      const characteristic = await this.client.getCharacteristic(target);
      const contract = characteristicContract(characteristic.control);
      const restoration = characteristicSettingRestoration(
        contract,
        typedNativeValue(characteristic.control.value),
      );
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract,
        restore_supported: restoration.supported,
        ...(restoration.limitation
          ? { restore_limitation: restoration.limitation }
          : {}),
        physical_effect_reversible: false,
      };
    }
    if (input.operation === "characteristic_option") {
      const target = parseCharacteristicRef(input.target_ref, this.hubSerial);
      const { option } = await this.#readCharacteristicOption(
        target,
        input.option_key,
      );
      const state = characteristicOptionState(option);
      const restoration = scalarValueRestoration(state.contract, state.value);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        option_key: input.option_key,
        contract: state.contract,
        restore_supported: restoration.supported,
        ...(restoration.limitation
          ? { restore_limitation: restoration.limitation }
          : {}),
      };
    }
    if (input.operation === "window_option") {
      const owner = parseWindowOptionOwner(input.target_ref, this.hubSerial);
      if (owner.kind === "scenario") {
        const { option } = await this.#readScenarioMetadataOption(
          owner,
          input.option_key,
        );
        const state = windowOptionState(option, { allowText: true });
        const restoration = scalarValueRestoration(state.contract, state.value);
        return {
          status: "ok",
          operation: input.operation,
          target_ref: input.target_ref,
          option_key: input.option_key,
          contract: state.contract,
          restore_supported: restoration.supported,
          ...(restoration.limitation
            ? { restore_limitation: restoration.limitation }
            : {}),
        };
      }
      const { option } = await this.#readWindowOption(owner, input.option_key);
      await this.#rejectDirectScenarioMetadataWindow(owner.windowKey, option);
      const state = windowOptionState(option);
      const restoration = scalarValueRestoration(state.contract, state.value);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        option_key: input.option_key,
        contract: state.contract,
        restore_supported: restoration.supported,
        ...(restoration.limitation
          ? { restore_limitation: restoration.limitation }
          : {}),
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
    if (input.operation === "logic_active") {
      const target = parseLogicRef(input.target_ref, this.hubSerial);
      const logic = await this.client.getLogic(target);
      if (!logic) throw logicNotFound();
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: logicActiveContract(),
      };
    }
    if (input.operation === "logic_option") {
      const target = parseLogicRef(input.target_ref, this.hubSerial);
      const { option } = await this.#readLogicOption(target, input.option_key);
      const state = logicOptionState(option);
      const restoration = scalarValueRestoration(state.contract, state.value);
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        option_key: input.option_key,
        contract: state.contract,
        restore_supported: restoration.supported,
        ...(restoration.limitation
          ? { restore_limitation: restoration.limitation }
          : {}),
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
      const target = parseScenarioRef(input.target_ref, this.hubSerial);
      const scenario = await this.client.getScenario(target.index);
      if (!scenario) throw scenarioNotFound();
      const snapshot = scenarioSnapshot(scenario);
      await validateScenarioRun(snapshot, this.client);
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
      };
    }
    throw unsupportedNativeOperation();
  }

  async prepareNativeChange(input) {
    if (input.operation === "characteristic_value") {
      return this.#prepareCharacteristicChange(input);
    }
    if (input.operation === "characteristic_option") {
      return this.#prepareCharacteristicOptionChange(input);
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
    if (input.operation === "window_option") {
      return this.#prepareWindowOptionChange(input);
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
    if (["logic_active", "logic_option"].includes(input.operation)) {
      return this.#prepareLogicValueChange(input);
    }
    throw unsupportedNativeOperation();
  }

  async #prepareCharacteristicChange(input) {
    const target = parseCharacteristicRef(input.target_ref, this.hubSerial);
    const characteristic = await this.client.getCharacteristic(target);
    const contract = characteristicContract(characteristic.control);
    const requestedValue = validateCharacteristicValue(input.value, contract);
    const baselineValue = typedNativeValue(characteristic.control.value);
    const virtualGroup = await this.#findOwnedVirtualGroupContext(target);
    if (
      !virtualGroup &&
      isKnownCharacteristicSetting(contract.type) &&
      valuesEqual(baselineValue, requestedValue)
    ) {
      return {
        status: "already_desired",
        operation: "characteristic_value",
        target_ref: input.target_ref,
        observed_value: baselineValue,
        native_write_sent: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "characteristic_value",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      target,
      contract,
      baseline_value: baselineValue,
      requested_value: requestedValue,
      ...(virtualGroup
        ? {
            virtual_group_change_ref: `spruthub-change://native/${virtualGroup.change_id}`,
            group_characteristic_type: virtualGroup.characteristic_type,
            group_member_targets: virtualGroup.members,
          }
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

  async #findOwnedVirtualGroupContext(target) {
    const matches = [];
    for (const change of await this.store.list()) {
      if (
        change.kind !== "virtual_light_group" ||
        change.status !== "applied" ||
        change.virtual_accessory_creation_owned !== true
      ) {
        continue;
      }
      for (const type of change.characteristic_types) {
        if (
          nativeTargetKey(change.virtual_target?.characteristics?.[type]) !==
          nativeTargetKey(target)
        ) {
          continue;
        }
        matches.push({
          change_id: change.id,
          characteristic_type: type,
          members: change.members.map((member) => ({
            member_ref: member.ref,
            target: structuredClone(member.characteristics[type]),
          })),
        });
      }
    }
    if (matches.length > 1) {
      throw new SprutHubError(
        "incompatible_local_state",
        "More than one owned virtual-light journal claims this characteristic.",
        "list_native_changes",
      );
    }
    return matches[0] ?? null;
  }

  async #prepareCharacteristicOptionChange(input) {
    const target = parseCharacteristicRef(input.target_ref, this.hubSerial);
    const { option } = await this.#readCharacteristicOption(
      target,
      input.option_key,
    );
    const { contract, value: baselineValue } =
      characteristicOptionState(option);
    const requestedValue = validateCharacteristicValue(input.value, contract);
    if (valuesEqual(baselineValue, requestedValue)) {
      return {
        status: "already_desired",
        operation: "characteristic_option",
        target_ref: input.target_ref,
        option_key: input.option_key,
        observed_value: baselineValue,
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "characteristic_option",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      option_key: input.option_key,
      target,
      contract,
      baseline_value: baselineValue,
      requested_value: requestedValue,
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

  async #prepareWindowOptionChange(input) {
    const owner = parseWindowOptionOwner(input.target_ref, this.hubSerial);
    if (owner.kind === "scenario") {
      return this.#prepareScenarioMetadataOption(input, owner);
    }
    const { option } = await this.#readWindowOption(owner, input.option_key);
    await this.#rejectDirectScenarioMetadataWindow(owner.windowKey, option);
    const { contract, value: baselineValue } = windowOptionState(option);
    const requestedValue = validateCharacteristicValue(input.value, contract);
    if (valuesEqual(baselineValue, requestedValue)) {
      return {
        status: "already_desired",
        operation: "window_option",
        target_ref: input.target_ref,
        option_key: input.option_key,
        observed_value: baselineValue,
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "window_option",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      option_key: input.option_key,
      target: owner,
      contract,
      baseline_value: baselineValue,
      requested_value: requestedValue,
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

  async #prepareScenarioMetadataOption(input, owner) {
    const { scenario, option, windowKey } =
      await this.#readScenarioMetadataOption(owner, input.option_key);
    const { contract, value: baselineValue } = windowOptionState(option, {
      allowText: true,
    });
    if (typeof input.value !== "string") {
      throw new SprutHubError(
        "invalid_native_value",
        "BLOCK Name and Desc require a string value.",
        "get_native_change_contract",
      );
    }
    if (input.option_key === "Name")
      requiredNativeName(input.value, "window_option");
    const requestedText =
      input.option_key === "Desc"
        ? nativeScenarioDescription(
            input.value,
            await this.#provenBlockOwnershipMarker(
              input.target_ref,
              typeof scenario.desc === "string"
                ? scenario.desc
                : baselineValue.value,
            ),
          )
        : input.value;
    const requestedValue = validateCharacteristicValue(requestedText, contract);
    if (valuesEqual(baselineValue, requestedValue)) {
      return {
        status: "already_desired",
        operation: "window_option",
        target_ref: input.target_ref,
        option_key: input.option_key,
        observed_value: baselineValue,
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: "window_option",
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      window_ref: `${configuredHomeRef(this.hubSerial)}/window/${encodeURIComponent(windowKey)}`,
      option_key: input.option_key,
      target: { windowKey },
      owner_kind: "scenario",
      owner_index: owner.index,
      owner_guard: scenarioOwnerGuard(scenario, input.option_key),
      contract,
      baseline_value: baselineValue,
      requested_value: requestedValue,
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

  async #prepareLogicValueChange(input) {
    const target = parseLogicRef(input.target_ref, this.hubSerial);
    let option;
    let contract;
    let baselineValue;
    if (input.operation === "logic_active") {
      const logic = await this.client.getLogic(target);
      if (!logic) throw logicNotFound();
      contract = logicActiveContract();
      baselineValue = logicActiveValue(logic);
    } else {
      ({ option } = await this.#readLogicOption(target, input.option_key));
      ({ contract, value: baselineValue } = logicOptionState(option));
    }
    const requestedValue = validateCharacteristicValue(input.value, contract);
    if (valuesEqual(baselineValue, requestedValue)) {
      return {
        status: "already_desired",
        operation: input.operation,
        target_ref: input.target_ref,
        ...(input.operation === "logic_option"
          ? { option_key: input.option_key }
          : {}),
        observed_value: baselineValue,
        native_write_sent: false,
        owned_change_created: false,
      };
    }
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      kind: input.operation,
      status: "prepared",
      home_ref: configuredHomeRef(this.hubSerial),
      reason: input.reason,
      target_ref: input.target_ref,
      target,
      ...(input.operation === "logic_option"
        ? { option_key: input.option_key }
        : {}),
      contract,
      baseline_value: baselineValue,
      requested_value: requestedValue,
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
        "inspect_home",
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
    const name = requiredNativeName(input.name, "room creation").trim();
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
        "list_rooms",
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
    const matching = allAccessories.filter(
      (accessory) =>
        accessory.virtual === true &&
        accessory.roomId === roomId &&
        accessory.name === name,
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
      throw unsupportedBlockFlags(input.target_ref);
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
    const validation = await validateBlockData(prepared.data, this.client, {
      allowUnknownFrom: baseline.data,
      allowedPauses: pauseChanges,
      allowActionOnly: true,
    });
    requireActionOnlyRuntime(baseline, validation);
    const requested = {
      ...structuredClone(baseline),
      data: prepared.data,
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

  async #prepareScenarioRun(input) {
    const target = parseScenarioRef(input.target_ref, this.hubSerial);
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) throw scenarioNotFound();
    const snapshot = scenarioSnapshot(scenario);
    const targets = await validateScenarioRun(snapshot, this.client);
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
      targets,
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
    const baselineLogicTypes = await this.#readLogicTypeCatalog(target);
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
      baseline_logic_types: baselineLogicTypes,
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
      requested_snapshot: { ...structuredClone(baseline), data: source },
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

  async #readLogicTypeCatalog(target) {
    const [accessory, types] = await Promise.all([
      this.client.getAccessory(target.aId),
      this.client.listLogicTypes(target),
    ]);
    if (!accessory.services?.some(({ sId }) => sId === target.sId)) {
      throw new SprutHubError(
        "service_not_found",
        "The selected service was not found on its accessory.",
        "get_entity",
      );
    }
    const values = types.map((entry) => {
      if (!isRecord(entry) || typeof entry.type !== "string") {
        throw new SprutHubError(
          "incompatible_response",
          "SprutHub returned incomplete logic type data.",
        );
      }
      return entry.type;
    });
    if (new Set(values).size !== values.length) {
      throw new SprutHubError(
        "incompatible_response",
        "SprutHub returned the same logic type more than once.",
      );
    }
    return values.sort((left, right) => left.localeCompare(right));
  }

  async applyNativeChange(changeReference) {
    const id = parseNativeChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireNativeChange(id);
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
    });
  }

  async #applyValueChange(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    let currentState;
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
    if (change.status === "applied") {
      const current = await this.#readNativeValue(change);
      if (valuesEqual(current, change.requested_value)) {
        change.applied_value_observed = true;
        return this.#recordNativeObservation(
          change,
          current,
          "requested_value_observed",
        );
      }
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "value_changed_after_apply",
        last_verification: freshVerification("conflict"),
      });
    }
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
    const ownerConflict = await this.#finishScenarioMetadataOwnerConflict(
      change,
      current,
    );
    if (ownerConflict) return ownerConflict;

    await this.#persistNativeIntent(change, "applying", "apply");
    try {
      await this.#writeNativeValue(change, change.requested_value);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        await this.#finishNative(change, "not_applied", current);
        throw error;
      }
      return this.#reconcileValueAfterWrite(change, "apply");
    }
    return this.#reconcileValueAfterWrite(change, "apply", true);
  }

  async #reconcileValueAfterWrite(change, direction, acknowledged = false) {
    const pending = await this.#reconcilePendingValueChange(change, {
      acknowledged,
    });
    if (!pending || pending.direction !== direction) {
      throw new Error("Native write intent changed before readback.");
    }
    return pending.result;
  }

  async #reconcilePendingValueChange(
    change,
    { requireWrite = false, acknowledged = false } = {},
  ) {
    if (!nativeValueIntentEvidence(change).unresolved) {
      return undefined;
    }
    const direction = nativeIntentDirection(change);
    let state;
    let groupMemberObservations;
    try {
      state = await this.#readNativeValueState(change, { requireWrite });
      if (
        direction === "apply" &&
        change.group_member_targets &&
        valuesEqual(state.value, change.requested_value)
      ) {
        groupMemberObservations = await this.#readVirtualGroupMembers(change);
      }
    } catch (error) {
      if (
        error instanceof SprutHubError &&
        error.code === "sensitive_native_data"
      ) {
        throw error;
      }
      return {
        direction,
        outcome: "read_failed",
        result: await this.#finishNative(change, "uncertain", undefined, {
          configuration_matches: undefined,
          last_verification: failedVerification(error),
        }),
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
      hasKnownSettingSemantics(change) &&
      !valuesEqual(current, change.baseline_value) &&
      !valuesEqual(current, change.requested_value)
    ) {
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
    const verificationResult =
      direction === "restore"
        ? "baseline_value_missing"
        : "requested_value_missing";
    return {
      direction,
      outcome: "expected_missing",
      current,
      contract,
      result: await this.#finishNative(change, "uncertain", current, {
        ...(groupMemberObservations
          ? {
              group_member_observations: groupMemberObservations,
              group_delivery_confirmed: false,
            }
          : {}),
        last_verification: freshVerification(verificationResult),
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
      }),
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
    const pending = await this.#reconcilePendingValueChange(change);
    if (pending) return pending.result;
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
    if (
      change.status === "applied" &&
      !valuesEqual(current, change.requested_value)
    ) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "value_changed_after_apply",
        manual_change_observed: true,
        last_verification: freshVerification("conflict"),
      });
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
    return this.#recordNativeObservation(
      change,
      current,
      valuesEqual(current, change.requested_value)
        ? "requested_value_observed"
        : "current_value_observed",
    );
  }

  async restoreNativeChange(changeReference) {
    const id = parseNativeChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireNativeChange(id);
      if (change.kind === "accessory_placement") {
        return this.#restoreAccessoryPlacement(change);
      }
      if (change.kind === "room_create") {
        return this.#restoreRoomCreate(change);
      }
      if (change.kind === "virtual_light_group") {
        return this.#restoreVirtualLightGroup(change);
      }
      if (change.kind === "characteristic_value") {
        const restoration = nativeValueRestoration(change);
        if (!restoration.supported) {
          throw new SprutHubError(
            "restore_unsupported",
            restoration.limitation?.message ??
              "This characteristic is not a supported restorable setting.",
            "get_native_change",
          );
        }
        return this.#restoreValueChange(change);
      }
      if (["characteristic_option", "window_option"].includes(change.kind)) {
        return this.#restoreValueChange(change);
      }
      if (["logic_active", "logic_option"].includes(change.kind)) {
        return this.#restoreValueChange(change);
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
      if (isLogicSourceChange(change)) {
        return this.#restoreScenarioChange(change);
      }
      if (change.kind === "block_action_pause") {
        return this.#restoreBlockActionPause(change);
      }
      return this.#restoreScenarioChange(change);
    });
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
    if (change.status === "applied") {
      if (accessoryPlacementMatches(current, change.applied_snapshot)) {
        return this.#finishNative(change, "applied", undefined, {
          observed_snapshot: current,
          last_verification: freshVerification("applied_snapshot_observed"),
        });
      }
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
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
        await this.#finishNative(change, "not_applied", undefined, {
          observed_snapshot: current,
        });
        throw error;
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
    if (
      change.status === "applied" &&
      !accessoryPlacementMatches(current, change.applied_snapshot)
    ) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_snapshot: current,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
    }
    return this.#finishNative(change, change.status, undefined, {
      observed_snapshot: current,
      last_verification: freshVerification("current_configuration_observed"),
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
      if (pending.result.status === "restored") return pending.result;
      if (direction === "apply" && pending.result.status === "applied") {
        current = pending.current;
      } else {
        const retryableRestore =
          direction === "restore" &&
          pending.outcome === "expected_missing" &&
          accessoryPlacementMatches(pending.current, change.applied_snapshot);
        if (!retryableRestore) return pending.result;
        current = pending.current;
      }
    }
    if (change.applied_snapshot === undefined) {
      return this.#finishNative(change, "not_owned", undefined, {
        conflict_reason: "change_was_not_applied",
        last_verification: savedVerification(change.last_verification),
      });
    }
    current ??= await this.#observeAccessoryPlacement(change);
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
        await this.#finishNative(change, "applied", undefined, {
          observed_snapshot: current,
        });
        throw error;
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
    if (change.native_write_sent) {
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
        await this.#finishNative(change, "not_applied");
        throw error;
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
    if (change.native_write_sent) {
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
      return this.#finishNative(change, "conflict", undefined, {
        observed_room: snapshot,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
    }
    return this.#finishNative(change, "applied", undefined, {
      observed_room: snapshot,
      last_verification: freshVerification("created_room_observed"),
    });
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
      return this.#finishNative(change, "conflict", undefined, {
        observed_room: snapshot,
        conflict_reason: "manual_change",
        last_verification: freshVerification("conflict"),
      });
    }
    const contents = await this.client.listAccessoriesInRoom(
      change.created_room_id,
    );
    if (contents.length > 0) {
      return this.#finishNative(change, "conflict", undefined, {
        observed_room: snapshot,
        room_contents: contents.map(({ id, name }) => ({
          ref: `${change.home_ref}/accessory/${id}`,
          name,
        })),
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
        await this.#finishNative(change, "applied", undefined, {
          observed_room: snapshot,
        });
        throw error;
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
          await this.#finishNative(change, "not_applied");
          throw error;
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
          await this.#finishNative(change, "not_applied");
          throw error;
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
          await this.#finishNative(change, "not_applied");
          throw error;
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
          await this.#finishNative(change, "applied", undefined, {
            observed_snapshot: current,
          });
          throw error;
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
          await this.#finishNative(change, "applied", undefined, {
            observed_snapshot: current,
          });
          throw error;
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
        await this.#finishNative(change, "applied", undefined, {
          observed_snapshot: current,
        });
        throw error;
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
    return (await this.client.listAccessories())
      .filter(
        (accessory) =>
          (!onlyNew || !baseline.has(accessory.id)) &&
          matchesVirtualLightCandidate(accessory, change, {
            allowNormalizedName: onlyNew,
          }),
      )
      .map(({ id, name }) => ({
        ref: `${change.home_ref}/accessory/${id}`,
        name,
      }));
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
    home_ref: homeRef,
    entity_ref: entityRef,
    limit,
    cursor,
  }) {
    parseConfiguredHomeRef(homeRef, this.hubSerial);
    if (entityRef !== undefined) requireEntityHome(entityRef, this.hubSerial);
    const selection = historySelection(homeRef, entityRef, limit, cursor);
    const storedChanges = await this.store.list();
    await this.#reconcileHistoryScenario(storedChanges, entityRef);
    const all = storedChanges
      .filter(
        (change) =>
          change.home_ref === undefined || change.home_ref === homeRef,
      )
      .map((change) => changeSummary(change, homeRef))
      .filter(
        (change) =>
          entityRef === undefined || change.target_refs.includes(entityRef),
      )
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
        await this.#finishNative(change, "not_applied", undefined, {
          configuration_matches: true,
        });
        throw error;
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
        await this.#finishNative(change, "applied", undefined, {
          configuration_matches: true,
        });
        throw error;
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
    if (
      ![
        "characteristic_value",
        "characteristic_option",
        "window_option",
        "logic_active",
        "logic_option",
        "logic_assignment",
        "accessory_placement",
        "room_create",
        "virtual_light_group",
        "block_create",
        "block_data_update",
        "block_action_pause",
        "scenario_run",
        "logic_source_create",
        "logic_source_update",
      ].includes(change?.kind)
    ) {
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

  async #readCharacteristicState(change, { requireWrite = false } = {}) {
    const characteristic = await this.client.getCharacteristic(change.target);
    const contract = characteristicContract(characteristic.control, {
      requireWrite,
    });
    if (
      contract.type !== change.contract.type ||
      contract.kind !== change.contract.kind
    ) {
      throw new SprutHubError(
        "binding_changed",
        "The selected characteristic contract changed after preparation.",
        "prepare_native_change",
      );
    }
    change.contract = contract;
    return {
      value: typedNativeValue(characteristic.control.value),
      contract,
    };
  }

  async #readCharacteristicOption(target, optionKey) {
    if (typeof optionKey !== "string" || optionKey.length === 0) {
      throw new SprutHubError(
        "option_key_required",
        "Select one characteristic option before reading its write contract.",
        "get_entity",
      );
    }
    const options = await this.client.getCharacteristicOptions(target);
    const matches = options.filter(({ key }) => key === optionKey);
    if (matches.length !== 1) {
      throw new SprutHubError(
        matches.length === 0
          ? "characteristic_option_not_found"
          : "incompatible_response",
        matches.length === 0
          ? "The selected characteristic option was not found."
          : "SprutHub returned the selected characteristic option more than once.",
        "get_entity",
      );
    }
    return { option: matches[0] };
  }

  async #readCharacteristicOptionState(change, { requireWrite = false } = {}) {
    const { option } = await this.#readCharacteristicOption(
      change.target,
      change.option_key,
    );
    const state = characteristicOptionState(option, { requireWrite });
    assertOptionBinding(change, state.contract, "characteristic");
    change.contract = state.contract;
    return state;
  }

  async #readWindowOption(target, optionKey) {
    if (typeof optionKey !== "string" || optionKey.length === 0) {
      throw new SprutHubError(
        "option_key_required",
        "Select one window option before reading its write contract.",
        "get_entity",
      );
    }
    const window = await this.client.getWindow(target.windowKey);
    const matches = window.options.filter(({ key }) => key === optionKey);
    if (matches.length !== 1) {
      throw new SprutHubError(
        matches.length === 0
          ? "window_option_not_found"
          : "incompatible_response",
        matches.length === 0
          ? "The selected window option was not found."
          : "SprutHub returned the selected window option more than once.",
        "get_entity",
      );
    }
    return { window, option: matches[0] };
  }

  async #readScenarioMetadataOption(owner, optionKey) {
    if (!SCENARIO_METADATA_KEYS.has(optionKey)) {
      throw new SprutHubError(
        "unsupported_window_option",
        "A scenario window_option target supports only Name and Desc.",
        "get_entity",
      );
    }
    const scenario = await this.client.getScenario(owner.index);
    if (!scenario) throw scenarioNotFound();
    if (scenario.type !== "BLOCK") throw unsupportedScenarioType();
    if (
      typeof scenario.optionsWindow !== "string" ||
      scenario.optionsWindow.length === 0
    ) {
      throw new SprutHubError(
        "options_window_unavailable",
        "This scenario has no native options window for Name and Desc.",
        "get_entity",
      );
    }
    const { window, option } = await this.#readWindowOption(
      { windowKey: scenario.optionsWindow },
      optionKey,
    );
    return {
      scenario,
      window,
      option,
      windowKey: scenario.optionsWindow,
    };
  }

  async #findScenarioRefForWindow(windowKey) {
    const matches = (await this.client.listScenarios()).filter(
      (scenario) =>
        scenario.type === "BLOCK" && scenario.optionsWindow === windowKey,
    );
    if (matches.length !== 1) return undefined;
    return `${configuredHomeRef(this.hubSerial)}/scenario/${encodeURIComponent(matches[0].index)}`;
  }

  async #rejectDirectScenarioMetadataWindow(windowKey, option) {
    if (!SCENARIO_METADATA_KEYS.has(option.key)) return;
    if (option.inputType !== "TEXT" && option.inputType !== "TEXT_MULTILINE") {
      return;
    }
    throw scenarioOwnerRequired(
      await this.#findScenarioRefForWindow(windowKey),
      option.key,
    );
  }

  async #finishScenarioMetadataOwnerConflict(change, current) {
    if (change.owner_kind !== "scenario") return null;
    const scenario = await this.client.getScenario(change.owner_index);
    if (!scenario || scenario.optionsWindow !== change.target.windowKey) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "owner_window_changed",
        last_verification: freshVerification("conflict"),
      });
    }
    if (
      !isDeepStrictEqual(
        scenarioOwnerGuard(scenario, change.option_key),
        change.owner_guard,
      )
    ) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "owner_configuration_changed",
        last_verification: freshVerification("conflict"),
      });
    }
    return null;
  }

  async #readWindowOptionState(change, { requireWrite = false } = {}) {
    const { option } = await this.#readWindowOption(
      change.target,
      change.option_key,
    );
    const state = windowOptionState(option, {
      requireWrite,
      allowText: change.owner_kind === "scenario",
    });
    assertOptionBinding(change, state.contract, "window");
    change.contract = state.contract;
    return state;
  }

  async #readLogicOption(target, optionKey) {
    if (typeof optionKey !== "string" || optionKey.length === 0) {
      throw new SprutHubError(
        "option_key_required",
        "Select one logic option before reading its write contract.",
        "get_entity",
      );
    }
    const logic = await this.client.getLogic(target);
    if (!logic) throw logicNotFound();
    const options = await this.client.getLogicOptions(target);
    const matches = options.filter(({ key }) => key === optionKey);
    if (matches.length !== 1) {
      throw new SprutHubError(
        matches.length === 0
          ? "logic_option_not_found"
          : "incompatible_response",
        matches.length === 0
          ? "The selected logic option was not found."
          : "SprutHub returned the selected logic option more than once.",
        "get_entity",
      );
    }
    return { logic, option: matches[0] };
  }

  async #readLogicValueState(change, { requireWrite = false } = {}) {
    if (change.kind === "logic_active") {
      const logic = await this.client.getLogic(change.target);
      if (!logic) throw logicNotFound();
      return {
        value: logicActiveValue(logic),
        contract: logicActiveContract({ requireWrite }),
      };
    }
    const { option } = await this.#readLogicOption(
      change.target,
      change.option_key,
    );
    const state = logicOptionState(option, { requireWrite });
    assertOptionBinding(change, state.contract, "logic");
    change.contract = state.contract;
    return state;
  }

  async #readNativeValueState(change, options = {}) {
    if (change.kind === "characteristic_option") {
      return this.#readCharacteristicOptionState(change, options);
    }
    if (change.kind === "window_option") {
      return this.#readWindowOptionState(change, options);
    }
    if (["logic_active", "logic_option"].includes(change.kind)) {
      return this.#readLogicValueState(change, options);
    }
    return this.#readCharacteristicState(change, options);
  }

  async #readNativeValue(change, options = {}) {
    return (await this.#readNativeValueState(change, options)).value;
  }

  async #writeNativeValue(change, value) {
    const nativeValue = { [value.kind]: value.value };
    if (change.kind === "characteristic_option") {
      return this.client.setCharacteristicOption({
        ...change.target,
        key: change.option_key,
        value: nativeValue,
      });
    }
    if (change.kind === "window_option") {
      return this.client.updateWindowOption({
        ...change.target,
        key: change.option_key,
        value: nativeValue,
      });
    }
    if (change.kind === "logic_option") {
      return this.client.setLogicOption({
        ...change.target,
        key: change.option_key,
        value: nativeValue,
      });
    }
    if (change.kind === "logic_active") {
      return this.client.updateLogicActive({
        ...change.target,
        active: value.value,
      });
    }
    return this.client.updateCharacteristic({
      ...change.target,
      value: nativeValue,
    });
  }

  async #restoreValueChange(change) {
    if (change.status === "restored") return publicStoredNativeChange(change);
    let currentState;
    const pending = await this.#reconcilePendingValueChange(change, {
      requireWrite: true,
    });
    if (pending) {
      const completedApply =
        pending.direction === "apply" &&
        pending.outcome === "expected_observed";
      const retryableRestore =
        pending.direction === "restore" &&
        pending.outcome === "expected_missing" &&
        isRetryableNativeValueChange(change) &&
        valuesEqual(pending.current, change.requested_value);
      if (!completedApply && !retryableRestore) {
        return pending.result;
      }
      currentState = { value: pending.current, contract: pending.contract };
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
    if (change.applied_value_observed !== true) {
      return this.#finishNative(change, "not_owned", current, {
        conflict_reason: "change_was_not_applied",
        last_verification: freshVerification("current_value_observed"),
      });
    }
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
    const ownerConflict = await this.#finishScenarioMetadataOwnerConflict(
      change,
      current,
    );
    if (ownerConflict) return ownerConflict;
    await this.#persistNativeIntent(change, "restoring", "restore");
    try {
      await this.#writeNativeValue(change, change.baseline_value);
      change.native_acknowledged = true;
      change.write_intent.acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        await this.#finishNative(change, "applied", current);
        throw error;
      }
      return this.#reconcileValueAfterWrite(change, "restore");
    }
    return this.#reconcileValueAfterWrite(change, "restore", true);
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
    const scenario = await this.client.getScenario(change.target.index);
    if (
      scenario === null ||
      !snapshotsEqual(scenarioSnapshot(scenario), change.baseline_snapshot)
    ) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "scenario_changed",
        configuration_matches: false,
        last_verification: freshVerification("scenario_changed"),
      });
    }
    const targets = await validateScenarioRun(
      scenarioSnapshot(scenario),
      this.client,
    );
    if (!isDeepStrictEqual(targets, change.targets)) {
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
        change.native_write_sent = delivery.status !== "not_sent";
        await this.#finishNative(change, "not_applied", undefined, {
          last_verification: failedVerification(error),
        });
        throw error;
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
        scenarioRunObservationResult(observations),
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
        snapshotsEqual(scenarioSnapshot(scenario), change.baseline_snapshot);
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
    const observation = scenarioChangeObservation(change, current, "applied");
    if (observation.matches) {
      return change.status === "applied"
        ? this.#recordScenarioObservation(change, observation)
        : this.#finishNative(change, "applied", undefined, {
            ...observation.fields,
            logic_assignments: undefined,
          });
    }
    return this.#finishNative(change, "conflict", undefined, {
      ...observation.fields,
      conflict_reason: "manual_change",
      logic_assignments: undefined,
    });
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
      return nativeIntentDirection(change) === "restore"
        ? this.#reconcileScenarioRestore(change, false)
        : this.#reconcileScenarioApply(change, false);
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
      await validateBlockData(change.requested_snapshot.data, this.client, {
        allowUnknownFrom:
          change.kind === "block_create"
            ? null
            : scenarioSnapshot(current.scenario).data,
        allowedPauses: [...pauseChanges, change],
        allowedPauseIntentId:
          change.kind === "block_action_pause" ? change.id : undefined,
        allowActionOnly: change.kind !== "block_action_pause",
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
        await this.#finishNative(change, "not_applied");
        throw error;
      }
      return this.#reconcileScenarioApply(change, false);
    }
    return this.#reconcileScenarioApply(change, true);
  }

  async #reconcileScenarioApply(change, acknowledged) {
    let current;
    try {
      current = await this.#observeScenarioChange(change);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    const requested = scenarioChangeObservation(change, current, "requested");
    if (requested.matches) {
      this.#adoptRequestedLogicSource(change, current, requested);
      if (change.kind === "block_action_pause") {
        await this.#markReplacedPauseSuperseded(change);
      } else if (change.kind === "block_data_update") {
        await this.#markPauseOutcomes(change, "apply");
      }
      return this.#finishNative(change, "applied", undefined, {
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
      });
    }
    const baseline = scenarioChangeObservation(change, current, "baseline");
    if (baseline.matches) {
      return this.#finishNative(change, "uncertain", undefined, {
        ...requested.fields,
        ...(acknowledged
          ? { conflict_reason: "ack_without_requested_result" }
          : {}),
      });
    }
    return this.#finishNative(change, "conflict", undefined, {
      conflict_reason: "manual_change",
      ...requested.fields,
    });
  }

  #adoptRequestedLogicSource(change, current, requested) {
    if (
      !isLogicSourceChange(change) ||
      change.applied_snapshot !== undefined ||
      change.native_write_sent !== true ||
      ["prepared", "not_applied", "restored", "conflict"].includes(
        change.status,
      ) ||
      !requested.matches
    ) {
      return false;
    }
    if (change.kind === "logic_source_create") {
      change.scenario_index = current.scenario.index;
      updateLogicTypeMapping(change, current.logicTypes);
    }
    change.applied_snapshot = scenarioChangeSnapshot(change, current.scenario);
    change.logic_assignments = undefined;
    change.conflict_reason = undefined;
    return true;
  }

  async #getScenarioChange(change) {
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      return nativeIntentDirection(change) === "restore"
        ? this.#reconcileScenarioRestore(change, false)
        : this.#reconcileScenarioApply(change, false);
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
    if (
      change.kind === "logic_source_create" &&
      change.applied_snapshot !== undefined &&
      current.scenario !== null
    ) {
      updateLogicTypeMapping(change, current.logicTypes);
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
      return nativeIntentDirection(change) === "restore"
        ? this.#reconcileScenarioRestore(change, false)
        : this.#reconcileScenarioApply(change, false);
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
      return nativeIntentDirection(change) === "restore"
        ? this.#reconcileScenarioRestore(change, false)
        : this.#reconcileScenarioApply(change, false);
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
        await this.#finishNative(change, "applied");
        throw error;
      }
      return this.#reconcileScenarioRestore(change, false);
    }
    return this.#reconcileScenarioRestore(change, true);
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
    if (["applying", "restoring", "uncertain"].includes(change.status)) {
      return nativeIntentDirection(change) === "restore"
        ? this.#reconcileScenarioRestore(change, false)
        : this.#reconcileScenarioApply(change, false);
    }
    const current = await this.#observeScenarioChange(change);
    if (
      change.kind === "logic_source_create" &&
      change.applied_snapshot !== undefined &&
      current.scenario !== null
    ) {
      updateLogicTypeMapping(change, current.logicTypes);
    }
    this.#adoptRequestedLogicSource(
      change,
      current,
      scenarioChangeObservation(change, current, "requested"),
    );
    const applied = scenarioChangeObservation(change, current, "applied");
    if (scenarioLacksProvenApply(change) || !applied.matches) {
      // Keep unproven baseline_changed; a proven snapshot mismatch is a fresh
      // manual_change, not a leftover assignment list.
      return this.#finishNative(change, "conflict", undefined, {
        ...(scenarioLacksProvenApply(change)
          ? scenarioUnprovenApplyFields(change, current)
          : applied.fields),
        conflict_reason: scenarioLacksProvenApply(change)
          ? (change.conflict_reason ?? "manual_change")
          : "manual_change",
        ...(scenarioLacksProvenApply(change)
          ? {}
          : { logic_assignments: undefined }),
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
        await validateBlockData(prepared.data, this.client, {
          allowUnknownFrom: scenarioSnapshot(current.scenario).data,
          allowedPauses: pauseChanges,
          allowActionOnly: true,
        });
        // Validation reads current bindings and can outlast a short pause. Rebuild
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
      if (typeof change.native_logic_type !== "string") {
        return this.#finishNative(change, "applied", undefined, {
          conflict_reason: undefined,
          ...applied.fields,
        });
      }
      const assignments = await this.client.findLogicAssignments(
        change.native_logic_type,
      );
      if (assignments.length > 0) {
        return this.#finishNative(change, "conflict", undefined, {
          conflict_reason: "logic_assignments_present",
          logic_assignments: assignments.map(({ aId, sId, active }) => ({
            ref: `${change.home_ref}/accessory/${aId}/service/${sId}/logic/${encodeURIComponent(change.native_logic_type)}`,
            active,
          })),
          ...applied.fields,
        });
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
        await this.#finishNative(change, "applied");
        throw error;
      }
      return this.#reconcileScenarioRestore(change, false);
    }
    return this.#reconcileScenarioRestore(change, true);
  }

  async #reconcileScenarioRestore(change, acknowledged) {
    let current;
    try {
      current = await this.#observeScenarioChange(change);
    } catch (error) {
      return this.#finishNative(change, "uncertain", undefined, {
        configuration_matches: undefined,
        last_verification: failedVerification(error),
      });
    }
    const baseline = scenarioChangeObservation(change, current, "restored");
    if (baseline.matches) {
      if (change.kind === "block_data_update") {
        await this.#markPauseOutcomes(change, "restore");
      }
      return this.#finishNative(change, "restored", undefined, {
        candidate_logic_types: undefined,
        logic_assignments: undefined,
        ...baseline.fields,
        ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
      });
    }
    return this.#finishNative(change, "uncertain", undefined, {
      ...baseline.fields,
      ...(acknowledged
        ? { conflict_reason: "ack_without_requested_result" }
        : {}),
    });
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
          "inspect_home",
        );
      }
      scenario = matches[0] ?? null;
    }
    const logicTypes =
      change.kind === "logic_source_create"
        ? await this.#readLogicTypeCatalog(change.target)
        : [];
    return { scenario, logicTypes };
  }

  async #observeBlock(change) {
    if (["block_data_update", "block_action_pause"].includes(change.kind)) {
      return this.client.getScenario(change.target.index);
    }
    if (change.scenario_index) {
      const scenario = await this.client.getScenario(change.scenario_index);
      if (scenario) return scenario;
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
        "inspect_home",
      );
    }
    return matches[0] ?? null;
  }

  async #provenBlockOwnershipMarker(targetRef, desc) {
    if (typeof desc !== "string") return null;
    const index = parseScenarioRef(targetRef, this.hubSerial).index;
    const homeRef = configuredHomeRef(this.hubSerial);
    for (const change of await this.store.list()) {
      if (
        change.home_ref !== homeRef ||
        change.kind !== "block_create" ||
        change.status === "restored" ||
        typeof change.marker !== "string" ||
        change.applied_snapshot === undefined ||
        change.scenario_index !== index ||
        !desc.includes(`[${change.marker}]`)
      ) {
        continue;
      }
      return change.marker;
    }
    return null;
  }

  async previewBooleanAutomation(input) {
    const source = parseCharacteristicRef(
      input.source_characteristic_ref,
      this.hubSerial,
    );
    const target = parseCharacteristicRef(
      input.target_characteristic_ref,
      this.hubSerial,
    );
    const sourceRoomId = parseRoomRef(input.source_room_ref, this.hubSerial);
    const targetRoomId = parseRoomRef(input.target_room_ref, this.hubSerial);
    const context = await this.client.inspectAutomation({
      source: { ...source, roomId: sourceRoomId },
      target: { ...target, roomId: targetRoomId },
    });
    const condition = selectCharacteristic(
      context.source,
      source,
      input.source_value,
      false,
      this.hubSerial,
    );
    const action = selectCharacteristic(
      context.target,
      target,
      input.target_value,
      true,
      this.hubSerial,
    );
    const autoOff = selectAutoOff(
      input.auto_off_after_seconds,
      condition,
      action,
    );
    const nativeData = buildNativeData(condition, action, autoOff);
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      status: "prepared",
      name: input.name,
      reason: input.reason,
      marker: `sprut-agent:automation:${id}`,
      home_ref: configuredHomeRef(this.hubSerial),
      created_at: now,
      updated_at: now,
      condition,
      action,
      ...(autoOff ? { auto_off: autoOff } : {}),
      native_data: nativeData,
    };
    await this.store.save(change);

    return {
      status: "prepared",
      change_ref: changeRef(id),
      name: input.name,
      reason: input.reason,
      condition,
      action,
      ...(autoOff ? { auto_off: autoOff } : {}),
      native_shape: {
        mechanism: "BLOCK",
        active: true,
        on_start: false,
        sync: false,
        else_actions: [],
      },
      context: normalizeContext(context, change.home_ref),
      limitations: [
        "Preview does not change the hub and is not an atomic reservation.",
        "Scenario associations come from the accessory index and do not establish a direction or cover arbitrary code and bridges.",
        ...(autoOff
          ? [
              "The native RESET delay counts from the latest trigger; it does not determine whether a person is still present.",
            ]
          : ["The rule does not turn the target off automatically."]),
        "Apply and rollback are serialized only inside this MCP process for the configured hub.",
        "SprutHub has no observed conditional delete; another process or the UI can edit after the rollback check.",
      ],
    };
  }

  async apply(changeReference) {
    const id = parseChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireChange(id);
      await this.#preflight(change);
      let reconciliation = await this.#reconcile(change);
      let observation = observeReconciliation(change, reconciliation);
      if (observation.kind !== "absent") {
        return this.#finishObservation(change, observation, {
          ...(observation.kind === "owned_match"
            ? verifiedApplyFields(false)
            : {}),
          ...(observation.kind === "equivalent" ? { created: false } : {}),
        });
      }
      if (["creating", "uncertain"].includes(change.status)) {
        return this.#finish(change, { status: "uncertain" }, uncertainResult);
      }
      if (change.status === "rolled_back") {
        return {
          status: "rolled_back",
          change_ref: changeReference,
          created: false,
          owned: true,
        };
      }

      change.status = "creating";
      change.updated_at = new Date().toISOString();
      await this.#saveBeforeWrite(change);
      try {
        const created = await this.client.createScenario(
          expectedScenario(change),
        );
        change.scenario_index = created.index;
      } catch (error) {
        if (!isUncertainWriteError(error)) {
          error.details = await this.#finishKnownNoEffect(
            change,
            changeReference,
            "prepared",
            "restore_state_storage_then_preview_boolean_automation",
          );
          throw error;
        }
        try {
          reconciliation = await this.#reconcile(change);
        } catch {
          return this.#finish(change, { status: "uncertain" }, uncertainResult);
        }
        observation = observeReconciliation(change, reconciliation);
        if (observation.kind === "owned_match") {
          return this.#finishObservation(change, observation, {
            ...verifiedApplyFields(true),
            recovered_after_uncertain_write: true,
            ...(error.code === "connection_closed"
              ? { recovered_after_disconnect: true }
              : {}),
          });
        }
        if (
          ["owned_conflict", "ownership_conflict"].includes(observation.kind)
        ) {
          return this.#finishObservation(change, observation);
        }
        return this.#finish(change, { status: "uncertain" }, uncertainResult);
      }

      try {
        reconciliation = await this.#reconcile(change);
      } catch {
        return this.#finish(change, { status: "uncertain" }, uncertainResult);
      }
      observation = observeReconciliation(change, reconciliation);
      if (observation.kind === "owned_match") {
        return this.#finishObservation(
          change,
          observation,
          verifiedApplyFields(true),
        );
      }
      if (["owned_conflict", "ownership_conflict"].includes(observation.kind)) {
        return this.#finishObservation(change, observation);
      }
      return this.#finish(change, { status: "uncertain" }, uncertainResult);
    });
  }

  async getChange(changeReference) {
    const id = parseChangeRef(changeReference);
    const change = await this.#requireChange(id);
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

  async rollback(changeReference) {
    const id = parseChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireChange(id);
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
    });
  }

  async #requireChange(id) {
    const change = await this.store.get(id);
    if (!change) {
      throw new SprutHubError(
        "change_not_found",
        "The automation change was not found for this configured hub.",
        "preview_boolean_automation",
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

  async #preflight(change) {
    const allowLegacy = change.home_ref === undefined;
    const source = parseCharacteristicRef(
      change.condition.characteristic.ref,
      this.hubSerial,
      allowLegacy,
    );
    const target = parseCharacteristicRef(
      change.action.characteristic.ref,
      this.hubSerial,
      allowLegacy,
    );
    const context = await this.client.inspectAutomation({
      source: {
        ...source,
        roomId: parseRoomRef(
          change.condition.room.ref,
          this.hubSerial,
          allowLegacy,
        ),
      },
      target: {
        ...target,
        roomId: parseRoomRef(
          change.action.room.ref,
          this.hubSerial,
          allowLegacy,
        ),
      },
    });
    const condition = selectCharacteristic(
      context.source,
      source,
      change.condition.value,
      false,
      this.hubSerial,
    );
    const action = selectCharacteristic(
      context.target,
      target,
      change.action.value,
      true,
      this.hubSerial,
    );
    if (
      condition.service.type !== change.condition.service.type ||
      condition.characteristic.type !== change.condition.characteristic.type ||
      action.service.type !== change.action.service.type ||
      action.characteristic.type !== change.action.characteristic.type
    ) {
      throw new SprutHubError(
        "binding_changed",
        "A selected SprutHub binding changed after preview.",
        "preview_boolean_automation",
      );
    }
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
    const candidates = scenarios.filter(
      (candidate) =>
        !ownedCandidates.includes(candidate) && sameRuleBody(candidate, change),
    );
    return {
      scenario,
      owned,
      matches: owned && matchesExpected(scenario, change),
      equivalent: candidates.find(matchesRequiredRuntime),
      runtimeConflict: candidates.find(
        (candidate) => !matchesRequiredRuntime(candidate),
      ),
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

  async #finishKnownNoEffect(
    change,
    changeReference,
    status,
    persistenceAction,
  ) {
    return this.#finish(
      change,
      { status },
      () => ({
        change_ref: changeReference,
        hub_effect: "not_applied",
      }),
      persistenceAction,
    );
  }

  async #finish(
    change,
    state,
    makeResult,
    persistenceAction = "restore_state_storage_then_get_automation_change",
  ) {
    Object.assign(change, state, { updated_at: new Date().toISOString() });
    const localStateSaved = await this.#trySave(change);
    return withLocalState(
      makeResult(change),
      localStateSaved,
      persistenceAction,
    );
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

  async #exclusiveWrite(operation) {
    const current = this.#writeSequence.catch(() => {}).then(operation);
    this.#writeSequence = current;
    return current;
  }
}

function parseRoomRef(ref, configuredSerial, allowLegacy = false) {
  const scoped = /^spruthub:\/\/hub\/([^/]+)\/room\/(\d+)$/.exec(ref);
  if (scoped) {
    const serial = decodeReferenceSegment(scoped[1]);
    requireConfiguredHome(serial, configuredSerial);
    return Number(scoped[2]);
  }
  const legacy = allowLegacy ? /^spruthub:\/\/room\/(\d+)$/.exec(ref) : null;
  if (!legacy) {
    throw new SprutHubError(
      "invalid_room_ref",
      "Use a home-qualified room reference returned by list_rooms.",
      "list_rooms",
    );
  }
  return Number(legacy[1]);
}

function parseAccessoryRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)$/.exec(ref ?? "");
  if (!match) {
    throw new SprutHubError(
      "invalid_accessory_ref",
      "Use a home-qualified accessory reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { id: Number(match[2]) };
}

function parseServiceRef(ref, configuredSerial) {
  const match =
    /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)\/service\/(\d+)$/.exec(
      ref ?? "",
    );
  if (!match) {
    throw new SprutHubError(
      "invalid_service_ref",
      "Use a home-qualified service reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { aId: Number(match[2]), sId: Number(match[3]) };
}

function parseCharacteristicRef(ref, configuredSerial, allowLegacy = false) {
  const scoped =
    /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/.exec(
      ref,
    );
  if (scoped) {
    const serial = decodeReferenceSegment(scoped[1]);
    requireConfiguredHome(serial, configuredSerial);
    return {
      aId: Number(scoped[2]),
      sId: Number(scoped[3]),
      cId: Number(scoped[4]),
    };
  }
  const match = allowLegacy
    ? /^spruthub:\/\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/.exec(
        ref,
      )
    : null;
  if (!match) {
    throw new SprutHubError(
      "invalid_characteristic_ref",
      "Use a characteristic reference returned by read_services or get_entity.",
      "read_services",
    );
  }
  return {
    aId: Number(match[1]),
    sId: Number(match[2]),
    cId: Number(match[3]),
  };
}

function decodeReferenceSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SprutHubError(
      "invalid_characteristic_ref",
      "Use a home-qualified characteristic reference returned by get_entity.",
      "get_entity",
    );
  }
}

function requireConfiguredHome(serial, configuredSerial) {
  if (configuredSerial !== undefined && serial !== configuredSerial) {
    throw unsupportedHomeWrite();
  }
}

function unsupportedHomeWrite() {
  return new SprutHubError(
    "unsupported_home_write",
    "Automation writes are limited to the configured SprutHub home.",
    "select_configured_home",
  );
}

function configuredHomeRef(serial) {
  return `spruthub://hub/${encodeURIComponent(serial)}`;
}

function parseConfiguredHomeRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_home_ref",
      "Use a home reference returned by list_homes.",
      "list_homes",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return serial;
}

function parseScenarioRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)\/scenario\/([^/]+)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_scenario_ref",
      "Use a home-qualified scenario reference returned by inspect_home.",
      "inspect_home",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  return { index: decodeReferenceSegment(match[2]) };
}

function parseWindowRef(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)\/window\/([^/]+)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_window_ref",
      "Use a home-qualified window reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  const windowKey = decodeReferenceSegment(match[2]);
  if (windowKey.length === 0) {
    throw new SprutHubError(
      "invalid_window_ref",
      "Use a home-qualified window reference returned by get_entity.",
      "get_entity",
    );
  }
  return { windowKey };
}

const SCENARIO_METADATA_KEYS = new Set(["Name", "Desc"]);

function parseWindowOptionOwner(ref, configuredSerial) {
  try {
    return { kind: "scenario", ...parseScenarioRef(ref, configuredSerial) };
  } catch (error) {
    if (
      !(error instanceof SprutHubError) ||
      error.code !== "invalid_scenario_ref"
    ) {
      throw error;
    }
  }
  return { kind: "window", ...parseWindowRef(ref, configuredSerial) };
}

function scenarioOwnerRequired(scenarioRef, optionKey = "Name") {
  return new SprutHubError(
    "scenario_owner_required",
    "TEXT Name and Desc on a BLOCK are written through window_option with the owning scenario ref.",
    "get_entity",
    scenarioRef
      ? {
          next: {
            tool: "get_native_change_contract",
            arguments: {
              operation: "window_option",
              target_ref: scenarioRef,
              option_key: optionKey,
            },
          },
        }
      : {},
  );
}

function unsupportedBlockMetadata(input) {
  return new SprutHubError(
    "unsupported_block_metadata",
    "block_data_update writes only data. Change Name or Desc with window_option using the scenario ref.",
    "get_native_change_contract",
    {
      next: {
        tool: "get_native_change_contract",
        arguments: {
          operation: "window_option",
          target_ref: input.target_ref,
          option_key: typeof input.name === "string" ? "Name" : "Desc",
        },
      },
    },
  );
}

function unsupportedBlockFlags(targetRef) {
  return new SprutHubError(
    "unsupported_block_flags",
    "block_data_update does not change runtime flags. Omit active, on_start, and sync.",
    "get_native_change_contract",
    {
      next: {
        tool: "get_native_change_contract",
        arguments: {
          operation: "block_data_update",
          target_ref: targetRef,
        },
      },
    },
  );
}

function scenarioOwnerGuard(scenario, optionKey) {
  const comparable = comparableScenarioOwnerConfiguration(scenario);
  if (optionKey === "Name") {
    const { name: _name, ...rest } = comparable;
    return rest;
  }
  if (optionKey === "Desc") {
    const { desc: _desc, ...rest } = comparable;
    return rest;
  }
  return comparable;
}

function comparableScenarioOwnerConfiguration(scenario) {
  let data;
  try {
    data = {
      kind: "json",
      value: configurationData(JSON.parse(scenario.data)),
    };
  } catch {
    data = { kind: "opaque", value: scenario.data };
  }
  return {
    index: scenario.index,
    predefined: scenario.predefined === true,
    name: scenario.name,
    desc: scenario.desc,
    active: scenario.active === true,
    onStart: scenario.onStart === true,
    sync: scenario.sync === true,
    type: scenario.type,
    window_key: scenario.optionsWindow,
    data,
  };
}

function parseLogicRef(ref, configuredSerial) {
  const match =
    /^spruthub:\/\/hub\/([^/]+)\/accessory\/(\d+)\/service\/(\d+)\/logic\/([^/]+)$/.exec(
      ref,
    );
  if (!match) {
    throw new SprutHubError(
      "invalid_logic_ref",
      "Use a home-qualified logic reference returned by get_entity.",
      "get_entity",
    );
  }
  const serial = decodeReferenceSegment(match[1]);
  requireConfiguredHome(serial, configuredSerial);
  const type = decodeReferenceSegment(match[4]);
  if (type.length === 0) {
    throw new SprutHubError(
      "invalid_logic_ref",
      "Use a home-qualified logic reference returned by get_entity.",
      "get_entity",
    );
  }
  return {
    aId: Number(match[2]),
    sId: Number(match[3]),
    type,
  };
}

function requireEntityHome(ref, configuredSerial) {
  const match = /^spruthub:\/\/hub\/([^/]+)(?:\/|$)/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_entity_ref",
      "Use a home-qualified entity reference returned by SprutHub discovery.",
      "inspect_home",
    );
  }
  requireConfiguredHome(decodeReferenceSegment(match[1]), configuredSerial);
}

function scenarioNotFound() {
  return new SprutHubError(
    "scenario_not_found",
    "The selected SprutHub scenario was not found.",
    "inspect_home",
  );
}

function unsupportedScenarioType() {
  return new SprutHubError(
    "unsupported_scenario_type",
    "Only native BLOCK scenario data can be changed in this slice.",
  );
}

function logicNotFound() {
  return new SprutHubError(
    "logic_not_found",
    "The selected native logic assignment was not found.",
    "get_entity",
  );
}

function unsupportedNativeOperation() {
  return new SprutHubError(
    "unsupported_native_operation",
    "This native operation is not supported in the current slice.",
  );
}

function accessoryPlacementContract(accessory) {
  return {
    current: {
      name: accessory.name,
      room_id: accessory.roomId,
    },
    write: "accessory.update({id,name,roomId})",
    scope: "one_accessory",
    confirmation: "empty_ack_then_separate_accessory_get",
    restore: "saved_name_and_room_only_while_applied_snapshot_matches",
    limitations: [
      "Services and other accessories sharing the same physical device are not changed.",
      "SprutHub may normalize the requested name; the observed saved name is reported separately.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
}

function roomCreateContract() {
  return {
    write: "room.create({name})",
    response: "RoomMessage",
    confirmation: "separate_room_get",
    restore:
      "delete_only_a_confirmed_created_room_with_unchanged_configuration_and_no_accessories",
    evidence: {
      create_request: "official_frontend",
      create_response: "bundled_official_protobuf_schema",
      live_create: false,
    },
    limitations: [
      "A lost create response cannot establish ownership from a matching name alone and is never retried blindly.",
      "Room deletion is not attempted when creation ownership, unchanged configuration, or emptiness is unconfirmed.",
    ],
  };
}

function virtualLightGroupContract() {
  return {
    write: [
      "accessory.create({name,roomId,services:[{type:'Lightbulb',name,optional:['Brightness']}]})",
      "link.addVirtual({aId,sId,cId,tAId,tSId,tCId})",
      "characteristic.update({aId,sId,cId,hasLinks:true})",
      "link.remove({aId,sId,cId,linkId})",
      "characteristic.update({aId,sId,cId,hasLinks:false})",
    ],
    scope: "one_created_virtual_light_and_explicit_member_services",
    characteristics: ["On", "Brightness"],
    feedback: "LAST_VALUE",
    restore:
      "remove_owned_in_links_disable_hasLinks_verify_physical_out_absence_then_delete_confirmed_created_accessory",
    evidence: {
      create_and_link_requests: "current_official_frontend",
      request_and_response_shapes: "current_bundled_official_protobuf_schema",
      existing_native_group_read: true,
      live_create_and_link: true,
      live_same_value_repeat_delivery: false,
      ui_ordered_link_cleanup_requires_live_recheck: true,
    },
    limitations: [
      "Creation and every link are sequential native writes, not one atomic transaction.",
      "A lost accessory-create response does not establish ownership from a matching candidate and is never retried blindly.",
      "A same-valued virtual command can be acknowledged without reaching every member; member readback is required.",
      "SprutHub exposes no native compare-and-set; a race remains after each pre-write observation.",
    ],
  };
}

function requiredNativeName(value, operation) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SprutHubError(
      "name_required",
      `A non-empty name is required for ${operation}.`,
      "prepare_native_change",
    );
  }
  return value;
}

function blockContract() {
  return {
    version: "2026-09-13",
    source: {
      frontend_sha256:
        "81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8",
      scenario_proto_sha256:
        "2319535876324b44c2048267d8b4297ec48d0881b964d5acc5ed1cbddfaa3657",
    },
    update: "scenario.update({index,data})",
    supported: {
      root: { required: ["targets"] },
      target_types: ["if", "service", "delay"],
      condition_modes: ["AND", "OR"],
      if_modes: ["EVERY"],
      action_types: ["set"],
      delay_modes: ["RESET"],
      delay_index: { type: "integer", minimum: 1, unique: true },
      characteristic_conditions: {
        boolean: ["="],
        string_or_enum: ["=", "!="],
        number: ["=", "!=", ">", ">=", "<", "<="],
        time: 0,
        time_condition: "",
      },
      daily_interval: {
        local_time: "HH:mm",
        start_and_end: "distinct",
        crosses_midnight: true,
        native_trigger: true,
        cron: {
          format: "0 MM HH ? * * *",
          fields: {
            MM: "minute_0_to_59",
            HH: "hour_0_to_23",
          },
          seconds: 0,
          mode: "NONE",
          offset: 0,
        },
        native_shape: {
          type: "interval",
          start: {
            type: "cron",
            mode: "NONE",
            cron: "0 MM HH ? * * *",
            offset: 0,
          },
          end: {
            type: "cron",
            mode: "NONE",
            cron: "0 MM HH ? * * *",
            offset: 0,
          },
          trigger: true,
        },
        boundaries: {
          start: "enter_interval",
          end: "leave_interval",
          clock: "selected_hub_local_wall_clock",
        },
        branch_semantics: {
          sole_interval_condition: "start_then_end_else",
          compound_condition:
            "boundary_rechecks_complete_condition_tree_then_selects_result_branch",
        },
      },
      nesting: [
        "if.if",
        "if.then",
        "if.else",
        "delay.targets",
        "condition.conditions",
        "interval.start",
        "interval.end",
      ],
      nodes: publishedBlockNodes(),
    },
    limitations: [
      "BLOCK data uses native IDs inside one configured home; preparation verifies each referenced characteristic.",
      "A conditional BLOCK requires at least one characteristic or daily interval condition with trigger=true; this action-only slice accepts only literal Lightbulb On=false service/set targets.",
      "Daily interval HH:mm values use the selected hub's local wall clock. This transport does not currently expose that hub's timezone, so timezone conversion requires separate evidence before apply.",
      "Daily interval creation and readback confirm stored native configuration, not firing at a minute boundary, immediate behavior when created inside the interval, or runtime across midnight.",
      "The same characteristic cannot be both a condition and an action in this slice.",
      "Name and Desc are separate window_option writes on the owning scenario ref; this operation writes only data.",
      "Runtime flags, type, orders, and JS source are not opened by this contract.",
      "SprutHub exposes no native compare-and-set; pre-write comparison does not close the remaining race window.",
    ],
  };
}

function scenarioRunContract() {
  return {
    version: "2026-09-13",
    write: "scenario.run({index})",
    scope: "one_action_only_light_off_BLOCK",
    required_configuration: {
      type: "BLOCK",
      active: true,
      on_start: false,
      sync: false,
      targets: "literal_Lightbulb_On_false_service_set_actions_only",
    },
    preparation: "read_and_validate_without_execution",
    repeat:
      "one send per prepared change; prepare a new change for each explicit run",
    delivery: {
      not_sent:
        "transport confirmed that scenario.run was not sent; prepare a new change after recovery",
      acknowledged: "native scenario.run ACK received",
      rejected:
        "SprutHub returned an explicit rejection; its code remains available in command_delivery.rejection",
      unknown: "request may have run but ACK was lost; never retry this change",
      target_readback:
        "fresh values are reported separately and do not prove physical or atomic delivery",
    },
    restore_supported: false,
    evidence: {
      live_hub_version: "3.0.0b (20131)",
      action_only_create_read: true,
      explicit_repeat_run: true,
      live_targets: 2,
    },
    limitations: [
      "Only active action-only Lightbulb On=false BLOCK scenarios with onStart=false and sync=false are supported.",
      "Arbitrary code, conditions, delays, child scenarios, and unknown action nodes are rejected.",
      "Target readback cannot prove that this command caused an observed value or that physical devices acted atomically.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-run scenario check.",
    ],
  };
}

function blockActionPauseContract() {
  return {
    version: "2026-09-12",
    write: "scenario.update({index,data})",
    scope: "one_existing_executable_BLOCK_action_selected_by_RFC_6901_pointer",
    duration: {
      unit: "seconds",
      minimum: 1,
      maximum: 31_536_000,
      starts: "first_apply",
    },
    native_mechanism:
      "if code-condition returning Date.now() >= one persisted absolute deadline",
    expiration:
      "the original action becomes eligible on the next ordinary trigger without a running client; missed triggers are not replayed",
    cleanup:
      "an unchanged owned expired controller is collapsed in the next planned write to the same BLOCK",
    restore:
      "remove_only_the_owned_unchanged_controller_and_keep_its_current_action",
    repeat:
      "the owned controller or its direct then/0 action replaces the same pause; overlapping narrower or wider scopes are rejected",
    evidence: {
      live_hub_version: "3.0.0b (20131)",
      code_condition_before_and_after_deadline: true,
      client_closed_between_evaluations: true,
      full_hub_restart: false,
    },
    limitations: [
      "Updating BLOCK data can cancel an already running native delay in that scenario.",
      "Expiration changes eligibility at the next trigger; it does not run the skipped action at the deadline.",
      "An inert expired controller may remain until the next ordinary write to this BLOCK.",
      "A selected subgraph containing trigger=true is rejected because nested trigger registration is not verified.",
      "Active/expired is estimated with the MCP host clock; SprutHub evaluates the deadline with the hub clock.",
      "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
}

async function validateBlockData(
  data,
  client,
  {
    allowUnknownFrom,
    allowedPauses = [],
    allowedPauseIntentId,
    allowActionOnly = false,
  },
) {
  if (
    !isRecord(data) ||
    !Array.isArray(data.targets) ||
    data.targets.length === 0 ||
    !blockNodeArray(data.targets)
  ) {
    throw invalidBlock("root", "targets must be a non-empty array");
  }
  const unknown = collectUnknownBlockFields(data);
  if (allowUnknownFrom === null) {
    if (unknown.length > 0) {
      throw invalidBlock(unknown[0].path, "unsupported field");
    }
  } else if (
    !isDeepStrictEqual(unknown, collectUnknownBlockFields(allowUnknownFrom))
  ) {
    throw invalidBlock(
      "root",
      "unknown configuration fields must be preserved unchanged",
    );
  }

  const context = {
    conditions: [],
    actions: [],
    delayIndexes: new Set(),
    intervals: 0,
    triggers: 0,
    pauseOwnership: inspectPauseOwnership(data, allowedPauses, {
      allowedIntentId: allowedPauseIntentId,
    }),
    allowedPauseCodeNodes: new WeakSet(),
  };
  visitKnownBlockNodes(
    data,
    (node, kind, path) => {
      validateBlockNode(node, kind, path, context);
    },
    (path, message) => {
      throw invalidBlock(path, message);
    },
  );
  if (
    context.triggers === 0 &&
    !(allowActionOnly && isLiteralActionOnlyBlock(data))
  ) {
    throw invalidBlock("targets", "at least one trigger=true is required");
  }

  const accessories = new Map();
  for (const reference of [...context.conditions, ...context.actions]) {
    if (!accessories.has(reference.aId)) {
      accessories.set(reference.aId, await client.getAccessory(reference.aId));
    }
    const accessory = accessories.get(reference.aId);
    const service = accessory.services?.find(
      ({ sId }) => sId === reference.sId,
    );
    const characteristic = service?.characteristics?.find(
      ({ cId }) => cId === reference.cId,
    );
    if (
      !service ||
      !characteristic?.control ||
      service.type !== reference.hs ||
      characteristic.control.type !== reference.hc
    ) {
      throw invalidBlock(
        reference.path,
        "native binding or type does not match",
      );
    }
    const contract = characteristicContract(characteristic.control, {
      requireWrite: reference.role === "action",
    });
    if (reference.role === "action") {
      reference.contract_kind = contract.kind;
      reference.observation_available = accessory.online;
      reference.observed_value = observableBlockValue(
        characteristic.control.value,
      );
    }
    const value = parseBlockValue(reference.value, contract.kind);
    if (reference.role === "action") reference.parsed_value = value;
    validateCharacteristicValue(value, contract);
    if (
      reference.role === "condition" &&
      !allowedConditions(contract.kind).includes(reference.cond)
    ) {
      throw invalidBlock(
        reference.path,
        "comparison is not supported for this value kind",
      );
    }
  }

  const actionRefs = new Set(
    context.actions.map(({ aId, sId, cId }) => `${aId}/${sId}/${cId}`),
  );
  const feedback = context.conditions.find(({ aId, sId, cId }) =>
    actionRefs.has(`${aId}/${sId}/${cId}`),
  );
  if (feedback) {
    throw invalidBlock(
      feedback.path,
      "a condition cannot write the same characteristic in this slice",
    );
  }
  if (
    context.triggers === 0 &&
    context.actions.some(
      (action) =>
        action.hs !== "Lightbulb" ||
        action.hc !== "On" ||
        action.contract_kind !== "boolValue" ||
        action.parsed_value !== false,
    )
  ) {
    throw invalidBlock(
      "targets",
      "action-only BLOCK supports only literal Lightbulb On=false actions",
    );
  }
  return context;
}

function observableBlockValue(value) {
  const typed = typedNativeValue(value);
  const validation = validateNativeScalarValue(typed.value, {
    kind: typed.kind,
  });
  return validation.valid ? validation.value : null;
}

function blockActionPreview(validation, homeRef, capturedAt) {
  return {
    snapshot: {
      source: "accessory_read_during_preparation",
      captured_at: capturedAt,
    },
    actions: validation.actions.map((action) => {
      const command = {
        value: action.parsed_value,
        kind: action.contract_kind,
        execution: "write_if_action_runs",
      };
      const observationAvailable =
        action.observation_available === true && action.observed_value !== null;
      const observation = {
        status: observationAvailable ? "available" : "unavailable",
        ...(action.observed_value ?? {}),
      };
      return {
        configuration_pointer: blockPathToPointer(action.path),
        characteristic_ref: `${homeRef}/accessory/${action.aId}/service/${action.sId}/characteristic/${action.cId}`,
        service_type: action.hs,
        characteristic_type: action.hc,
        command,
        observation,
        comparison_to_observation: observationAvailable
          ? valuesEqual(command, action.observed_value)
            ? "equal"
            : "different"
          : "unknown",
      };
    }),
  };
}

async function validateScenarioRun(snapshot, client) {
  if (snapshot.type !== "BLOCK") throw unsupportedScenarioType();
  const context = await validateBlockData(snapshot.data, client, {
    allowUnknownFrom: null,
    allowActionOnly: true,
  });
  if (
    !isLiteralActionOnlyBlock(snapshot.data) ||
    context.conditions.length > 0
  ) {
    throw new SprutHubError(
      "unsupported_scenario_run",
      "Only a BLOCK containing literal service/set targets and no conditions, delays, or code can be run by this path.",
      "get_native_change_contract",
    );
  }
  requireActionOnlyRuntime(snapshot, context, "unsupported_scenario_run");
  const homeRef = configuredHomeRef(client.serial);
  const targets = context.actions.map((action) => ({
    characteristic_ref: `${homeRef}/accessory/${action.aId}/service/${action.sId}/characteristic/${action.cId}`,
    target: { aId: action.aId, sId: action.sId, cId: action.cId },
    service_type: action.hs,
    characteristic_type: action.hc,
    expected_value: {
      value: action.parsed_value,
      kind: action.contract_kind,
    },
  }));
  const refs = targets.map(({ characteristic_ref: ref }) => ref);
  if (new Set(refs).size !== refs.length) {
    throw new SprutHubError(
      "unsupported_scenario_run",
      "A runnable native command must set each target characteristic at most once.",
      "get_native_change_contract",
    );
  }
  return targets;
}

function requireActionOnlyRuntime(
  snapshot,
  validation,
  code = "invalid_native_change",
) {
  if (validation.triggers > 0) return;
  if (
    snapshot.active === true &&
    snapshot.onStart === false &&
    snapshot.sync === false
  ) {
    return;
  }
  throw new SprutHubError(
    code,
    "An action-only native command must be active with onStart=false and sync=false.",
    "get_native_change_contract",
  );
}

function isLiteralActionOnlyBlock(data) {
  return (
    isRecord(data) &&
    Array.isArray(data.targets) &&
    data.targets.length > 0 &&
    data.targets.every(
      (target) =>
        isRecord(target) &&
        target.type === "service" &&
        Array.isArray(target.characteristics) &&
        target.characteristics.length > 0 &&
        target.characteristics.every(
          (action) =>
            isRecord(action) &&
            action.type === "set" &&
            typeof action.value === "string",
        ),
    )
  );
}

function validateBlockNode(node, kind, path, context) {
  if (kind === "root") return;
  if (kind === "if") {
    const pauseId = pauseControllerId(node);
    if (pauseId !== null) {
      const parsed = parsePauseCode(node.if?.conditions?.[0]?.code);
      const owner = context.pauseOwnership.get(pauseId);
      if (
        owner?.state !== "owned" ||
        owner.node !== node ||
        owner.change.pause_expires_at_ms !== parsed?.deadline
      ) {
        throw invalidBlock(path, "unowned or changed action-pause controller");
      }
      context.allowedPauseCodeNodes.add(node.if.conditions[0]);
      return;
    }
    if (
      node.mode !== "EVERY" ||
      node.then_delay !== 0 ||
      node.else_delay !== 0 ||
      !blockNode(node.if) ||
      !blockNodeArray(node.then) ||
      !blockNodeArray(node.else)
    ) {
      throw invalidBlock(
        path,
        "only EVERY with a condition and zero-delay branches is supported",
      );
    }
    return;
  }
  if (kind === "condition") {
    if (
      !["AND", "OR"].includes(node.mode) ||
      !Array.isArray(node.conditions) ||
      node.conditions.length === 0 ||
      !blockNodeArray(node.conditions)
    ) {
      throw invalidBlock(path, "AND/OR condition must not be empty");
    }
    return;
  }
  if (kind === "code") {
    const parsed = parsePauseCode(node.code);
    if (
      !parsed ||
      context.pauseOwnership.get(parsed.id)?.state !== "owned" ||
      !context.allowedPauseCodeNodes.has(node) ||
      Object.keys(node).some(
        (key) => !["type", "blockId", "code"].includes(key),
      )
    ) {
      throw invalidBlock(
        path,
        "only an owned absolute pause condition is supported",
      );
    }
    return;
  }
  if (kind === "characteristic") {
    if (
      !stableNativeId(node.aId) ||
      !stableNativeId(node.sId) ||
      !stableNativeId(node.cId) ||
      typeof node.hs !== "string" ||
      typeof node.hc !== "string" ||
      typeof node.trigger !== "boolean" ||
      typeof node.cond !== "string" ||
      typeof node.value !== "string" ||
      node.timeCond !== "" ||
      node.time !== 0
    ) {
      throw invalidBlock(path, "characteristic condition is incomplete");
    }
    if (node.trigger) context.triggers += 1;
    context.conditions.push({
      role: "condition",
      path,
      aId: node.aId,
      sId: node.sId,
      cId: node.cId,
      hs: node.hs,
      hc: node.hc,
      trigger: node.trigger,
      cond: node.cond,
      value: node.value,
    });
    return;
  }
  if (kind === "interval") {
    if (
      typeof node.trigger !== "boolean" ||
      !isRecord(node.start) ||
      !isRecord(node.end)
    ) {
      throw invalidBlock(path, "daily interval condition is incomplete");
    }
    context.intervals += 1;
    if (context.intervals > 1) {
      throw invalidBlock(path, "only one daily interval is supported");
    }
    const start = parseDailyCron(node.start, `${path}.start`);
    const end = parseDailyCron(node.end, `${path}.end`);
    if (start.hour === end.hour && start.minute === end.minute) {
      throw invalidBlock(path, "daily interval start and end must differ");
    }
    if (node.trigger) context.triggers += 1;
    return;
  }
  if (kind === "cron") {
    parseDailyCron(node, path);
    return;
  }
  if (kind === "service") {
    if (
      !stableNativeId(node.aId) ||
      !stableNativeId(node.sId) ||
      typeof node.hs !== "string" ||
      !Array.isArray(node.characteristics) ||
      node.characteristics.length === 0 ||
      !blockNodeArray(node.characteristics)
    ) {
      throw invalidBlock(path, "service action is incomplete");
    }
    node.characteristics.forEach((action, index) => {
      const actionPath = `${path}.characteristics[${index}]`;
      if (
        !isRecord(action) ||
        action.type !== "set" ||
        !stableNativeId(action.cId) ||
        typeof action.hc !== "string" ||
        typeof action.value !== "string"
      ) {
        throw invalidBlock(actionPath, "set action is incomplete");
      }
      context.actions.push({
        role: "action",
        path: actionPath,
        aId: node.aId,
        sId: node.sId,
        cId: action.cId,
        hs: node.hs,
        hc: action.hc,
        value: action.value,
      });
    });
    return;
  }
  if (kind === "set") return;
  if (kind === "delay") {
    if (
      !Number.isSafeInteger(node.index) ||
      node.index <= 0 ||
      context.delayIndexes.has(node.index) ||
      node.mode !== "RESET" ||
      !Number.isSafeInteger(node.time) ||
      node.time <= 0 ||
      !blockNodeArray(node.targets)
    ) {
      throw invalidBlock(
        path,
        "RESET delay index must be a positive unique integer; time must be a positive integer",
      );
    }
    context.delayIndexes.add(node.index);
    return;
  }
  throw invalidBlock(path, `node type ${kind ?? "missing"} is not supported`);
}

function parseDailyCron(node, path) {
  if (
    !isRecord(node) ||
    node.type !== "cron" ||
    node.mode !== "NONE" ||
    node.offset !== 0 ||
    typeof node.cron !== "string"
  ) {
    throw invalidBlock(
      path,
      "daily cron requires mode NONE, offset 0, and a cron string",
    );
  }
  const match = /^0 ([0-5]?\d) ([01]?\d|2[0-3]) \? \* \* \*$/.exec(node.cron);
  if (!match) {
    throw invalidBlock(
      path,
      "daily cron must match 0 MM HH ? * * * with MM 0-59 and HH 0-23 in the selected hub's local wall clock",
    );
  }
  return { minute: Number(match[1]), hour: Number(match[2]) };
}

function blockNode(value) {
  return isRecord(value) && typeof value.type === "string";
}

function blockNodeArray(value) {
  return Array.isArray(value) && value.every(blockNode);
}

function collectUnknownBlockFields(data) {
  const unknown = [];
  visitKnownBlockNodes(data, (node, kind, path) => {
    const allowed = BLOCK_ALLOWED_KEYS[kind] ?? new Set();
    for (const [key, value] of Object.entries(node)) {
      if (!allowed.has(key)) unknown.push({ path: `${path}.${key}`, value });
    }
  });
  return unknown.sort((left, right) => left.path.localeCompare(right.path));
}

const PAUSE_CODE_PATTERN =
  /^return Date\.now\(\) >= (\d+); \/\* sprut-agent:block-action-pause:([a-f0-9]{24}) \*\/$/;

function parsePauseCode(code) {
  if (typeof code !== "string") return null;
  const match = PAUSE_CODE_PATTERN.exec(code);
  if (!match) return null;
  const deadline = Number(match[1]);
  return Number.isSafeInteger(deadline) ? { deadline, id: match[2] } : null;
}

function pauseControllerId(node) {
  if (!isRecord(node) || node.type !== "if") return null;
  const conditions = node.if?.conditions;
  if (!Array.isArray(conditions) || conditions.length !== 1) return null;
  return parsePauseCode(conditions[0]?.code)?.id ?? null;
}

function pauseControllerShapeMatches(node) {
  return (
    isRecord(node) &&
    node.type === "if" &&
    node.mode === "EVERY" &&
    node.then_delay === 0 &&
    node.else_delay === 0 &&
    isRecord(node.if) &&
    node.if.type === "condition" &&
    node.if.mode === "AND" &&
    Array.isArray(node.if.conditions) &&
    node.if.conditions.length === 1 &&
    node.if.conditions[0]?.type === "code" &&
    parsePauseCode(node.if.conditions[0]?.code) !== null &&
    Object.keys(node.if.conditions[0]).every((key) =>
      BLOCK_ALLOWED_KEYS.code.has(key),
    ) &&
    Array.isArray(node.then) &&
    node.then.length === 1 &&
    blockNode(node.then[0]) &&
    Array.isArray(node.else) &&
    node.else.length === 0 &&
    Object.keys(node).every((key) => BLOCK_ALLOWED_KEYS.if.has(key)) &&
    Object.keys(node.if).every((key) => BLOCK_ALLOWED_KEYS.condition.has(key))
  );
}

function pauseControllerMatches(node, change) {
  const parsed = parsePauseCode(node?.if?.conditions?.[0]?.code);
  return (
    pauseControllerShapeMatches(node) &&
    parsed?.id === change.id &&
    parsed.deadline === change.pause_expires_at_ms
  );
}

function pauseController(change, action) {
  return {
    type: "if",
    mode: "EVERY",
    if: {
      type: "condition",
      mode: "AND",
      conditions: [
        {
          type: "code",
          code: `return Date.now() >= ${change.pause_expires_at_ms}; /* sprut-agent:block-action-pause:${change.id} */`,
        },
      ],
    },
    // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
    then: [structuredClone(action)],
    else: [],
    then_delay: 0,
    else_delay: 0,
  };
}

function buildPauseRequestedSnapshot(change) {
  const requested = structuredClone(change.baseline_snapshot);
  replaceBlockValueAtPointer(
    requested.data,
    change.action_pointer,
    pauseController(change, change.selected_action_snapshot),
  );
  return requested;
}

function blockPathToPointer(path) {
  return path
    .replace(/^root/, "")
    .replace(/\.([^.[\]]+)/g, "/$1")
    .replace(/\[(\d+)\]/g, "/$1")
    .split("/")
    .map((part, index) =>
      index === 0 ? part : part.replaceAll("~", "~0").replaceAll("/", "~1"),
    )
    .join("/");
}

function executableBlockActions(data) {
  const actions = new Map();
  visitKnownBlockNodes(data, (node, kind, path) => {
    if (["if", "service", "delay"].includes(kind)) {
      actions.set(blockPathToPointer(path), node);
    }
  });
  return actions;
}

function selectBlockAction(data, pointer, pauseChanges) {
  const node = executableBlockActions(data).get(pointer);
  if (!node) throw invalidActionPointer(pointer);
  const ownership = inspectPauseOwnership(data, pauseChanges);
  for (const owner of ownership.values()) {
    if (owner.state !== "owned") continue;
    if (pointer === owner.pointer || pointer === `${owner.pointer}/then/0`) {
      ensurePauseableTriggerScope(data, owner.node.then[0], owner.pointer);
      return {
        action: owner.node.then[0],
        pointer: owner.pointer,
        replacesChangeId: owner.change.id,
      };
    }
    if (
      pointer.startsWith(`${owner.pointer}/`) ||
      owner.pointer.startsWith(`${pointer}/`)
    ) {
      throw pauseScopeOverlap(pointer, owner.pointer);
    }
  }
  if (pauseControllerId(node) !== null) {
    throw new SprutHubError(
      "pause_controller_changed",
      "The selected action-pause controller is not an unchanged owned controller.",
      "get_native_change",
    );
  }
  ensurePauseableTriggerScope(data, node, pointer);
  return { action: node, pointer };
}

const INACTIVE_PAUSE_STATUSES = new Set([
  "restored",
  "superseded",
  "completed",
  "not_applied",
]);

function inspectPauseOwnership(
  data,
  pauseChanges,
  { allowedIntentId, includeInactive = false } = {},
) {
  const candidates = new Map(
    pauseChanges
      .filter(
        (change) =>
          Number.isSafeInteger(change.pause_expires_at_ms) &&
          (includeInactive ||
            !INACTIVE_PAUSE_STATUSES.has(change.status) ||
            (change.status === "not_applied" && change.id === allowedIntentId)),
      )
      .map((change) => [change.id, change]),
  );
  const occurrences = new Map();
  visitKnownBlockNodes(data, (node, kind, path) => {
    if (kind !== "if") return;
    const parsed = parsePauseCode(node.if?.conditions?.[0]?.code);
    if (!parsed) return;
    const found = occurrences.get(parsed.id) ?? [];
    found.push({ node, parsed, pointer: blockPathToPointer(path) });
    occurrences.set(parsed.id, found);
  });
  const ownership = new Map();
  for (const [id, change] of candidates) {
    const found = occurrences.get(id) ?? [];
    const exact = found.filter(({ node }) =>
      pauseControllerMatches(node, change),
    );
    ownership.set(
      id,
      found.length === 1 && exact.length === 1
        ? { state: "owned", change, ...exact[0] }
        : {
            state: found.length === 0 ? "missing" : "changed_or_duplicated",
            change,
          },
    );
  }
  return ownership;
}

function ensurePauseableTriggerScope(data, node, pointer) {
  let containsTrigger = false;
  visitKnownBlockNodes({ targets: [node] }, (candidate, kind) => {
    if (
      ["characteristic", "interval"].includes(kind) &&
      candidate.trigger === true
    ) {
      containsTrigger = true;
    }
  });
  if (!containsTrigger) return;
  const nested = [...executableBlockActions(data).entries()].filter(
    ([candidatePointer, candidate]) =>
      candidatePointer.startsWith(`${pointer}/`) &&
      !blockSubgraphContainsTrigger(candidate),
  );
  const shallowest = nested
    .filter(([candidatePointer]) =>
      nested.every(
        ([otherPointer]) =>
          candidatePointer === otherPointer ||
          !candidatePointer.startsWith(`${otherPointer}/`),
      ),
    )
    .map(([candidatePointer]) => candidatePointer);
  throw new SprutHubError(
    "unsupported_pause_trigger_scope",
    "The selected BLOCK subgraph contains trigger=true, whose registration after nesting is not verified. Select an executable action below that trigger.",
    "get_entity",
    { suggested_action_pointers: shallowest },
  );
}

function blockSubgraphContainsTrigger(node) {
  let containsTrigger = false;
  visitKnownBlockNodes({ targets: [node] }, (candidate, kind) => {
    if (
      ["characteristic", "interval"].includes(kind) &&
      candidate.trigger === true
    ) {
      containsTrigger = true;
    }
  });
  return containsTrigger;
}

function pauseScopeOverlap(pointer, ownedPointer) {
  return new SprutHubError(
    "pause_scope_overlap",
    `The selected BLOCK scope overlaps the owned pause at ${JSON.stringify(ownedPointer)} without selecting the same action. Restore that pause or select its controller or direct then/0 action.`,
    "get_native_change",
    {
      owned_pause_pointer: ownedPointer,
      owned_action_pointer: `${ownedPointer}/then/0`,
      requested_action_pointer: pointer,
    },
  );
}

function decodeJsonPointer(pointer) {
  if (
    typeof pointer !== "string" ||
    !pointer.startsWith("/") ||
    /~(?:[^01]|$)/.test(pointer)
  ) {
    throw invalidActionPointer(pointer);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function blockPointerLocation(data, pointer) {
  const tokens = decodeJsonPointer(pointer);
  let parent;
  let key;
  let value = data;
  for (const token of tokens) {
    parent = value;
    key = Array.isArray(parent)
      ? /^(?:0|[1-9]\d*)$/.test(token)
        ? Number(token)
        : token
      : token;
    if (
      (Array.isArray(parent) && !Number.isSafeInteger(key)) ||
      (!isRecord(parent) && !Array.isArray(parent)) ||
      !Object.hasOwn(parent, key)
    ) {
      throw invalidActionPointer(pointer);
    }
    value = parent[key];
  }
  return { parent, key, value };
}

function replaceBlockValueAtPointer(data, pointer, replacement) {
  const location = blockPointerLocation(data, pointer);
  location.parent[location.key] = replacement;
}

function prepareBlockWriteSource(input, pauseChanges, now) {
  const data = structuredClone(input);
  const owned = [
    ...inspectPauseOwnership(data, pauseChanges, {
      includeInactive: true,
    }).values(),
  ]
    .filter(
      (owner) =>
        owner.state === "owned" &&
        (INACTIVE_PAUSE_STATUSES.has(owner.change.status) ||
          owner.change.pause_expires_at_ms <= now),
    )
    .sort(
      (left, right) =>
        decodeJsonPointer(right.pointer).length -
        decodeJsonPointer(left.pointer).length,
    );
  for (const owner of owned) {
    replaceBlockValueAtPointer(
      data,
      owner.pointer,
      structuredClone(owner.node.then[0]),
    );
  }
  return {
    data,
    pauseOutcomes: owned
      .filter(({ change }) => !INACTIVE_PAUSE_STATUSES.has(change.status))
      .map(({ change }) => ({
        change_id: change.id,
        direction: "apply",
        status: "completed",
      })),
  };
}

function prepareBlockUpdateSource(baseline, requested, pauseChanges, now) {
  const prepared = prepareBlockWriteSource(requested, pauseChanges, now);
  const baselineOwnership = inspectPauseOwnership(baseline, pauseChanges, {
    includeInactive: true,
  });
  const requestedOwnership = inspectPauseOwnership(
    prepared.data,
    pauseChanges,
    { includeInactive: true },
  );
  const explicitOutcomes = [...baselineOwnership.values()]
    .filter(
      (owner) =>
        owner.state === "owned" &&
        requestedOwnership.get(owner.change.id)?.state !== "owned" &&
        !INACTIVE_PAUSE_STATUSES.has(owner.change.status),
    )
    .map(({ change }) => ({
      change_id: change.id,
      direction: "apply",
      status: change.pause_expires_at_ms <= now ? "completed" : "restored",
    }));
  return {
    data: prepared.data,
    pauseOutcomes: mergePauseOutcomes(prepared.pauseOutcomes, explicitOutcomes),
  };
}

function mergePauseOutcomes(current, additions) {
  const outcomes = new Map(
    current.map((outcome) => [
      `${outcome.direction}:${outcome.change_id}`,
      outcome,
    ]),
  );
  for (const outcome of additions) {
    outcomes.set(`${outcome.direction}:${outcome.change_id}`, outcome);
  }
  return [...outcomes.values()];
}

function nativePauseOutcomes(change) {
  if (Array.isArray(change.pause_outcomes)) return change.pause_outcomes;
  return (change.collapsed_pause_change_ids ?? []).map((changeId) => ({
    change_id: changeId,
    direction: "apply",
    status: "completed",
  }));
}

function invalidActionPointer(pointer) {
  return new SprutHubError(
    "invalid_action_pointer",
    `The BLOCK pointer ${JSON.stringify(pointer)} does not select one executable action or branch.`,
    "get_entity",
  );
}

function invalidBlock(path, message) {
  return new SprutHubError(
    "invalid_block_data",
    `Unsupported BLOCK data at ${path}: ${message}.`,
    "get_native_change_contract",
  );
}

function stableNativeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBlockValue(value, kind) {
  if (kind === "boolValue") {
    if (value === "true") return true;
    if (value === "false") return false;
  } else if (["intValue", "longValue"].includes(kind)) {
    if (/^-?\d+$/.test(value)) return Number(value);
  } else if (kind === "doubleValue") {
    if (value.trim() !== "" && Number.isFinite(Number(value)))
      return Number(value);
  } else if (kind === "stringValue") {
    return value;
  }
  throw invalidBlock("value", `value does not match ${kind}`);
}

function allowedConditions(kind) {
  if (kind === "boolValue") return ["="];
  if (kind === "stringValue") return ["=", "!="];
  return ["=", "!=", ">", ">=", "<", "<="];
}

function characteristicContract(control, { requireWrite = true } = {}) {
  if (control.read !== true || (requireWrite && control.write !== true)) {
    throw new SprutHubError(
      "insufficient_rights",
      requireWrite
        ? "The selected characteristic must be readable and writable."
        : "The selected characteristic must be readable.",
      "get_entity",
    );
  }
  const current = typedNativeValue(control.value);
  if (typeof control.type !== "string" || control.type.length === 0) {
    throw new SprutHubError(
      "unsupported_characteristic",
      "The selected characteristic has no stable native type.",
    );
  }
  if (
    control.validValues !== undefined &&
    !Array.isArray(control.validValues)
  ) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned invalid native valid values.",
    );
  }
  const scalarContract = nativeScalarContract(control, current.kind);
  const validValues = (control.validValues ?? []).flatMap((validValue) => {
    const typed = typedNativeValue(validValue?.value);
    if (typed.kind !== current.kind) {
      throw new SprutHubError(
        "unsupported_characteristic",
        "The selected characteristic has incompatible native valid values.",
      );
    }
    const projected = {
      key: validValue.key,
      name: validValue.name,
      ...typed,
    };
    return isSelectableNativeValidValue(validValue, typed, scalarContract)
      ? [projected]
      : [];
  });
  return {
    type: control.type,
    ...scalarContract,
    ...(control.validValues !== undefined ? { valid_values: validValues } : {}),
  };
}

function logicAssignmentContract(target, type, assigned) {
  return {
    type: target.type,
    name:
      typeof type.name === "string"
        ? sanitizeNativeData(type.name)
        : target.type,
    description:
      typeof type.desc === "string" ? sanitizeNativeData(type.desc) : "",
    assigned,
    create_active: false,
    confirmation: "scoped_logic_list_and_configuration_readback",
  };
}

function logicActiveContract() {
  return {
    type: "LogicActive",
    kind: "boolValue",
    confirmation: "separate_logic_get_readback",
  };
}

function characteristicOptionState(option, options = {}) {
  return nativeOptionState(option, {
    ...options,
    owner: "characteristic",
    unsupportedCode: "unsupported_characteristic_option",
    confirmation: "separate_characteristic_get_options_readback",
  });
}

function windowOptionState(option, options = {}) {
  return nativeOptionState(option, {
    ...options,
    owner: "window",
    unsupportedCode: "unsupported_window_option",
    confirmation: "separate_window_get_readback",
  });
}

function logicOptionState(option, options = {}) {
  return nativeOptionState(option, {
    ...options,
    owner: "logic",
    unsupportedCode: "unsupported_logic_option",
    confirmation: "separate_logic_get_options_readback",
  });
}

function nativeOptionState(
  option,
  {
    requireWrite = true,
    owner,
    unsupportedCode,
    confirmation,
    allowText = false,
  },
) {
  if (isSensitiveNativeNode(option)) {
    throw new SprutHubError(
      "sensitive_native_data",
      `The selected ${owner} setting contains sensitive native data.`,
      "get_entity",
    );
  }
  const inspected = inspectNativeOption(option, { requireWrite, allowText });
  if (!inspected.supported) {
    throw new SprutHubError(
      inspected.category === "rights"
        ? "insufficient_rights"
        : inspected.category === "incompatible"
          ? "incompatible_response"
          : unsupportedCode,
      `The selected ${owner} setting is unavailable: ${inspected.message}`,
      "get_entity",
    );
  }
  return {
    value: inspected.current,
    contract: { ...inspected.contract, confirmation },
  };
}

function assertOptionBinding(change, contract, owner) {
  if (
    contract.type !== change.contract.type ||
    contract.input_type !== change.contract.input_type ||
    contract.kind !== change.contract.kind
  ) {
    throw new SprutHubError(
      "binding_changed",
      `The selected ${owner} option contract changed after preparation.`,
      "prepare_native_change",
    );
  }
}

function logicActiveValue(logic) {
  if (typeof logic?.active !== "boolean") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned a logic assignment without an explicit active state.",
      "get_entity",
    );
  }
  return { value: logic.active, kind: "boolValue" };
}

function typedNativeValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SprutHubError(
      "unsupported_characteristic",
      "The selected characteristic has no supported current value.",
    );
  }
  const kinds = [
    "boolValue",
    "intValue",
    "longValue",
    "doubleValue",
    "stringValue",
  ].filter((key) => Object.hasOwn(value, key));
  if (kinds.length !== 1) {
    throw new SprutHubError(
      "unsupported_characteristic",
      "The selected characteristic value kind is ambiguous or unsupported.",
    );
  }
  return { value: value[kinds[0]], kind: kinds[0] };
}

function validateCharacteristicValue(value, contract) {
  const validated = validateNativeScalarValue(value, contract);
  if (!validated.valid) {
    throw new SprutHubError("invalid_native_value", validated.message);
  }
  return validated.value;
}

function valuesEqual(left, right) {
  return left?.kind === right?.kind && Object.is(left?.value, right?.value);
}

function groupValuesEqual(left, right) {
  const numericKinds = new Set(["intValue", "longValue", "doubleValue"]);
  if (numericKinds.has(left?.kind) && numericKinds.has(right?.kind)) {
    return Object.is(Number(left.value), Number(right.value));
  }
  return valuesEqual(left, right);
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

function nativeTargetKey({ aId, sId, cId }) {
  return `${aId}:${sId}:${cId}`;
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

function matchesVirtualLightCandidate(
  accessory,
  change,
  { allowNormalizedName = false } = {},
) {
  if (
    accessory.virtual !== true ||
    accessory.roomId !== change.room_id ||
    (!allowNormalizedName && accessory.name !== change.requested_name)
  ) {
    return false;
  }
  try {
    selectCreatedVirtualLight(accessory, change);
    return true;
  } catch {
    return false;
  }
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

function isNativeValueChange(change) {
  return [
    "characteristic_value",
    "characteristic_option",
    "window_option",
    "logic_active",
    "logic_option",
  ].includes(change?.kind);
}

function isKnownCharacteristicSetting(type) {
  return STATEFUL_CHARACTERISTIC_SETTING_TYPES.has(type);
}

function isRetryableNativeValueChange(change) {
  return [
    "characteristic_option",
    "window_option",
    "logic_active",
    "logic_option",
  ].includes(change?.kind);
}

function hasKnownSettingSemantics(change) {
  return (
    ["characteristic_option", "window_option", "logic_option"].includes(
      change?.kind,
    ) ||
    (change?.kind === "characteristic_value" &&
      isKnownCharacteristicSetting(change.contract?.type))
  );
}

function nativeValueRestoration(change) {
  if (isRetryableNativeValueChange(change)) {
    return scalarValueRestoration(change.contract, change.baseline_value);
  }
  if (change?.kind !== "characteristic_value") return { supported: false };
  return characteristicSettingRestoration(
    change.contract,
    change.baseline_value,
  );
}

function characteristicSettingRestoration(contract, baseline) {
  if (!isKnownCharacteristicSetting(contract?.type)) {
    return { supported: false };
  }
  return scalarValueRestoration(contract, baseline);
}

function scalarValueRestoration(contract, baseline) {
  const validation = validateNativeScalarValue(baseline?.value, contract);
  if (validation.valid) return { supported: true };
  return {
    supported: false,
    limitation: {
      code: "baseline_not_writable",
      message: `The saved baseline cannot be restored automatically: ${validation.message}`,
    },
  };
}

function freshVerification(result) {
  return {
    fresh: true,
    checked_at: new Date().toISOString(),
    result,
  };
}

function failedVerification(error) {
  return {
    fresh: false,
    checked_at: null,
    error: {
      code: error instanceof SprutHubError ? error.code : "read_failed",
      ...(error instanceof SprutHubError && error.action
        ? { action: error.action }
        : {}),
    },
  };
}

function classifyScenarioRunDelivery(error) {
  if (error instanceof SprutHubError && error.requestSent === false) {
    error.action = "restore_connection_then_prepare_native_change";
    return { status: "not_sent", failure: scenarioRunFailure(error) };
  }
  if (
    error instanceof SprutHubError &&
    ["authentication_failed", "request_rejected", "unsupported"].includes(
      error.code,
    )
  ) {
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

function scenarioRunObservationResult(observations) {
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

function savedVerification(verification) {
  return verification
    ? { ...structuredClone(verification), fresh: false }
    : { fresh: false, checked_at: null };
}

function nativeIntentDirection(change) {
  return (
    change.write_intent?.direction ??
    (change.status === "restoring" ? "restore" : "apply")
  );
}

function nativeValueIntentEvidence(change) {
  if (!isNativeValueChange(change)) {
    return { outcome: "not_applicable", unresolved: false };
  }
  const intent = change.write_intent;
  if (!intent || change.native_write_sent !== true) {
    return { outcome: "not_sent", unresolved: false };
  }
  if (
    ["sending", "needs_reconciliation"].includes(intent.phase) ||
    ["applying", "restoring", "uncertain"].includes(change.status)
  ) {
    return { outcome: "unknown", unresolved: true };
  }
  if (change.status === "not_applied") {
    return { outcome: "rejected", unresolved: false };
  }
  if (intent.direction === "apply" && change.applied_value_observed === true) {
    return { outcome: "requested_value_observed", unresolved: false };
  }
  if (intent.direction === "restore" && change.status === "restored") {
    return { outcome: "baseline_value_observed", unresolved: false };
  }
  return { outcome: "resolved", unresolved: false };
}

function manualValueChangeObserved(change) {
  return (
    change?.manual_change_observed === true ||
    ["manual_change", "value_changed_after_apply"].includes(
      change?.conflict_reason,
    ) ||
    legacyManualValueChangeObserved(change)
  );
}

function legacyManualValueChangeObserved(change) {
  return (
    change?.status === "not_owned" &&
    change.native_write_sent === true &&
    Array.isArray(change.history) &&
    change.history.some(({ status }) => status === "conflict") &&
    change.observed_value &&
    !valuesEqual(change.observed_value, change.baseline_value) &&
    !valuesEqual(change.observed_value, change.requested_value)
  );
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

function requiredLogicSource(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SprutHubError(
      "invalid_native_change",
      "LOGIC source must be a non-empty string.",
      "get_scenario_sdk",
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

function logicSnapshotMatches(scenario, expected) {
  return (
    scenario !== null &&
    isDeepStrictEqual(
      logicEditableSnapshot(logicScenarioSnapshot(scenario)),
      logicEditableSnapshot(expected),
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
      matches =
        current.scenario === null &&
        (change.native_logic_type
          ? !current.logicTypes.includes(change.native_logic_type)
          : isDeepStrictEqual(current.logicTypes, change.baseline_logic_types));
    } else {
      expected = change.baseline_snapshot;
      matches = logicSnapshotMatches(current.scenario, expected);
    }
  } else if (snapshot === "requested") {
    expected = logicSourceRequestedSnapshot(change);
    matches = logicSourceWriteMatches(current.scenario, expected);
  } else if (snapshot === "applied") {
    expected = change.applied_snapshot;
    matches =
      expected !== undefined &&
      logicSnapshotMatches(current.scenario, expected);
  } else if (snapshot === "restored") {
    if (change.kind === "logic_source_create") {
      matches =
        current.scenario === null &&
        (change.native_logic_type
          ? !current.logicTypes.includes(change.native_logic_type)
          : isDeepStrictEqual(current.logicTypes, change.baseline_logic_types));
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

function newLogicTypeMapping(change, currentTypes) {
  if (typeof change.native_logic_type === "string") {
    return {
      status: "mapped",
      type: change.native_logic_type,
      assignmentReady: currentTypes.includes(change.native_logic_type),
    };
  }
  const baseline = new Set(change.baseline_logic_types);
  const types = currentTypes.filter((type) => !baseline.has(type));
  if (types.length === 0) return { status: "missing", types: [] };
  if (types.length > 1) return { status: "ambiguous", types };
  return { status: "mapped", type: types[0], assignmentReady: true };
}

function updateLogicTypeMapping(change, currentTypes) {
  const mapping = newLogicTypeMapping(change, currentTypes);
  change.logic_mapping_status = mapping.status;
  change.logic_assignment_ready =
    mapping.status === "mapped" && mapping.assignmentReady;
  if (mapping.status === "mapped") {
    change.native_logic_type = mapping.type;
    change.logic_mapping_reason = mapping.assignmentReady
      ? undefined
      : "logic_type_not_available_on_target";
    change.candidate_logic_types = undefined;
    return;
  }
  change.logic_mapping_reason =
    mapping.status === "missing"
      ? "logic_type_not_visible_after_create"
      : "ambiguous_logic_type";
  change.candidate_logic_types =
    mapping.status === "ambiguous" ? mapping.types : undefined;
}

function logicSourceContract(mode) {
  return {
    version: "2026-09-11",
    scenario_type: "LOGIC",
    mode,
    source: {
      format: "javascript",
      execution_environment: "SprutHub scenario sandbox",
      exact_readback: true,
    },
    editable_fields:
      mode === "create"
        ? ["name", "description", "active", "on_start", "sync", "source"]
        : ["source"],
    assignment: {
      mapping:
        "stored source ownership is independent from a new type observed through logic.types on the selected service",
      separate_operation: "logic_assignment",
    },
    restore: {
      update:
        "restore the exact saved source only while the observed applied source and metadata are unchanged",
      create:
        "delete only the owned unchanged scenario after its native type is mapped and every current assignment of that type is absent",
    },
    limitations: [
      "Source is stored and compared as exact text; it is not executed or statically analyzed locally.",
      "SprutHub-normalized create flags are reported separately and become the saved applied snapshot.",
      "A successful source readback does not confirm callback behavior or physical effects.",
      "SprutHub exposes no compare-and-set; a race remains after the pre-write comparison.",
    ],
  };
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

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

function nativeScenarioDescription(userDescription, provenMarker) {
  if (typeof provenMarker !== "string") return userDescription;
  const token = `[${provenMarker}]`;
  const userText = userDescription
    .split(token)
    .join("")
    .replace(/^\n+|\n+$/gu, "");
  if (userText.length === 0) return token;
  return `${userText}\n\n${token}`;
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
        configurationData(change.baseline_snapshot.data),
        configurationData(change.requested_snapshot.data),
      ),
      from: structuredClone(change.baseline_snapshot.data),
      to: structuredClone(change.requested_snapshot.data),
    };
  }
  return diff;
}

function blockCreateSnapshot(change) {
  const request = blockCreateRequest(change);
  return {
    ...request,
    data: structuredClone(change.requested_snapshot.data),
  };
}

function blockMatchesRequested(change, scenario) {
  if (!scenario) return false;
  const current = scenarioSnapshot(scenario);
  if (["block_data_update", "block_action_pause"].includes(change.kind)) {
    if (!change.requested_snapshot) return false;
    return snapshotsEqual(current, change.requested_snapshot);
  }
  const expected = blockCreateRequest(change);
  return (
    current.name === expected.name &&
    current.desc === expected.desc &&
    current.active === expected.active &&
    current.onStart === expected.onStart &&
    current.sync === expected.sync &&
    current.type === expected.type &&
    isDeepStrictEqual(
      configurationData(current.data),
      configurationData(change.requested_snapshot.data),
    )
  );
}

function blockStillAtBaseline(change, scenario) {
  if (change.kind === "block_create") return scenario === null;
  const baseline = change.restore_snapshot ?? change.baseline_snapshot;
  return (
    scenario !== null && snapshotsEqual(scenarioSnapshot(scenario), baseline)
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
    snapshotsEqual(scenarioSnapshot(scenario), change.applied_snapshot)
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

function scenarioLacksProvenApply(change) {
  // Lost write ownership: a later requested match is coincidence, not restore rights.
  return change.status === "conflict" && change.applied_snapshot === undefined;
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

function unprovenApplyLimitation() {
  return "This change has no proven applied snapshot, so apply will not be sent again and restore is not allowed. Prepare a new authorized change from the current hub configuration.";
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

function comparableNativeScenarioConfiguration(snapshot) {
  // Compare identity plus ScenarioCreateRequest/ScenarioUpdateRequest fields.
  // ScenarioMessage rooms, iconsIf/iconsThen, error, order and bundleId are
  // hub projections or runtime diagnostics, not editable configuration.
  return nativeScenarioConfiguration(
    snapshot,
    configurationData(snapshot.data),
  );
}

function parseNativeChangeRef(ref) {
  const match = /^spruthub-change:\/\/native\/([a-f0-9]{24})$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_change_ref",
      "Use a change reference returned by prepare_native_change.",
      "prepare_native_change",
    );
  }
  return match[1];
}

function publicStoredNativeChange(change) {
  return publicNativeChange(change, undefined, {
    verification: savedVerification(change.last_verification),
  });
}

function publicBlockActionPreview(change, fresh) {
  return {
    snapshot: {
      ...structuredClone(change.block_action_preview.snapshot),
      fresh,
    },
    actions: structuredClone(change.block_action_preview.actions),
  };
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
      ...(room ? { room } : {}),
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
        "SprutHub room creation and deletion are schema-confirmed but not live-confirmed in this slice.",
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
    const scenarioRef = change.scenario_index
      ? `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`
      : change.kind === "logic_source_update"
        ? change.target_ref
        : undefined;
    const logicRef =
      change.kind === "logic_source_create" &&
      typeof change.native_logic_type === "string"
        ? `${change.target_ref}/logic/${encodeURIComponent(change.native_logic_type)}`
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
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(change.scenario_index
        ? { scenario_index: change.scenario_index }
        : {}),
      ...(scenarioRef ? { scenario_ref: scenarioRef } : {}),
      ...(change.native_logic_type
        ? { native_logic_type: change.native_logic_type }
        : {}),
      ...(mappingVisible && change.logic_mapping_status
        ? { logic_mapping_status: change.logic_mapping_status }
        : {}),
      ...(mappingVisible && typeof change.logic_assignment_ready === "boolean"
        ? { logic_assignment_ready: change.logic_assignment_ready }
        : {}),
      ...(mappingVisible && change.logic_mapping_reason
        ? { logic_mapping_reason: change.logic_mapping_reason }
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
      ...(mappingVisible && change.candidate_logic_types
        ? { candidate_logic_types: [...change.candidate_logic_types] }
        : {}),
      ...(change.logic_assignments
        ? { logic_assignments: structuredClone(change.logic_assignments) }
        : {}),
      restore_supported:
        !scenarioLacksProvenApply(change) &&
        (change.kind !== "logic_source_create" ||
          typeof change.native_logic_type === "string"),
      ...(scenarioConflictAsksForNewPrepare(change)
        ? { next: unprovenApplyNext(change) }
        : {}),
      limitations: [
        "The source is compared exactly and represented by SHA-256 in change output so embedded native data is not echoed from the journal.",
        "LOGIC creation appends a unique JavaScript ownership comment to the source sent to SprutHub.",
        "Metadata returned after a source write is observed rather than attributed to either source derivation or a concurrent edit, and becomes the guard for a later restore.",
        "Source readback confirms stored configuration, not execution or physical behavior.",
        "Scenario creation, source updates, assignment, options, and activation are separate native operations.",
        "Deletion requires a mapped native logic type and scans its current assignments, but SprutHub exposes no compare-and-set after that check.",
        ...(scenarioLacksProvenApply(change)
          ? [unprovenApplyLimitation()]
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
        "An acknowledged run means SprutHub accepted scenario.run; target values are observed separately and do not prove physical delivery or causality.",
        "The target actions are not atomic, and a race remains after the pre-run scenario comparison.",
        "An unknown run outcome is never resent; prepare a new change only for a new explicit user request.",
        "Removing or restoring scenario configuration does not undo a past command effect.",
      ],
    };
  }
  if (!isNativeValueChange(change)) {
    const diff =
      change.kind === "block_create"
        ? {
            configuration: {
              changed: true,
              from: null,
              to: blockCreateSnapshot(change),
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
      restore_supported: !scenarioLacksProvenApply(change),
      ...(scenarioConflictAsksForNewPrepare(change)
        ? { next: unprovenApplyNext(change) }
        : {}),
      limitations: [
        ...(change.block_action_preview
          ? [
              "Every listed service/set remains a write when its enclosing action runs; equality with the preparation observation is not a no-op or a manual-control guarantee.",
              "Action comparisons use the saved preparation observation. Later reads of this change do not refresh it or predict the value at a future branch execution.",
              "The preview describes only service/set actions in this BLOCK. A branch does not write omitted characteristics, but other automation can still affect them.",
            ]
          : []),
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
        scenarioLacksProvenApply(change)
          ? unprovenApplyLimitation()
          : "Restoration is allowed only while the current configuration matches the saved applied snapshot.",
        ...(scenarioConflictAsksForNewPrepare(change) &&
        change.applied_snapshot !== undefined
          ? [scenarioRepeatApplyLimitation()]
          : []),
      ],
    };
  }
  const optionChange = [
    "characteristic_option",
    "window_option",
    "logic_option",
  ].includes(change.kind);
  const valueChoices = optionChange
    ? {
        baseline: namedOptionValue(change, change.baseline_value),
        requested: namedOptionValue(change, change.requested_value),
        ...(observedValue
          ? { observed: namedOptionValue(change, observedValue) }
          : {}),
      }
    : undefined;
  const conflictResolution =
    optionChange &&
    change.status === "conflict" &&
    change.applied_value_observed === true &&
    observedValue
      ? {
          requires_user_decision: true,
          action_if_authorized:
            change.kind === "characteristic_option"
              ? "prepare_new_characteristic_option_change"
              : change.kind === "window_option"
                ? "prepare_new_window_option_change"
                : "prepare_new_logic_option_change",
          effect: {
            replace: namedOptionValue(change, observedValue),
            with: namedOptionValue(change, change.baseline_value),
          },
        }
      : undefined;
  const restoration = nativeValueRestoration(change);
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    ...(change.window_ref ? { window_ref: change.window_ref } : {}),
    diff: {
      value: {
        from: change.baseline_value.value,
        to: change.requested_value.value,
        kind: change.requested_value.kind,
      },
    },
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(observedValue ? { observed_value: observedValue } : {}),
    ...(valueChoices ? { value_choices: valueChoices } : {}),
    ...(verification ? { verification } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
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
    restore_supported: restoration.supported,
    ...(restoration.limitation
      ? { restore_limitation: restoration.limitation }
      : {}),
    ...(change.kind === "characteristic_value"
      ? { physical_effect_reversible: false }
      : {}),
    command_caused_observation: "unknown",
    limitations: [
      "Readback observes the value but cannot prove this command caused it.",
      "SprutHub exposes no native compare-and-set for this operation.",
      restoration.supported
        ? change.kind === "characteristic_value"
          ? "The saved setting can be restored only while its current value still matches this change; past physical effects are not reversed."
          : "Restoration is allowed only while the current setting still matches this change."
        : (restoration.limitation?.message ??
          "A runtime command does not provide rollback of physical effects."),
      "An option or logic-active write with an unknown outcome may be retried only while this change retains ownership; a characteristic-value write is not retried automatically. After ownership is lost, any further authorized write requires a newly prepared change.",
      ...(change.kind === "window_option"
        ? [
            "Window readback confirms the setting stored by SprutHub; delivery to the device and behavior after a physical power cycle remain unverified.",
            ...(change.owner_kind === "scenario"
              ? [
                  "Name, Desc, and BLOCK data are separate native changes. Prepare each field on a fresh baseline after the previous apply. Restore of this metadata write is allowed only while the remaining significant configuration and owner window binding still match the saved snapshot.",
                  "A later sibling Name, Desc, data, or flag write is owner_configuration_changed, not proof that this field was edited by hand. Restore remaining fields in reverse apply order.",
                  "A proven create marker in Desc is kept by the adapter only while that create change is still applied; it is not copied from a restored or deleted owner and does not restore create-delete rights.",
                ]
              : []),
          ]
        : []),
      ...(change.group_member_targets
        ? [
            "Delivery is checked against every journal-known group member; a same-valued native virtual command may be suppressed by SprutHub.",
          ]
        : []),
    ],
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

function changeSummary(change, homeRef) {
  if (
    [
      "characteristic_value",
      "characteristic_option",
      "window_option",
      "logic_active",
      "logic_option",
      "logic_assignment",
      "accessory_placement",
      "room_create",
      "virtual_light_group",
      "block_create",
      "block_data_update",
      "block_action_pause",
      "scenario_run",
      "logic_source_create",
      "logic_source_update",
    ].includes(change.kind)
  ) {
    const reference = `spruthub-change://native/${change.id}`;
    return {
      change_ref: reference,
      operation: change.kind,
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
      target_refs: nativeAffectedRefs(change, homeRef),
      created_at: change.created_at,
      updated_at: change.updated_at,
      next: {
        tool: "get_native_change",
        arguments: { change_ref: reference },
      },
    };
  }
  const reference = changeRef(change.id);
  const characteristicRefs = [
    change.condition?.characteristic?.ref,
    change.action?.characteristic?.ref,
  ]
    .filter(Boolean)
    .map((ref) => canonicalEntityRef(ref, homeRef));
  const ancestorRefs = characteristicRefs.flatMap((ref) =>
    canonicalAncestors(ref),
  );
  return {
    change_ref: reference,
    operation: "legacy_boolean_automation",
    recorded_status: change.status,
    target_refs: uniqueRefs([
      ...characteristicRefs,
      ...ancestorRefs,
      ...(change.scenario_index
        ? [`${homeRef}/scenario/${encodeURIComponent(change.scenario_index)}`]
        : []),
    ]),
    created_at: change.created_at,
    updated_at: change.updated_at,
    next: {
      tool: "get_automation_change",
      arguments: { change_ref: reference },
    },
  };
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
    tool: "list_native_changes",
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
    "Use the cursor returned by list_native_changes for the same home and entity filter.",
    "restart_list_native_changes",
    { next: historyNext(selection, null) },
  );
}

function nativeAffectedRefs(change, homeRef) {
  const refs = [canonicalEntityRef(change.target_ref, homeRef)];
  if (
    change.kind === "window_option" &&
    typeof change.window_ref === "string"
  ) {
    refs.push(change.window_ref);
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
  if (
    [
      "characteristic_value",
      "characteristic_option",
      "logic_active",
      "logic_option",
      "logic_assignment",
    ].includes(change.kind)
  ) {
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
    if (
      change.kind === "logic_source_create" &&
      typeof change.native_logic_type === "string"
    ) {
      refs.push(
        `${change.target_ref}/logic/${encodeURIComponent(change.native_logic_type)}`,
      );
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

function selectCharacteristic(selection, ref, value, requireWrite, serial) {
  const accessory = selection.accessories.find(({ id }) => id === ref.aId);
  const service = accessory?.services?.find(({ sId }) => sId === ref.sId);
  const characteristic = service?.characteristics?.find(
    ({ cId }) => cId === ref.cId,
  );
  const control = characteristic?.control;
  if (
    !accessory ||
    accessory.roomId !== selection.room.id ||
    !service ||
    !control
  ) {
    throw new SprutHubError(
      "characteristic_not_found",
      "The selected characteristic was not found in the selected room.",
      "read_services",
    );
  }
  if (accessory.online !== true) {
    throw new SprutHubError(
      "device_unavailable",
      "A selected device is currently unavailable.",
      "retry",
    );
  }
  if (
    typeof value !== "boolean" ||
    typeof control.value?.boolValue !== "boolean"
  ) {
    throw new SprutHubError(
      "unsupported_characteristic",
      "This automation supports boolean characteristics only.",
    );
  }
  if (control.read !== true || (requireWrite && control.write !== true)) {
    throw new SprutHubError(
      "insufficient_rights",
      requireWrite
        ? "The target characteristic is not writable."
        : "The source characteristic is not readable.",
    );
  }

  const normalized = {
    room: {
      ref: `${configuredHomeRef(serial)}/room/${selection.room.id}`,
      name: selection.room.name,
    },
    device: {
      ref: `${configuredHomeRef(serial)}/accessory/${accessory.id}`,
      name: accessory.name,
    },
    service: {
      ref: `${configuredHomeRef(serial)}/accessory/${accessory.id}/service/${service.sId}`,
      name: service.name,
      type: service.type,
    },
    characteristic: {
      ref: `${configuredHomeRef(serial)}/accessory/${accessory.id}/service/${service.sId}/characteristic/${characteristic.cId}`,
      name: control.name,
      type: control.type ?? control.key,
      read: control.read === true,
      write: control.write === true,
    },
    value,
  };
  return requireWrite
    ? normalized
    : { ...normalized, operator: "=", trigger: true };
}

function selectAutoOff(seconds, condition, action) {
  if (seconds === undefined) return null;
  if (
    condition.characteristic.type !== "MotionDetected" ||
    condition.value !== true ||
    action.characteristic.type !== "On" ||
    action.value !== true
  ) {
    throw new SprutHubError(
      "unsupported_auto_off",
      "Auto-off is supported only for MotionDetected=true to On=true automations.",
    );
  }
  return {
    after_seconds: seconds,
    timer_mode: "RESET",
    restarts_on_each_trigger: true,
    target_value: false,
  };
}

function buildNativeData(condition, action, autoOff) {
  const source = parseCharacteristicRef(condition.characteristic.ref);
  const target = parseCharacteristicRef(action.characteristic.ref);
  return {
    blockId: 0,
    targets: [
      {
        type: "if",
        blockId: 1,
        if: {
          type: "condition",
          blockId: 2,
          mode: "AND",
          conditions: [
            {
              type: "characteristic",
              blockId: 3,
              ...source,
              value: String(condition.value),
              cond: "=",
              trigger: true,
              hs: condition.service.type,
              hc: condition.characteristic.type,
              time: 0,
              timeCond: "",
            },
          ],
        },
        // biome-ignore lint/suspicious/noThenProperty: SprutHub's native BLOCK schema requires this key.
        then: [
          {
            type: "service",
            blockId: 4,
            aId: target.aId,
            sId: target.sId,
            hs: action.service.type,
            characteristics: [
              {
                type: "set",
                blockId: 5,
                cId: target.cId,
                hc: action.characteristic.type,
                value: String(action.value),
              },
            ],
          },
          ...(autoOff
            ? [
                {
                  type: "delay",
                  blockId: 6,
                  index: 1,
                  mode: "RESET",
                  time: autoOff.after_seconds * 1_000,
                  targets: [
                    {
                      type: "service",
                      blockId: 7,
                      aId: target.aId,
                      sId: target.sId,
                      hs: action.service.type,
                      characteristics: [
                        {
                          type: "set",
                          blockId: 8,
                          cId: target.cId,
                          hc: action.characteristic.type,
                          value: "false",
                        },
                      ],
                    },
                  ],
                },
              ]
            : []),
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
        mode: "EVERY",
      },
    ],
  };
}

function normalizeContext(context, homeReference) {
  return {
    scenarios: context.scenarios.map(
      ({ index, name, type, predefined, active }) => ({
        index,
        name,
        type,
        predefined,
        active,
      }),
    ),
    source: normalizeSelectionContext(context.source, homeReference),
    target: normalizeSelectionContext(context.target, homeReference),
    extensions: context.extensions.map(
      ({ type, bundleType, name, enabled, state }) => ({
        type,
        bundle_type: bundleType,
        name,
        enabled,
        state,
      }),
    ),
  };
}

function normalizeSelectionContext(selection, homeReference) {
  return {
    scenario_associations: selection.directScenarios.map((scenario) => ({
      ref: `${homeReference}/scenario/${encodeURIComponent(scenario.index)}`,
      name: scenario.name,
      type: scenario.type,
      predefined: scenario.predefined === true,
      active: scenario.active === true,
      on_start: scenario.onStart === true,
      sync: scenario.sync === true,
      meaning: "accessory_index_association",
      direction: "not_established",
    })),
    assigned_logics: selection.assignedLogics,
    available_logic_types: selection.logicTypes,
    links: selection.links.map(({ type }) => ({ type })),
    options: selection.options.map((option) => ({
      key: option.key,
      name: option.name,
      type: option.type,
      value: typedValue(option.value),
      read: option.read === true,
      write: option.write === true,
    })),
  };
}

function typedValue(value) {
  for (const key of [
    "boolValue",
    "intValue",
    "longValue",
    "doubleValue",
    "stringValue",
  ]) {
    if (Object.hasOwn(value ?? {}, key)) return value[key];
  }
  return null;
}

export function parseChangeRef(ref) {
  const match = /^spruthub-change:\/\/automation\/([a-f0-9]{24})$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_change_ref",
      "Use a change reference returned by preview_boolean_automation.",
      "preview_boolean_automation",
    );
  }
  return match[1];
}

function changeRef(id) {
  return `spruthub-change://automation/${id}`;
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
  const expected = expectedScenario(change);
  const metadataMatches = Object.entries(expected).every(
    ([key, value]) => key === "data" || scenario[key] === value,
  );
  if (!metadataMatches || typeof scenario.data !== "string") return false;
  try {
    return isDeepStrictEqual(
      configurationData(JSON.parse(scenario.data)),
      configurationData(change.native_data),
    );
  } catch {
    return false;
  }
}

function configurationData(data) {
  return normalizedKnownBlockNode(data, "root");
}

function normalizedKnownBlockNode(node, kind) {
  if (!isRecord(node)) return structuredClone(node);
  const isKnownNode = Object.hasOwn(BLOCK_ALLOWED_KEYS, kind);
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      (isKnownNode && key === "blockId") ||
      (kind === "if" && key === "state")
    )
      continue;
    const rule = BLOCK_CHILD_FIELDS[kind]?.[key];
    if (!rule) {
      normalized[key] = structuredClone(value);
      continue;
    }
    if (rule.shape === "array") {
      normalized[key] = Array.isArray(value)
        ? value.map((child) => normalizedBlockChild(child, rule))
        : structuredClone(value);
      continue;
    }
    normalized[key] = normalizedBlockChild(value, rule);
  }
  return normalized;
}

function normalizedBlockChild(child, rule) {
  return isRecord(child) && rule.kinds.has(child.type)
    ? normalizedKnownBlockNode(child, child.type)
    : structuredClone(child);
}

function sameRuleBody(scenario, change) {
  if (scenario.type !== "BLOCK" || typeof scenario.data !== "string")
    return false;
  try {
    const candidate = ruleMeaning(JSON.parse(scenario.data));
    const expected = ruleMeaning(change.native_data);
    return (
      candidate !== null &&
      expected !== null &&
      JSON.stringify(candidate) === JSON.stringify(expected)
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
    condition: {
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
    },
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

function verifiedApplyFields(created) {
  return {
    created,
    hub_configuration_verified: true,
    physical_effect_observed: false,
  };
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
  action = "restore_state_storage_then_get_automation_change",
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

function isUncertainWriteError(error) {
  return (
    error instanceof SprutHubError &&
    error.requestSent === true &&
    !["authentication_failed", "request_rejected"].includes(error.code)
  );
}
