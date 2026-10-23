// The lamps of an existing virtual lamp group: what virtual_light_group
// does when its target_ref is the group's lamp service. A group is a
// virtual accessory's Lightbulb whose characteristics have one IN link per
// member lamp (2026-10-14-light-group-relink); the lamps are changed only
// by link.addVirtual and link.remove on the group's side, so the group
// stays the same accessory and its bridge export is untouched. Pure
// helpers here; the reads and writes are AutomationService's.
import {
  parseAccessoryRef,
  parseServiceRef,
  serviceKey,
  stableNativeId,
} from "./change-refs.mjs";
import { SprutHubError, serviceRef } from "./spruthub-client.mjs";

export const LIGHT_GROUP_MEMBERS = "light_group_members";

// The operation a change was prepared with: a group's lamps are set by
// virtual_light_group, as a group is created.
export function changeOperation(change) {
  return change.kind === LIGHT_GROUP_MEMBERS
    ? "virtual_light_group"
    : change.kind;
}

// The lamp controls a group links, in the owner's order: 7 of the owner's 9
// groups link all five, 2 all but ColorTemperature.
export const LAMP_GROUP_TYPES = [
  "On",
  "Brightness",
  "Hue",
  "Saturation",
  "ColorTemperature",
];

const controlType = (characteristic) =>
  characteristic.control?.type ?? characteristic.control?.key;
const targetKey = ({ aId, sId, cId }) => `${aId}.${sId}.${cId}`;
const linkKey = (type, target) => `${type}|${targetKey(target)}`;
const stepKey = (step) => linkKey(step.type, step.target);

export function isHomeRef(ref) {
  return typeof ref === "string" && /^spruthub:\/\/hub\/[^/]+$/.test(ref);
}

export function lampServiceRef(homeRef, { aId, sId }) {
  return `${homeRef}/accessory/${aId}/service/${sId}`;
}

// A lamp named by its service ref, or by its accessory ref when the
// accessory has one lamp service; sId is then found by lampService.
export function parseLampRef(ref, serial) {
  try {
    return parseServiceRef(ref, serial);
  } catch (error) {
    try {
      return { aId: parseAccessoryRef(ref, serial).id, sId: undefined };
    } catch {
      throw error;
    }
  }
}

// The Lightbulb service of a lamp: the one named, or the accessory's only
// one.
export function lampService(accessory, sId, ref) {
  const lamps = (accessory.services ?? []).filter(
    ({ type }) => type === "Lightbulb",
  );
  const service =
    sId === undefined
      ? lamps.length === 1
        ? lamps[0]
        : undefined
      : lamps.find((candidate) => candidate.sId === sId);
  if (!service) {
    throw new SprutHubError(
      "unsupported_group_member",
      `${ref} is not one lamp (Lightbulb) service. Pass the lamp's service ref from find_devices or get_entity.`,
      "get_entity",
    );
  }
  return service;
}

export function notALampGroup(ref) {
  return new SprutHubError(
    "not_a_lamp_group",
    `${ref} is not a virtual lamp group: only a virtual accessory's lamp, linked to its lamps in SprutHub, is a group. To make a new group pass the home ref as target_ref.`,
    "get_native_change_contract",
  );
}

// The group's lamp service, checked to be a virtual accessory's.
export function lampGroupService(accessory, sId, ref) {
  if (accessory.virtual !== true) throw notALampGroup(ref);
  try {
    return lampService(accessory, sId, ref);
  } catch {
    throw notALampGroup(ref);
  }
}

// The readable and writable lamp controls of a service by type, as link
// endpoints.
export function lampControls(accessory, service) {
  const controls = {};
  for (const characteristic of service.characteristics ?? []) {
    const type = controlType(characteristic);
    if (
      !LAMP_GROUP_TYPES.includes(type) ||
      Object.hasOwn(controls, type) ||
      characteristic.control?.read !== true ||
      characteristic.control?.write !== true ||
      !stableNativeId(characteristic.cId)
    ) {
      continue;
    }
    controls[type] = {
      aId: accessory.id,
      sId: service.sId,
      cId: characteristic.cId,
    };
  }
  return controls;
}

