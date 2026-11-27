// Virtual switches, buttons and sensors the owner asks for: virtual_device
// creates one in a room, virtual_device_delete deletes one. What the hub
// does with them was observed on the owner's hub, 3.0.0
// (research/protocol/2026-10-23-virtual-devices.md).
import { CODE_DEPENDENCY_NOTE } from "./code-device-refs.mjs";
import { nameWithinLimit } from "./native-values.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export { CODE_DEPENDENCY_NOTE };

export const VIRTUAL_DEVICE = "virtual_device";
export const VIRTUAL_DEVICE_DELETE = "virtual_device_delete";

// Common service types offered as examples in the contract. Creation checks
// the hub's live non-system service.types list instead of a fixed allowlist.
export const VIRTUAL_DEVICE_TYPES = [
  "Switch",
  "Outlet",
  "Lightbulb",
  "Thermostat",
  "HeaterCooler",
  "Fan",
  "WindowCovering",
  "AirPurifier",
  "SecuritySystem",
  "StatelessProgrammableSwitch",
  "ContactSensor",
  "MotionSensor",
  "LeakSensor",
  "OccupancySensor",
  "TemperatureSensor",
  "HumiditySensor",
  "SmokeSensor",
  "LightSensor",
  "CarbonDioxideSensor",
  "C_WattMeter",
];

// Hardware/media-stream services and AccessoryInformation cannot work as plain
// virtual services even when listed with system=false.
export const REFUSED_VIRTUAL_DEVICE_TYPES = new Set([
  "AccessoryInformation",
  "CameraRTPStreamManagement",
  "AudioStreamManagement",
  "DataStreamTransportManagement",
  "Microphone",
  "Speaker",
]);

function serviceCharacteristicName(entry) {
  return typeof entry === "string"
    ? entry
    : (entry?.type ?? entry?.shortId ?? null);
}

export function isAllowedVirtualDeviceServiceType(serviceType) {
  return (
    Boolean(serviceType) &&
    typeof serviceType.type === "string" &&
    serviceType.type.length > 0 &&
    serviceType.system !== true &&
    !REFUSED_VIRTUAL_DEVICE_TYPES.has(serviceType.type)
  );
}

// accessory.create kept the first 32 characters of an accessory's and a
// service's name, Latin and Cyrillic alike, without an error (probe, 15).
// A longer name is refused here, so the owner never gets a name cut short.
export const ACCESSORY_NAME_MAX_LENGTH = 32;

// The hub put an accessory sent with a room it lacks into another room
// without an error (probe, 14), so the room is checked before the write.
export function virtualDeviceName(name) {
  return nameWithinLimit(name, "a device name", ACCESSORY_NAME_MAX_LENGTH);
}

export function virtualDeviceServiceType(value, serviceTypes) {
  const supportedTypes = serviceTypes
    .filter(isAllowedVirtualDeviceServiceType)
    .map(({ type }) => type);
  const matched =
    typeof value === "string"
      ? serviceTypes.find(({ type }) => type === value)
      : undefined;
  if (!isAllowedVirtualDeviceServiceType(matched)) {
    const message =
      matched !== undefined
        ? `Service type "${matched.type}" cannot be created as a virtual device (system or hardware/media-stream service). Choose a non-system type from supported_types.`
        : `value must be a supported non-system service type from SprutHub's service.types catalog (supported_types).`;
    throw new SprutHubError(
      "unsupported_virtual_device_type",
      message,
      "get_native_change_contract",
      { supported_types: supportedTypes },
    );
  }
  return matched;
}

