import {
  characteristicContract,
  logicActiveContract,
  ROOM_NAME_MAX_LENGTH,
  ROOM_NAME_REFUSED_CHARACTER,
  requiredNativeName,
  roomNameLimits,
  typedNativeValue,
  validateCharacteristicValue,
  valuesEqual,
} from "./change-contracts.mjs";
import {
  assertWindowOptionWritable,
  configuredHomeRef,
  logicInfoInCode,
  logicNotFound,
  nativeTargetKey,
  parseCharacteristicRef,
  parseLogicRef,
  parseRoomRef,
  parseScenarioRef,
  parseServiceRef,
  parseWindowOptionOwner,
  SCENARIO_METADATA_KEYS,
  scenarioActiveOwnerRequired,
  scenarioNotFound,
  scenarioOwnerRequired,
  stableJson,
} from "./change-refs.mjs";
import {
  inspectNativeOption,
  validateNativeScalarValue,
} from "./native-option-contract.mjs";
import { characteristicNotificationServices } from "./scenario-notifications.mjs";
import {
  BRIDGE_NOT_RUNNING,
  bridgeExportUnverified,
  bridgeRunning,
  characteristicNotifyOffered,
  characteristicNotifyOn,
  HUB_TRANSPORT_ERROR_CODES,
  isSensitiveNativeNode,
  SprutHubError,
  sanitizeNativeData,
  serviceRef,
} from "./spruthub-client.mjs";

// Characteristics whose value is a setting rather than a momentary command:
// an equal value is not resent, and a third value seen after a write is a
// manual change. Any characteristic command is restorable (restoreValueChange).
export const STATEFUL_CHARACTERISTIC_SETTING_TYPES = new Set([
  "TargetTemperature",
  "TargetHeatingCoolingState",
  "C_FanSpeed",
]);

export function characteristicOptionState(option, options = {}) {
  return nativeOptionState(option, {
    ...options,
    owner: "characteristic",
    unsupportedCode: "unsupported_characteristic_option",
    confirmation: "separate_characteristic_get_options_readback",
  });
}

export function windowOptionState(option, options = {}) {
  return nativeOptionState(option, {
    ...options,
    owner: "window",
    unsupportedCode: "unsupported_window_option",
    confirmation: "separate_window_get_readback",
  });
}

export function logicOptionState(option, options = {}) {
  return nativeOptionState(option, {
    ...options,
    owner: "logic",
    unsupportedCode: "unsupported_logic_option",
    confirmation: "separate_logic_get_options_readback",
  });
}

export function nativeOptionState(
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

export function assertOptionBinding(change, contract, owner) {
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

export function logicActiveValue(logic) {
  if (typeof logic?.active !== "boolean") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned a logic assignment without an explicit active state.",
      "get_entity",
    );
  }
  return { value: logic.active, kind: "boolValue" };
}

// Scalar native settings share one prepare → apply → readback → restore
// lifecycle. An entry holds only what is specific to its operation:
// - inspect(service, input) reads the target for a contract or prepare and
//   returns { fields, value, contract }; fields are the saved target identity.
// - read(service, change, { requireWrite }) rereads a saved target, rejecting
//   a changed binding; write(service, change, typedValue) sends one value.
// - restoration(contract, baseline) decides restore; knownSetting(change)
//   decides whether a third readback value is a manual change.
// Optional: optionKey (input option_key selects the setting), command (a
// runtime command that is never resent automatically, whose restore writes
// the previous value back only while the device still shows the sent one
// and does not reverse past physical effects), contract and prepare
// overrides, ownerConflict, and extra limitations.
// A virtual button's press is its ProgrammableSwitchEvent written: each
// write is a press that scenarios on the button react to, the same value
// included (2026-10-23-virtual-devices, 9 and 10). A press is not undone:
// writing the earlier value back would be another press.
export const BUTTON_PRESS_TYPE = "ProgrammableSwitchEvent";
export const BUTTON_PRESS_NOTE =
  "A write to a virtual button is a press: scenarios on this button ran as on a press, each time it is sent. A press is not undone.";
const BUTTON_PRESS_RESTORATION = {
  supported: false,
  limitation: {
    code: "button_press_not_undone",
    message:
      "A button press is not undone: writing the earlier value back would press it again.",
  },
};

