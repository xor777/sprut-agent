// Virtual switches, buttons and sensors the owner asks for: virtual_device
// creates one in a room, virtual_device_delete deletes one. What the hub
// does with them was observed on the owner's hub, 3.0.0
// (research/protocol/2026-10-23-virtual-devices.md).
import { SprutHubError } from "./spruthub-client.mjs";

export const VIRTUAL_DEVICE = "virtual_device";
export const VIRTUAL_DEVICE_DELETE = "virtual_device_delete";

// The service types created and written on the hub in the probe. The hub
// offers more (every non-system type of service.types); they were not
// tried, so they are not offered here.
export const VIRTUAL_DEVICE_TYPES = [
  "Switch",
  "Outlet",
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
];

// accessory.create kept the first 32 characters of an accessory's and a
// service's name, Latin and Cyrillic alike, without an error (probe, 15).
// A longer name is refused here, so the owner never gets a name cut short.
export const ACCESSORY_NAME_MAX_LENGTH = 32;

// The hub put an accessory sent with a room it lacks into another room
// without an error (probe, 14), so the room is checked before the write.
export function virtualDeviceName(name) {
  const length = [...name].length;
  if (length > ACCESSORY_NAME_MAX_LENGTH) {
    throw new SprutHubError(
      "name_too_long",
      `This name has ${length} characters, and SprutHub keeps only the first ${ACCESSORY_NAME_MAX_LENGTH} of a device name. Nothing was written; suggest a name of at most ${ACCESSORY_NAME_MAX_LENGTH} characters.`,
      "prepare_native_change",
      { max_length: ACCESSORY_NAME_MAX_LENGTH, name_length: length },
    );
  }
  return name;
}

export function virtualDeviceType(value) {
  if (!VIRTUAL_DEVICE_TYPES.includes(value)) {
    throw new SprutHubError(
      "unsupported_virtual_device_type",
      `value is the service type of the virtual device, one of ${VIRTUAL_DEVICE_TYPES.join(", ")}.`,
      "get_native_change_contract",
      { supported_types: VIRTUAL_DEVICE_TYPES },
    );
  }
  return value;
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
        "creates the device again with the same name, room and service types: a new id, and the scenarios, links, export and logic are not put back on it (not_restored)",
    };
  }
  return {
    write: "accessory.create({name,roomId,services:[{type,name,optional:[]}]})",
    fields: {
      target_ref: "the home ref",
      room_ref: "an existing room",
      name: {
        min_length: 1,
        max_length: ACCESSORY_NAME_MAX_LENGTH,
        note: "also the name of its service",
      },
      value: { service_type: VIRTUAL_DEVICE_TYPES },
    },
    types:
      "Switch and Outlet: On. StatelessProgrammableSwitch: a button; writing ProgrammableSwitchEvent with send_device_commands is a press (0 single, 1 double, 2 long). The sensors' reading (ContactSensorState, MotionDetected, LeakDetected, …) is written with send_device_commands too, so a scenario on it can be tried.",
    duplicate:
      "a virtual device of the same name in the room is named in matching_devices with tell_owner",
    restore:
      "deletes the created device by its id; refused (virtual_device_in_use) while scenarios, links or logic refer to it",
  };
}

// What the search of code (#readCodeMentions in spruthub-client.mjs) finds.
export const CODE_DEPENDENCY_NOTE =
  "Code is searched as get_entity relations search it (code_mentions): a Hub call with the device's id or its exact name in a string; an id kept in an array or a variable (a global list of lights) or computed is not found.";

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
  "Things refer to this device (dependencies). Name them to the owner and apply only after they confirm: its scenarios stay but no longer react to it or act on it, its links, bridge export and logic go, and undo brings back only a new device of the same name and type.";

// The device's own services: the information service is the hub's.
export function ownServices(accessory) {
  return (accessory.services ?? []).filter(
    ({ type }) => type !== "AccessoryInformation",
  );
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
        .map(({ control }) => control?.type)
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

export function hasDependencies(dependencies) {
  return Object.values(dependencies ?? {}).some((list) => list.length > 0);
}

// The services sent to create a deleted device again: each with its name
// and the optional characteristics it had, as service.types tells them.
export function recreateServices(snapshot, serviceTypes) {
  return snapshot.services.map((service) => {
    const catalog = serviceTypes.find(({ type }) => type === service.type);
    const listed = new Set(
      (catalog?.optional ?? []).map((entry) => entry?.type ?? entry),
    );
    return {
      type: service.type,
      name: service.name,
      optional: service.characteristic_types.filter(
        (type) => type !== "Name" && listed.has(type),
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
        ...(created?.services?.[0]
          ? {
              service_ref: `${deviceRef(homeRef, created.id)}/service/${created.services[0].sId}`,
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
      ...(dependencies.code_unread ?? []).map(
        ({ ref, reason }) => `unread ${ref ?? reason}`,
      ),
    ]);
  const known = keys(prepared);
  return [...keys(current)].every((key) => known.has(key));
}