// IN links of one group characteristic, one entry per linked lamp
// characteristic.
export function incomingLinks(links) {
  return links
    .filter(({ type }) => type === "IN")
    .flatMap(({ index, characteristics }) =>
      characteristics.map(({ aId, sId, cId }) => ({
        index,
        target: { aId, sId, cId },
      })),
    );
}

// The characteristics the group links: those with at least one lamp, or,
// for a group without any, every lamp control it has.
export function linkedTypes(controls, links) {
  const linked = LAMP_GROUP_TYPES.filter(
    (type) => (links[type] ?? []).length > 0,
  );
  return linked.length > 0
    ? linked
    : LAMP_GROUP_TYPES.filter((type) => Object.hasOwn(controls, type));
}

// The lamps linked now, by service, with the types each is linked on.
export function currentMembers(types, links) {
  const members = new Map();
  for (const type of types) {
    for (const { target } of links[type] ?? []) {
      const key = serviceKey(target);
      const member = members.get(key) ?? {
        target: { aId: target.aId, sId: target.sId },
        types: [],
      };
      if (!member.types.includes(type)) member.types.push(type);
      members.set(key, member);
    }
  }
  return [...members.values()].sort(
    (left, right) =>
      left.target.aId - right.target.aId || left.target.sId - right.target.sId,
  );
}

// The writes that give the group exactly the desired lamps: each desired
// lamp gets a link for every linked type it has and is not yet linked on,
// and every link to a lamp left out is removed. Links of the lamps that
// stay are not touched.
export function planGroupMembers({ homeRef, types, links, desired }) {
  const steps = [];
  const desiredKeys = new Set(desired.map(({ target }) => serviceKey(target)));
  const changes = new Map();
  for (const member of desired) {
    const added = [];
    const lacks = [];
    for (const type of types) {
      if (
        (links[type] ?? []).some(
          ({ target }) => serviceKey(target) === serviceKey(member.target),
        )
      ) {
        continue;
      }
      const target = member.controls[type];
      if (!target) {
        lacks.push(type);
        continue;
      }
      added.push(type);
      steps.push({ action: "add", type, member_ref: member.ref, target });
    }
    changes.set(serviceKey(member.target), { added, lacks });
  }
  for (const type of types) {
    for (const { target, index } of links[type] ?? []) {
      if (desiredKeys.has(serviceKey(target))) continue;
      steps.push({
        action: "remove",
        type,
        member_ref: lampServiceRef(homeRef, target),
        target,
        index,
      });
    }
  }
  return {
    steps: steps.map((step) => ({
      ...step,
      sent: false,
      acknowledged: false,
      completed: false,
    })),
    changes,
  };
}

export function linkKeys(links) {
  const keys = new Set();
  for (const [type, entries] of Object.entries(links)) {
    for (const { target } of entries) keys.add(linkKey(type, target));
  }
  return keys;
}

// Whether the home already shows what a step does.
export function stepInEffect(step, keys) {
  return step.action === "add"
    ? keys.has(stepKey(step))
    : !keys.has(stepKey(step));
}

// The link id SprutHub keeps for a step's link now (removal by id).
export function currentLinkIndex(links, step) {
  return (links[step.type] ?? []).find(
    ({ target }) => targetKey(target) === targetKey(step.target),
  )?.index;
}

export function expectedAppliedKeys(change) {
  const keys = linkKeys(change.baseline_links);
  for (const step of change.steps) {
    if (step.action === "add") keys.add(stepKey(step));
    else keys.delete(stepKey(step));
  }
  return keys;
}