export function virtualDeviceOptionalCharacteristics(types, serviceType) {
  if (types === undefined) return [];
  const required = new Set(
    (serviceType.required ?? [])
      .map(serviceCharacteristicName)
      .filter((name) => typeof name === "string"),
  );
  const availableOptional = (serviceType.optional ?? [])
    .map(serviceCharacteristicName)
    .filter(
      (name) =>
        typeof name === "string" && name !== "Name" && !required.has(name),
    );
  const availableSet = new Set(availableOptional);
  const listText =
    availableOptional.length > 0 ? availableOptional.join(", ") : "(none)";
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    types.some((item) => typeof item !== "string" || item.length === 0) ||
    new Set(types).size !== types.length
  ) {
    throw new SprutHubError(
      "unsupported_virtual_device_characteristics",
      `characteristic_types must be a non-empty array of unique optional characteristic names for ${serviceType.type}. Available optional characteristics: ${listText}.`,
      "get_native_change_contract",
      { available_optional: availableOptional },
    );
  }
  for (const item of types) {
    if (item === "Name") {
      throw new SprutHubError(
        "unsupported_virtual_device_characteristics",
        `Name is managed automatically by SprutHub and cannot be passed in characteristic_types. Available optional characteristics for ${serviceType.type}: ${listText}.`,
        "get_native_change_contract",
        { available_optional: availableOptional },
      );
    }
    if (required.has(item)) {
      throw new SprutHubError(
        "unsupported_virtual_device_characteristics",
        `${item} is already a required characteristic of ${serviceType.type}; omit it from characteristic_types. Available optional characteristics: ${listText}.`,
        "get_native_change_contract",
        { available_optional: availableOptional },
      );
    }
    if (!availableSet.has(item)) {
      throw new SprutHubError(
        "unsupported_virtual_device_characteristics",
        `${item} is not an optional characteristic of ${serviceType.type}. Available optional characteristics: ${listText}.`,
        "get_native_change_contract",
        { available_optional: availableOptional },
      );
    }
  }
  return [...types];
}

export function notAVirtualDevice() {
  return new SprutHubError(
    "not_a_virtual_device",
    "This is a physical device; virtual_device_delete deletes only virtual devices. Nothing was written.",
    "find_devices",
  );
}

export function virtualDeviceContract(operation) {
  if (operation === VIRTUAL_DEVICE_DELETE) {
    return {
      write: "accessory.delete({id})",
      target: "a virtual accessory's ref; a physical one is refused",
      dependencies:
        "prepare reads what refers to the device: the BLOCK scenarios the hub lists for it, code scenarios that name it (code), its links, bridge exports and logic. With any, the result has tell_owner: name them and apply only after the owner confirms. Scenarios and code stay and no longer reach it; links and exports go with it. " +
        CODE_DEPENDENCY_NOTE,
      restore:
        "creates the device again with the same name, room, service types and optional characteristics: a new id, and the scenarios, links, export and logic are not put back on it (not_restored)",
    };
  }
  return {
    write:
      "accessory.create({name,roomId,services:[{type,name,optional:[...]}]})",
    fields: {
      target_ref: "the home ref",
      room_ref: "an existing room",
      name: {
        min_length: 1,
        max_length: ACCESSORY_NAME_MAX_LENGTH,
        refused_characters:
          "emoji and other characters outside the Basic Multilingual Plane, as in a room name",
        note: "also the name of its service",
      },
      value: {
        service_type:
          "any non-system SprutHub service.types entry (e.g. Switch, Outlet, Lightbulb, Thermostat, HeaterCooler, Fan, WindowCovering, AirPurifier, SecuritySystem, StatelessProgrammableSwitch, sensors, C_WattMeter); system types, AccessoryInformation and media-stream types are refused",
      },
      characteristic_types:
        "optional array of unique optional characteristic names for the chosen service type (excluding Name and already-required characteristics)",
    },
    types:
      "Validated against the hub's live non-system service.types. Pass characteristic_types to include optional controls (e.g. Brightness, Hue, Saturation, ColorTemperature on Lightbulb). StatelessProgrammableSwitch: writing ProgrammableSwitchEvent with send_device_commands is a press (0 single, 1 double, 2 long). Virtual sensor readings are writable with send_device_commands too.",
    duplicate:
      "a virtual device of the same name in the room is named in matching_devices with tell_owner",
    restore:
      "deletes the created device by its id, unchanged since; refused (virtual_device_in_use) while scenarios, code, links, bridge exports or logic are found to refer to it. Code or bridges that could not be read are named (code_unread, bridges_unread) and do not stop it",
  };
}

const LIMITATIONS = {
  [VIRTUAL_DEVICE]: [
    CODE_DEPENDENCY_NOTE,
    "SprutHub answers a creation in 4-9 s; a lost answer leaves the outcome unknown, with the new devices of this name in the room as candidate_devices, never owned or deleted by undo.",
    "New devices appear in each bridge's list as not exported; the bridges' own settings decide nothing here.",
  ],
  [VIRTUAL_DEVICE_DELETE]: [
    "A deleted device's id is gone for good: undo makes a new one, and what referred to the old one stays without it.",
    CODE_DEPENDENCY_NOTE,
  ],
};