export const NATIVE_VALUE_KINDS = {
  characteristic_value: {
    command: true,
    restoration: (contract, baseline) =>
      contract?.type === BUTTON_PRESS_TYPE
        ? BUTTON_PRESS_RESTORATION
        : scalarValueRestoration(contract, baseline),
    knownSetting: (change) =>
      isKnownCharacteristicSetting(change.contract?.type),
    inspect: inspectCharacteristicValue,
    prepare: prepareCharacteristicValue,
    read: readCharacteristicValueState,
    write: (service, change, value) =>
      service.client.updateCharacteristic({
        ...change.target,
        value: nativeScalarValue(value),
      }),
  },
  characteristic_option: {
    optionKey: true,
    restoration: scalarValueRestoration,
    knownSetting: () => true,
    async inspect(service, input) {
      const target = parseCharacteristicRef(
        input.target_ref,
        service.hubSerial,
      );
      const option = await readCharacteristicOption(
        service.client,
        target,
        input.option_key,
      );
      return {
        fields: { option_key: input.option_key, target },
        ...characteristicOptionState(option),
      };
    },
    async read(service, change, { requireWrite = false } = {}) {
      const option = await readCharacteristicOption(
        service.client,
        change.target,
        change.option_key,
      );
      return boundOptionState(
        change,
        characteristicOptionState(option, { requireWrite }),
        "characteristic",
      );
    },
    write: (service, change, value) =>
      service.client.setCharacteristicOption({
        ...change.target,
        key: change.option_key,
        value: nativeScalarValue(value),
      }),
  },
  window_option: {
    optionKey: true,
    restoration: scalarValueRestoration,
    knownSetting: () => true,
    inspect: inspectWindowOption,
    prepare: prepareWindowOption,
    async read(service, change, { requireWrite = false } = {}) {
      if (change.owner_kind === "scenario") {
        return readScenarioOwnedOption(service, change, { requireWrite });
      }
      const option = await readWindowOption(
        service.client,
        change.target,
        change.option_key,
      );
      return boundOptionState(
        change,
        windowOptionState(option, { requireWrite }),
        "window",
      );
    },
    // The guard reads the bridges anyway; a bridge started or stopped since
    // prepare is told as it is now, and the record saved before the write
    // keeps that.
    async beforeWrite(service, change) {
      const bridge = await refuseBridgeExportWrite(
        service,
        change.target.windowKey,
        change.option_key,
      );
      if (change.bridge_export && bridge?.extension) {
        const { limitation: _, ...rest } = change.bridge_export;
        change.bridge_export = bridgeExportState(rest, bridge.extension);
      }
    },
    write(service, change, value) {
      assertWindowOptionWritable(change.target.windowKey);
      return service.client.updateWindowOption({
        ...change.target,
        key: change.option_key,
        value: nativeScalarValue(value),
      });
    },
    ownerConflict: scenarioWindowOwnerConflict,
    limitations: windowOptionLimitations,
    notes: ({ fields }) =>
      fields.bridge_export ? { bridge_export: fields.bridge_export } : {},
  },
  logic_active: {
    restoration: scalarValueRestoration,
    knownSetting: () => false,
    async contract(service, input) {
      const target = parseLogicRef(input.target_ref, service.hubSerial);
      if (!(await service.client.getLogic(target))) throw logicNotFound();
      return { contract: logicActiveContract() };
    },
    async inspect(service, input) {
      const target = parseLogicRef(input.target_ref, service.hubSerial);
      return {
        fields: { target },
        ...(await readLogicActive(service.client, target)),
      };
    },
    read: (service, change) => readLogicActive(service.client, change.target),
    write: (service, change, value) =>
      service.client.updateLogicActive({
        ...change.target,
        active: value.value,
      }),
  },
  logic_option: {
    optionKey: true,
    restoration: scalarValueRestoration,
    knownSetting: () => true,
    async inspect(service, input) {
      const target = parseLogicRef(input.target_ref, service.hubSerial);
      const option = await readLogicOption(
        service.client,
        target,
        input.option_key,
      );
      return {
        fields: { target, option_key: input.option_key },
        ...logicOptionState(option),
      };
    },
    async read(service, change, { requireWrite = false } = {}) {
      const option = await readLogicOption(
        service.client,
        change.target,
        change.option_key,
      );
      return boundOptionState(
        change,
        logicOptionState(option, { requireWrite }),
        "logic",
      );
    },
    write: (service, change, value) =>
      service.client.setLogicOption({
        ...change.target,
        key: change.option_key,
        value: nativeScalarValue(value),
      }),
  },
  scenario_active: {
    restoration: scalarValueRestoration,
    knownSetting: () => false,
    async inspect(service, input) {
      const target = parseScenarioRef(input.target_ref, service.hubSerial);
      const {
        windowKey: _windowKey,
        name,
        ...state
      } = await readScenarioActive(service.client, target, {
        beforeChangeRef: input.target_ref,
      });
      return {
        fields: {
          target,
          ...(typeof name === "string" ? { target_name: name } : {}),
        },
        ...state,
      };
    },
    // The write goes to the options window this read found, so a change
    // journaled before the window path gets it on its first read too.
    async read(service, change, { requireWrite = false } = {}) {
      const {
        windowKey,
        name: _name,
        ...state
      } = await readScenarioActive(service.client, change.target, {
        requireWrite,
      });
      change.options_window_key = windowKey;
      return state;
    },
    // SprutHub 3.0.0 acknowledged scenario.update {active} and kept the flag
    // (owner hub, 2026-09-24); the official web client switches a scenario
    // only through the Active option of its options window. Only that option
    // is sent, so data, metadata and other flags stay as they are.
    write(service, change, value) {
      if (typeof change.options_window_key !== "string") {
        throw new Error("scenario_active is written only after a readback.");
      }
      return service.client.updateWindowOption({
        windowKey: change.options_window_key,
        key: "Active",
        value: nativeScalarValue(value),
      });
    },
    limitations: () => [
      "The flag is written as the Active option of the scenario's options window, as the SprutHub web client does, and confirmed only when scenario.get and that window both show it. A change recorded while this operation sent scenario.update is settled by the same readback, and a retry uses the window.",
    ],
  },
  room_name: {
    restoration: scalarValueRestoration,
    knownSetting: () => false,
    inspect: inspectRoomName,
    prepare: prepareRoomName,
    // A change prepared by an earlier version may carry a name the hub
    // would not keep.
    recheck: (change) => roomNameWithinLimit(change.requested_value.value),
    read: (service, change) => readRoomName(service.client, change.target),
    write: (service, change, value) =>
      service.client.renameRoom(change.target.id, value.value),
    limitations: nativeNameLimitations,
  },
  service_name: {
    restoration: scalarValueRestoration,
    knownSetting: () => false,
    inspect: (service, input) =>
      inspectService(service, input, readServiceName),
    prepare: async (service, input) =>
      nativeNameDraft(
        await inspectService(service, input, readServiceName),
        input.value,
        "service_name",
      ),
    read: (service, change) => readServiceName(service.client, change.target),
    write: (service, change, value) =>
      service.client.updateService(change.target, { name: value.value }),
    limitations: nativeNameLimitations,
  },
  service_visible: {
    restoration: scalarValueRestoration,
    knownSetting: () => false,
    inspect: (service, input) =>
      inspectService(service, input, readServiceVisible),
    read: (service, change) =>
      readServiceVisible(service.client, change.target),
    write: (service, change, value) =>
      service.client.updateService(change.target, { visible: value.value }),
  },
  // SprutHub's own notification on a change of one characteristic; on the
  // C_Online characteristic of a device's information service, on the
  // device going offline or online.
  characteristic_notify: {
    restoration: scalarValueRestoration,
    knownSetting: () => false,
    async inspect(service, input) {
      const target = parseCharacteristicRef(
        input.target_ref,
        service.hubSerial,
      );
      const setting = await readCharacteristicNotify(service.client, target);
      return {
        fields: { target },
        ...setting,
        // Kept with a prepared change, as read at preparation.
        extra: {
          notification_services: await characteristicNotificationServices(
            service.client,
          ),
        },
      };
    },
    read: (service, change) =>
      readCharacteristicNotify(service.client, change.target),
    write: (service, change, value) =>
      service.client.updateCharacteristicNotify({
        ...change.target,
        notify: value.value,
      }),
    limitations: characteristicNotifyLimitations,
    // What a contract or an already_desired answer says of the setting, as
    // a prepared change does: setting it on is not a message delivered.
    notes: (state) => ({
      notification_services: state.extra.notification_services,
      limitations: characteristicNotifyLimitations(),
    }),
  },
};