export function sameKeys(left, right) {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

// Links of the group that differ from the prepared ones where no write of
// this change was sent: a change by hand, in the app or by another tool.
export function foreignDifferences(change, observed, homeRef) {
  const baseline = linkKeys(change.baseline_links);
  const now = linkKeys(observed.links);
  const owned = new Set(
    change.steps.filter(({ sent }) => sent).map((step) => stepKey(step)),
  );
  const differences = [];
  const describe = (key, state) => {
    const [type, target] = key.split("|");
    const [aId, sId, cId] = target.split(".");
    differences.push({
      characteristic_type: type,
      lamp_characteristic_ref: `${homeRef}/accessory/${aId}/service/${sId}/characteristic/${cId}`,
      now: state,
    });
  };
  for (const key of now) {
    if (!baseline.has(key) && !owned.has(key)) describe(key, "linked");
  }
  for (const key of baseline) {
    if (!now.has(key) && !owned.has(key)) describe(key, "not_linked");
  }
  return differences;
}

// What undoing the sent steps writes: removed links added back first, so
// the old lamps work again, then the added ones removed.
export function restoreSteps(change) {
  const sent = change.steps.filter(({ sent: wasSent }) => wasSent);
  return [
    ...sent.filter(({ action }) => action === "remove"),
    ...sent.filter(({ action }) => action === "add"),
  ].map((step) => ({
    action: step.action === "add" ? "remove" : "add",
    type: step.type,
    member_ref: step.member_ref,
    target: structuredClone(step.target),
    sent: false,
    acknowledged: false,
    completed: false,
  }));
}

// The lamp service of each virtual accessory in accessory.list, with its
// lamp characteristics by type, whose On link.list says whether it is a
// group: accessory.list has no virtual flag but gives a virtual accessory
// model "Virtual" (owner hub, 3.0.0, all 9 lamp groups,
// 2026-10-14-light-group-relink).
export function virtualLamps(accessories) {
  return accessories.flatMap((accessory) =>
    accessory.model !== "Virtual"
      ? []
      : (accessory.services ?? [])
          .filter(({ type }) => type === "Lightbulb")
          .flatMap((service) => {
            const controls = lampTypes(service);
            return controls.On
              ? [{ aId: accessory.id, sId: service.sId, controls }]
              : [];
          }),
  );
}

// A service's lamp characteristics: the cId of each type it has.
function lampTypes(service) {
  const types = {};
  for (const characteristic of service.characteristics ?? []) {
    const type = controlType(characteristic);
    if (LAMP_GROUP_TYPES.includes(type) && !Object.hasOwn(types, type)) {
      types[type] = characteristic.cId;
    }
  }
  return types;
}

// The lamp services the links of a group's On reach.
export function groupLamps(links) {
  return currentMembers(["On"], { On: incomingLinks(links) }).map(
    ({ target }) => target,
  );
}

// What household reads say of lamp services: a group's lamps with name,
// room and whether online, and the names of the groups a lamp is in. Null
// when the groups were not read. A group with an offline lamp also names
// what may have replaced it (replacementOf).
export function lampGroupMarks(catalog, serial) {
  if (!catalog.lampGroups) return null;
  const rooms = new Map(catalog.rooms.map(({ id, name }) => [id, name]));
  const memberOf = new Map();
  for (const { group, lamps } of catalog.lampGroups) {
    const owner = catalog.byId.get(group.aId);
    if (!owner) continue;
    for (const lamp of lamps) {
      const key = serviceKey(lamp);
      memberOf.set(key, [...(memberOf.get(key) ?? []), owner.name]);
    }
  }
  const groups = new Map();
  for (const { group, lamps, types } of catalog.lampGroups) {
    if (!catalog.byId.has(group.aId)) continue;
    const found = lamps.map(({ aId }) => catalog.byId.get(aId));
    const offlineRooms = new Set(
      found
        .filter((lamp) => lamp && lamp.online !== true)
        .map(({ roomId }) => roomId),
    );
    groups.set(serviceKey(group), {
      lamps: found.map((lamp) =>
        lamp
          ? {
              name: lamp.name,
              room: rooms.get(lamp.roomId) ?? null,
              online: lamp.online === true,
            }
          : { exists: false },
      ),
      ...replacementOf(
        catalog,
        serial,
        offlineRooms,
        types ?? ["On"],
        memberOf,
        rooms,
      ),
    });
  }
  return { groups, memberOf };
}

// A replaced lamp is usually on the hub already, unlinked, in the room of
// the offline one: the online physical lamps of those rooms in no group
// that have every characteristic the group links (types). With none, the
// new lamp still has to be paired.
function replacementOf(catalog, serial, roomIds, types, memberOf, rooms) {
  if (roomIds.size === 0) return {};
  const candidates = catalog.accessories.flatMap((accessory) =>
    accessory.online === true &&
    roomIds.has(accessory.roomId) &&
    accessory.model !== "Virtual" &&
    accessory.virtual !== true
      ? (accessory.services ?? [])
          .filter(
            (service) =>
              service.type === "Lightbulb" &&
              !memberOf.has(
                serviceKey({ aId: accessory.id, sId: service.sId }),
              ) &&
              types.every((type) => Object.hasOwn(lampTypes(service), type)),
          )
          .map((service) => ({
            name: accessory.name,
            service_ref: serviceRef(serial, accessory.id, service.sId),
          }))
      : [],
  );
  if (candidates.length > 0) return { replacement_candidates: candidates };
  const names = [...roomIds].map((id) => rooms.get(id) ?? "its room");
  return {
    no_replacement_on_hub: `No online lamp in ${names.join(", ")} is outside lamp groups: the new lamp is not on the hub yet. Pair it first (device_search), then add it to this group.`,
  };
}

// The marks of one service: lamp_group on a group, in_lamp_groups on a lamp
// in one; none when the groups were not read.
export function lampGroupMark(marks, aId, sId) {
  const key = serviceKey({ aId, sId });
  return {
    ...(marks?.groups.has(key) ? { lamp_group: marks.groups.get(key) } : {}),
    ...(marks?.memberOf.has(key)
      ? { in_lamp_groups: marks.memberOf.get(key) }
      : {}),
  };
}

// A lamp's on/off as SprutHub shows it, or null.
export function lampIsOn(accessory, sId) {
  const value = accessory?.services
    ?.find((service) => service.sId === sId)
    ?.characteristics?.find(
      (characteristic) => controlType(characteristic) === "On",
    )?.control?.value?.boolValue;
  return typeof value === "boolean" ? value : null;
}

// A link added copies the lamp's value to the group, and a group command
// equal to what the group shows does not reach the lamps
// (2026-10-14-light-group-relink, 11, 12 and 14). So after the change the
// group shows the on/off of the last lamp linked on On, and the online
// lamps it keeps that show the other value are out of step: the next
// «включи» or «выключи» may miss them. Null when none is.
export function outOfStepLamps(steps, desired) {
  const last = steps
    .filter(({ action, type }) => action === "add" && type === "On")
    .at(-1);
  const joiner = last && desired.find(({ ref }) => ref === last.member_ref);
  const shows = joiner ? lampIsOn(joiner.accessory, joiner.target.sId) : null;
  if (shows === null) return null;
  const lamps = desired.filter(
    (member) =>
      member.accessory.online === true &&
      lampIsOn(member.accessory, member.target.sId) === !shows,
  );
  return lamps.length === 0
    ? null
    : {
        shows,
        joined: joiner.accessory.name,
        lamps: lamps.map(({ accessory }) => accessory.name),
      };
}

export function lampGroupNotes(members, outOfStep) {
  const notes = [];
  if (outOfStep) {
    const names = outOfStep.lamps.map((name) => `«${name}»`).join(", ");
    notes.push(
      `After «${outOfStep.joined}» joins, the group shows ${outOfStep.shows ? "on" : "off"} like it, while ${names} ${outOfStep.lamps.length === 1 ? "is" : "are"} ${outOfStep.shows ? "off" : "on"}. A group command equal to what the group shows does not reach them: to bring them in step, switch the group ${outOfStep.shows ? "off and on" : "on and off"} once, or switch those lamps.`,
    );
  }
  for (const member of members) {
    const name = member.name ? `«${member.name}»` : member.service_ref;
    if (member.change === "joins" && member.online === false) {
      notes.push(
        `${name} is offline: it is linked now; that it follows the group shows once it is back online.`,
      );
    }
    if (member.lacks?.length > 0) {
      notes.push(
        `${name} has no ${member.lacks.join(", ")}: the group's ${member.lacks.join(", ")} will not reach it.`,
      );
    }
  }
  return notes;
}

const LAMP_GROUP_LIMITATIONS = [
  "Links are written one at a time. If the hub refuses one, the earlier ones stay (hub_effect=partial) and restore_native_change takes them back.",
  "A lamp that joins passes its current values to the group (SprutHub's last-value feedback); the other lamps keep theirs until the next group command. A command equal to what the group already shows does not reach the lamps.",
  "A removed lamp keeps an empty link entry in SprutHub; it carries nothing.",
  "Undo adds back the removed links and removes the added ones while the group's links are as this change left them; a change made by hand meanwhile is reported, not overwritten.",
];

export function publicLampGroupMember(member) {
  return {
    service_ref: member.service_ref,
    ...(member.exists === false
      ? { exists: false }
      : { name: member.name, room: member.room, online: member.online }),
    change: member.change,
    ...(member.links_added?.length > 0
      ? { links_added: [...member.links_added] }
      : {}),
    ...(member.links_removed?.length > 0
      ? { links_removed: [...member.links_removed] }
      : {}),
    ...(member.lacks?.length > 0 ? { lacks: [...member.lacks] } : {}),
  };
}

export function publicLampGroupChange(
  change,
  { verification, configurationMatches },
) {
  const notes = lampGroupNotes(change.members, change.out_of_step);
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: "virtual_light_group",
    reason: change.reason,
    target_ref: change.target_ref,
    lamp_group: {
      ref: change.target_ref,
      name: change.group.name,
      room: change.group.room,
    },
    characteristics: [...change.linked_types],
    members: change.members.map(publicLampGroupMember),
    ...(notes.length > 0 ? { notes } : {}),
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
    ...(change.observed_differences?.length > 0
      ? { observed_differences: structuredClone(change.observed_differences) }
      : {}),
    restore_supported: true,
    limitations: LAMP_GROUP_LIMITATIONS,
  };
}

