import { isDeepStrictEqual } from "node:util";
import { AutomationStore } from "./automation-store.mjs";
import { SprutHubError } from "./spruthub-client.mjs";

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
      return {
        status: "ok",
        operation: input.operation,
        target_ref: input.target_ref,
        contract: characteristicContract(characteristic.control),
      };
    }
    if (["block_create", "block_data_update"].includes(input.operation)) {
      return {
        status: "ok",
        operation: input.operation,
        contract: blockContract(),
      };
    }
    throw unsupportedNativeOperation();
  }

  async prepareNativeChange(input) {
    if (input.operation === "characteristic_value") {
      return this.#prepareCharacteristicChange(input);
    }
    if (input.operation === "block_create") {
      return this.#prepareBlockCreate(input);
    }
    if (input.operation === "block_data_update") {
      return this.#prepareBlockUpdate(input);
    }
    throw unsupportedNativeOperation();
  }

  async #prepareCharacteristicChange(input) {
    const target = parseCharacteristicRef(input.target_ref, this.hubSerial);
    const characteristic = await this.client.getCharacteristic(target);
    const contract = characteristicContract(characteristic.control);
    const requestedValue = validateCharacteristicValue(input.value, contract);
    const baselineValue = typedNativeValue(characteristic.control.value);
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
      native_write_sent: false,
      native_acknowledged: false,
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
    await validateBlockData(data, this.client, { allowUnknownFrom: null });
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
      native_write_sent: false,
      native_acknowledged: false,
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async #prepareBlockUpdate(input) {
    if (!isRecord(input.data)) {
      throw new SprutHubError(
        "invalid_native_change",
        "BLOCK data update requires one complete data object.",
        "get_native_change_contract",
      );
    }
    const target = parseScenarioRef(input.target_ref, this.hubSerial);
    const scenario = await this.client.getScenario(target.index);
    if (!scenario) throw scenarioNotFound();
    const baseline = scenarioSnapshot(scenario);
    if (baseline.type !== "BLOCK") throw unsupportedScenarioType();
    const data = structuredClone(input.data);
    await validateBlockData(data, this.client, {
      allowUnknownFrom: baseline.data,
    });
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
      baseline_snapshot: baseline,
      requested_snapshot: { ...structuredClone(baseline), data },
      native_write_sent: false,
      native_acknowledged: false,
      created_at: now,
      updated_at: now,
      history: [{ status: "prepared", at: now }],
    };
    await this.store.save(change);
    return publicNativeChange(change);
  }

  async applyNativeChange(changeReference) {
    const id = parseNativeChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireNativeChange(id);
      return change.kind === "characteristic_value"
        ? this.#applyCharacteristicChange(change)
        : this.#applyBlockChange(change);
    });
  }

  async #applyCharacteristicChange(change) {
    const current = await this.#readCharacteristicValue(change);
    if (change.status === "applied") {
      return valuesEqual(current, change.requested_value)
        ? publicNativeChange(change, current)
        : this.#finishNative(change, "conflict", current, {
            conflict_reason: "value_changed_after_apply",
          });
    }
    if (["applying", "uncertain"].includes(change.status)) {
      return valuesEqual(current, change.requested_value)
        ? this.#finishNative(change, "applied", current)
        : this.#finishNative(change, "uncertain", current);
    }
    if (!valuesEqual(current, change.baseline_value)) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "baseline_changed",
      });
    }

    await this.#persistNativeIntent(change, "applying");
    try {
      await this.client.updateCharacteristic({
        ...change.target,
        value: {
          [change.requested_value.kind]: change.requested_value.value,
        },
      });
      change.native_acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        await this.#finishNative(change, "not_applied", current);
        throw error;
      }
      return this.#reconcileCharacteristicAfterWrite(change);
    }
    return this.#reconcileCharacteristicAfterWrite(change, true);
  }

  async #reconcileCharacteristicAfterWrite(change, acknowledged = false) {
    try {
      const observed = await this.#readCharacteristicValue(change);
      return valuesEqual(observed, change.requested_value)
        ? this.#finishNative(change, "applied", observed, {
            ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
          })
        : this.#finishNative(change, "uncertain", observed, {
            ...(acknowledged
              ? { conflict_reason: "ack_without_requested_result" }
              : {}),
          });
    } catch {
      return this.#finishNative(change, "uncertain");
    }
  }

  async getNativeChange(changeReference) {
    const id = parseNativeChangeRef(changeReference);
    const change = await this.#requireNativeChange(id);
    if (change.kind !== "characteristic_value") {
      return this.#getBlockChange(change);
    }
    let current;
    try {
      current = await this.#readCharacteristicValue(change);
    } catch {
      return publicNativeChange(change);
    }
    if (
      ["applying", "uncertain"].includes(change.status) &&
      valuesEqual(current, change.requested_value)
    ) {
      return this.#finishNative(change, "applied", current);
    }
    if (
      change.status === "applied" &&
      !valuesEqual(current, change.requested_value)
    ) {
      return this.#finishNative(change, "conflict", current, {
        conflict_reason: "value_changed_after_apply",
      });
    }
    return publicNativeChange(change, current);
  }

  async restoreNativeChange(changeReference) {
    const id = parseNativeChangeRef(changeReference);
    return this.#exclusiveWrite(async () => {
      const change = await this.#requireNativeChange(id);
      if (change.kind === "characteristic_value") {
        throw new SprutHubError(
          "restore_unsupported",
          "A characteristic command does not provide rollback of physical effects.",
          "get_native_change",
        );
      }
      return this.#restoreBlockChange(change);
    });
  }

  async listNativeChanges({ home_ref: homeRef, entity_ref: entityRef, limit }) {
    parseConfiguredHomeRef(homeRef, this.hubSerial);
    if (entityRef !== undefined) requireEntityHome(entityRef, this.hubSerial);
    const all = (await this.store.list())
      .filter(
        (change) =>
          change.home_ref === undefined || change.home_ref === homeRef,
      )
      .map(changeSummary)
      .filter(
        (change) =>
          entityRef === undefined || change.target_refs.includes(entityRef),
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return {
      status: "ok",
      home_ref: homeRef,
      ...(entityRef ? { entity_ref: entityRef } : {}),
      changes: all.slice(0, limit),
      truncated: all.length > limit,
    };
  }

  async #requireNativeChange(id) {
    const change = await this.store.get(id);
    if (
      !["characteristic_value", "block_create", "block_data_update"].includes(
        change?.kind,
      )
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

  async #readCharacteristicValue(change) {
    const characteristic = await this.client.getCharacteristic(change.target);
    const contract = characteristicContract(characteristic.control);
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
    return typedNativeValue(characteristic.control.value);
  }

  async #finishNative(change, status, observedValue, extra = {}) {
    const now = new Date().toISOString();
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
    change.history.push({ status, at: now });
    const saved = await this.#trySave(change);
    return withLocalState(publicNativeChange(change, observedValue), saved);
  }

  async #persistNativeIntent(change, status) {
    const now = new Date().toISOString();
    Object.assign(change, {
      status,
      native_write_sent: true,
      updated_at: now,
    });
    change.history.push({ status, at: now });
    await this.#saveBeforeWrite(change);
  }

  async #applyBlockChange(change) {
    const current = await this.#observeBlock(change);
    if (change.status === "applied") {
      return blockMatchesApplied(change, current)
        ? publicNativeChange(change)
        : this.#finishNative(change, "conflict", undefined, {
            conflict_reason: "manual_change",
          });
    }
    if (["applying", "uncertain"].includes(change.status)) {
      if (blockMatchesRequested(change, current)) {
        return this.#finishNative(change, "applied", undefined, {
          scenario_index: current.index,
          applied_snapshot: scenarioSnapshot(current),
          configuration_matches: true,
          recovered_after_uncertain_write: true,
        });
      }
      if (blockStillAtBaseline(change, current)) {
        return this.#finishNative(change, "uncertain");
      }
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "manual_change",
      });
    }
    if (!blockStillAtBaseline(change, current)) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "baseline_changed",
      });
    }

    await this.#persistNativeIntent(change, "applying");
    try {
      if (change.kind === "block_create") {
        const created = await this.client.createScenario(
          blockCreateRequest(change),
        );
        change.scenario_index = created.index;
      } else {
        await this.client.updateScenarioData(
          change.target.index,
          JSON.stringify(change.requested_snapshot.data),
        );
      }
      change.native_acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        await this.#finishNative(change, "not_applied");
        throw error;
      }
      return this.#reconcileBlockAfterWrite(change, false);
    }
    return this.#reconcileBlockAfterWrite(change, true);
  }

  async #reconcileBlockAfterWrite(change, acknowledged) {
    try {
      const current = await this.#observeBlock(change);
      if (blockMatchesRequested(change, current)) {
        return this.#finishNative(change, "applied", undefined, {
          scenario_index: current.index,
          applied_snapshot: scenarioSnapshot(current),
          configuration_matches: true,
          ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
        });
      }
      return this.#finishNative(change, "uncertain", undefined, {
        ...(acknowledged
          ? { conflict_reason: "ack_without_requested_result" }
          : {}),
      });
    } catch {
      return this.#finishNative(change, "uncertain");
    }
  }

  async #getBlockChange(change) {
    let current;
    try {
      current = await this.#observeBlock(change);
    } catch {
      return publicNativeChange(change);
    }
    if (
      ["applying", "uncertain"].includes(change.status) &&
      blockMatchesRequested(change, current)
    ) {
      return this.#finishNative(change, "applied", undefined, {
        scenario_index: current.index,
        applied_snapshot: scenarioSnapshot(current),
        configuration_matches: true,
        recovered_after_uncertain_write: true,
      });
    }
    if (change.status === "applied" && !blockMatchesApplied(change, current)) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "manual_change",
      });
    }
    return publicNativeChange(change);
  }

  async #restoreBlockChange(change) {
    const current = await this.#observeBlock(change);
    if (change.status === "restored") return publicNativeChange(change);
    if (!change.applied_snapshot || !blockMatchesApplied(change, current)) {
      return this.#finishNative(change, "conflict", undefined, {
        conflict_reason: "manual_change",
      });
    }
    await this.#persistNativeIntent(change, "restoring");
    try {
      if (change.kind === "block_create") {
        await this.client.deleteScenario(change.scenario_index);
      } else {
        await this.client.updateScenarioData(
          change.target.index,
          JSON.stringify(change.baseline_snapshot.data),
        );
      }
      change.native_acknowledged = true;
    } catch (error) {
      if (!isUncertainWriteError(error)) {
        await this.#finishNative(change, "applied");
        throw error;
      }
      return this.#reconcileBlockRestore(change, false);
    }
    return this.#reconcileBlockRestore(change, true);
  }

  async #reconcileBlockRestore(change, acknowledged) {
    try {
      const current = await this.#observeBlock(change);
      if (blockMatchesBaseline(change, current)) {
        return this.#finishNative(change, "restored", undefined, {
          configuration_matches: true,
          ...(!acknowledged ? { recovered_after_uncertain_write: true } : {}),
        });
      }
      return this.#finishNative(change, "uncertain", undefined, {
        ...(acknowledged
          ? { conflict_reason: "ack_without_requested_result" }
          : {}),
      });
    } catch {
      return this.#finishNative(change, "uncertain");
    }
  }

  async #observeBlock(change) {
    if (change.kind === "block_data_update") {
      return this.client.getScenario(change.target.index);
    }
    if (change.scenario_index) {
      const scenario = await this.client.getScenario(change.scenario_index);
      if (scenario) return scenario;
    }
    const scenarios = await this.client.listScenarioDetails();
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
      context: normalizeContext(context),
      limitations: [
        "Preview does not change the hub and is not an atomic reservation.",
        "An empty direct scenario list does not rule out dependencies inside arbitrary code or bridges.",
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

function unsupportedNativeOperation() {
  return new SprutHubError(
    "unsupported_native_operation",
    "This native operation is not supported in the current slice.",
  );
}

function blockContract() {
  return {
    version: "2026-09-10",
    source: {
      frontend_sha256:
        "81c1ef74ce21eb5ccff583255ba82fe766ff4cf6bc251c0566b7bd67436647f8",
      scenario_proto_sha256:
        "2319535876324b44c2048267d8b4297ec48d0881b964d5acc5ed1cbddfaa3657",
    },
    supported: {
      root: { required: ["targets"] },
      target_types: ["if", "service", "delay"],
      condition_modes: ["AND", "OR"],
      if_modes: ["EVERY"],
      action_types: ["set"],
      delay_modes: ["RESET"],
      characteristic_conditions: {
        boolean: ["="],
        string_or_enum: ["=", "!="],
        number: ["=", "!=", ">", ">=", "<", "<="],
        time: 0,
        time_condition: "",
      },
      nesting: ["if.then", "if.else", "delay.targets", "condition.conditions"],
    },
    limitations: [
      "BLOCK data uses native IDs inside one configured home; preparation verifies each referenced characteristic.",
      "At least one characteristic condition must have trigger=true.",
      "The same characteristic cannot be both a condition and an action in this slice.",
      "Only full data replacement is supported for an existing BLOCK; top-level rename and flag updates are not supported.",
      "SprutHub exposes no native compare-and-set; pre-write comparison does not close the remaining race window.",
    ],
  };
}

async function validateBlockData(data, client, { allowUnknownFrom }) {
  if (
    !isRecord(data) ||
    !Array.isArray(data.targets) ||
    data.targets.length === 0
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
    triggers: 0,
  };
  validateTargetArray(data.targets, "targets", context);
  if (context.triggers === 0) {
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
    const value = parseBlockValue(reference.value, contract.kind);
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
}

function validateTargetArray(targets, path, context) {
  if (!Array.isArray(targets)) throw invalidBlock(path, "must be an array");
  targets.forEach((target, index) => {
    validateTarget(target, `${path}[${index}]`, context);
  });
}

function validateTarget(target, path, context) {
  if (!isRecord(target) || typeof target.type !== "string") {
    throw invalidBlock(path, "target type is required");
  }
  if (target.type === "if") {
    if (
      target.mode !== "EVERY" ||
      target.then_delay !== 0 ||
      target.else_delay !== 0
    ) {
      throw invalidBlock(
        path,
        "only EVERY with zero branch delays is supported",
      );
    }
    validateCondition(target.if, `${path}.if`, context);
    validateTargetArray(target.then, `${path}.then`, context);
    validateTargetArray(target.else, `${path}.else`, context);
    return;
  }
  if (target.type === "service") {
    if (
      !stableNativeId(target.aId) ||
      !stableNativeId(target.sId) ||
      typeof target.hs !== "string" ||
      !Array.isArray(target.characteristics) ||
      target.characteristics.length === 0
    ) {
      throw invalidBlock(path, "service action is incomplete");
    }
    target.characteristics.forEach((action, index) => {
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
        aId: target.aId,
        sId: target.sId,
        cId: action.cId,
        hs: target.hs,
        hc: action.hc,
        value: action.value,
      });
    });
    return;
  }
  if (target.type === "delay") {
    if (
      !Number.isSafeInteger(target.index) ||
      target.index < 0 ||
      context.delayIndexes.has(target.index) ||
      target.mode !== "RESET" ||
      !Number.isSafeInteger(target.time) ||
      target.time <= 0
    ) {
      throw invalidBlock(
        path,
        "RESET delay index/time is invalid or duplicated",
      );
    }
    context.delayIndexes.add(target.index);
    validateTargetArray(target.targets, `${path}.targets`, context);
    return;
  }
  throw invalidBlock(path, `target type ${target.type} is not supported`);
}