export function characteristicNotifyLimitations() {
  return [
    "This is SprutHub's own per-characteristic notification setting, written with characteristic.update {notify} as the web client's Notifications screen writes it. Only the device read (accessory.get) reports it; baseline, readback and restore use that read, so a restore writes back the value read before the change, on for a notification that was on, such as a new virtual accessory's C_Online.",
    "Through which notification services and to which recipients SprutHub sends these notifications was not observed: notification_services shows the home's services as read, with a warning for each that may deliver nothing. Tell the owner the setting is on, not that a message will arrive.",
    "The setting has no value condition: SprutHub notifies on each change of the characteristic, so a door sensor likely notifies on closing as well as on opening (not observed). For one value only, such as «only when the door opens», prepare a BLOCK scenario with a condition on that value and a notify action instead.",
  ];
}

export function nativeValueKind(kind) {
  return Object.hasOwn(NATIVE_VALUE_KINDS, kind)
    ? NATIVE_VALUE_KINDS[kind]
    : undefined;
}

export const OTHER_NATIVE_CHANGE_KINDS = new Set([
  "logic_assignment",
  "accessory_placement",
  "room_create",
  "virtual_light_group",
  "virtual_device",
  "virtual_device_delete",
  // The lamps of an existing group (light-group-members.mjs).
  "light_group_members",
  "block_create",
  "block_data_update",
  "block_action_pause",
  "scenario_run",
  "logic_source_create",
  "logic_source_update",
]);

export function isNativeChange(change) {
  return (
    isNativeValueChange(change) || OTHER_NATIVE_CHANGE_KINDS.has(change?.kind)
  );
}

export async function nativeValueContractFields(service, kind, input) {
  const state = await kind.inspect(service, input);
  const { target } = state.fields;
  // A lamp's level is told as prepare tells it; the accessory is read only
  // for a level command.
  const lampLevel =
    kind.command &&
    LIGHT_LEVEL_TYPES.has(state.contract.type) &&
    lightLevelOnTarget(
      await readTargetAccessory(service, target.aId),
      target,
      state.contract.type,
    );
  const restoration = lampLevel
    ? LAMP_LEVEL_RESTORATION
    : kind.restoration(state.contract, state.value);
  return {
    ...(kind.optionKey ? { option_key: input.option_key } : {}),
    contract: state.contract,
    restore_supported: restoration.supported,
    ...(restoration.limitation
      ? { restore_limitation: restoration.limitation }
      : {}),
    ...(kind.command ? { physical_effect_reversible: false } : {}),
    ...(kind.notes ? kind.notes(state) : {}),
  };
}

export async function nativeValueDraft(service, kind, input) {
  const state = await kind.inspect(service, input);
  return {
    ...state,
    requested: validateCharacteristicValue(input.value, state.contract),
  };
}

export function nativeValueAlreadyDesired(draft) {
  return !draft.alwaysSend && valuesEqual(draft.value, draft.requested);
}

export function isDeviceCommandRejection(error) {
  return (
    error instanceof SprutHubError && !HUB_TRANSPORT_ERROR_CODES.has(error.code)
  );
}

// The accessory of a setting or command, for its name and whether it is a
// lamp; null when the hub refuses the read. A transport failure is thrown.
export async function readTargetAccessory(service, aId) {
  try {
    return await service.client.getAccessory(aId);
  } catch (error) {
    if (!isDeviceCommandRejection(error)) throw error;
    return null;
  }
}

export const LIGHT_LEVEL_TYPES = new Set([
  "Brightness",
  "ColorTemperature",
  "Hue",
  "Saturation",
]);

// With «Связь включения и уровня», which the owner's hub assigns to every
// dimmable lamp, a brightness write switches a lamp that is off on
// (2026-10-13-lamp-logic-undo). So undo never writes a level of a lamp (a
// service with On, lightLevelOnTarget), whether or not the logic is
// assigned to it, and a command's record says so (lamp_level).
export const LAMP_LEVEL_LIMITATION = {
  code: "lamp_level_not_restored",
  message:
    "On the hub's lamps a brightness write switches an off lamp on, so undo puts back only a lamp's on/off, not its brightness or color.",
};

export const LAMP_LEVEL_RESTORATION = {
  supported: false,
  limitation: LAMP_LEVEL_LIMITATION,
};

export function lightLevelOnTarget(accessory, { aId, sId }, type) {
  if (!LIGHT_LEVEL_TYPES.has(type)) return null;
  const on = accessory?.services
    ?.find((entry) => entry.sId === sId)
    ?.characteristics?.find(({ control }) => control?.type === "On");
  return Number.isInteger(on?.cId) ? { aId, sId, cId: on.cId } : null;
}

export function nativeScalarValue(typed) {
  return { [typed.kind]: typed.value };
}

export function boundOptionState(change, state, owner) {
  assertOptionBinding(change, state.contract, owner);
  change.contract = state.contract;
  return state;
}

export async function inspectCharacteristicValue(service, input) {
  if (!input.target_ref) {
    throw new SprutHubError(
      "target_required",
      "Select one characteristic before reading its write contract.",
      "get_entity",
    );
  }
  const target = parseCharacteristicRef(input.target_ref, service.hubSerial);
  const characteristic = await service.client.getCharacteristic(target);
  return {
    fields: { target },
    contract: characteristicContract(characteristic.control),
    value: typedNativeValue(characteristic.control.value),
  };
}

export async function prepareCharacteristicValue(service, input) {
  return characteristicValueDraft(
    service,
    input,
    await inspectCharacteristicValue(service, input),
  );
}

// changes: the journal already read by the caller, else it is read here.
export async function characteristicValueDraft(
  service,
  input,
  { fields, contract, value },
  changes = undefined,
) {
  const requested = validateCharacteristicValue(input.value, contract);
  const virtualGroup = ownedVirtualGroupContext(
    changes ?? (await service.store.list()),
    fields.target,
  );
  return {
    fields,
    contract,
    value,
    requested,
    // A virtual group or a command with unknown semantics is still delivered.
    alwaysSend:
      Boolean(virtualGroup) || !isKnownCharacteristicSetting(contract.type),
    extra: virtualGroup
      ? {
          virtual_group_change_ref: `spruthub-change://native/${virtualGroup.change_id}`,
          group_characteristic_type: virtualGroup.characteristic_type,
          group_member_targets: virtualGroup.members,
        }
      : {},
  };
}

