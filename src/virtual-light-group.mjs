import { isDeepStrictEqual } from "node:util";
import { characteristicContract } from "./change-contracts.mjs";
import { nativeTargetKey } from "./change-refs.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export function validateVirtualLightCharacteristicTypes(types) {
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

export function characteristicTypeName(type) {
  return type?.type ?? type?.shortId ?? null;
}

export function validateVirtualLightServiceType(
  serviceType,
  characteristicTypes,
) {
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

export function selectVirtualLightMember(
  ref,
  target,
  accessory,
  characteristicTypes,
) {
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

export function selectCreatedVirtualLight(accessory, change) {
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

export function createdVirtualLightTarget(accessory, change) {
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

export function virtualAccessoryStructure(accessory) {
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

export function findNativeCharacteristic(accessory, { sId, cId }) {
  return accessory.services
    ?.find((service) => service.sId === sId)
    ?.characteristics?.find((characteristic) => characteristic.cId === cId);
}

export function virtualLightSettingsSnapshot(accessory, target, types) {
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

export function virtualLinkTarget({ aId, sId, cId }) {
  return { tAId: aId, tSId: sId, tCId: cId };
}

export function normalizeVirtualLinks(links) {
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

export function normalizePhysicalLinks(links) {
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

export function physicalLinkBaseline(change, artifact) {
  return change.physical_link_baselines.find(
    (baseline) =>
      baseline.type === artifact.type &&
      baseline.member_ref === artifact.member_ref &&
      nativeTargetKey(baseline.target) === nativeTargetKey(artifact.target),
  );
}

export function virtualLightProgressLink(change, cleanup) {
  return change.progress.links.find(
    (link) =>
      link.type === cleanup.type && link.member_ref === cleanup.member_ref,
  );
}

export function physicalLinkArtifact(change, progress, cleanup) {
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

export function samePhysicalLink(left, right) {
  return (
    left.type === right.type &&
    left.index === right.index &&
    left.controller === right.controller
  );
}

export function physicalLinkContains(observed, expected) {
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

export function physicalLinksPreservedAcrossOwnRemoval(
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

export function nativeEmptyPhysicalLinkResidue(link, baselineLinks, index) {
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

export function virtualLinkRelation(links, target) {
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

export function expectedTargetsForType(change, type) {
  return change.progress.links
    .filter((link) => link.type === type)
    .map((link) => link.target);
}

export function unexpectedVirtualLinks(links, expectedTargets) {
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

export function virtualLinkSettingsMatch(characteristic) {
  return (
    characteristic?.hasLinks === true &&
    (characteristic.linkProcessing ?? 0) === 0
  );
}

export function completeVirtualLightConfiguration(change, observation) {
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

export function safeOwnedVirtualLightConfiguration(change, observation) {
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

export function safeRestoringVirtualLightConfiguration(change, observation) {
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
export function hasVirtualLightShape(
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
export function virtualLightGroupPartlyWritten(change, direction) {
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

export function virtualLightAllWritesAcknowledged(change) {
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