export const VIRTUAL_DEVICE_DUPLICATE_NOTE =
  "A virtual device of this name is already in this room (matching_devices). Tell the owner; apply only if they want a second one.";

export const VIRTUAL_DEVICE_DEPENDENCIES_NOTE =
  "Things refer to this device (dependencies). Name them to the owner and apply only after they confirm: its scenarios stay but no longer react to it or act on it, its links, bridge export and logic go, and undo brings back only a new device of the same name and type. Code with found_by accessory_id_list holds its id as a number in a list, which may only coincide.";

// The device's own services: the information service is the hub's.
export function ownServices(accessory) {
  return (accessory.services ?? []).filter(
    ({ type }) => type !== "AccessoryInformation",
  );
}

// SprutHub 3.0.0 auto-attaches hub-default logics to some newly created
// virtual services (e.g. active LightbulbControl on a Lightbulb with
// Brightness). Recording them at creation time lets virtual_device undo
// delete an untouched device while still refusing if default logic was
// changed or another logic was assigned later.
export function defaultServiceLogicEntry(sId, logic) {
  return {
    sId,
    ...(typeof logic.type === "string" && logic.type.length > 0
      ? { type: logic.type }
      : {}),
    name: typeof logic.name === "string" ? logic.name : String(logic.type),
    // Proto3 omits active when false, so normalize explicitly to boolean.
    active: logic.active === true,
  };
}

export function isDefaultServiceLogic(sId, logic, defaults) {
  if (!Array.isArray(defaults) || defaults.length === 0) return false;
  const current = defaultServiceLogicEntry(sId, logic);
  return defaults.some((saved) => {
    if (saved.sId !== current.sId) return false;
    if ((saved.active === true) !== current.active) return false;
    if (saved.type !== undefined || current.type !== undefined) {
      return saved.type === current.type;
    }
    return saved.name === current.name;
  });
}

export function virtualDeviceSnapshot(accessory) {
  return {
    id: accessory.id,
    name: accessory.name,
    room_id: accessory.roomId,
    services: ownServices(accessory).map((service) => ({
      sId: service.sId,
      type: service.type,
      name: service.name,
      characteristic_types: (service.characteristics ?? [])
        .map(({ control }) => control?.type ?? control?.key)
        .filter((type) => typeof type === "string" && type !== "Name"),
    })),
  };
}

// The device at a created device's id is that device as created: virtual,
// with its name, room and services.
export function sameCreatedDevice(accessory, snapshot) {
  const services = (list) => list.map(({ sId, type }) => `${sId}:${type}`);
  const current = virtualDeviceSnapshot(accessory);
  return (
    accessory.virtual === true &&
    current.name === snapshot.name &&
    current.room_id === snapshot.room_id &&
    services(current.services).join() === services(snapshot.services).join()
  );
}

// What could not be read may refer to the device or not: it is named to
// the owner before a deletion they asked for (hasDependencies), but only a
// reference found stops a step on the agent's own (foundDependencies).
const UNREAD = ["code_unread", "bridges_unread"];

export function hasDependencies(dependencies) {
  return Object.values(dependencies ?? {}).some((list) => list.length > 0);
}

export function foundDependencies(dependencies) {
  return Object.entries(dependencies ?? {}).some(
    ([key, list]) => !UNREAD.includes(key) && list.length > 0,
  );
}

export function unreadDependencies(dependencies) {
  return Object.fromEntries(
    UNREAD.filter((key) => dependencies?.[key]?.length > 0).map((key) => [
      key,
      dependencies[key],
    ]),
  );
}

// The services sent to create a deleted device again: each with its name
// and the optional characteristics it had, as service.types tells them.
export function recreateServices(snapshot, serviceTypes) {
  return snapshot.services.map((service) => {
    const catalog = serviceTypes.find(({ type }) => type === service.type);
    const required = new Set(
      (catalog?.required ?? []).map(serviceCharacteristicName),
    );
    const listed = new Set(
      (catalog?.optional ?? []).map(serviceCharacteristicName),
    );
    return {
      type: service.type,
      name: service.name,
      optional: service.characteristic_types.filter(
        (type) => type !== "Name" && !required.has(type) && listed.has(type),
      ),
    };
  });
}

function deviceRef(homeRef, id) {
  return `${homeRef}/accessory/${id}`;
}