export function ownedVirtualGroupContext(changes, target) {
  const matches = [];
  for (const change of changes) {
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
      "get_native_change",
    );
  }
  return matches[0] ?? null;
}

export async function readCharacteristicValueState(service, change, options) {
  const characteristic = await service.client.getCharacteristic(change.target);
  return characteristicValueState(change, characteristic.control, options);
}

// The value and contract of a recorded characteristic change from a read of
// its control, refused when the characteristic is no longer the one bound.
export function characteristicValueState(
  change,
  control,
  { requireWrite = false } = {},
) {
  // A virtual device's reading or press: written though marked read-only.
  const contract = characteristicContract(
    change.virtual_write === true ? { ...control, write: true } : control,
    { requireWrite },
  );
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
  return { value: typedNativeValue(control.value), contract };
}

export async function readCharacteristicOption(client, target, optionKey) {
  if (typeof optionKey !== "string" || optionKey.length === 0) {
    throw new SprutHubError(
      "option_key_required",
      "Select one characteristic option before reading its write contract.",
      "get_entity",
    );
  }
  const options = await client.getCharacteristicOptions(target);
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
  return matches[0];
}

export async function inspectWindowOption(service, input) {
  const owner = parseWindowOptionOwner(input.target_ref, service.hubSerial);
  if (owner.kind === "scenario") {
    const { scenario, option, windowKey } = await readScenarioMetadataOption(
      service.client,
      owner,
      input.option_key,
      input.target_ref,
    );
    return {
      fields: {
        window_ref: `${configuredHomeRef(service.hubSerial)}/window/${encodeURIComponent(windowKey)}`,
        option_key: input.option_key,
        target: { windowKey },
        owner_kind: "scenario",
        owner_index: owner.index,
        owner_type: scenario.type,
      },
      scenario,
      ...scenarioMetadataState(scenario, option, input.option_key, {
        requireWrite: true,
      }),
    };
  }
  assertWindowOptionWritable(owner.windowKey);
  const bridge =
    typeof input.option_key === "string" && input.option_key.length > 0
      ? await refuseBridgeExportWrite(
          service,
          owner.windowKey,
          input.option_key,
        )
      : null;
  if (bridge?.extension) {
    const { option, bridgeExport, targetName } = await readBridgeExportOption(
      service,
      bridge,
      owner.windowKey,
      input.option_key,
    );
    return {
      fields: {
        option_key: input.option_key,
        target: owner,
        bridge_export: bridgeExport,
        target_name: targetName,
      },
      ...windowOptionState(option),
    };
  }
  const option = await readWindowOption(
    service.client,
    owner,
    input.option_key,
  );
  await rejectDirectScenarioMetadataWindow(service, owner.windowKey, option);
  return {
    fields: { option_key: input.option_key, target: owner },
    ...windowOptionState(option),
  };
}

// A bridge's own settings and its child window's groups are read, not
// written (bridgeExportUnverified): the contract and prepare refuse them,
// and so do apply and restore of a change an earlier version journaled.
// Returns the window's bridge, if any.
export async function refuseBridgeExportWrite(service, windowKey, optionKey) {
  const bridge = await service.client.bridgeExportOptions(
    service.client.selectedSerial(),
    windowKey,
    [optionKey],
    Date.now() + service.client.timeoutMs,
  );
  if (bridge?.withheld.has(optionKey))
    throw bridgeExportUnverified(bridge.next);
  return bridge;
}

// A service's checkbox s:<sId> in a bridge child's window, with what the
// agent tells the owner: which device, service and bridge, and whether the
// bridge runs. A bridge that does not list the accessory has no such
// window, and one that does not export a service has no checkbox for it
// (2026-10-14-bridge-export-write 11-13): both are refused before
// anything is sent.
async function readBridgeExportOption(service, bridge, windowKey, optionKey) {
  const { extension, aId, next } = bridge;
  const serial = service.client.selectedSerial();
  const accessory = await service.client.getAccessory(aId);
  const device = sanitizeNativeData(accessory.name);
  const bridgeName = sanitizeNativeData(extension.name);
  let window;
  try {
    window = await service.client.getWindow(windowKey);
  } catch (error) {
    if (
      !(error instanceof SprutHubError) ||
      error.protocolErrorCode !== -32603
    ) {
      throw error;
    }
    const { children } = await service.client.nativeExtensionChildren(
      serial,
      extension.key,
      Date.now() + service.client.timeoutMs,
    );
    if (children.some(({ id }) => id === String(aId))) throw error;
    throw new SprutHubError(
      "bridge_export_unavailable",
      `${bridgeName} does not list ${device}, so it cannot export it. Nothing was sent.`,
      "get_entity",
      { next },
    );
  }
  const sId = Number(optionKey.slice(2));
  const target = accessory.services?.find((entry) => entry.sId === sId);
  const options = window.options.filter(({ key }) => key === optionKey);
  if (!target || options.length === 0) {
    const named = target ? sanitizeNativeData(target.name) : optionKey;
    throw new SprutHubError(
      "bridge_service_not_exportable",
      `${bridgeName} has no checkbox for ${named} of ${device}: this bridge does not export that service. Nothing was sent.`,
      "get_entity",
      { next },
    );
  }
  if (options.length > 1) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned the selected window option more than once.",
      "get_entity",
    );
  }
  const serviceName = sanitizeNativeData(target.name);
  return {
    option: options[0],
    targetName: `${device} / ${serviceName}`,
    bridgeExport: bridgeExportState(
      {
        device,
        service: serviceName,
        service_ref: serviceRef(serial, aId, sId),
        bridge: bridgeName,
        bridge_ref: extension.ref,
      },
      extension,
    ),
  };
}

// Whether the bridge runs now, and what that means for the assistant.
function bridgeExportState(fields, extension) {
  const running = bridgeRunning(extension);
  return {
    ...fields,
    running,
    ...(running ? {} : { limitation: BRIDGE_NOT_RUNNING }),
  };
}

