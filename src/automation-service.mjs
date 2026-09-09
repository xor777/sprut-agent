import { AutomationStore } from "./automation-store.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export class AutomationService {
  constructor({ client, stateDirectory, hubUrl, hubSerial }) {
    this.client = client;
    this.store = new AutomationStore({
      directory: stateDirectory,
      hubUrl,
      hubSerial,
    });
  }

  async previewBooleanAutomation(input) {
    const source = parseCharacteristicRef(input.source_characteristic_ref);
    const target = parseCharacteristicRef(input.target_characteristic_ref);
    const sourceRoomId = parseRoomRef(input.source_room_ref);
    const targetRoomId = parseRoomRef(input.target_room_ref);
    const context = await this.client.inspectAutomation({
      source: { ...source, roomId: sourceRoomId },
      target: { ...target, roomId: targetRoomId },
    });
    const condition = selectCharacteristic(
      context.source,
      source,
      input.source_value,
      false,
    );
    const action = selectCharacteristic(
      context.target,
      target,
      input.target_value,
      true,
    );
    const nativeData = buildNativeData(condition, action);
    const id = this.store.newId();
    const now = new Date().toISOString();
    const change = {
      id,
      status: "prepared",
      name: input.name,
      reason: input.reason,
      marker: `sprut-agent:automation:${id}`,
      created_at: now,
      updated_at: now,
      condition,
      action,
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
      native_shape: {
        mechanism: "BLOCK",
        active: true,
        on_start: false,
        sync: false,
        else_actions: [],
      },
      context: normalizeContext(context),
      limitations: [
        "Preview does not change the hub and is not an atomic reservation.",
        "An empty direct scenario list does not rule out dependencies inside arbitrary code or bridges.",
        "The rule turns the target on; it does not turn it off automatically.",
      ],
    };
  }
}

function parseRoomRef(ref) {
  const match = /^spruthub:\/\/room\/(\d+)$/.exec(ref);
  if (!match) {
    throw new SprutHubError(
      "invalid_room_ref",
      "Use a room reference returned by list_rooms.",
      "list_rooms",
    );
  }
  return Number(match[1]);
}

function parseCharacteristicRef(ref) {
  const match =
    /^spruthub:\/\/accessory\/(\d+)\/service\/(\d+)\/characteristic\/(\d+)$/.exec(
      ref,
    );
  if (!match) {
    throw new SprutHubError(
      "invalid_characteristic_ref",
      "Use a characteristic reference returned by read_room.",
      "read_room",
    );
  }
  return {
    aId: Number(match[1]),
    sId: Number(match[2]),
    cId: Number(match[3]),
  };
}

function selectCharacteristic(selection, ref, value, requireWrite) {
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
      "read_room",
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
      ref: `spruthub://room/${selection.room.id}`,
      name: selection.room.name,
    },
    device: {
      ref: `spruthub://accessory/${accessory.id}`,
      name: accessory.name,
    },
    service: {
      ref: `spruthub://accessory/${accessory.id}/service/${service.sId}`,
      name: service.name,
      type: service.type,
    },
    characteristic: {
      ref: `spruthub://accessory/${accessory.id}/service/${service.sId}/characteristic/${characteristic.cId}`,
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

function buildNativeData(condition, action) {
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
        ],
        else: [],
        then_delay: 0,
        else_delay: 0,
        mode: "EVERY",
      },
    ],
  };
}

function normalizeContext(context) {
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
    source: normalizeSelectionContext(context.source),
    target: normalizeSelectionContext(context.target),
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

function normalizeSelectionContext(selection) {
  return {
    direct_scenarios: selection.directScenarios,
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