function validateCondition(condition, path, context) {
  if (!isRecord(condition) || typeof condition.type !== "string") {
    throw invalidBlock(path, "condition type is required");
  }
  if (condition.type === "condition") {
    if (
      !["AND", "OR"].includes(condition.mode) ||
      !Array.isArray(condition.conditions) ||
      condition.conditions.length === 0
    ) {
      throw invalidBlock(path, "AND/OR condition must not be empty");
    }
    condition.conditions.forEach((child, index) => {
      validateCondition(child, `${path}.conditions[${index}]`, context);
    });
    return;
  }
  if (condition.type !== "characteristic") {
    throw invalidBlock(
      path,
      `condition type ${condition.type} is not supported`,
    );
  }
  if (
    !stableNativeId(condition.aId) ||
    !stableNativeId(condition.sId) ||
    !stableNativeId(condition.cId) ||
    typeof condition.hs !== "string" ||
    typeof condition.hc !== "string" ||
    typeof condition.trigger !== "boolean" ||
    typeof condition.cond !== "string" ||
    typeof condition.value !== "string" ||
    condition.timeCond !== "" ||
    condition.time !== 0
  ) {
    throw invalidBlock(path, "characteristic condition is incomplete");
  }
  if (condition.trigger) context.triggers += 1;
  context.conditions.push({
    role: "condition",
    path,
    aId: condition.aId,
    sId: condition.sId,
    cId: condition.cId,
    hs: condition.hs,
    hc: condition.hc,
    trigger: condition.trigger,
    cond: condition.cond,
    value: condition.value,
  });
}

