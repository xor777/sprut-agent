import { storedScenarioRunPlan } from "./block-validation.mjs";
import { ROOM_NAME_LIMIT_NOTE, valuesEqual } from "./change-contracts.mjs";
import { decodeReferenceSegment } from "./change-refs.mjs";
import { hubCodeErrorFields } from "./hub-code.mjs";
import {
  LIGHT_GROUP_MEMBERS,
  publicLampGroupChange,
} from "./light-group-members.mjs";
import {
  createdLogicMapping,
  isGlobalCodeChange,
  logicDeleteAssignmentCheckUnproven,
  logicSourceRequestedSnapshot,
  publicLogicEditableFlags,
  sourceFingerprint,
} from "./logic-changes.mjs";
import {
  isNativeValueChange,
  LAMP_LEVEL_RESTORATION,
  manualValueChangeObserved,
  nativeValueKind,
  nativeValueProvenApply,
  nativeValueRestoration,
  savedVerification,
} from "./native-values.mjs";
import { publicAccessoryPlacement, publicRoom } from "./placement-rooms.mjs";
import {
  blockCreateObservedFlags,
  blockCreateSnapshot,
  blockDataUpdateDiff,
  isLogicSourceChange,
  ownedTargetAbsentLimitation,
  publicScenarioTargetReferences,
  scenarioConflictAsksForNewPrepare,
  scenarioLacksProvenApply,
  scenarioRepeatApplyLimitation,
  scenarioRestoreSupported,
  unprovenApplyLimitation,
  unprovenApplyNext,
} from "./scenario-changes.mjs";
import { isSensitiveNativeNode } from "./spruthub-client.mjs";

export function laterChangeRef(change) {
  return change.conflict_reason === "later_owned_change" &&
    typeof change.restore_first_change_id === "string"
    ? {
        restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
      }
    : {};
}

export function publicStoredNativeChange(change) {
  return publicNativeChange(change, undefined, {
    verification: savedVerification(change.last_verification),
  });
}

export function publicBlockActionPreview(change, fresh) {
  const preview = change.block_action_preview;
  return {
    snapshot: { ...structuredClone(preview.snapshot), fresh },
    actions: structuredClone(preview.actions),
    // A change prepared before scenario modes held only FIRE targets.
    ...(preview.scenario_runs
      ? {
          scenario_runs: preview.scenario_runs.map((run) => ({
            configuration_pointer: run.configuration_pointer,
            mode: run.mode ?? "FIRE",
            scenario: structuredClone(run.scenario),
          })),
        }
      : {}),
    ...(preview.notifications
      ? { notifications: structuredClone(preview.notifications) }
      : {}),
    ...(preview.http_requests
      ? { http_requests: structuredClone(preview.http_requests) }
      : {}),
    ...(preview.unchecked_actions
      ? { unchecked_actions: structuredClone(preview.unchecked_actions) }
      : {}),
    ...(preview.triggers
      ? { triggers: structuredClone(preview.triggers) }
      : {}),
    ...(preview.warnings
      ? { warnings: structuredClone(preview.warnings) }
      : {}),
    // Stored nodes a block_data_update removes, pointers into diff.data.from.
    ...(preview.removed_nodes
      ? {
          removed_nodes: preview.removed_nodes.map(({ pointer, type }) => ({
            pointer,
            type,
          })),
        }
      : {}),
  };
}

// Names hub code and other nodes this contract cannot write that an update
// deletes, so that the owner hears of it before apply.
export function removedUnwritableLimitation(change) {
  const unwritable = (change.block_action_preview?.removed_nodes ?? []).flatMap(
    (removed) => removed.unwritable ?? [],
  );
  if (unwritable.length === 0) return [];
  const listed = unwritable
    .map(({ pointer, type }) => `${type ?? "untyped node"} at ${pointer}`)
    .join(", ");
  return [
    `This edit deletes stored nodes this contract cannot write: ${listed}. Tell the owner before apply: block_data_update cannot add them back; only restore of this change or the SprutHub interface can.`,
  ];
}