export function lampGroupContract(group) {
  return {
    change: "the_lamps_of_this_existing_group",
    lamp_group: { ref: group.ref, name: group.name, room: group.room },
    characteristics: [...group.types],
    members: group.members.map((member) => ({
      service_ref: member.service_ref,
      ...(member.exists === false
        ? { exists: false }
        : { name: member.name, room: member.room, online: member.online }),
      characteristics: [...member.types],
    })),
    input:
      "prepare_native_change with this target_ref and member_service_refs: every lamp service the group should hold afterwards, the lamps it keeps included. A joining lamp is linked on each of these characteristics it has; a lamp left out is unlinked; the lamps kept are not touched. A new lamp that replaced one and is already on the hub (find_devices shows it, without in_lamp_groups) is linked here, not paired again.",
    write: [
      "link.addVirtual({aId,sId,cId,tAId,tSId,tCId})",
      "link.remove({aId,sId,cId,linkId})",
    ],
    bridges:
      "The group stays the same accessory, so its export to Alice, HomeKit or Google is unchanged.",
    restore:
      "add_back_removed_links_then_remove_added_ones_while_the_group_links_are_as_this_change_left_them",
    evidence: {
      live_add_remove_and_re_add: "SprutHub 3.0.0 rev 20131, 2026-10-14",
    },
    limitations: LAMP_GROUP_LIMITATIONS,
  };
}