const BLOCK_ALLOWED_KEYS = {
  root: new Set(["blockId", "targets"]),
  if: new Set([
    "type",
    "blockId",
    "state",
    "mode",
    "if",
    "then",
    "else",
    "then_delay",
    "else_delay",
  ]),
  condition: new Set(["type", "blockId", "mode", "conditions"]),
  characteristic: new Set([
    "type",
    "blockId",
    "aId",
    "sId",
    "cId",
    "hs",
    "hc",
    "trigger",
    "cond",
    "value",
    "timeCond",
    "time",
  ]),
  service: new Set(["type", "blockId", "aId", "sId", "hs", "characteristics"]),
  set: new Set(["type", "blockId", "cId", "hc", "value"]),
  delay: new Set(["type", "blockId", "index", "mode", "time", "targets"]),
};

function collectUnknownBlockFields(data) {
  const unknown = [];
  collectUnknownNode(data, "root", "root", unknown);
  return unknown.sort((left, right) => left.path.localeCompare(right.path));
}

function collectUnknownNode(node, kind, path, unknown) {
  if (!isRecord(node)) return;
  const allowed = BLOCK_ALLOWED_KEYS[kind] ?? new Set();
  for (const [key, value] of Object.entries(node)) {
    if (!allowed.has(key)) unknown.push({ path: `${path}.${key}`, value });
  }
  if (kind === "root") {
    node.targets?.forEach((child, index) => {
      collectUnknownNode(
        child,
        child?.type,
        `${path}.targets[${index}]`,
        unknown,
      );
    });
  } else if (kind === "if") {
    collectUnknownNode(node.if, node.if?.type, `${path}.if`, unknown);
    for (const key of ["then", "else"]) {
      node[key]?.forEach((child, index) => {
        collectUnknownNode(
          child,
          child?.type,
          `${path}.${key}[${index}]`,
          unknown,
        );
      });
    }
  } else if (kind === "condition") {
    node.conditions?.forEach((child, index) => {
      collectUnknownNode(
        child,
        child?.type,
        `${path}.conditions[${index}]`,
        unknown,
      );
    });
  } else if (kind === "service") {
    node.characteristics?.forEach((child, index) => {
      collectUnknownNode(
        child,
        child?.type,
        `${path}.characteristics[${index}]`,
        unknown,
      );
    });
  } else if (kind === "delay") {
    node.targets?.forEach((child, index) => {
      collectUnknownNode(
        child,
        child?.type,
        `${path}.targets[${index}]`,
        unknown,
      );
    });
  }
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
  const validValues = (control.validValues ?? []).map((validValue) => {
    const typed = typedNativeValue(validValue?.value);
    if (typed.kind !== current.kind) {
      throw new SprutHubError(
        "unsupported_characteristic",
        "The selected characteristic has incompatible native valid values.",
      );
    }
    return {
      key: validValue.key,
      name: validValue.name,
      ...typed,
    };
  });
  return {
    type: control.type,
    kind: current.kind,
    ...(typeof control.minValue === "number" ? { min: control.minValue } : {}),
    ...(typeof control.maxValue === "number" ? { max: control.maxValue } : {}),
    ...(typeof control.minStep === "number" ? { step: control.minStep } : {}),
    ...(typeof control.minLen === "number"
      ? { min_length: control.minLen }
      : {}),
    ...(typeof control.maxLen === "number"
      ? { max_length: control.maxLen }
      : {}),
    ...(validValues.length > 0 ? { valid_values: validValues } : {}),
  };
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
  const expected = {
    boolValue: "boolean",
    intValue: "number",
    longValue: "number",
    doubleValue: "number",
    stringValue: "string",
  }[contract.kind];
  if (
    typeof value !== expected ||
    (expected === "number" && !Number.isFinite(value)) ||
    (["intValue", "longValue"].includes(contract.kind) &&
      !Number.isSafeInteger(value))
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      `The requested value must match ${contract.kind}.`,
    );
  }
  if (
    contract.step !== undefined &&
    typeof value === "number" &&
    !isStepAligned(value, contract.min ?? 0, contract.step)
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "The requested value does not match the native step.",
    );
  }
  if (
    (contract.min !== undefined && value < contract.min) ||
    (contract.max !== undefined && value > contract.max)
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "The requested value is outside the native range.",
    );
  }
  if (
    typeof value === "string" &&
    ((contract.min_length !== undefined &&
      value.length < contract.min_length) ||
      (contract.max_length !== undefined && value.length > contract.max_length))
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "The requested value has an invalid native length.",
    );
  }
  if (
    contract.valid_values !== undefined &&
    !contract.valid_values.some(
      (candidate) =>
        candidate.kind === contract.kind && Object.is(candidate.value, value),
    )
  ) {
    throw new SprutHubError(
      "invalid_native_value",
      "The requested value is not in the native valid-values set.",
    );
  }
  return { value, kind: contract.kind };
}