export function publicNativeChange(
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
      ...laterChangeRef(change),
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
      ...(room
        ? { room, name_normalized: room.name !== change.requested_name }
        : {}),
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
      ...(change.conflict_reason === "later_owned_change"
        ? {
            restore_first_change_ref: `spruthub-change://native/${change.restore_first_change_id}`,
          }
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
        "A later applied room_name change of this room is named by restore_first_change_ref; restoring it first brings back the created name.",
        ROOM_NAME_LIMIT_NOTE,
        ...(room && room.name !== change.requested_name
          ? [
              "SprutHub stored the room under another name than requested (name_normalized): room.name is the stored one, diff.room.to.name the requested one. The room is this change's, and restore deletes it by what was stored.",
            ]
          : []),
      ],
    };
  }
  if (change.kind === LIGHT_GROUP_MEMBERS) {
    return publicLampGroupChange(change, {
      verification,
      configurationMatches,
    });
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
    const mapping =
      change.kind === "logic_source_create"
        ? createdLogicMapping(change)
        : undefined;
    const scenarioRef = change.scenario_index
      ? `${change.home_ref}/scenario/${encodeURIComponent(change.scenario_index)}`
      : change.kind === "logic_source_update"
        ? change.target_ref
        : undefined;
    const logicRef =
      mapping?.type !== undefined
        ? `${change.target_ref}/logic/${encodeURIComponent(mapping.type)}`
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
      ...(change.code_sets
        ? { code_sets: structuredClone(change.code_sets) }
        : {}),
      ...(change.restore_code_sets
        ? { restore_code_sets: structuredClone(change.restore_code_sets) }
        : {}),
      ...(change.warnings
        ? { warnings: structuredClone(change.warnings) }
        : {}),
      ...(change.code_diff
        ? { code_diff: structuredClone(change.code_diff) }
        : {}),
      ...(change.code_diff_truncated ? { code_diff_truncated: true } : {}),
      ...(change.code_mentions
        ? { code_mentions: structuredClone(change.code_mentions) }
        : {}),
      ...(isGlobalCodeChange(change)
        ? { executes_on_apply: true, hub_memory_kept: true }
        : {}),
      ...hubCodeErrorFields(change),
      native_write_sent: change.native_write_sent,
      native_acknowledged: change.native_acknowledged,
      ...(change.write_intent
        ? { write_intent: structuredClone(change.write_intent) }
        : {}),
      ...(change.scenario_index
        ? { scenario_index: change.scenario_index }
        : {}),
      ...(scenarioRef ? { scenario_ref: scenarioRef } : {}),
      ...(mapping?.type !== undefined
        ? { native_logic_type: mapping.type }
        : {}),
      ...(mappingVisible
        ? {
            logic_mapping_status: mapping.status,
            logic_assignment_ready: mapping.assignmentReady === true,
          }
        : {}),
      ...(mappingVisible && mapping.reason
        ? { logic_mapping_reason: mapping.reason }
        : {}),
      ...(logicDeleteAssignmentCheckUnproven(change)
        ? { logic_assignments_may_remain: true }
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
      ...(change.logic_assignments
        ? { logic_assignments: structuredClone(change.logic_assignments) }
        : {}),
      ...laterChangeRef(change),
      ...publicScenarioTargetReferences(change),
      restore_supported: scenarioRestoreSupported(change),
      ...(scenarioConflictAsksForNewPrepare(change)
        ? { next: unprovenApplyNext(change) }
        : {}),
      limitations: [
        "The source is compared exactly and represented by SHA-256 in change output so embedded native data is not echoed from the journal.",
        "LOGIC creation appends a unique JavaScript ownership comment to the source sent to SprutHub.",
        "Metadata returned after a source write is observed rather than attributed to either source derivation or a concurrent edit, and becomes the guard for a later restore.",
        "Source readback confirms stored configuration, not execution or physical behavior.",
        ...(isGlobalCodeChange(change)
          ? [
              "SprutHub runs a GLOBAL's code at once on every write, on or off, the write of a restore included (executes_on_apply). What the code assigned to global and what it did stay until the hub restarts (hub_memory_kept): a restore writes the old code back and runs it, it does not undo them.",
            ]
          : []),
        "Scenario creation, source updates, assignment, options, and activation are separate native operations.",
        "A created LOGIC's native type is its scenario index. Deletion scans the current assignments of that type across the home and the scenario targets of BLOCKs; what the scan finds blocks it, whether the LOGIC is on or off. SprutHub exposes no compare-and-set after that check.",
        ...(logicDeleteAssignmentCheckUnproven(change)
          ? [
              "An earlier version deleted this LOGIC after checking the assignments of a type other than its own (its scenario index), so assignments of its own type may remain on devices (logic_assignments_may_remain).",
            ]
          : []),
        ...(scenarioLacksProvenApply(change)
          ? [unprovenApplyLimitation()]
          : change.owned_target_absent_observed === true
            ? [ownedTargetAbsentLimitation()]
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
    const plan = storedScenarioRunPlan(change);
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
      targets_known: plan.targets_known,
      effect: structuredClone(plan.effect),
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
        ...(plan.effect.predicted
          ? []
          : [
              "SprutHub decides during the run which conditions, delays, and code let actions execute, so the effect is not predicted. Listed targets are only literal actions it may write; read_hub_log watch on this scenario, active during the run, shows what it did.",
            ]),
        ...(plan.targets_known
          ? []
          : [
              "Characteristics changed by LOGIC or BLOCK code, or by uninterpreted BLOCK parts, are not listed as targets.",
            ]),
        "An acknowledged run means SprutHub accepted scenario.run; target values are observed separately and do not prove physical delivery or causality.",
        "The target actions are not atomic, and a race remains after the pre-run scenario comparison.",
        "An unknown run outcome is never resent; prepare a new change only for a new explicit user request.",
        "Removing or restoring scenario configuration does not undo a past command effect.",
      ],
    };
  }
  if (!isNativeValueChange(change)) {
    const createFlags =
      change.kind === "block_create" ? blockCreateObservedFlags(change) : {};
    const diff =
      change.kind === "block_create"
        ? {
            configuration: {
              changed: true,
              from: null,
              to: blockCreateSnapshot(change),
              ...createFlags,
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
      ...laterChangeRef(change),
      ...publicScenarioTargetReferences(change),
      restore_supported: scenarioRestoreSupported(change),
      ...(scenarioConflictAsksForNewPrepare(change)
        ? { next: unprovenApplyNext(change) }
        : {}),
      limitations: [
        ...(change.block_action_preview
          ? [
              "Every listed service/set remains a write when its enclosing action runs; equality with the preparation observation is not a no-op or a manual-control guarantee.",
              "Action comparisons use the saved preparation observation. Later reads of this change do not refresh it or predict the value at a future branch execution.",
              "The preview's actions are the service actions of this BLOCK; notifications and http_requests list what it sends that the change adds or changes. A branch does not write omitted characteristics, but other automation can still affect them.",
              "scenario_runs names the scenario each scenario target runs, switches or resets (mode), as read at preparation; what that scenario writes is not listed.",
              "Known enum branch coverage is the condition's listed values at preparation, not a promise that the action will run, its order, a physical effect, or a trigger change. A condition with a hold time is left undisclosed (held_condition). Undisclosed coverage is not an empty domain. Later reads of this change do not refresh that domain.",
            ]
          : []),
        ...removedUnwritableLimitation(change),
        ...(createFlags.flags_exact_match === false
          ? [
              "SprutHub stored runtime flags other than requested at create (observed_at_create); this does not affect ownership or restore. Turning the scenario on or off is a separate scenario_active change.",
            ]
          : []),
        "SprutHub exposes no native compare-and-set; a race remains after the pre-write comparison.",
        scenarioLacksProvenApply(change)
          ? unprovenApplyLimitation()
          : change.owned_target_absent_observed === true
            ? ownedTargetAbsentLimitation()
            : "Restoration is allowed only while the current configuration matches the saved applied snapshot.",
        ...(scenarioConflictAsksForNewPrepare(change) &&
        change.applied_snapshot !== undefined
          ? [scenarioRepeatApplyLimitation()]
          : []),
      ],
    };
  }
  const kind = nativeValueKind(change.kind);
  const optionChange = kind.optionKey === true;
  // A change saved before its option was hidden (a keypad passcode written
  // as a NUMBER) holds the option's values; they are shown hidden, as
  // get_entity shows the option now.
  const hidden = optionChange && optionValuesHidden(change, observedValue);
  const shownValue = (typed) => (hidden ? hiddenOptionValue(typed) : typed);
  const namedValue = (typed) =>
    hidden ? hiddenOptionValue(typed) : namedOptionValue(change, typed);
  const valueChoices = optionChange
    ? {
        baseline: namedValue(change.baseline_value),
        requested: namedValue(change.requested_value),
        ...(observedValue ? { observed: namedValue(observedValue) } : {}),
      }
    : undefined;
  const conflictResolution =
    optionChange &&
    change.status === "conflict" &&
    change.conflict_reason !== "later_owned_change" &&
    nativeValueProvenApply(change) &&
    observedValue
      ? {
          requires_user_decision: true,
          action_if_authorized: `prepare_new_${change.kind}_change`,
          effect: {
            replace: namedValue(observedValue),
            with: namedValue(change.baseline_value),
          },
        }
      : undefined;
  // A record without lamp_level (from before it, or whose device read was
  // refused) keeps the answer of its type and baseline: telling a lamp
  // needs the accessory, which is not read here.
  const restoration =
    change.lamp_level === true
      ? LAMP_LEVEL_RESTORATION
      : nativeValueRestoration(change);
  return {
    status: change.status,
    change_ref: `spruthub-change://native/${change.id}`,
    operation: change.kind,
    reason: change.reason,
    target_ref: change.target_ref,
    ...(change.window_ref ? { window_ref: change.window_ref } : {}),
    ...(change.bridge_export
      ? { bridge_export: structuredClone(change.bridge_export) }
      : {}),
    diff: {
      value: {
        from: shownValue(change.baseline_value).value,
        to: shownValue(change.requested_value).value,
        kind: change.requested_value.kind,
      },
    },
    ...(change.warnings ? { warnings: structuredClone(change.warnings) } : {}),
    ...(change.notification_services
      ? {
          notification_services: structuredClone(change.notification_services),
        }
      : {}),
    native_write_sent: change.native_write_sent,
    native_acknowledged: change.native_acknowledged,
    ...(change.caused_by_change_id
      ? {
          caused_by_change_ref: `spruthub-change://native/${change.caused_by_change_id}`,
        }
      : {}),
    ...(change.write_intent
      ? { write_intent: structuredClone(change.write_intent) }
      : {}),
    ...(observedValue ? { observed_value: shownValue(observedValue) } : {}),
    ...(valueChoices ? { value_choices: valueChoices } : {}),
    ...(verification ? { verification } : {}),
    ...(change.conflict_reason
      ? { conflict_reason: change.conflict_reason }
      : {}),
    ...laterChangeRef(change),
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
    restore_supported: restoration.supported && change.status !== "restored",
    ...(restoration.limitation
      ? { restore_limitation: restoration.limitation }
      : {}),
    ...(kind.command ? { physical_effect_reversible: false } : {}),
    command_caused_observation: "unknown",
    limitations: [
      restoration.supported
        ? kind.command
          ? "Restore writes the previous value back only while the device still shows the value this change set and is online; past physical effects are not reversed."
          : "Restoration is allowed only while the current setting still matches this change."
        : (restoration.limitation?.message ??
          "A runtime command does not provide rollback of physical effects."),
      // What a write leaves unproven says nothing before it is sent.
      ...(change.status === "prepared"
        ? []
        : [
            "Readback observes the value but cannot prove this command caused it.",
            "SprutHub exposes no native compare-and-set for this operation.",
            "A setting write other than characteristic_value (an option, active flag, room or service name, or service visibility) with an unknown outcome may be retried only while this change retains ownership; a characteristic-value write is not retried automatically. After ownership is lost, any further authorized write requires a newly prepared change.",
          ]),
      ...(kind.limitations?.(change) ?? []),
      ...(change.group_member_targets
        ? [
            "Delivery is checked against every journal-known group member; a same-valued native virtual command may be suppressed by SprutHub.",
          ]
        : []),
      ...(change.caused_by_change_id
        ? [
            "No command was sent to this characteristic: the lamp switched itself when caused_by_change_ref set its level, and this change records that switch so undo puts it back.",
          ]
        : []),
    ],
  };
}

export function optionValuesHidden(change, observedValue) {
  return [change.baseline_value, change.requested_value, observedValue].some(
    (typed) =>
      typed != null &&
      isSensitiveNativeNode({
        key: change.option_key,
        type: change.contract?.type,
        input_type: change.contract?.input_type,
        value: typed.value,
      }),
  );
}

export function hiddenOptionValue(typed) {
  return {
    value: { redacted: true, reason: "sensitive_native_data" },
    kind: typed.kind,
  };
}

export function namedOptionValue(change, value) {
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

export function publicPauseEffect(change, now = Date.now()) {
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
