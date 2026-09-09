import { AutomationStore } from "./automation-store.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

export class AutomationService {
  #writeSequence = Promise.resolve();

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
      if (reconciliation.owned && reconciliation.matches) {
        const localStateSaved = await this.#markApplied(
          change,
          reconciliation.scenario.index,
        );
        return withLocalState(applyResult(change, false), localStateSaved);
      }
      if (reconciliation.owned) {
        return conflictResult(change, reconciliation.scenario.index);
      }
      if (reconciliation.equivalent) {
        change.status = "already_present";
        change.scenario_index = reconciliation.equivalent.index;
        change.owned = false;
        change.updated_at = new Date().toISOString();
        await this.store.save(change);
        return {
          status: "already_present",
          change_ref: changeReference,
          scenario_index: reconciliation.equivalent.index,
          created: false,
          owned: false,
        };
      }
      if (reconciliation.runtimeConflict) {
        change.status = "conflict";
        change.scenario_index = reconciliation.runtimeConflict.index;
        change.owned = false;
        change.conflict_reason = "equivalent_rule_runtime_mismatch";
        change.updated_at = new Date().toISOString();
        await this.store.save(change);
        return runtimeConflictResult(change, reconciliation.runtimeConflict);
      }
      if (["creating", "uncertain"].includes(change.status)) {
        change.status = "uncertain";
        change.updated_at = new Date().toISOString();
        await this.store.save(change);
        return uncertainResult(change);
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
          change.status = "prepared";
          change.updated_at = new Date().toISOString();
          const localStateSaved = await this.#trySave(change);
          if (!localStateSaved) {
            error.details = {
              change_ref: changeReference,
              hub_effect: "not_applied",
              local_state: {
                saved: false,
                action: "restore_state_storage_then_preview_boolean_automation",
              },
            };
          }
          throw error;
        }
        change.status = "uncertain";
        change.updated_at = new Date().toISOString();
        const uncertainStateSaved = await this.#trySave(change);
        try {
          reconciliation = await this.#reconcile(change);
        } catch {
          return withLocalState(uncertainResult(change), uncertainStateSaved);
        }
        if (reconciliation.owned && reconciliation.matches) {
          const localStateSaved = await this.#markApplied(
            change,
            reconciliation.scenario.index,
          );
          return withLocalState(
            {
              ...applyResult(change, true),
              recovered_after_uncertain_write: true,
              ...(error.code === "connection_closed"
                ? { recovered_after_disconnect: true }
                : {}),
            },
            localStateSaved,
          );
        }
        return withLocalState(uncertainResult(change), uncertainStateSaved);
      }

      try {
        reconciliation = await this.#reconcile(change);
      } catch {
        change.status = "uncertain";
        change.updated_at = new Date().toISOString();
        const localStateSaved = await this.#trySave(change);
        return withLocalState(uncertainResult(change), localStateSaved);
      }
      if (!reconciliation.owned || !reconciliation.matches) {
        change.status = reconciliation.owned ? "conflict" : "uncertain";
        change.updated_at = new Date().toISOString();
        const localStateSaved = await this.#trySave(change);
        const result = reconciliation.owned
          ? conflictResult(change, reconciliation.scenario.index)
          : uncertainResult(change);
        return withLocalState(result, localStateSaved);
      }
      const localStateSaved = await this.#markApplied(
        change,
        reconciliation.scenario.index,
      );
      return withLocalState(applyResult(change, true), localStateSaved);
    });
  }

  async getChange(changeReference) {
    const id = parseChangeRef(changeReference);
    const change = await this.#requireChange(id);
    if (["prepared", "rolled_back"].includes(change.status)) {
      return publicChange(change);
    }
    const reconciliation = await this.#reconcile(change);
    if (
      ["deleting", "rollback_uncertain"].includes(change.status) &&
      !reconciliation.scenario
    ) {
      return rolledBackResult(change, false);
    }
    if (
      change.conflict_reason === "equivalent_rule_runtime_mismatch" &&
      reconciliation.runtimeConflict
    ) {
      return runtimeConflictResult(change, reconciliation.runtimeConflict);
    }
    if (reconciliation.owned) {
      return {
        ...publicChange(change),
        status: reconciliation.matches ? "applied" : "conflict",
        scenario_index: reconciliation.scenario.index,
        owned: true,
        configuration_matches: reconciliation.matches,
      };
    }
    if (reconciliation.equivalent && change.owned === false) {
      return {
        ...publicChange(change),
        status: "already_present",
        scenario_index: reconciliation.equivalent.index,
        owned: false,
        configuration_matches: true,
      };
    }
    if (reconciliation.scenario) {
      return ownershipConflictResult(change, reconciliation.scenario.index);
    }
    return {
      ...publicChange(change),
      status: "uncertain",
      owned: change.owned === true,
      configuration_matches: false,
      action: "inspect_hub_before_retry",
    };
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
      if (reconciliation.scenario && !reconciliation.owned) {
        change.status = "conflict";
        change.updated_at = new Date().toISOString();
        await this.store.save(change);
        return ownershipConflictResult(change, reconciliation.scenario.index);
      }
      if (!reconciliation.owned) {
        if (["creating", "uncertain"].includes(change.status)) {
          change.status = "uncertain";
          change.updated_at = new Date().toISOString();
          await this.store.save(change);
          return uncertainResult(change);
        }
        change.status = "rolled_back";
        change.updated_at = new Date().toISOString();
        await this.store.save(change);
        return {
          ...publicChange(change),
          status: "rolled_back",
          removed: false,
          physical_state_reverted: false,
        };
      }
      if (!reconciliation.matches) {
        change.status = "conflict";
        change.updated_at = new Date().toISOString();
        await this.store.save(change);
        return conflictResult(change, reconciliation.scenario.index);
      }
      change.status = "deleting";
      change.updated_at = new Date().toISOString();
      await this.#saveBeforeWrite(change);
      try {
        await this.client.deleteScenario(reconciliation.scenario.index);
      } catch (error) {
        if (!isUncertainWriteError(error)) throw error;
        change.status = "rollback_uncertain";
        change.updated_at = new Date().toISOString();
        const uncertainStateSaved = await this.#trySave(change);
        try {
          const afterUncertainDelete = await this.#reconcile(change);
          return this.#finishDeleteReadback(change, afterUncertainDelete, true);
        } catch {
          return withLocalState(uncertainResult(change), uncertainStateSaved);
        }
      }
      let afterDelete;
      try {
        afterDelete = await this.#reconcile(change);
      } catch {
        change.status = "rollback_uncertain";
        change.updated_at = new Date().toISOString();
        const localStateSaved = await this.#trySave(change);
        return withLocalState(uncertainResult(change), localStateSaved);
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
    return change;
  }

  async #preflight(change) {
    const source = parseCharacteristicRef(change.condition.characteristic.ref);
    const target = parseCharacteristicRef(change.action.characteristic.ref);
    const context = await this.client.inspectAutomation({
      source: { ...source, roomId: parseRoomRef(change.condition.room.ref) },
      target: { ...target, roomId: parseRoomRef(change.action.room.ref) },
    });
    const condition = selectCharacteristic(
      context.source,
      source,
      change.condition.value,
      false,
    );
    const action = selectCharacteristic(
      context.target,
      target,
      change.action.value,
      true,
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

  async #markApplied(change, scenarioIndex) {
    change.status = "applied";
    change.scenario_index = scenarioIndex;
    change.owned = true;
    change.updated_at = new Date().toISOString();
    return this.#trySave(change);
  }

  async #finishDeleteReadback(change, reconciliation, recovered) {
    if (!reconciliation.scenario) {
      const result = await this.#markRolledBack(change, true);
      return recovered
        ? { ...result, recovered_after_uncertain_write: true }
        : result;
    }
    if (!reconciliation.owned) {
      change.status = "conflict";
      change.updated_at = new Date().toISOString();
      const localStateSaved = await this.#trySave(change);
      return withLocalState(
        ownershipConflictResult(change, reconciliation.scenario.index),
        localStateSaved,
      );
    }
    if (!reconciliation.matches) {
      change.status = "conflict";
      change.updated_at = new Date().toISOString();
      const localStateSaved = await this.#trySave(change);
      return withLocalState(
        conflictResult(change, reconciliation.scenario.index),
        localStateSaved,
      );
    }
    change.status = "rollback_uncertain";
    change.updated_at = new Date().toISOString();
    const localStateSaved = await this.#trySave(change);
    return withLocalState(uncertainResult(change), localStateSaved);
  }

  async #markRolledBack(change, removed) {
    change.status = "rolled_back";
    change.updated_at = new Date().toISOString();
    const localStateSaved = await this.#trySave(change);
    return withLocalState(rolledBackResult(change, removed), localStateSaved);
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
  return Object.entries(expected).every(
    ([key, value]) => scenario[key] === value,
  );
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
  const action = target?.then?.length === 1 ? target.then[0] : null;
  const setting =
    action?.characteristics?.length === 1 ? action.characteristics[0] : null;
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
  };
}

function applyResult(change, created) {
  return {
    ...publicChange(change),
    status: "applied",
    scenario_index: change.scenario_index,
    created,
    owned: true,
    configuration_matches: true,
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

function withLocalState(result, saved) {
  if (saved) return result;
  return {
    ...result,
    local_state: {
      saved: false,
      action: "restore_state_storage_then_get_automation_change",
    },
  };
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
    created: false,
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