export async function prepareWindowOption(service, input) {
  const { fields, contract, value, scenario } = await inspectWindowOption(
    service,
    input,
  );
  if (!scenario) {
    return {
      fields,
      contract,
      value,
      requested: validateCharacteristicValue(input.value, contract),
    };
  }
  const spec = SCENARIO_METADATA_OPTIONS[input.option_key];
  if (spec.kind === "stringValue" && typeof input.value !== "string") {
    throw new SprutHubError(
      "invalid_native_value",
      `A scenario's ${input.option_key} takes a string value.`,
      "get_native_change_contract",
    );
  }
  if (input.option_key === "Name")
    requiredNativeName(input.value, "window_option");
  const requestedValue =
    input.option_key === "Desc" && scenario.type === "BLOCK"
      ? nativeScenarioDescription(
          input.value,
          await provenBlockOwnershipMarker(
            service,
            input.target_ref,
            scenario.desc,
          ),
        )
      : input.value;
  return {
    fields,
    contract,
    value,
    requested: validateCharacteristicValue(requestedValue, contract),
  };
}

// A scenario's name, description, start on boot and sequential run, as
// the options of its options window. On SprutHub 3.0.0 these options are
// the only way to change them for a BLOCK and a GLOBAL, and a LOGIC's
// sync: scenario.update {name, desc, onStart, sync} is acknowledged and
// ignored (research/protocol/2026-10-13-wave4-contracts.md 1.3, 1.8,
// 1.10). A LOGIC's code sets its name, description and onStart from info
// on every code write (1.5), so those three are changed in its code
// (logicInfoInCode).
export const SCENARIO_METADATA_OPTIONS = {
  Name: { field: "name", kind: "stringValue" },
  Desc: { field: "desc", kind: "stringValue" },
  OnStart: { field: "onStart", kind: "boolValue" },
  Sync: { field: "sync", kind: "boolValue" },
};

export const SCENARIO_METADATA_TYPES = new Set(["BLOCK", "LOGIC", "GLOBAL"]);

// The current value comes from scenario.get: a LOGIC's window keeps the
// last values written to it and can disagree with the scenario, and a
// built-in's shows placeholders (1.7, 1.11). The window gives the
// contract.
export function scenarioMetadataState(scenario, option, optionKey, options) {
  const { contract } = windowOptionState(option, {
    ...options,
    allowText: true,
  });
  if (contract.kind !== SCENARIO_METADATA_OPTIONS[optionKey].kind) {
    throw scenarioOptionForm(optionKey);
  }
  return {
    value: scenarioOptionValue(scenario, optionKey),
    contract: { ...contract, confirmation: "separate_scenario_get_readback" },
  };
}

// The option's value as the scenario holds it.
export function scenarioOptionValue(scenario, optionKey) {
  const spec = SCENARIO_METADATA_OPTIONS[optionKey];
  const current = scenario[spec.field];
  if (typeof current !== (spec.kind === "boolValue" ? "boolean" : "string")) {
    throw scenarioOptionForm(optionKey);
  }
  return { value: current, kind: spec.kind };
}

export function scenarioOptionForm(optionKey) {
  return new SprutHubError(
    "incompatible_response",
    `SprutHub returned the scenario's ${optionKey} in an unexpected form.`,
    "get_entity",
  );
}