export function publicVirtualDeviceChange(change, { verification }) {
  const homeRef = change.home_ref;
  const room = {
    ref: `${homeRef}/room/${change.room_id}`,
    name: change.room_name,
  };
  const common = {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
  };
  const tail = {
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(verification ? { verification } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...(change.candidates
      ? {
          candidate_devices: change.candidates.map(({ id, name }) => ({
            ref: deviceRef(homeRef, id),
            name,
          })),
        }
      : {}),
  };
  if (change.kind === VIRTUAL_DEVICE) {
    const created = change.created_snapshot;
    return {
      ...common,
      device: {
        ...(change.created_id !== undefined
          ? { ref: deviceRef(homeRef, change.created_id) }
          : {}),
        name: created?.name ?? change.requested_name,
        room,
        type: change.service_type,
        ...(change.optional_characteristics?.length
          ? { optional_characteristics: [...change.optional_characteristics] }
          : {}),
        ...(created?.services?.[0]
          ? {
              service_ref: `${deviceRef(homeRef, created.id)}/service/${created.services[0].sId}`,
              ...(created.services[0].characteristic_types?.length
                ? {
                    characteristic_types: [
                      ...created.services[0].characteristic_types,
                    ],
                  }
                : {}),
            }
          : {}),
      },
      ...(created
        ? { name_normalized: created.name !== change.requested_name }
        : {}),
      ...(change.matching?.length
        ? {
            matching_devices: change.matching.map(({ id, name }) => ({
              ref: deviceRef(homeRef, id),
              name,
            })),
          }
        : {}),
      ...(change.dependencies ? { dependencies: change.dependencies } : {}),
      ...(change.unread ?? {}),
      ...(change.status === "conflict" && change.observed_device
        ? { observed_device: change.observed_device }
        : {}),
      creation_owned: change.creation_owned === true,
      ...tail,
      restore_supported: change.creation_owned === true,
      limitations: LIMITATIONS[VIRTUAL_DEVICE],
    };
  }
  const snapshot = change.baseline_snapshot;
  const recreated = change.recreated_snapshot;
  return {
    ...common,
    device: {
      ref: deviceRef(homeRef, snapshot.id),
      name: snapshot.name,
      room,
      services: snapshot.services.map(({ type, name }) => ({ type, name })),
    },
    dependencies: change.dependencies,
    ...(recreated
      ? {
          recreated_device: {
            ref: deviceRef(homeRef, recreated.id),
            name: recreated.name,
            room,
            services: recreated.services.map(({ sId, type }) => ({
              ref: `${deviceRef(homeRef, recreated.id)}/service/${sId}`,
              type,
            })),
          },
          not_restored: notRestored(change.dependencies),
        }
      : {}),
    ...tail,
    restore_supported: change.status === "applied",
    limitations: LIMITATIONS[VIRTUAL_DEVICE_DELETE],
  };
}

// What undo of a deletion does not bring back to the new device.
function notRestored(dependencies) {
  return [
    "the old id: the device is new",
    ...dependencies.scenarios.map(
      ({ name }) => `scenario «${name}» still refers to the old device`,
    ),
    ...dependencies.links.map(
      ({ characteristic, with: others }) =>
        `link of ${characteristic} with ${others.map(({ name }) => `«${name}»`).join(", ")}`,
    ),
    ...dependencies.bridges.map(({ name }) => `export to ${name}`),
    ...dependencies.logics.map(({ name }) => `logic «${name}»`),
    ...(dependencies.code ?? []).map(
      ({ name }) => `code of «${name}» still names the old id`,
    ),
  ];
}

// Whether everything that refers to the device now was already named at
// prepare, which the owner confirmed.
export function dependenciesWithin(current, prepared) {
  const keys = (dependencies) =>
    new Set([
      ...dependencies.scenarios.map(({ ref }) => `scenario ${ref}`),
      ...dependencies.links.flatMap(({ characteristic, with: others }) =>
        others.map(({ ref }) => `link ${characteristic} ${ref}`),
      ),
      ...dependencies.bridges.map(({ ref }) => `bridge ${ref}`),
      ...dependencies.logics.map(({ name }) => `logic ${name}`),
      ...(dependencies.code ?? []).map(({ ref }) => `code ${ref}`),
    ]);
  const known = keys(prepared);
  return [...keys(current)].every((key) => known.has(key));
}