function isStepAligned(value, min, step) {
  if (!Number.isFinite(step) || step <= 0) return false;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) <= Number.EPSILON * 16;
}

function valuesEqual(left, right) {
  return left?.kind === right?.kind && Object.is(left?.value, right?.value);
}

function scenarioSnapshot(scenario) {
  if (
    !isRecord(scenario) ||
    typeof scenario.index !== "string" ||
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
  return { ...structuredClone(scenario), data };
}

function blockCreateRequest(change) {
  return {
    name: change.requested_snapshot.name,
    desc: `${change.requested_snapshot.desc}\n\n[${change.marker}]`,
    active: change.requested_snapshot.active,
    onStart: change.requested_snapshot.onStart,
    sync: change.requested_snapshot.sync,
    type: "BLOCK",
    data: JSON.stringify(change.requested_snapshot.data),
  };
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
  if (change.kind === "block_data_update") {
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
  return (
    scenario !== null &&
    snapshotsEqual(scenarioSnapshot(scenario), change.baseline_snapshot)
  );
}

function blockMatchesApplied(change, scenario) {
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

function snapshotsEqual(left, right) {
  return isDeepStrictEqual(
    normalizeScenarioSnapshot(left),
    normalizeScenarioSnapshot(right),
  );
}

function normalizeScenarioSnapshot(snapshot) {
  return {
    ...structuredClone(snapshot),
    data: configurationData(snapshot.data),
  };
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

function publicNativeChange(change, observedValue = change.observed_value) {
  if (change.kind !== "characteristic_value") {
    const diff =
      change.kind === "block_create"
        ? {
            configuration: {
              changed: true,
              from: null,
              to: blockCreateSnapshot(change),
            },
          }
        : {
            data: {
              changed: !isDeepStrictEqual(
                configurationData(change.baseline_snapshot.data),
                configurationData(change.requested_snapshot.data),
              ),
              from: structuredClone(change.baseline_snapshot.data),
              to: structuredClone(change.requested_snapshot.data),
            },
          };
    return {
      status: change.status,
      change_ref: `spruthub-change://native/${change.id}`,
      operation: change.kind,
      reason: change.reason,
      target_ref: change.target_ref,
      diff,
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.scenario_index
        ? {
            scenario_index: change.scenario_index,
            scenario_ref: `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`,
          }
        : {}),
      ...(change.configuration_matches !== undefined
        ? { configuration_matches: change.configuration_matches }
        : {}),
      ...(change.recovered_after_uncertain_write
        ? { recovered_after_uncertain_write: true }
        : {}),
      ...(change.conflict_reason
        ? { conflict_reason: change.conflict_reason }
        : {}),
      restore_supported: true,
      limitations: [
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
        "Restoration is allowed only while the current configuration matches the saved applied snapshot.",
      ],
    };
  }
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    diff: {
      value: {
        from: change.baseline_value.value,
        to: change.requested_value.value,
        kind: change.requested_value.kind,
      },
    },
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(observedValue ? { observed_value: observedValue } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...(change.recovered_after_uncertain_write
      ? { recovered_after_uncertain_write: true }
      : {}),
    restore_supported: false,
    physical_effect_reversible: false,
    command_caused_observation: "unknown",
    limitations: [
      "Readback observes the value but cannot prove this command caused it.",
      "SprutHub exposes no native compare-and-set for this operation.",
      "A runtime command does not provide rollback of physical effects.",
    ],
  };
}

function changeSummary(change) {
  if (
    ["characteristic_value", "block_create", "block_data_update"].includes(
      change.kind,
    )
  ) {
    const reference = `spruthub-change://native/${change.id}`;
    return {
      change_ref: reference,
      operation: change.kind,
      status: change.status,
      target_refs: [change.target_ref],
      created_at: change.created_at,
      updated_at: change.updated_at,
      next: {
        tool: "get_native_change",
        arguments: { change_ref: reference },
      },
    };
  }
  const reference = changeRef(change.id);
  return {
    change_ref: reference,
    operation: "legacy_boolean_automation",
    status: change.status,
    target_refs: [
      change.condition?.characteristic?.ref,
      change.action?.characteristic?.ref,
      ...(change.scenario_index
        ? [
            `${change.home_ref ?? "spruthub://legacy-home"}/scenario/${encodeURIComponent(change.scenario_index)}`,
          ]
        : []),
    ].filter(Boolean),
    created_at: change.created_at,
    updated_at: change.updated_at,
    next: {
      tool: "get_automation_change",
      arguments: { change_ref: reference },
    },
  };
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
  if (Array.isArray(data)) return data.map(configurationData);
  if (!data || typeof data !== "object") return data;
  return Object.fromEntries(
    Object.entries(data)
      .filter(
        ([key]) =>
          key !== "blockId" && !(key === "state" && data.type === "if"),
      )
      .map(([key, value]) => [key, configurationData(value)]),
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