export async function provenBlockOwnershipMarker(service, targetRef, desc) {
  if (typeof desc !== "string") return null;
  const index = parseScenarioRef(targetRef, service.hubSerial).index;
  const homeRef = configuredHomeRef(service.hubSerial);
  for (const change of await service.store.list()) {
    if (
      change.home_ref !== homeRef ||
      change.kind !== "block_create" ||
      change.status === "restored" ||
      // Observed deletion ends marker ownership; a later config conflict does not.
      change.owned_target_absent_observed === true ||
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

export async function readWindowOption(client, target, optionKey) {
  assertWindowOptionWritable(target.windowKey);
  if (typeof optionKey !== "string" || optionKey.length === 0) {
    throw new SprutHubError(
      "option_key_required",
      "Select one window option before reading its write contract.",
      "get_entity",
    );
  }
  const window = await client.getWindow(target.windowKey);
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
  return matches[0];
}

export async function readScenarioMetadataOption(
  client,
  owner,
  optionKey,
  scenarioRef,
) {
  if (!SCENARIO_METADATA_KEYS.has(optionKey)) {
    throw new SprutHubError(
      "unsupported_window_option",
      "A scenario window_option target supports Name, Desc, OnStart (run when the hub starts) and Sync (run actions one after another). Turn a scenario on or off with scenario_active.",
      "get_entity",
    );
  }
  const scenario = await client.getScenario(owner.index);
  if (!scenario) throw scenarioNotFound();
  if (scenario.predefined === true) throw predefinedScenarioReadOnly();
  if (!SCENARIO_METADATA_TYPES.has(scenario.type)) {
    throw new SprutHubError(
      "unsupported_scenario_type",
      `Name, Desc, OnStart and Sync are changed for BLOCK and GLOBAL scenarios, and Sync for a LOGIC; this one is ${String(scenario.type)}.`,
      "get_entity",
    );
  }
  if (scenario.type === "LOGIC" && optionKey !== "Sync") {
    throw logicInfoInCode(scenarioRef, optionKey, scenario);
  }
  if (
    typeof scenario.optionsWindow !== "string" ||
    scenario.optionsWindow.length === 0
  ) {
    throw new SprutHubError(
      "options_window_unavailable",
      "This scenario has no native options window, the only place SprutHub changes its name, description and flags.",
      "get_entity",
    );
  }
  const option = await readWindowOption(
    client,
    { windowKey: scenario.optionsWindow },
    optionKey,
  );
  return { scenario, option, windowKey: scenario.optionsWindow };
}

export function predefinedScenarioReadOnly() {
  return new SprutHubError(
    "predefined_scenario_read_only",
    "This is a built-in SprutHub scenario: its name and flags come from SprutHub's own code and its options window shows placeholders, so it is not changed here and nothing was sent. The owner can change it in the SprutHub app.",
    "get_entity",
  );
}

// A change prepared on the scenario ref reads its value from scenario.get
// (scenarioMetadataState) and the contract from the window.
export async function readScenarioOwnedOption(
  service,
  change,
  { requireWrite },
) {
  const scenario = await service.client.getScenario(change.owner_index);
  if (!scenario) throw scenarioNotFound();
  const option = await readWindowOption(
    service.client,
    change.target,
    change.option_key,
  );
  return boundOptionState(
    change,
    scenarioMetadataState(scenario, option, change.option_key, {
      requireWrite,
    }),
    "window",
  );
}

export async function rejectDirectScenarioMetadataWindow(
  service,
  windowKey,
  option,
) {
  if (option.key === "Active") {
    // window_option confirms only the window, not scenario.get.
    const owners = (await service.client.listScenarios()).filter(
      (scenario) => scenario.optionsWindow === windowKey,
    );
    if (owners.length === 0) return;
    throw scenarioActiveOwnerRequired(
      owners.length === 1
        ? `${configuredHomeRef(service.hubSerial)}/scenario/${encodeURIComponent(owners[0].index)}`
        : undefined,
    );
  }
  if (!SCENARIO_METADATA_KEYS.has(option.key)) return;
  // The window shows a LOGIC's stale values, and its code sets them back.
  const matches = (await service.client.listScenarios()).filter(
    (scenario) => scenario.optionsWindow === windowKey,
  );
  if (matches.length !== 1) return;
  // Answered as on its scenario ref (readScenarioMetadataOption).
  if (matches[0].predefined === true) throw predefinedScenarioReadOnly();
  const scenarioRef = `${configuredHomeRef(service.hubSerial)}/scenario/${encodeURIComponent(matches[0].index)}`;
  if (matches[0].type === "LOGIC" && option.key !== "Sync") {
    // The list carries no code; the scenario read does.
    throw logicInfoInCode(
      scenarioRef,
      option.key,
      await service.client.getScenario(matches[0].index),
    );
  }
  throw scenarioOwnerRequired(scenarioRef, option.key);
}

// The scenario at the index is still the one prepared: same type, not
// built-in, same options window. A record from before LOGIC and GLOBAL
// were supported has no owner_type and was a BLOCK.
export async function scenarioWindowOwnerConflict(service, change) {
  if (change.owner_kind !== "scenario") return undefined;
  const scenario = await service.client.getScenario(change.owner_index);
  return !scenario ||
    scenario.type !== (change.owner_type ?? "BLOCK") ||
    scenario.predefined === true ||
    scenario.optionsWindow !== change.target.windowKey
    ? "owner_window_changed"
    : undefined;
}

export function windowOptionLimitations(change) {
  if (change.bridge_export) {
    return [
      "Window readback confirms the export SprutHub stored; what the assistant's app shows is not observed from the hub.",
    ];
  }
  if (change.owner_kind !== "scenario") {
    return [
      "Window readback confirms the setting stored by SprutHub; delivery to the device and behavior after a physical power cycle remain unverified.",
    ];
  }
  return [
    "Written to the scenario's options window, as the SprutHub app does, and confirmed with scenario.get; scenario.update does not change a name, description or flag.",
    "This option is written apart from the scenario's other options and its data or code: each is its own change, they can be prepared on the same scenario and restored in any order. A later change of this option by the agent is restored first (later_owned_change names it).",
    "A completed restore stays closed: get may refresh the current value or a read error, but apply and restore of this change do not write again. A change by hand once observed still blocks restore even if the value later matches. A proven apply is not resent.",
    ...(change.owner_type === undefined || change.owner_type === "BLOCK"
      ? [
          "A proven create marker in a BLOCK's Desc is kept by the adapter only while that create still owns the current scenario; it is not copied from a restored or deleted owner and does not restore create-delete rights.",
        ]
      : []),
  ];
}

export async function readLogicOption(client, target, optionKey) {
  if (typeof optionKey !== "string" || optionKey.length === 0) {
    throw new SprutHubError(
      "option_key_required",
      "Select one logic option before reading its write contract.",
      "get_entity",
    );
  }
  const logic = await client.getLogic(target);
  if (!logic) throw logicNotFound();
  const options = await client.getLogicOptions(target);
  const matches = options.filter(({ key }) => key === optionKey);
  if (matches.length !== 1) {
    throw new SprutHubError(
      matches.length === 0 ? "logic_option_not_found" : "incompatible_response",
      matches.length === 0
        ? "The selected logic option was not found."
        : "SprutHub returned the selected logic option more than once.",
      "get_entity",
    );
  }
  return matches[0];
}

export async function readLogicActive(client, target) {
  const logic = await client.getLogic(target);
  if (!logic) throw logicNotFound();
  return { value: logicActiveValue(logic), contract: logicActiveContract() };
}

// beforeChangeRef is the scenario ref of a contract or prepare read: no change
// exists yet, so a mismatch points to that scenario instead of the change.
export async function readScenarioActive(
  client,
  target,
  { requireWrite = true, beforeChangeRef } = {},
) {
  const scenario = await client.getScenario(target.index);
  if (!scenario) throw scenarioNotFound();
  if (typeof scenario.active !== "boolean") {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub returned a scenario without an explicit active state.",
      "get_entity",
    );
  }
  if (
    typeof scenario.optionsWindow !== "string" ||
    scenario.optionsWindow.length === 0
  ) {
    throw new SprutHubError(
      "options_window_unavailable",
      "SprutHub returned no options window for this scenario. A scenario is turned on or off only through the Active option of that window, so nothing was sent; the owner can switch it in the SprutHub app.",
      "get_entity",
    );
  }
  const window = await client.getWindow(scenario.optionsWindow);
  const options = window.options.filter(({ key }) => key === "Active");
  if (options.length !== 1) {
    throw new SprutHubError(
      options.length === 0
        ? "window_option_not_found"
        : "incompatible_response",
      options.length === 0
        ? "The scenario's options window has no Active option, so this scenario cannot be turned on or off here; nothing was sent. The owner can switch it in the SprutHub app."
        : "SprutHub returned the Active option of this scenario more than once.",
      "get_entity",
    );
  }
  const option = windowOptionState(options[0], { requireWrite });
  if (option.contract.kind !== "boolValue") {
    throw new SprutHubError(
      "incompatible_response",
      "The Active option of this scenario is not an on/off setting.",
      "get_entity",
    );
  }
  if (option.value.value !== scenario.active) {
    const unknown = `SprutHub reports active=${scenario.active} in scenario.get but Active=${option.value.value} in the scenario's options window, so whether the scenario is on is unknown.`;
    throw beforeChangeRef === undefined
      ? new SprutHubError(
          "scenario_active_mismatch",
          `${unknown} Read the change again later; nothing more is sent until both agree.`,
          "get_native_change",
        )
      : new SprutHubError(
          "scenario_active_mismatch",
          `${unknown} Nothing was prepared or sent; read the scenario again later and prepare once both agree.`,
          "get_entity",
          {
            next: {
              tool: "get_entity",
              arguments: { entity_ref: beforeChangeRef },
            },
          },
        );
  }
  return {
    value: { value: scenario.active, kind: "boolValue" },
    contract: {
      type: "ScenarioActive",
      kind: "boolValue",
      write:
        'window.update({windowKey: scenario.optionsWindow, options: [{key: "Active", value: {boolValue}}]})',
      confirmation: "separate_scenario_get_and_window_get_readback",
    },
    windowKey: scenario.optionsWindow,
    name: scenario.name,
  };
}

export function nativeNameDraft(state, value, operation) {
  const name = requiredNativeName(value, operation).trim();
  return {
    ...state,
    requested: validateCharacteristicValue(name, state.contract),
  };
}

// knownSetting stays false for names: SprutHub may store a normalized name,
// and that readback must not look like the owner's edit.
export function nativeNameLimitations(change) {
  return [
    `SprutHub may store a different name than requested. Such a readback stays uncertain, not a manual change, and this change does not write the name again; to set it again, prepare a new ${change.kind} change from the stored name.`,
  ];
}

export function nativeNameContract(type, confirmation) {
  return { type, kind: "stringValue", min_length: 1, confirmation };
}

export async function inspectRoomName(service, input) {
  const target = { id: parseRoomRef(input.target_ref, service.hubSerial) };
  return {
    fields: { target },
    ...(await readRoomName(service.client, target)),
  };
}

export async function prepareRoomName(service, input) {
  const draft = nativeNameDraft(
    await inspectRoomName(service, input),
    roomNameWithinLimit(requiredNativeName(input.value, "room_name").trim()),
    "room_name",
  );
  if (valuesEqual(draft.value, draft.requested)) return draft;
  // SprutHub's rule for two rooms with one name is unknown, so a namesake is
  // reported for the user to decide instead of being refused or ignored.
  const namesakes = (await service.client.listRooms()).rooms.filter(
    ({ name }) => name === draft.requested.value,
  );
  if (namesakes.length === 0) return draft;
  return {
    ...draft,
    extra: {
      warnings: [
        {
          code: "room_name_in_use",
          message: "Another room in this home already has this exact name.",
          room_refs: namesakes.map(({ ref }) => ref),
        },
      ],
    },
  };
}

export async function readRoomName(client, target) {
  const room = await client.getRoom(target.id);
  if (!room) {
    throw new SprutHubError(
      "room_not_found",
      "The selected room was not found.",
      "home_overview",
    );
  }
  return {
    value: { value: room.name, kind: "stringValue" },
    contract: {
      ...nativeNameContract("RoomName", "separate_room_get_readback"),
      ...roomNameLimits(),
    },
  };
}

// A name the hub would not keep whole is refused before any write instead
// of being cut or stripped.
export function roomNameWithinLimit(name) {
  return nameWithinLimit(name, "a room name", ROOM_NAME_MAX_LENGTH);
}

// what: "a room name", "a device name"; both are kept to their first 32
// characters (2026-09-24-live-conformance-3, 2026-10-23-virtual-devices).
// Only a room name was seen losing an emoji; a device name is held to the
// same rule, as its creation is found again by its exact name.
export function nameWithinLimit(name, what, maxLength) {
  const characters = [...name];
  const unsupported = [
    ...new Set(
      characters.filter(
        (character) =>
          character.codePointAt(0) > 0xffff ||
          ROOM_NAME_REFUSED_CHARACTER.test(character),
      ),
    ),
  ];
  if (unsupported.length > 0) {
    throw new SprutHubError(
      "name_characters_unsupported",
      `This name has ${unsupported.map(characterLabel).join(", ")}. SprutHub dropped an emoji from a room name; in ${what} emoji, pictographs, variation selectors and other characters outside the Basic Multilingual Plane are refused as a precaution. Nothing was written; ask the owner for a name without ${unsupported.length === 1 ? "it" : "them"}.`,
      "prepare_native_change",
      { unsupported_characters: unsupported },
    );
  }
  if (characters.length <= maxLength) return name;
  throw new SprutHubError(
    "name_too_long",
    `This name has ${characters.length} characters, and SprutHub keeps only the first ${maxLength} characters of ${what}. Nothing was written; ask the owner for a name of at most ${maxLength} characters.`,
    "prepare_native_change",
    { max_length: maxLength, name_length: characters.length },
  );
}

// A variation selector is invisible, so it is named by its code point only.
export function characterLabel(character) {
  const code = `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  return /[\uFE00-\uFE0F]/u.test(character)
    ? `${code} (variation selector)`
    : `${character} (${code})`;
}

export async function inspectService(service, input, read) {
  const target = parseServiceRef(input.target_ref, service.hubSerial);
  return { fields: { target }, ...(await read(service.client, target)) };
}

export async function readService(client, target) {
  const accessory = await client.getAccessoryOrNull(target.aId);
  const service = accessory?.services?.find(({ sId }) => sId === target.sId);
  if (!service) {
    throw new SprutHubError(
      "service_not_found",
      "The selected service was not found on its accessory.",
      "get_entity",
    );
  }
  return service;
}

export async function readServiceName(client, target) {
  const { name } = await readService(client, target);
  return {
    value: { value: name, kind: "stringValue" },
    contract: nativeNameContract(
      "ServiceName",
      "separate_accessory_get_readback",
    ),
  };
}

export async function readServiceVisible(client, target) {
  const { visible } = await readService(client, target);
  // An omitted flag is unknown, not hidden: a guessed baseline could write
  // or restore a visibility the service never had.
  if (typeof visible !== "boolean") {
    throw new SprutHubError(
      "service_visibility_unknown",
      "SprutHub did not report whether this service is visible, so it cannot be hidden, shown or restored safely.",
    );
  }
  return {
    value: { value: visible, kind: "boolValue" },
    contract: {
      type: "ServiceVisible",
      kind: "boolValue",
      confirmation: "separate_accessory_get_readback",
    },
  };
}

// Read from accessory.get, the only read that reports notify
// (2026-10-12-notifications-live); the service type decides whether a
// notification is offered.
export async function readCharacteristicNotify(client, target) {
  const accessory = await client.getAccessoryOrNull(target.aId);
  const service = accessory?.services?.find(({ sId }) => sId === target.sId);
  const characteristic = service?.characteristics?.find(
    ({ cId }) => cId === target.cId,
  );
  if (!characteristic?.control) {
    throw new SprutHubError(
      "characteristic_not_found",
      "The selected characteristic was not found on its accessory.",
      "get_entity",
    );
  }
  // A notification carries the characteristic's value.
  if (isSensitiveNativeNode(characteristic.control)) {
    throw new SprutHubError(
      "sensitive_native_data",
      "The selected characteristic holds sensitive data, which a notification would send; its notification is not changed here.",
      "get_entity",
    );
  }
  if (!characteristicNotifyOffered(service, characteristic)) {
    throw new SprutHubError(
      "notification_not_offered",
      "SprutHub offers a notification for the device's online state (the C_Online characteristic of its information service) and for the characteristics of its other services, not for a name, other device information, extended information or a camera stream. Pick such a characteristic from get_entity: it carries notify.",
      "get_entity",
    );
  }
  const notify = characteristicNotifyOn(characteristic);
  if (notify === null) {
    throw new SprutHubError(
      "incompatible_response",
      "SprutHub reported this characteristic's notification setting in an unknown form, so it cannot be changed or restored safely.",
    );
  }
  return {
    value: { value: notify, kind: "boolValue" },
    contract: {
      type: "CharacteristicNotify",
      kind: "boolValue",
      confirmation: "separate_accessory_get_readback",
    },
  };
}

export function isNativeValueChange(change) {
  return nativeValueKind(change?.kind) !== undefined;
}

export function nativeValueProvenApply(change) {
  // Proven apply follows observed write-back, not the current lifecycle status.
  return change.applied_value_observed === true;
}

export function nativeValueLifecycle(change) {
  // Closed restore and observed loss of write rights outrank proof and value match.
  if (change.status === "restored") return { phase: "restore_completed" };
  if (
    manualValueChangeObserved(change) ||
    (change.status === "not_owned" && change.native_write_sent === true)
  ) {
    return { phase: "right_lost" };
  }
  if (nativeValueIntentEvidence(change).unresolved) {
    return {
      phase: "unresolved_intent",
      direction: nativeIntentDirection(change),
    };
  }
  if (nativeValueProvenApply(change)) return { phase: "apply_proven" };
  return { phase: "apply_unproven" };
}

// One setting a value change writes: the same kind on the same target (and
// option key).
export function valueTargetKey(change) {
  return `${change.kind}|${stableJson(change.target ?? null)}|${change.option_key ?? ""}`;
}

// A sent change that may still hold its target: not undone, refused,
// replaced or found not applied. A lamp's On switched by the call's level
// (caused_by_change_id) holds it as the call's commands do.
export function changeStillInEffect(change) {
  return (
    (change.native_write_sent === true ||
      change.caused_by_change_id !== undefined) &&
    ![
      "prepared",
      "not_applied",
      "not_owned",
      "restored",
      "superseded",
      "completed",
    ].includes(change.status)
  );
}

export function isKnownCharacteristicSetting(type) {
  return STATEFUL_CHARACTERISTIC_SETTING_TYPES.has(type);
}

export function isRetryableNativeValueChange(change) {
  const kind = nativeValueKind(change?.kind);
  return kind !== undefined && !kind.command;
}

export function hasKnownSettingSemantics(change) {
  return nativeValueKind(change?.kind)?.knownSetting(change) === true;
}

export function nativeValueRestoration(change) {
  const kind = nativeValueKind(change?.kind);
  if (!kind) return { supported: false };
  return kind.restoration(change.contract, change.baseline_value);
}

export function scalarValueRestoration(contract, baseline) {
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

export function freshVerification(result) {
  return {
    fresh: true,
    checked_at: new Date().toISOString(),
    result,
  };
}

export function failedVerification(error) {
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

export function savedVerification(verification) {
  return verification
    ? { ...structuredClone(verification), fresh: false }
    : { fresh: false, checked_at: null };
}

export function nativeIntentDirection(change) {
  return (
    change.write_intent?.direction ??
    (change.status === "restoring" ? "restore" : "apply")
  );
}

// A restore after a write whose outcome was unknown (its answer lost, the
// server stopped before the journal held it, or the hub acknowledged it
// without the result) is decided by the fresh read that settled that
// write: it goes on to send only while the read shows the change in place,
// an apply that took effect after all (expected_observed) or a restore
// that did not (expected_missing). Back as before, changed since or not
// read, the settled answer stands.
export function restoreGoesOn({ direction, outcome }) {
  return direction === "apply"
    ? outcome === "expected_observed"
    : outcome === "expected_missing";
}

// A setting goes on as restoreGoesOn says. A device command's undo is not
// sent again by itself, as its first write may still be on its way; its
// item offers the resend instead (restoreResendNext).
export function valueRestoreGoesOn(change, pending) {
  return (
    restoreGoesOn(pending) &&
    (pending.direction === "apply" || isRetryableNativeValueChange(change))
  );
}

// The answer to a restore whose read shows it did not take effect: the
// next restore_native_change reads first and sends only while the agent's
// change is still in place.
export function withRestoreAgainNext(result, change) {
  return {
    ...result,
    next: {
      tool: "restore_native_change",
      arguments: { change_ref: `spruthub-change://native/${change.id}` },
    },
  };
}

