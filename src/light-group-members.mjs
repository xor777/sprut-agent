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
import { SprutHubError } from "./spruthub-client.mjs";

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

export function lampGroupNotes(members) {
  const notes = [];
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
  const notes = lampGroupNotes(change.members);
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
      "prepare_native_change with this target_ref and member_service_refs: every lamp service the group should hold afterwards, the lamps it keeps included. A joining lamp is linked on each of these characteristics it has; a lamp left out is unlinked; the lamps kept are not touched.",
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