// A sent write of this change whose outcome its journal does not hold yet.
export function writeOutcomeUnknown(change) {
  return isNativeValueChange(change)
    ? nativeValueLifecycle(change).phase === "unresolved_intent"
    : ["applying", "restoring", "uncertain"].includes(change.status);
}

// An unknown write no longer hidden by the agent's later change
// (finishHiddenByLaterChange), or whose read failed, does not name it any
// more.
export function withoutLaterChange(change) {
  return change.conflict_reason === "later_owned_change"
    ? { conflict_reason: undefined, restore_first_change_id: undefined }
    : {};
}

export function nativeValueIntentEvidence(change) {
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
  if (intent.direction === "apply" && nativeValueProvenApply(change)) {
    return { outcome: "requested_value_observed", unresolved: false };
  }
  if (intent.direction === "restore" && change.status === "restored") {
    return { outcome: "baseline_value_observed", unresolved: false };
  }
  return { outcome: "resolved", unresolved: false };
}

export function manualValueChangeObserved(change) {
  return (
    change?.manual_change_observed === true ||
    ["manual_change", "value_changed_after_apply"].includes(
      change?.conflict_reason,
    ) ||
    legacyManualValueChangeObserved(change)
  );
}

export function legacyManualValueChangeObserved(change) {
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

export function nativeScenarioDescription(userDescription, provenMarker) {
  if (typeof provenMarker !== "string") return userDescription;
  const token = `[${provenMarker}]`;
  const userText = userDescription
    .split(token)
    .join("")
    .replace(/^\n+|\n+$/gu, "");
  if (userText.length === 0) return token;
  return `${userText}\n\n${token}`;
}
